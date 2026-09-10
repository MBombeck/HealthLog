import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
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
import { createHash } from "node:crypto";

import {
  validateMeasurementRange,
  measurementTypeEnum,
  glucoseContextEnum,
} from "@/lib/validations/measurement";
import {
  ENTRY_INSTANT_CLOCK_SKEW_MS,
  isPlausibleEntryInstant,
  validateEntryInstant,
} from "@/lib/validations/entry-instant";
import {
  classifyExternalId,
  unstableExternalIdMeta,
  type UnstableExternalIdShape,
} from "@/lib/validations/external-id";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { recomputeUserMoodRollups } from "@/lib/rollups/mood-rollups";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import type { MeasurementType } from "@/generated/prisma/client";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { isP2002, isP2025 } from "@/lib/prisma-errors";
import { DEFAULT_TIMEZONE, moodDateKey } from "@/lib/mood/date-key";
import { deriveA1 } from "@/lib/mood/level-a";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";

// Derived from canonical enum so round-trip export → import covers every
// type. Previous hardcoded subset silently dropped 4 of 11 types
// (V3 audit: enum drift cousins).
const measurementSchema = z
  .object({
    type: measurementTypeEnum,
    value: z.number(),
    unit: z.string(),
    // v1.17.1 — share the canonical entry-instant bound used by the single
    // POST + edit paths (v1.17 W1b). Previously a bare `z.string().datetime()`
    // with no ceiling, so a crafted JSON import could forward-date a reading.
    // `validateEntryInstant` rejects any future instant beyond a 5-min skew
    // tolerance and any instant before 1900; the field transforms to a `Date`.
    measuredAt: validateEntryInstant(
      z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
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
    // @external-id-checked-per-entry: src/app/api/import/route.ts
    externalId: z.string().min(1).max(120).optional(),
  })
  .refine(
    (data) => validateMeasurementRange(data.type, data.value) === null,
    "Wert ausserhalb des plausiblen Bereichs",
  );

function fallbackMoodDateStart(date: string): Date | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  const instant = zonedWallClockToUtc(
    { year, month, day, hour: 0, minute: 0 },
    DEFAULT_TIMEZONE,
  );
  return moodDateKey(instant, DEFAULT_TIMEZONE) === date ? instant : null;
}

const moodEntrySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    mood: z.enum(["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"]),
    score: z.number().int().min(1).max(5),
    tags: z.string().optional(),
    // v1.17.1 — same entry-instant bound as measurements; an imported mood
    // log cannot be forward-dated. Optional + transforms to a `Date` when set.
    loggedAt: validateEntryInstant(
      z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
    ).optional(),
    // v1.12.1 — optional source-stable id (e.g. a Daylio row id). When
    // present, the import upserts on `(userId, source, externalId)` so a
    // re-import of the same export is idempotent rather than minting a
    // duplicate; absent → the legacy first-write-wins create path.
    // Stability is enforced per entry in the import loop, not at the
    // field: a schema-level refusal would fail the whole file on one bad
    // row.
    // @external-id-checked-per-entry: src/app/api/import/route.ts
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

type MoodEntryInput = z.infer<typeof moodEntrySchema>;

function fallbackMoodIdentity(entry: MoodEntryInput): string {
  return JSON.stringify([
    entry.date,
    entry.mood,
    entry.score,
    entry.tags ?? null,
    entry.externalId ?? null,
  ]);
}

