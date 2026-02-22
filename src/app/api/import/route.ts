import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const measurementSchema = z.object({
  type: z.enum([
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "PULSE",
    "BODY_FAT",
    "SLEEP_DURATION",
    "ACTIVITY_STEPS",
  ]),
  value: z.number(),
  unit: z.string(),
  measuredAt: z.string().datetime(),
  source: z.string().optional(),
  notes: z.string().optional(),
});

const moodEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mood: z.enum(["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"]),
  score: z.number().int().min(1).max(5),
  tags: z.string().optional(),
  loggedAt: z.string().datetime().optional(),
});

const importSchema = z.object({
  measurements: z.array(measurementSchema).optional(),
  moodEntries: z.array(moodEntrySchema).optional(),
});

/**
 * Import user data (JSON format matching export structure).
 * Deduplicates via unique constraints — existing records are skipped.
 */
export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    const body = await request.json();
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const userId = sessionData.user.id;
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

    return apiSuccess(stats);
  } catch (err) {
    console.error("Import error:", err);
    return apiError("Import fehlgeschlagen", 500);
  }
}
