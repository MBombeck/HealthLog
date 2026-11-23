/**
 * `POST /api/import/gadgetbridge` — upload a Gadgetbridge database export
 * (the SQLite file Gadgetbridge's "Export database" writes) for a background
 * import onto native measurement types (`src/lib/import/gadgetbridge/`).
 *
 * Staged like every file import (`src/lib/import/staged-upload.ts`):
 * streamed to disk after authentication, at most 512 MB, the same bytes
 * resolving to the earlier job, one import per account at a time.
 */
import type { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import {
  GADGETBRIDGE_IMPORT_KIND,
  GADGETBRIDGE_MAX_UPLOAD_BYTES,
} from "@/lib/import/file-import/kinds";
import { recordFileUploadSpec } from "@/lib/import/file-import/upload";
import { handleStagedUpload } from "@/lib/import/staged-upload";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) =>
  handleStagedUpload(
    request,
    recordFileUploadSpec(
      GADGETBRIDGE_IMPORT_KIND,
      GADGETBRIDGE_MAX_UPLOAD_BYTES,
      "512 MB",
    ),
  ),
);
