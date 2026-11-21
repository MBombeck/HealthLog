/**
 * `POST /api/import/fhir-bundle` — upload a FHIR R4 Bundle (JSON) exported
 * from a patient portal for a background import of its lab results, vital
 * signs, conditions, immunizations, medication statements and encounters
 * (`src/lib/import/fhir-bundle/`).
 *
 * Staged like every file import (`src/lib/import/file-import/upload.ts`):
 * streamed to disk after authentication, at most 32 MB, the same bytes
 * resolving to the earlier job, one import per account at a time.
 */
import type { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import {
  FHIR_BUNDLE_IMPORT_KIND,
  FHIR_BUNDLE_MAX_UPLOAD_BYTES,
} from "@/lib/import/file-import/kinds";
import { handleRecordFileUpload } from "@/lib/import/file-import/upload";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) =>
  handleRecordFileUpload(request, {
    kind: FHIR_BUNDLE_IMPORT_KIND,
    maxBytes: FHIR_BUNDLE_MAX_UPLOAD_BYTES,
    capLabel: "32 MB",
  }),
);
