/**
 * `GET /api/import/fhir-bundle/status` — the caller's most recent FHIR
 * Bundle import, or `null`. Counts and closed reasons only.
 */
import { apiHandler } from "@/lib/api-handler";
import { FHIR_BUNDLE_IMPORT_KIND } from "@/lib/import/file-import/kinds";
import { recordFileImportStatus } from "@/lib/import/file-import/upload";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () =>
  recordFileImportStatus(FHIR_BUNDLE_IMPORT_KIND),
);
