import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import {
  validateMeasurementRange,
  measurementTypeEnum,
  glucoseContextEnum,
} from "@/lib/validations/measurement";

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
    return apiSuccess({ error: parsed.error.issues[0].message }, 422);
  }

  const userId = user.id;
  const data = parsed.data;
  const stats = { measurements: 0, moodEntries: 0, skipped: 0 };

  // Import measurements
  if (data.measurements?.length) {
    for (const m of data.measurements) {
      try {
        await prisma.measurement.create({
          data: {
            userId,
            type: m.type,
            value: m.value,
            unit: m.unit,
            source: "IMPORT",
            measuredAt: new Date(m.measuredAt),
            notes: m.notes || null,
            glucoseContext: m.glucoseContext ?? null,
          },
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

  await auditLog("import.upload", {
    userId,
    ipAddress: getClientIp(request),
    details: stats,
  });

  annotate({ meta: { import_stats: stats } });

  return apiSuccess(stats);
});
