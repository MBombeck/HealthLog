/**
 * `POST /api/import` — import user data (JSON format matching the export
 * structure). The route authenticates, meters and parses the file; the
 * schema and the writers live in `src/lib/import/json/`. The app's own full backup and JSON
 * export are read in their own terms first (`normalizeJsonImportFile`).
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";

import { droppedLinkKeysForWire } from "@/lib/mood/tag-links";
import { normalizeJsonImportFile } from "@/lib/import/json/normalize";
import { runJsonImport } from "@/lib/import/json/run";
import {
  JSON_IMPORT_MAX_BYTES,
  jsonImportSchema,
} from "@/lib/import/json/schema";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.upload" } });

  // V3 audit: bulk-injection vector unchecked. 5/hour matches the export
  // limit (10/hour) but is tighter because import writes have a higher
  // blast radius (DB writes vs. read-only export).
  const rl = await checkRateLimit(`import:${user.id}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 5 imports per hour", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: JSON_IMPORT_MAX_BYTES,
  });

  if (jsonError) return jsonError;
  const normalized = normalizeJsonImportFile(body);
  const parsed = jsonImportSchema.safeParse(normalized.file);
  if (!parsed.success) {
    return apiValidationError(
      parsed.error.issues[0]?.message ?? "Invalid import payload",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }

  const {
    stats: written,
    writeFailed,
    droppedLinkKeys,
    keptMoodTagKeys,
    keptMoodCategoryKeys,
  } = await runJsonImport({
    userId: user.id,
    measurements: parsed.data.measurements,
    moodEntries: parsed.data.moodEntries,
    customMoodTagCategories: parsed.data.customMoodTagCategories,
    customMoodTags: parsed.data.customMoodTags,
    ipAddress: getClientIp(request),
  });
  const stats = {
    ...written,
    skipped: written.skipped + normalized.skipped,
    // The mood links the account could not resolve, by key, only when there
    // are any: "imported" alone told the person their tags had landed.
    ...droppedLinkKeysForWire(droppedLinkKeys),
    // The account's own tags and groups the file names differently: kept as
    // they are, and said so, only when there are any.
    ...(keptMoodTagKeys.length > 0 ? { keptMoodTagKeys } : {}),
    ...(keptMoodCategoryKeys.length > 0 ? { keptMoodCategoryKeys } : {}),
  };

  if (writeFailed) {
    return apiError("Import write failed", 503, {
      errorCode: "import.write_failed",
      retryable: true,
      stats,
    });
  }

  return apiSuccess(stats);
});
