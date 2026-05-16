/**
 * `POST /api/admin/import-apple-health-export` — admin-only Apple
 * Health import on behalf of a target user.
 *
 * Same multipart streaming path as the user-facing kick-off, but with
 * `requireAdmin()` (cookie-only — Bearer tokens never elevate) and a
 * `userId` text field naming the target user. The kicked-off
 * `ImportJob` row carries `triggeredByAdminId = admin.id` so the
 * status endpoint admits both the target user AND the triggering
 * admin.
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §9.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin, HttpError } from "@/lib/api-handler";
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

const MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024 * 1024;
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user: admin } = await requireAdmin();
  annotate({ action: { name: "admin.import-apple-health.kickoff" } });

  const rl = await checkRateLimit(
    `admin-import-apple-health:${admin.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new HttpError(429, "Too many import uploads, try again later");
  }

  const declaredBytes = Number(request.headers.get("content-length") ?? 0);
  if (declaredBytes > MAX_UPLOAD_BYTES) {
    await auditLog("admin.import-apple-health.kickoff.denied", {
      userId: admin.id,
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

  let uploaded;
  try {
    uploaded = await streamMultipartToDisk(
      body,
      request.headers.get("content-type"),
      {
        maxBytes: MAX_UPLOAD_BYTES,
        fieldName: "file",
        tmpPrefix: "healthlog-admin-apple-health-import",
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "upload_failed";
    await auditLog("admin.import-apple-health.kickoff.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason: "stream_to_disk_failed", message },
    });
    return apiError(`Multipart upload failed: ${message}`, 422);
  }

  // Resolve the target user from the multipart text field. Mandatory:
  // the admin variant is explicitly cross-user.
  const targetUserId = uploaded.textFields.userId;
  if (!targetUserId) {
    await auditLog("admin.import-apple-health.kickoff.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason: "missing_user_id" },
    });
    return apiError("Multipart field 'userId' is required", 422);
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true },
  });
  if (!targetUser) {
    await auditLog("admin.import-apple-health.kickoff.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason: "target_user_missing", targetUserId },
    });
    return apiError(
      `Target user '${targetUserId}' does not exist`,
      422,
    );
  }

  // Same content-hash idempotency as the user-facing route, but scoped
  // by the target user — an admin re-uploading the same file for the
  // same user resolves to the previous job.
  const existing = await prisma.importJob.findFirst({
    where: {
      userId: targetUser.id,
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
    await auditLog("admin.import-apple-health.kickoff.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason: "worker_not_running" },
    });
    throw new HttpError(503, "Background worker is not running");
  }

  const importJob = await prisma.importJob.create({
    data: {
      userId: targetUser.id,
      triggeredByAdminId: admin.id,
      status: "queued",
      uploadBytes: uploaded.bytes,
      uploadSha256: uploaded.sha256,
    },
  });

  const payload: AppleHealthImportPayload = {
    userId: targetUser.id,
    triggeredByAdminId: admin.id,
    uploadPath: uploaded.filePath,
    uploadBytes: uploaded.bytes,
    enqueuedAt: new Date().toISOString(),
  };
  const bossJobId = await boss.send(APPLE_HEALTH_IMPORT_QUEUE, payload);

  await prisma.importJob.update({
    where: { id: importJob.id },
    data: { pgBossJobId: bossJobId },
  });

  await auditLog("admin.import-apple-health.kickoff", {
    userId: admin.id,
    ipAddress: getClientIp(request),
    details: {
      jobId: importJob.id,
      bossJobId: bossJobId ?? null,
      targetUserId: targetUser.id,
      targetUsername: targetUser.username,
      uploadBytes: uploaded.bytes,
      uploadSha256: uploaded.sha256,
    },
  });

  return apiSuccess(
    {
      jobId: importJob.id,
      status: "queued" as const,
      targetUserId: targetUser.id,
    },
    202,
  );
});
