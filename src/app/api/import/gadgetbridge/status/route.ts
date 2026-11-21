/**
 * `GET /api/import/gadgetbridge/status` — the caller's most recent
 * Gadgetbridge import, or `null`. Counts and closed reasons only.
 */
import { apiHandler } from "@/lib/api-handler";
import { GADGETBRIDGE_IMPORT_KIND } from "@/lib/import/file-import/kinds";
import { recordFileImportStatus } from "@/lib/import/file-import/upload";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () =>
  recordFileImportStatus(GADGETBRIDGE_IMPORT_KIND),
);
