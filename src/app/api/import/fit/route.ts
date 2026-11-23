/**
 * `POST /api/import/fit` — upload one activity file (`.fit`, `.fit.gz`, or
 * the ZIP Garmin Connect's "Export original" hands out) for a background
 * import.
 *
 * The shared staged upload (`src/lib/import/staged-upload.ts`): streamed to
 * disk after authentication and refused past the 10 MB cap; an `ImportJob`
 * row (`kind = "fit"`) carries the progress; the `fit-import` queue decodes
 * the file in the worker, never in this request.
 */
import type { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { FIT_UPLOAD_MAX_BYTES } from "@/lib/fit/container";
import { handleStagedUpload } from "@/lib/import/staged-upload";
import { FIT_IMPORT_KIND, FIT_IMPORT_QUEUE } from "@/lib/jobs/fit-import-queue";
import {
  FIT_IMPORT_PARSER_REVISION,
  FIT_IMPORT_SEND_OPTIONS,
  type FitImportPayload,
} from "@/lib/jobs/fit-import-worker";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) =>
  handleStagedUpload(request, {
    action: "import.fit.kickoff",
    maxBytes: FIT_UPLOAD_MAX_BYTES,
    capLabel: "10 MB",
    tmpPrefix: "healthlog-fit-import",
    import: {
      kind: FIT_IMPORT_KIND,
      parserRevision: FIT_IMPORT_PARSER_REVISION,
      queue: FIT_IMPORT_QUEUE,
      sendOptions: FIT_IMPORT_SEND_OPTIONS,
      payload: ({ userId, importJobId, uploadPath }): FitImportPayload => ({
        userId,
        importJobId,
        uploadPath,
      }),
    },
  }),
);
