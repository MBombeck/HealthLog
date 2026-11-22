/**
 * `POST /api/import/health-connect-export` — upload an Android Health Connect
 * export ZIP for background import (v1.42, #972).
 *
 * The shared staged upload (`src/lib/import/staged-upload.ts`): streamed to
 * disk after authentication, hashed on the way, refused past the 1 GiB cap
 * and handed to the `health-connect-import` queue, the same hand-off the
 * scheduled folder fetch uses.
 */
import type { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { HEALTH_CONNECT_STAGED_IMPORT } from "@/lib/import/health-connect/queue-staged";
import { handleStagedUpload } from "@/lib/import/staged-upload";

export const dynamic = "force-dynamic";

/**
 * Hard cap on the upload. The ZIP holds one SQLite file that compresses to
 * about half; a multi-year export with minute-by-minute heart rate sits in
 * the low hundreds of megabytes, and 1 GiB leaves room for the long tail.
 */
const HEALTH_CONNECT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export const POST = apiHandler(async (request: NextRequest) =>
  handleStagedUpload(request, {
    action: "import.health-connect.kickoff",
    maxBytes: HEALTH_CONNECT_MAX_UPLOAD_BYTES,
    capLabel: "1 GB",
    tmpPrefix: "healthlog-health-connect-import",
    import: HEALTH_CONNECT_STAGED_IMPORT,
  }),
);
