import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import {
  validateMeasurementRange,
  measurementTypeEnum,
  glucoseContextEnum,
} from "@/lib/validations/measurement";
import { recomputeUserMoodRollups } from "@/lib/rollups/mood-rollups";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import type { MeasurementType } from "@/generated/prisma/client";

// Derived from canonical enum so round-trip export → import covers every
// type. Previous hardcoded subset silently dropped 4 of 11 types
// (V3 audit: enum drift cousins).
const measurementSchema = z
  .object({
    type: measurementTypeEnum,
    value: z.number(),
    unit: z.string(),
    measuredAt: z.string().datetime(),
    glucoseContext: glucoseContextEnum.optional(),
    source: z.string().optional(),
    notes: z.string().optional(),
  })
  .refine(
    (data) => validateMeasurementRange(data.type, data.value) === null,
    "Wert ausserhalb des plausiblen Bereichs",
  );

const moodEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mood: z.enum(["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"]),
  score: z.number().int().min(1).max(5),
  tags: z.string().optional(),
  loggedAt: z.string().datetime().optional(),
});

const importSchema = z.object({
  measurements: z.array(measurementSchema).max(10000).optional(),
  moodEntries: z.array(moodEntrySchema).max(10000).optional(),
});

/**
 * Import user data (JSON format matching export structure).
 * Deduplicates via unique constraints — existing records are skipped.
 */
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

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      parsed.error.issues[0]?.message ?? "Invalid import payload",
      422,
    );
  }

  const userId = user.id;
  const data = parsed.data;
  const stats = { measurements: 0, moodEntries: 0, skipped: 0 };

  // Import measurements
  // v1.4.39.1 — track each (type, measuredAt) we wrote so we can re-
  // fold the persistent rollup tier at the end. Pre-fix, the import
  // path bypassed the rollup write hook entirely, so a CSV / JSON
  // restore left the user's `source=rollup` chart paths under-counting
  // the imported days until the next worker boot re-ran the backfill.
  const touchedMeasurements: Array<{
    type: MeasurementType;
    measuredAt: Date;
  }> = [];
  if (data.measurements?.length) {
    for (const m of data.measurements) {
      try {
        const measuredAt = new Date(m.measuredAt);
        await prisma.measurement.create({
          data: {
            userId,
            type: m.type,
            value: m.value,
            unit: m.unit,
            source: "IMPORT",
            measuredAt,
            notes: m.notes || null,
            glucoseContext: m.glucoseContext ?? null,
          },
        });
        touchedMeasurements.push({
          type: m.type as MeasurementType,
          measuredAt,
        });
        stats.measurements++;
      } catch {
        // Unique constraint violation — skip duplicate
        stats.skipped++;
      }
    }
  }

  // Import mood entries
  if (data.moodEntries?.length) {
    for (const e of data.moodEntries) {
      try {
        const loggedAt = e.loggedAt ? new Date(e.loggedAt) : new Date();
        await prisma.moodEntry.create({
          data: {
            userId,
            date: e.date,
            mood: e.mood,
            score: e.score,
            tags: e.tags || null,
            source: "IMPORT",
            moodLoggedAt: loggedAt,
          },
        });
        stats.moodEntries++;
      } catch {
        // Unique constraint violation — skip duplicate
        stats.skipped++;
      }
    }
  }

  // v1.4.39 W-MOOD — one bounded re-fold per import is cheaper than
  // firing N per-row hooks. The mood rollup tier is keyed on the
  // user + day; the fold materialises every touched day from the
  // entries we just wrote. Best-effort: an importer hiccup must not
  // surface as a 5xx, the rollup is a cache tier.
  if (stats.moodEntries > 0) {
    try {
      await recomputeUserMoodRollups(userId, { granularities: ["DAY"] });
    } catch (err) {
      annotate({
        meta: {
          mood_rollup_import_failed: true,
          mood_rollup_import_error:
            err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // v1.4.39.1 — refresh the persistent measurement rollup table for
  // every distinct (type, day) the import touched. Collapsed so a
  // 10 000-row CSV restore pays at most ~N (type, day) recomputes
  // rather than 10 000 per-row hooks. Best-effort: a populator hiccup
  // never fails the importer.
  if (touchedMeasurements.length > 0) {
    try {
      const keys = collapseToTypeDayKeys(touchedMeasurements);
      for (const k of keys) {
        await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
      }
    } catch (err) {
      annotate({
        meta: {
          measurement_rollup_import_failed: true,
          measurement_rollup_import_error:
            err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  await auditLog("import.upload", {
    userId,
    ipAddress: getClientIp(request),
    details: stats,
  });

  annotate({ meta: { import_stats: stats } });

  return apiSuccess(stats);
});
