/**
 * The one upload path every staged file import takes: an Apple Health export
 * (owner and admin variant), a Health Connect export, an activity FIT file, a
 * Gadgetbridge database and a FHIR R4 Bundle. Each route supplies what is its
 * own (the job kind, the queue and its payload, the cap, the staging name);
 * everything else happens here, once, in this order:
 *
 *   1. the caller is authenticated (the owner by `requireAuth()`, the admin
 *      variant by `requireAdmin()` before it calls in);
 *   2. one rate rule: five uploads a minute per acting account and import
 *      kind, in the bucket `import:<kind>:<actor id>`, spent before the body
 *      is touched. The buffered imports (CSV, JSON, dose history) spend a
 *      different, hourly bucket (`src/lib/import/record-import-route.ts`);
 *   3. the declared `Content-Length`, with a 64 KiB reserve for the multipart
 *      envelope around the file;
 *   4. the body streamed to disk with the cap held on the file itself,
 *      hashed on the way. A file past the cap is a 413, whether the declared
 *      length or the stream found it, always with `errorCode`
 *      `import.file.too_large`; a body that cannot be read is a 422;
 *   5. the same bytes resolving to the still-viable job (202, `idempotent`);
 *      a failed job never blocks a retry of the same file;
 *   6. no worker: 503; one import per account at a time: 409
 *      `import.apple_health.busy` with the running job's id;
 *   7. the queue hand-off (503 when the queue takes nothing, the row failed),
 *      and the audit row with the upload's size and hash, nothing from inside.
 *
 * The staged file is the person's export in plain text; every way out except
 * a queued job removes it. The routes sit outside the proxy matcher
 * (`src/lib/http/proxy-bypass-routes.ts`), so nothing reads the body before
 * the caller is known. `src/__tests__/staged-upload-guard.test.ts` holds that
 * nothing else streams a multipart body to disk.
 */
import type { NextRequest } from "next/server";
import { unlink } from "node:fs/promises";
import type { SendOptions } from "pg-boss";

import { prisma } from "@/lib/db";
import { HttpError, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import { emitSignal, logCaught } from "@/lib/logging/signal";
import {
  MULTIPART_ENVELOPE_RESERVE_BYTES,
  MultipartMalformedError,
  MultipartTooLargeError,
  streamMultipartToDisk,
  type MultipartFileResult,
} from "@/lib/multipart/stream-to-disk";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  ACTIVE_IMPORT_MAX_AGE_MS,
  ACTIVE_IMPORT_STATUSES,
  createImportJobUnlessBusy,
  discardStagedUpload,
  IMPORT_BUSY_CODE,
  IMPORT_BUSY_MESSAGE,
} from "@/lib/import/apple-health-staging";

/** Five uploads a minute per acting account and kind. */
export const STAGED_UPLOAD_RATE_LIMIT = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** The `errorCode` of every 413 an upload answers. */
export const IMPORT_FILE_TOO_LARGE_CODE = "import.file.too_large";

/** The job a staged file becomes, as the worker's payload is built from it. */
export interface StagedImportJob {
  userId: string;
  importJobId: string;
  uploadPath: string;
  uploadBytes: number;
  triggeredByAdminId?: string;
}

/** What one kind of import puts on its job row and its queue. */
export interface StagedImportSpec {
  /** `ImportJob.kind`. */
  kind: string;
  parserRevision: number;
  queue: string;
  sendOptions: SendOptions;
  payload(job: StagedImportJob): object;
}

export type QueueStagedResult =
  | { outcome: "queued"; jobId: string; bossJobId: string }
  | { outcome: "idempotent"; jobId: string; status: string }
  | { outcome: "busy"; jobId: string }
  | { outcome: "no_worker" }
  | { outcome: "not_queued" };

/**
 * Hand a staged file to its queue: the same-bytes dedupe, the one import per
 * account, the job row and the send. Shared by the upload routes and the
 * scheduled Health Connect fetch. The staged file is consumed on every way
 * out except `queued`, where the worker owns it.
 */
