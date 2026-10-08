/**
 * `POST /api/import/health-connect-export` — upload an Android Health Connect
 * export ZIP for background import (v1.42, #972).
 *
 * Mirrors the Apple Health upload (`../apple-health-export/route.ts`): the
 * route sits outside the proxy matcher (`src/lib/http/proxy-bypass-routes.ts`)
 * so the body is streamed to disk after authentication instead of buffered,
 * hashed with SHA-256 on the way, refused past the size cap, and handed to
 * the `health-connect-import` queue. One import runs per account at a time,
 * whatever its kind (`createImportJobUnlessBusy`). Re-uploading the same
 * bytes resolves to the still-viable job instead of importing twice; a failed
 * job never blocks a retry of the same file.
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
import { checkRateLimit } from "@/lib/rate-limit";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  HEALTH_CONNECT_IMPORT_KIND,
  HEALTH_CONNECT_IMPORT_PARSER_REVISION,
  HEALTH_CONNECT_IMPORT_QUEUE,
  HEALTH_CONNECT_IMPORT_SEND_OPTIONS,
  type HealthConnectImportPayload,
} from "@/lib/jobs/health-connect-import-worker";
import { streamMultipartToDisk } from "@/lib/multipart/stream-to-disk";
import {
  createImportJobUnlessBusy,
  discardStagedUpload,
  IMPORT_BUSY_CODE,
  IMPORT_BUSY_MESSAGE,
} from "@/lib/import/apple-health-staging";

export const dynamic = "force-dynamic";

/**
 * Hard cap on the upload. The ZIP holds one SQLite file that compresses to
 * about half; a multi-year export with minute-by-minute heart rate sits in
 * the low hundreds of megabytes, and 1 GiB leaves room for the long tail.
 */
const HEALTH_CONNECT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** Three uploads per minute per account, like the Apple Health upload. */
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.health-connect.kickoff" } });

  const rl = await checkRateLimit(
    `import:health-connect:${user.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new HttpError(429, "Too many import uploads, try again later");
  }

  const declaredBytes = Number(request.headers.get("content-length") ?? 0);
  if (declaredBytes > HEALTH_CONNECT_MAX_UPLOAD_BYTES) {
    await auditLog("import.health-connect.kickoff.denied", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        reason: "content_length_exceeded",
        contentLength: declaredBytes,
      },
    });
    return apiError("Upload exceeds the 1 GB limit", 413);
  }

  const body = request.body;
  if (!body) return apiError("Request body is required", 400);

  let uploaded;
  try {
    uploaded = await streamMultipartToDisk(
      body,
      request.headers.get("content-type"),
      {
        maxBytes: HEALTH_CONNECT_MAX_UPLOAD_BYTES,
        fieldName: "file",
        tmpPrefix: "healthlog-health-connect-import",
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "upload_failed";
    await auditLog("import.health-connect.kickoff.denied", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reason: "stream_to_disk_failed" },
    });
    return apiError(`Multipart upload failed: ${message}`, 422);
  }

  const existing = await prisma.importJob.findFirst({
    where: {
      userId: user.id,
      kind: HEALTH_CONNECT_IMPORT_KIND,
      uploadSha256: uploaded.sha256,
      parserRevision: HEALTH_CONNECT_IMPORT_PARSER_REVISION,
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
    await auditLog("import.health-connect.kickoff.denied", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reason: "worker_not_running" },
    });
    await discardStagedUpload(uploaded.filePath);
    throw new HttpError(503, "Background worker is not running");
  }

  const staged = await createImportJobUnlessBusy(prisma, {
    userId: user.id,
    kind: HEALTH_CONNECT_IMPORT_KIND,
    status: "queued",
    uploadBytes: uploaded.bytes,
    uploadSha256: uploaded.sha256,
    parserRevision: HEALTH_CONNECT_IMPORT_PARSER_REVISION,
  });
  if ("busy" in staged) {
    await discardStagedUpload(uploaded.filePath);
    return apiError(IMPORT_BUSY_MESSAGE, 409, {
      errorCode: IMPORT_BUSY_CODE,
      jobId: staged.busy.id,
    });
  }
  const importJob = staged.created;

  const payload: HealthConnectImportPayload = {
    userId: user.id,
    importJobId: importJob.id,
    uploadPath: uploaded.filePath,
  };
  const bossJobId = await boss.send(
    HEALTH_CONNECT_IMPORT_QUEUE,
    payload,
    HEALTH_CONNECT_IMPORT_SEND_OPTIONS,
  );
  if (!bossJobId) {
    await prisma.importJob.update({
      where: { id: importJob.id },
      data: {
        status: "failed",
        failureReason:
          "The import could not be queued. Upload the export again.",
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

  await auditLog("import.health-connect.kickoff", {
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
