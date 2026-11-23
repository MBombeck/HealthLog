/**
 * The Apple Health import as a staged import (`./staged-upload.ts`), shared
 * by the owner's upload (`POST /api/import/apple-health-export`) and the
 * admin variant (`POST /api/admin/import-apple-health-export`).
 */
import type { StagedImportSpec } from "@/lib/import/staged-upload";
import { APPLE_HEALTH_IMPORT_V2_QUEUE } from "@/lib/jobs/apple-health-import-queue";
import {
  APPLE_HEALTH_IMPORT_KIND,
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  APPLE_HEALTH_IMPORT_SEND_OPTIONS,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";

/**
 * Hard cap on the upload. Apple's largest observed exports sit around
 * 800 MB for a 10-year iCloud-synced account; 1.5 GB leaves comfortable
 * margin for the long tail.
 */
export const APPLE_HEALTH_MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024 * 1024;
export const APPLE_HEALTH_CAP_LABEL = "1.5 GB";

export const APPLE_HEALTH_STAGED_IMPORT: StagedImportSpec = {
  kind: APPLE_HEALTH_IMPORT_KIND,
  parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
  queue: APPLE_HEALTH_IMPORT_V2_QUEUE,
  // No retries and a wide expiry: the first run consumes the staged upload,
  // so a redelivery could only fail on the deleted file and mask the real
  // outcome (see the worker's send-options doc).
  sendOptions: APPLE_HEALTH_IMPORT_SEND_OPTIONS,
  payload: (job): AppleHealthImportPayload => ({
    userId: job.userId,
    ...(job.triggeredByAdminId
      ? { triggeredByAdminId: job.triggeredByAdminId }
      : {}),
    uploadPath: job.uploadPath,
    uploadBytes: job.uploadBytes,
    enqueuedAt: new Date().toISOString(),
  }),
};