export async function queueStagedImport(
  spec: StagedImportSpec,
  input: {
    userId: string;
    filePath: string;
    bytes: number;
    sha256: string;
    triggeredByAdminId?: string;
  },
): Promise<QueueStagedResult> {
  const existing = await prisma.importJob.findFirst({
    where: {
      userId: input.userId,
      kind: spec.kind,
      uploadSha256: input.sha256,
      parserRevision: spec.parserRevision,
      status: { not: "failed" },
      // A finished import, or one still within the queue's own expiry. An
      // active row older than that holds nothing any more (the busy check
      // ignores it too); counting it here answered "already uploaded" for
      // that file forever, with no import running.
      OR: [
        { status: { notIn: [...ACTIVE_IMPORT_STATUSES] } },
        {
          startedAt: {
            gte: new Date(Date.now() - ACTIVE_IMPORT_MAX_AGE_MS),
          },
        },
      ],
    },
    orderBy: { startedAt: "desc" },
  });
  if (existing) {
    // The viable job owns the canonical bytes; this copy is redundant.
    await unlink(input.filePath).catch(() => {});
    return {
      outcome: "idempotent",
      jobId: existing.id,
      status: existing.status,
    };
  }

  const boss = getGlobalBoss();
  if (!boss) {
    await discardStagedUpload(input.filePath);
    return { outcome: "no_worker" };
  }

  const staged = await createImportJobUnlessBusy(prisma, {
    userId: input.userId,
    ...(input.triggeredByAdminId
      ? { triggeredByAdminId: input.triggeredByAdminId }
      : {}),
    kind: spec.kind,
    status: "queued",
    uploadBytes: input.bytes,
    uploadSha256: input.sha256,
    parserRevision: spec.parserRevision,
  });
  if ("busy" in staged) {
    await discardStagedUpload(input.filePath);
    return { outcome: "busy", jobId: staged.busy.id };
  }
  const importJob = staged.created;

  // A send that throws (the database connection dropped mid-call) is the
  // same as one that returns no id: nothing will consume the row. Left
  // `queued`, it blocked the same file from being uploaded again.
  const bossJobId = await boss
    .send(
      spec.queue,
      spec.payload({
        userId: input.userId,
        importJobId: importJob.id,
        uploadPath: input.filePath,
        uploadBytes: input.bytes,
        ...(input.triggeredByAdminId
          ? { triggeredByAdminId: input.triggeredByAdminId }
          : {}),
      }),
      spec.sendOptions,
    )
    .catch((err: unknown) => {
      logCaught("import.staged.queue_send_failed", err);
      return null;
    });
  if (!bossJobId) {
    // No worker will consume the file or move the row on.
    await prisma.importJob.update({
      where: { id: importJob.id },
      data: {
        status: "failed",
        failureReason: "The import could not be queued. Upload the file again.",
        completedAt: new Date(),
      },
    });
    await discardStagedUpload(input.filePath);
    return { outcome: "not_queued" };
  }
  await prisma.importJob.update({
    where: { id: importJob.id },
    data: { pgBossJobId: bossJobId },
  });
  return { outcome: "queued", jobId: importJob.id, bossJobId };
}

/** One upload route. */
export interface StagedUploadSpec {
  /** `import.fit.kickoff`: the annotation, the audit row; `.denied` for a refusal. */
  action: string;
  maxBytes: number;
  /** "10 MB", for the refusal's message. */
  capLabel: string;
  /** The staged-file prefix; the staging sweep knows these names. */
  tmpPrefix: string;
  import: StagedImportSpec;
}

/** Into whose account the import lands, once the body is on disk. */
export interface UploadTarget {
  userId: string;
  triggeredByAdminId?: string;
  /** More for the audit row of a queued upload. */
  auditDetails?: Record<string, unknown>;
  /** More for the 202 of a queued upload. */
  responseFields?: Record<string, unknown>;
}

/** Who uploads. The owner by default; the admin variant brings its own. */
export interface UploadActor {
  /** The account that spends the bucket and signs the audit row. */
  id: string;
  /** Record a refusal. */
  denied(reason: string, details: Record<string, unknown>): Promise<void>;
  /** Resolve the target; a Response refuses, and the staged file is removed. */
  target(uploaded: MultipartFileResult): Promise<UploadTarget | Response>;
}

