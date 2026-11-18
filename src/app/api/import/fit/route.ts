/**
 * `POST /api/import/fit` — upload one activity file (`.fit`, `.fit.gz`, or
 * the ZIP Garmin Connect's "Export original" hands out) for a background
 * import.
 *
 * The same staging as the Apple Health and Health Connect uploads: the route
 * sits outside the proxy matcher (`src/lib/http/proxy-bypass-routes.ts`), so
 * the body is streamed to disk after authentication, hashed on the way and
 * refused past the 10 MB cap; an `ImportJob` row (`kind = "fit"`) carries
 * the progress; the `fit-import` queue decodes the file in the worker, never
 * in this request. One import runs per account at a time, whatever its kind.
 * Re-uploading the same bytes resolves to the still-viable job; a failed job
 * never blocks a retry of the same file.
 *
 * The audit row carries the upload's size and hash and nothing from inside
 * the file.
 */
import type { NextRequest } from "next/server";
import { unlink } from "node:fs/promises";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { emitSignal } from "@/lib/logging/signal";
import { checkRateLimit } from "@/lib/rate-limit";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { FIT_UPLOAD_MAX_BYTES } from "@/lib/fit/container";
import { FIT_IMPORT_KIND, FIT_IMPORT_QUEUE } from "@/lib/jobs/fit-import-queue";
import {
  FIT_IMPORT_PARSER_REVISION,
  FIT_IMPORT_SEND_OPTIONS,
  type FitImportPayload,
} from "@/lib/jobs/fit-import-worker";
import { streamMultipartToDisk } from "@/lib/multipart/stream-to-disk";
import {
  createImportJobUnlessBusy,
  discardStagedUpload,
  IMPORT_BUSY_CODE,
  IMPORT_BUSY_MESSAGE,
} from "@/lib/import/apple-health-staging";

export const dynamic = "force-dynamic";

/** Ten files a minute per account: a person catching up on a few rides. */
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.fit.kickoff" } });

  const rl = await checkRateLimit(
    `import:fit:${user.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new HttpError(429, "Too many import uploads, try again later");
  }

  // The multipart envelope adds a few hundred bytes around the file; the
  // stream below holds the file itself to the cap.
  const declaredBytes = Number(request.headers.get("content-length") ?? 0);
  if (declaredBytes > FIT_UPLOAD_MAX_BYTES + 64 * 1024) {
    emitSignal({
      action: "import.fit.kickoff.denied",
      level: "warn",
      meta: {
        reason: "content_length_exceeded",
        content_length: declaredBytes,
      },
    });
    return apiError("Upload exceeds the 10 MB limit", 413);
  }

  const body = request.body;
  if (!body) return apiError("Request body is required", 400);

  let uploaded;
  try {
    uploaded = await streamMultipartToDisk(
      body,
      request.headers.get("content-type"),
      {
        maxBytes: FIT_UPLOAD_MAX_BYTES,
        fieldName: "file",
        tmpPrefix: "healthlog-fit-import",
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "upload_failed";
    emitSignal({
      action: "import.fit.kickoff.denied",
      level: "warn",
      meta: { reason: "stream_to_disk_failed" },
    });
    if (/exceed|limit|too large/i.test(message)) {
      return apiError("Upload exceeds the 10 MB limit", 413);
    }
    return apiError(`Multipart upload failed: ${message}`, 422);
  }

  const existing = await prisma.importJob.findFirst({
    where: {
      userId: user.id,
      kind: FIT_IMPORT_KIND,
      uploadSha256: uploaded.sha256,
      parserRevision: FIT_IMPORT_PARSER_REVISION,
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
      action: "import.fit.kickoff.denied",
      level: "warn",
      meta: { reason: "worker_not_running" },
    });
    await discardStagedUpload(uploaded.filePath);
    throw new HttpError(503, "Background worker is not running");
  }

  const staged = await createImportJobUnlessBusy(prisma, {
    userId: user.id,
    kind: FIT_IMPORT_KIND,
    status: "queued",
    uploadBytes: uploaded.bytes,
    uploadSha256: uploaded.sha256,
    parserRevision: FIT_IMPORT_PARSER_REVISION,
  });
  if ("busy" in staged) {
    await discardStagedUpload(uploaded.filePath);
    return apiError(IMPORT_BUSY_MESSAGE, 409, {
      errorCode: IMPORT_BUSY_CODE,
      jobId: staged.busy.id,
    });
  }
  const importJob = staged.created;

  const payload: FitImportPayload = {
    userId: user.id,
    importJobId: importJob.id,
    uploadPath: uploaded.filePath,
  };
  const bossJobId = await boss.send(
    FIT_IMPORT_QUEUE,
    payload,
    FIT_IMPORT_SEND_OPTIONS,
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

  await auditLog("import.fit.kickoff", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      jobId: importJob.id,
      uploadBytes: uploaded.bytes,
      uploadSha256: uploaded.sha256,
    },
  });

  return apiSuccess({ jobId: importJob.id, status: "queued" as const }, 202);
});
