/**
 * The request side every record-file import shares: owner-only auth, a rate
 * bucket, the declared-length check, the body streamed to disk with its byte
 * cap after authentication, the same-bytes dedupe, one import per account,
 * the queue hand-off and the audit row. The routes sit outside the proxy
 * matcher (`src/lib/http/proxy-bypass-routes.ts`) so nothing reads the body
 * before the caller is known.
 *
 * The audit row carries the upload's size and hash, nothing from inside.
 */
import type { NextRequest } from "next/server";
import { unlink } from "node:fs/promises";

import { prisma } from "@/lib/db";
import { HttpError, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import { emitSignal } from "@/lib/logging/signal";
import { streamMultipartToDisk } from "@/lib/multipart/stream-to-disk";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  createImportJobUnlessBusy,
  discardStagedUpload,
  IMPORT_BUSY_CODE,
  IMPORT_BUSY_MESSAGE,
} from "@/lib/import/apple-health-staging";

import {
  RECORD_FILE_IMPORT_PARSER_REVISION,
  RECORD_FILE_IMPORT_QUEUE,
  RECORD_FILE_IMPORT_SEND_OPTIONS,
  RECORD_FILE_IMPORT_TMP_PREFIX,
  type RecordFileImportKind,
} from "./kinds";

/** What the worker receives. */
export interface RecordFileImportPayload {
  kind: RecordFileImportKind;
  userId: string;
  importJobId: string;
  /** Absolute path on the worker filesystem where the upload landed. */
  uploadPath: string;
}

/** Five files a minute per account and kind. */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function handleRecordFileUpload(
  request: NextRequest,
  opts: {
    kind: RecordFileImportKind;
    maxBytes: number;
    /** "512 MB", for the refusal. */
    capLabel: string;
  },
): Promise<Response> {
  const { user } = await requireAuth();
  const action = `import.${opts.kind}.kickoff`;
  annotate({ action: { name: action } });

  const rl = await checkRateLimit(
    `import:${opts.kind}:${user.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new HttpError(429, "Too many import uploads, try again later");
  }

  const tooLarge = () =>
    apiError(`Upload exceeds the ${opts.capLabel} limit`, 413, {
      errorCode: "import.file.too_large",
    });
  // The multipart envelope adds a few hundred bytes around the file; the
  // stream below holds the file itself to the cap.
  const declaredBytes = Number(request.headers.get("content-length") ?? 0);
  if (declaredBytes > opts.maxBytes + 64 * 1024) {
    emitSignal({
      action: `${action}.denied`,
      level: "warn",
      meta: {
        reason: "content_length_exceeded",
        content_length: declaredBytes,
      },
    });
    return tooLarge();
  }

  const body = request.body;
  if (!body) return apiError("Request body is required", 400);

  let uploaded;
  try {
    uploaded = await streamMultipartToDisk(
      body,
      request.headers.get("content-type"),
      {
        maxBytes: opts.maxBytes,
        fieldName: "file",
        tmpPrefix: RECORD_FILE_IMPORT_TMP_PREFIX[opts.kind],
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "upload_failed";
    emitSignal({
      action: `${action}.denied`,
      level: "warn",
      meta: { reason: "stream_to_disk_failed" },
    });
    if (/exceed|limit|too large/i.test(message)) return tooLarge();
    return apiError(`Multipart upload failed: ${message}`, 422);
  }

  const parserRevision = RECORD_FILE_IMPORT_PARSER_REVISION[opts.kind];
  const existing = await prisma.importJob.findFirst({
    where: {
      userId: user.id,
      kind: opts.kind,
      uploadSha256: uploaded.sha256,
      parserRevision,
      status: { not: "failed" },
    },
    orderBy: { startedAt: "desc" },
  });
  if (existing) {
    await unlink(uploaded.filePath).catch(() => {});
    annotate({ meta: { idempotent_hit: true, job_id: existing.id } });
    return apiSuccess(
      { jobId: existing.id, status: existing.status, idempotent: true },
      202,
    );
  }

  const boss = getGlobalBoss();
  if (!boss) {
    emitSignal({
      action: `${action}.denied`,
      level: "warn",
      meta: { reason: "worker_not_running" },
    });
    await discardStagedUpload(uploaded.filePath);
    throw new HttpError(503, "Background worker is not running");
  }

  const staged = await createImportJobUnlessBusy(prisma, {
    userId: user.id,
    kind: opts.kind,
    status: "queued",
    uploadBytes: uploaded.bytes,
    uploadSha256: uploaded.sha256,
    parserRevision,
  });
  if ("busy" in staged) {
    await discardStagedUpload(uploaded.filePath);
    return apiError(IMPORT_BUSY_MESSAGE, 409, {
      errorCode: IMPORT_BUSY_CODE,
      jobId: staged.busy.id,
    });
  }
  const importJob = staged.created;

  const payload: RecordFileImportPayload = {
    kind: opts.kind,
    userId: user.id,
    importJobId: importJob.id,
    uploadPath: uploaded.filePath,
  };
  const bossJobId = await boss.send(
    RECORD_FILE_IMPORT_QUEUE,
    payload,
    RECORD_FILE_IMPORT_SEND_OPTIONS,
  );
  if (!bossJobId) {
    await prisma.importJob.update({
      where: { id: importJob.id },
      data: {
        status: "failed",
        failureReason: "The import could not be queued. Upload the file again.",
        completedAt: new Date(),
      },
    });
    await discardStagedUpload(uploaded.filePath);
    throw new HttpError(503, "The import could not be queued");
  }
  await prisma.importJob.update({
    where: { id: importJob.id },
    data: { pgBossJobId: bossJobId },
  });

  await auditLog(action, {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      jobId: importJob.id,
      uploadBytes: uploaded.bytes,
      uploadSha256: uploaded.sha256,
    },
  });

  return apiSuccess({ jobId: importJob.id, status: "queued" as const }, 202);
}

/** The caller's latest job of one kind, as the status routes answer it. */
export async function recordFileImportStatus(
  kind: RecordFileImportKind,
): Promise<Response> {
  const { user } = await requireAuth();
  annotate({ action: { name: `import.${kind}.status` } });
  const row = await prisma.importJob.findFirst({
    where: { userId: user.id, kind },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      startedAt: true,
      completedAt: true,
      uploadBytes: true,
      result: true,
      failureReason: true,
    },
  });
  return apiSuccess({
    job: row
      ? {
          jobId: row.id,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
          uploadBytes: row.uploadBytes,
          result: (row.result as Record<string, unknown> | null) ?? null,
          failureReason: row.failureReason,
        }
      : null,
  });
}
