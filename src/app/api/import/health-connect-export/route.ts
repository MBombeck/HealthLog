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
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { emitSignal } from "@/lib/logging/signal";
import { checkRateLimit } from "@/lib/rate-limit";
import { streamMultipartToDisk } from "@/lib/multipart/stream-to-disk";
import {
  IMPORT_BUSY_CODE,
  IMPORT_BUSY_MESSAGE,
} from "@/lib/import/apple-health-staging";
import { queueStagedHealthConnectImport } from "@/lib/import/health-connect/queue-staged";

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
    emitSignal({
      action: "import.health-connect.kickoff.denied",
      level: "warn",
      meta: {
        reason: "content_length_exceeded",
        content_length: declaredBytes,
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
    emitSignal({
      action: "import.health-connect.kickoff.denied",
      level: "warn",
      meta: { reason: "stream_to_disk_failed" },
    });
    return apiError(`Multipart upload failed: ${message}`, 422);
  }

  const queued = await queueStagedHealthConnectImport({
    userId: user.id,
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
      emitSignal({
        action: "import.health-connect.kickoff.denied",
        level: "warn",
        meta: { reason: "worker_not_running" },
      });
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

  await auditLog("import.health-connect.kickoff", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      jobId: queued.jobId,
      uploadBytes: uploaded.bytes,
      uploadSha256: uploaded.sha256,
    },
  });

  return apiSuccess({ jobId: queued.jobId, status: "queued" as const }, 202);
});
