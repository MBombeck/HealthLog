/**
 * `POST /api/import/apple-health-export` — user-facing kick-off for an
 * Apple Health `export.zip` import.
 *
 * The shared staged upload (`src/lib/import/staged-upload.ts`): the body is
 * streamed to disk without buffering, an `ImportJob` row is created in
 * `queued`, and an `apple-health-import-v2` job is enqueued. Returns
 * `{ jobId }` so the client can poll
 * `GET /api/import/apple-health-export/[jobId]/status`.
 *
 * Idempotency is by content: the iOS client cannot emit a stable
 * `Idempotency-Key` for a 1 GB file, so a re-upload of the same bytes
 * resolves to the still-viable job. A prior `failed` job is not matched, so
 * the same export can always be retried (issue #486).
 */
import type { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import {
  APPLE_HEALTH_CAP_LABEL,
  APPLE_HEALTH_MAX_UPLOAD_BYTES,
  APPLE_HEALTH_STAGED_IMPORT,
} from "@/lib/import/apple-health-upload";
import { handleStagedUpload } from "@/lib/import/staged-upload";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) =>
  handleStagedUpload(request, {
    action: "import.apple-health.kickoff",
    maxBytes: APPLE_HEALTH_MAX_UPLOAD_BYTES,
    capLabel: APPLE_HEALTH_CAP_LABEL,
    tmpPrefix: "healthlog-apple-health-import",
    import: APPLE_HEALTH_STAGED_IMPORT,
  }),
);