function stableFallbackMoodInstant(
  entry: MoodEntryInput,
  occurrence: number,
  probe: number,
): Date {
  const digest = createHash("sha256")
    .update(`${fallbackMoodIdentity(entry)}:${occurrence}`)
    .digest();
  const initialOffset = digest.readUInt32BE(0) % ENTRY_INSTANT_CLOCK_SKEW_MS;
  const offset = (initialOffset + probe) % ENTRY_INSTANT_CLOCK_SKEW_MS;
  const dateStart = fallbackMoodDateStart(entry.date);
  if (!dateStart) throw new Error("Invalid mood date");
  return new Date(dateStart.getTime() + offset);
}

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

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(
      parsed.error.issues[0]?.message ?? "Invalid import payload",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }

  const userId = user.id;
  const data = parsed.data;
  const stats = { measurements: 0, moodEntries: 0, skipped: 0 };
  const unstableShapes: UnstableExternalIdShape[] = [];
  let writeFailed = false;

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
  const insertedMeasurements: Array<{
    id: string;
    type: MeasurementType;
    measuredAt: Date;
  }> = [];
  if (data.measurements?.length) {
    for (const m of data.measurements) {
      // The `(userId, type, source, externalId)` upsert key is only
      // idempotent while the id is STABLE; an id that rotates between
      // exports re-imports as a fresh row every time. Skipped per entry,
      // like every other rejected row in this importer.
      const unstable =
        m.externalId === undefined ? null : classifyExternalId(m.externalId);
      if (unstable) {
        unstableShapes.push(unstable);
        stats.skipped++;
        continue;
      }
      try {
        // `measuredAt` is already a `Date` (validateEntryInstant transform).
        const measuredAt = m.measuredAt;
        if (m.externalId) {
          const notesEncrypted = encryptNote(m.notes || null);
          // INSERT ... RETURNING is the only insertion proof. A concurrent
          // importer can win this key after any existence probe, so attempt
          // the insert first and update only when the statement returns no row.
          const created = await prisma.measurement.createManyAndReturn({
            data: [
              {
                userId,
                type: m.type,
                value: m.value,
                unit: m.unit,
                source: "IMPORT",
                externalId: m.externalId,
                measuredAt,
                notes: null,
                notesEncrypted,
                glucoseContext: m.glucoseContext ?? null,
              },
            ],
            skipDuplicates: true,
            select: { id: true, type: true, measuredAt: true },
          });
          const inserted = created[0];
          if (inserted) {
            insertedMeasurements.push(inserted);
          } else {
            // A pre-existing row or a raced insert owns the key. Preserve
            // idempotent re-import semantics without classifying this update
            // as an arrival.
            try {
              await prisma.measurement.update({
                where: {
                  userId_type_source_externalId: {
                    userId,
                    type: m.type,
                    source: "IMPORT",
                    externalId: m.externalId,
                  },
                },
                data: {
                  value: m.value,
                  unit: m.unit,
                  measuredAt,
                  notes: null,
                  notesEncrypted,
                  glucoseContext: m.glucoseContext ?? null,
                },
              });
            } catch (err) {
              if (isP2025(err)) {
                stats.skipped++;
                continue;
              }
              throw err;
            }
          }
        } else {
          const inserted = await prisma.measurement.create({
            data: {
              userId,
              type: m.type,
              value: m.value,
              unit: m.unit,
              source: "IMPORT",
              measuredAt,
              notes: null,
              notesEncrypted: encryptNote(m.notes || null),
              glucoseContext: m.glucoseContext ?? null,
            },
            select: { id: true, type: true, measuredAt: true },
          });
          insertedMeasurements.push(inserted);
        }
        touchedMeasurements.push({
          type: m.type as MeasurementType,
          measuredAt,
        });
        stats.measurements++;
      } catch (err) {
        if (isP2002(err)) {
          stats.skipped++;
          continue;
        }
        writeFailed = true;
        break;
      }
    }
  }

  void emitInsertedMeasurementArrivals(
    userId,
    insertedMeasurements,
    "json_import",
  ).catch(() => {});
  void maybeEnqueueMorningRefresh(
    userId,
    insertedMeasurements
      .filter((row) => row.type === "SLEEP_DURATION")
      .map((row) => row.measuredAt),
  ).catch(() => {});

  // Import mood entries
  if (!writeFailed && data.moodEntries?.length) {
    const fallbackOccurrences = new Map<string, number>();
    const reservedFallbackInstants = new Set<number>();
    for (const e of data.moodEntries) {
      // Same stability floor as the measurement loop above — the mood
      // upsert keys on `(userId, source, externalId)`.
      const unstableMood =
        e.externalId === undefined ? null : classifyExternalId(e.externalId);
      if (unstableMood) {
        unstableShapes.push(unstableMood);
        stats.skipped++;
        continue;
      }
      const identity = e.loggedAt ? null : fallbackMoodIdentity(e);
      const occurrence =
        identity === null ? 0 : (fallbackOccurrences.get(identity) ?? 0);
      if (identity !== null) {
        fallbackOccurrences.set(identity, occurrence + 1);
      }

      for (let probe = 0; probe < ENTRY_INSTANT_CLOCK_SKEW_MS; probe++) {
        const loggedAt =
          e.loggedAt ?? stableFallbackMoodInstant(e, occurrence, probe);
        if (!e.loggedAt && reservedFallbackInstants.has(loggedAt.getTime())) {
          continue;
        }
        try {
          if (e.externalId) {
            // v1.12.1 — idempotent re-import keyed on the source-stable id.
            // A second import of the same export updates the row in place
            // rather than skipping it as a duplicate, so an upstream edit
            // (re-scored mood, added tag) is reflected.
            await prisma.moodEntry.upsert({
              where: {
                userId_source_externalId: {
                  userId,
                  source: "IMPORT",
                  externalId: e.externalId,
                },
              },
              update: {
                date: e.date,
                mood: e.mood,
                score: e.score,
                // v1.37 — pleasantness derived from the row's own label, not
                // from the file's `score`. This is the one writer whose score
                // comes out of the file rather than out of the label, so the
                // two can disagree; the column that records a self-assessment
                // has to agree with the label the user actually picked.
                moodA1: deriveA1(e.mood),
                tags: e.tags || null,
                moodLoggedAt: loggedAt,
              },
              create: {
                userId,
                date: e.date,
                mood: e.mood,
                score: e.score,
                moodA1: deriveA1(e.mood),
                tags: e.tags || null,
                source: "IMPORT",
                externalId: e.externalId,
                moodLoggedAt: loggedAt,
              },
            });
          } else {
            await prisma.moodEntry.create({
              data: {
                userId,
                date: e.date,
                mood: e.mood,
                score: e.score,
                // See the upsert arm above: derived from the label, because
                // an imported file's `score` is its own field.
                moodA1: deriveA1(e.mood),
                tags: e.tags || null,
                source: "IMPORT",
                moodLoggedAt: loggedAt,
              },
            });
          }
          if (!e.loggedAt) {
            reservedFallbackInstants.add(loggedAt.getTime());
          }
          stats.moodEntries++;
          break;
        } catch (err) {
          if (!isP2002(err)) {
            writeFailed = true;
            break;
          }
          if (e.loggedAt) {
            stats.skipped++;
            break;
          }
          if (!e.externalId) {
            try {
              const existing = await prisma.moodEntry.findUnique({
                where: {
                  userId_date_moodLoggedAt: {
                    userId,
                    date: e.date,
                    moodLoggedAt: loggedAt,
                  },
                },
                select: {
                  source: true,
                  mood: true,
                  score: true,
                  tags: true,
                  externalId: true,
                },
              });
              if (
                existing?.source === "IMPORT" &&
                existing.mood === e.mood &&
                existing.score === e.score &&
                existing.tags === (e.tags || null) &&
                (existing.externalId ?? null) === null
              ) {
                reservedFallbackInstants.add(loggedAt.getTime());
                stats.skipped++;
                break;
              }
            } catch {
              writeFailed = true;
              break;
            }
          }
          if (probe === ENTRY_INSTANT_CLOCK_SKEW_MS - 1) {
            writeFailed = true;
          }
        }
      }
      if (writeFailed) break;
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

  annotate({
    meta: {
      import_stats: stats,
      ...(unstableShapes.length > 0
        ? unstableExternalIdMeta("import.json", unstableShapes)
        : {}),
    },
  });

  try {
    await auditLog("import.upload", {
      userId,
      ipAddress: getClientIp(request),
      details: stats,
    });
  } catch (err) {
    if (!writeFailed) throw err;
    annotate({ meta: { import_audit_failed: true } });
  }

  if (writeFailed) {
    return apiError("Import write failed", 503, {
      errorCode: "import.write_failed",
      retryable: true,
      stats,
    });
  }

  return apiSuccess(stats);
});
