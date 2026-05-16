/**
 * `POST /api/import/apple-health-export` — user-facing kick-off for an
 * Apple Health `export.zip` import.
 *
 * Streams the upload directly to disk (`/tmp/healthlog-upload-*.bin`)
 * without buffering the full body in memory, creates an `ImportJob`
 * row in `queued`, and enqueues an `apple-health-import` pg-boss job.
 * Returns `{ jobId }` so the client can poll
 * `GET /api/import/apple-health-export/[jobId]/status`.
 *
 * Idempotency: a re-upload of the exact same file (same SHA-256 of
 * the bytes) short-circuits to the previous `ImportJob` id without
 * re-queueing — the iOS client cannot reliably emit a stable
 * `Idempotency-Key` for a 1 GB file, so we hash the bytes and dedup
 * on content.
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §5.3.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  APPLE_HEALTH_IMPORT_QUEUE,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";
import { streamMultipartToDisk } from "@/lib/multipart/stream-to-disk";

export const dynamic = "force-dynamic";

/**
 * Hard cap on the upload size. Apple's largest observed exports
 * sit around 800 MB for a 10-year iCloud-synced account; 1.5 GB
 * leaves comfortable margin for the long tail.
 */
const MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024 * 1024;

/** Rate-limit window: three uploads per minute per user. */
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.apple-health.kickoff" } });

  // Rate limit before touching the body — protects against a flood of
  // 1 GB uploads from a single user.
  const rl = await checkRateLimit(
    `import:apple-health:${user.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new HttpError(429, "Too many import uploads, try again later");
  }

  // Cheap pre-flight on the declared Content-Length. The streaming
  // sink below enforces the hard cap as well — a missing/wrong
  // content-length cannot bypass it.
  const declaredBytes = Number(request.headers.get("content-length") ?? 0);
  if (declaredBytes > MAX_UPLOAD_BYTES) {
    await auditLog("import.apple-health.kickoff.denied", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        reason: "content_length_exceeded",
        contentLength: declaredBytes,
      },
    });
    return apiError("Upload exceeds 1.5 GB limit", 413);
  }

  const body = request.body;
  if (!body) {
    return apiError("Request body is required", 400);
  }

  // Stream the upload to disk, computing a SHA-256 in the same pass.
  let uploaded;
  try {
    uploaded = await streamMultipartToDisk(
      body,
      request.headers.get("content-type"),
      {
        maxBytes: MAX_UPLOAD_BYTES,
        fieldName: "file",
        tmpPrefix: "healthlog-apple-health-import",
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "upload_failed";
    await auditLog("import.apple-health.kickoff.denied", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reason: "stream_to_disk_failed", message },
    });
    return apiError(`Multipart upload failed: ${message}`, 422);
  }

  // Content-hash idempotency: a re-upload of the same bytes resolves
  // to the previous ImportJob row instead of re-queueing.
  const existing = await prisma.importJob.findFirst({
    where: {
      userId: user.id,
      uploadSha256: uploaded.sha256,
    },
    orderBy: { startedAt: "desc" },
  });
  if (existing) {
    annotate({ meta: { idempotent_hit: true, job_id: existing.id } });
    return apiSuccess(
      {
        jobId: existing.id,
        status: existing.status,
        idempotent: true,
      },
      202,
    );
  }

  const boss = getGlobalBoss();
  if (!boss) {
    await auditLog("import.apple-health.kickoff.denied", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reason: "worker_not_running" },
    });
    throw new HttpError(503, "Background worker is not running");
  }

  const importJob = await prisma.importJob.create({
    data: {
      userId: user.id,
      status: "queued",
      uploadBytes: uploaded.bytes,
      uploadSha256: uploaded.sha256,
    },
  });

  const payload: AppleHealthImportPayload = {
    userId: user.id,
    uploadPath: uploaded.filePath,
    uploadBytes: uploaded.bytes,
    enqueuedAt: new Date().toISOString(),
  };
  const bossJobId = await boss.send(APPLE_HEALTH_IMPORT_QUEUE, payload);

  await prisma.importJob.update({
    where: { id: importJob.id },
    data: { pgBossJobId: bossJobId },
  });

  await auditLog("import.apple-health.kickoff", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      jobId: importJob.id,
      bossJobId: bossJobId ?? null,
      uploadBytes: uploaded.bytes,
      uploadSha256: uploaded.sha256,
    },
  });

  return apiSuccess(
    {
      jobId: importJob.id,
      status: "queued" as const,
    },
    202,
  );
});