async function ownerActor(action: string): Promise<UploadActor> {
  const { user } = await requireAuth();
  return {
    id: user.id,
    // A refused upload is an operational outcome, not an account action.
    denied: async (reason, details) =>
      emitSignal({
        action: `${action}.denied`,
        level: "warn",
        meta: { reason, ...details },
      }),
    target: async () => ({ userId: user.id }),
  };
}

/** The body on disk, or the refusal to answer instead. */
async function receiveUpload(
  request: NextRequest,
  spec: StagedUploadSpec,
  actor: UploadActor,
): Promise<MultipartFileResult | Response> {
  const tooLarge = () =>
    apiError(`Upload exceeds the ${spec.capLabel} limit`, 413, {
      errorCode: IMPORT_FILE_TOO_LARGE_CODE,
    });

  // A cheap pre-flight; the stream below counts every byte it reads against
  // the cap plus the same envelope, so a missing or wrong header (a chunked
  // body has none) cannot get past it.
  const declaredBytes = Number(request.headers.get("content-length") ?? 0);
  if (declaredBytes > spec.maxBytes + MULTIPART_ENVELOPE_RESERVE_BYTES) {
    await actor.denied("content_length_exceeded", {
      content_length: declaredBytes,
    });
    return tooLarge();
  }

  const body = request.body;
  if (!body) return apiError("Request body is required", 400);

  try {
    return await streamMultipartToDisk(
      body,
      request.headers.get("content-type"),
      { maxBytes: spec.maxBytes, fieldName: "file", tmpPrefix: spec.tmpPrefix },
    );
  } catch (err) {
    if (err instanceof MultipartTooLargeError) {
      await actor.denied("file_too_large", {});
      return tooLarge();
    }
    // Only the parser's own refusals are shown. Anything else (a dropped
    // connection, a full disk) carries a message written for a log, which
    // can name the temp path; the caller gets the generic answer.
    if (err instanceof MultipartMalformedError) {
      await actor.denied("stream_to_disk_failed", { message: err.message });
      return apiError(`Multipart upload failed: ${err.message}`, 422);
    }
    const name = err instanceof Error ? err.name : "unknown";
    await actor.denied("stream_to_disk_failed", { error: name });
    return apiError("Multipart upload failed", 422);
  }
}

export async function handleStagedUpload(
  request: NextRequest,
  spec: StagedUploadSpec,
  asActor?: UploadActor,
): Promise<Response> {
  const actor = asActor ?? (await ownerActor(spec.action));
  annotate({ action: { name: spec.action } });

  const rl = await checkRateLimit(
    `import:${spec.import.kind}:${actor.id}`,
    STAGED_UPLOAD_RATE_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new HttpError(429, "Too many import uploads, try again later");
  }

  const uploaded = await receiveUpload(request, spec, actor);
  if (uploaded instanceof Response) return uploaded;

  const target = await actor.target(uploaded);
  if (target instanceof Response) {
    await discardStagedUpload(uploaded.filePath);
    return target;
  }

  const queued = await queueStagedImport(spec.import, {
    userId: target.userId,
    triggeredByAdminId: target.triggeredByAdminId,
    filePath: uploaded.filePath,
    bytes: uploaded.bytes,
    sha256: uploaded.sha256,
  });
  switch (queued.outcome) {
    case "idempotent":
      annotate({ meta: { idempotent_hit: true, job_id: queued.jobId } });
      return apiSuccess(
        { jobId: queued.jobId, status: queued.status, idempotent: true },
        202,
      );
    case "no_worker":
      await actor.denied("worker_not_running", {});
      throw new HttpError(503, "Background worker is not running");
    case "busy":
      return apiError(IMPORT_BUSY_MESSAGE, 409, {
        errorCode: IMPORT_BUSY_CODE,
        jobId: queued.jobId,
      });
    case "not_queued":
      throw new HttpError(503, "The import could not be queued");
    case "queued":
      break;
  }

  await auditLog(spec.action, {
    userId: actor.id,
    ipAddress: getClientIp(request),
    details: {
      jobId: queued.jobId,
      bossJobId: queued.bossJobId,
      ...target.auditDetails,
      uploadBytes: uploaded.bytes,
      uploadSha256: uploaded.sha256,
    },
  });

  return apiSuccess(
    {
      jobId: queued.jobId,
      status: "queued" as const,
      ...target.responseFields,
    },
    202,
  );
}
