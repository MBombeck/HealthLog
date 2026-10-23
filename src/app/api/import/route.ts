/**
 * `POST /api/import` — import user data (JSON format matching the export
 * structure). The route authenticates, meters and parses the file; the
 * writers live in `src/lib/import/json/`. The app's own full backup and JSON
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
import { z } from "zod/v4";

import {
  validateMeasurementRange,
  measurementTypeEnum,
  glucoseContextEnum,
} from "@/lib/validations/measurement";
import {
  isPlausibleEntryInstant,
  validateEntryInstant,
} from "@/lib/validations/entry-instant";
import { isoDateTime } from "@/lib/validations/datetime";
import { fallbackMoodDateStart } from "@/lib/import/json/mood";
import { normalizeJsonImportFile } from "@/lib/import/json/normalize";
import { runJsonImport } from "@/lib/import/json/run";

// Derived from canonical enum so round-trip export → import covers every
// type. Previous hardcoded subset silently dropped 4 of 11 types
// (V3 audit: enum drift cousins).
const measurementSchema = z
  .object({
    type: measurementTypeEnum,
    value: z.number(),
    unit: z.string(),
    // v1.17.1 — share the canonical entry-instant bound used by the single
    // POST + edit paths (v1.17 W1b). Previously a bare datetime check
    // with no ceiling, so a crafted JSON import could forward-date a reading.
    // `validateEntryInstant` rejects any future instant beyond a 5-min skew
    // tolerance and any instant before 1900; the field transforms to a `Date`.
    measuredAt: validateEntryInstant(
      isoDateTime().transform((s) => new Date(s)),
    ),
    glucoseContext: glucoseContextEnum.optional(),
    source: z.string().optional(),
    notes: z.string().optional(),
    // v1.17.1 — optional source-stable id. When present, the import upserts on
    // `(userId, type, source=IMPORT, externalId)` so a re-import of the same
    // export is idempotent rather than minting a duplicate set — mirrors the
    // mood path. Absent → first-write-wins create with a NULL externalId
    // (distinct in the unique key), which DOES duplicate on re-import.
    // Stability is enforced per entry in the import loop, not at the
    // field: a schema-level refusal would fail the whole file on one bad
    // row.
    // @external-id-checked-per-entry: src/lib/import/json/measurements.ts
    externalId: z.string().min(1).max(120).optional(),
  })
  .refine(
    (data) => validateMeasurementRange(data.type, data.value) === null,
    "Wert ausserhalb des plausiblen Bereichs",
  );

const moodEntrySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    mood: z.enum(["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"]),
    score: z.number().int().min(1).max(5),
    tags: z.string().optional(),
    // v1.17.1 — same entry-instant bound as measurements; an imported mood
    // log cannot be forward-dated. Optional + transforms to a `Date` when set.
    loggedAt: validateEntryInstant(
      isoDateTime().transform((s) => new Date(s)),
    ).optional(),
    // v1.12.1 — optional source-stable id (e.g. a Daylio row id). When
    // present, the import upserts on `(userId, source, externalId)` so a
    // re-import of the same export is idempotent rather than minting a
    // duplicate; absent → the legacy first-write-wins create path.
    // Stability is enforced per entry in the import loop, not at the
    // field: a schema-level refusal would fail the whole file on one bad
    // row.
    // @external-id-checked-per-entry: src/lib/import/json/mood.ts
    externalId: z.string().min(1).max(120).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.loggedAt) return;
    const dateStart = fallbackMoodDateStart(entry.date);
    if (!dateStart || !isPlausibleEntryInstant(dateStart)) {
      ctx.addIssue({
        code: "custom",
        path: ["date"],
        message: "Mood date must be between 1900 and today",
      });
    }
  });

const importSchema = z.object({
  measurements: z.array(measurementSchema).max(10000).optional(),
  moodEntries: z.array(moodEntrySchema).max(10000).optional(),
});

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
    maxBytes: 16 * 1024 * 1024,
  });

  if (jsonError) return jsonError;
  const normalized = normalizeJsonImportFile(body);
  const parsed = importSchema.safeParse(normalized.file);
  if (!parsed.success) {
    return apiValidationError(
      parsed.error.issues[0]?.message ?? "Invalid import payload",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }

  const { stats: written, writeFailed } = await runJsonImport({
    userId: user.id,
    measurements: parsed.data.measurements,
    moodEntries: parsed.data.moodEntries,
    ipAddress: getClientIp(request),
  });
  const stats = { ...written, skipped: written.skipped + normalized.skipped };

  if (writeFailed) {
    return apiError("Import write failed", 503, {
      errorCode: "import.write_failed",
      retryable: true,
      stats,
    });
  }

  return apiSuccess(stats);
});
