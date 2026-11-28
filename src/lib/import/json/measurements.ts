/**
 * The measurement rows of a JSON import (`POST /api/import`).
 *
 * The route's schema has already bounded each row (plausible range, entry
 * instant). With an external id a row is inserted or, when the key is taken,
 * updated in place, so a re-import of the same export is idempotent; without
 * one it is a first-write-wins create with a NULL external id. The natural
 * key `(userId, type, measuredAt, source=IMPORT, sleepStage)` (NULLS NOT
 * DISTINCT) turns a second pass of the same file into skips, and a row the
 * account already holds from another source, same type, instant, value and
 * stage, is skipped too: the file is the account's own export coming back.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { classifyExternalId } from "@/lib/validations/external-id";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { isP2002, isP2025 } from "@/lib/prisma-errors";
import { isStorableTimeZone } from "@/lib/tz/reading-zone";
import { zonesKnownToPostgres } from "@/lib/tz/reading-zone-sql";

import type { JsonImportMeasurement } from "./schema";
import type { JsonImportTally } from "./tally";

export type { JsonImportMeasurement } from "./schema";

/**
 * A reading's own columns beyond its value: what the reading says, carried
 * whole so a range keeps its bounds, a sleep row its stage and an ECG its
 * verdict. Every arm of the write states them, so a re-import of the same
 * file puts back what an edit in between changed. A zone the server cannot
 * read is stored as null, as the batch route stores it.
 */
function readingColumns(
  m: JsonImportMeasurement,
  storableZones: ReadonlySet<string>,
) {
  return {
    value: m.value,
    valueMin: m.valueMin ?? null,
    valueMax: m.valueMax ?? null,
    unit: m.unit,
    measuredAt: m.measuredAt,
    glucoseContext: m.glucoseContext ?? null,
    sleepStage: m.sleepStage ?? null,
    rhythmClassification: m.rhythmClassification ?? null,
    deviceType: m.deviceType ?? null,
    timeZone:
      m.timeZone !== undefined && storableZones.has(m.timeZone)
        ? m.timeZone
        : null,
    notes: null,
    notesEncrypted: encryptNote(m.notes || null),
  };
}

/** Instants per lookup: well under Postgres's bind-parameter cap. */
const LOOKUP_CHUNK = 1_000;

function readingKey(r: {
  type: string;
  measuredAt: Date;
  value: number;
  sleepStage?: string | null;
}): string {
  return `${r.type}|${r.measuredAt.getTime()}|${r.value}|${r.sleepStage ?? ""}`;
}

/**
 * The readings the account already holds under another source that a row
 * without an external id would repeat. Importing an account's own export
 * back into it wrote every manual and synced reading a second time, as an
 * IMPORT copy beside the original, because the natural key includes the
 * source.
 */
async function heldElsewhere(
  userId: string,
  rows: JsonImportMeasurement[],
): Promise<Set<string>> {
  const held = new Set<string>();
  const byType = new Map<string, Date[]>();
  for (const m of rows) {
    if (m.externalId !== undefined) continue;
    const list = byType.get(m.type) ?? [];
    list.push(m.measuredAt);
    byType.set(m.type, list);
  }
  for (const [type, instants] of byType) {
    for (let i = 0; i < instants.length; i += LOOKUP_CHUNK) {
      const found = await prisma.measurement.findMany({
        where: {
          userId,
          type: type as MeasurementType,
          source: { not: "IMPORT" },
          deletedAt: null,
          measuredAt: { in: instants.slice(i, i + LOOKUP_CHUNK) },
        },
        select: { type: true, measuredAt: true, value: true, sleepStage: true },
      });
      for (const row of found) held.add(readingKey(row));
    }
  }
  return held;
}

export interface ImportedMeasurements {
  /**
   * Each `(type, measuredAt)` written, so the persistent rollup tier is
   * re-folded at the end. The import path once bypassed the rollup write
   * hook entirely, so a restore left the `source=rollup` chart paths
   * under-counting the imported days until the next worker boot re-ran the
   * backfill.
   */
  touched: Array<{ type: MeasurementType; measuredAt: Date }>;
  /** The rows this import inserted (not the ones it updated in place). */
  inserted: Array<{ id: string; type: MeasurementType; measuredAt: Date }>;
}

/**
 * Write `rows` for `userId`, counting into `tally`. Stops at the first
 * write that fails for any reason other than a duplicate, and marks the
 * tally failed.
 */
export async function importJsonMeasurements(
  userId: string,
  rows: JsonImportMeasurement[],
  tally: JsonImportTally,
): Promise<ImportedMeasurements> {
  const touched: ImportedMeasurements["touched"] = [];
  const inserted: ImportedMeasurements["inserted"] = [];
  // Checked against Postgres too: the SQL readers hand the zone to
  // `AT TIME ZONE`, which refuses a name only the runtime knows.
  const storableZones = await zonesKnownToPostgres(prisma, [
    ...new Set(
      rows.flatMap((m) =>
        m.timeZone !== undefined && isStorableTimeZone(m.timeZone)
          ? [m.timeZone]
          : [],
      ),
    ),
  ]);
  const held = await heldElsewhere(userId, rows);
  for (const m of rows) {
    if (m.externalId === undefined && held.has(readingKey(m))) {
      tally.stats.skipped++;
      continue;
    }
    // The `(userId, type, source, externalId)` upsert key is only
    // idempotent while the id is STABLE; an id that rotates between
    // exports re-imports as a fresh row every time. Skipped per entry,
    // like every other rejected row in this importer.
    const unstable =
      m.externalId === undefined ? null : classifyExternalId(m.externalId);
    if (unstable) {
      tally.unstableShapes.push(unstable);
      tally.stats.skipped++;
      continue;
    }
    try {
      // `measuredAt` is already a `Date` (validateEntryInstant transform).
      const measuredAt = m.measuredAt;
      const columns = readingColumns(m, storableZones);
      if (m.externalId) {
        // INSERT ... RETURNING is the only insertion proof. A concurrent
        // importer can win this key after any existence probe, so attempt
        // the insert first and update only when the statement returns no row.
        const created = await prisma.measurement.createManyAndReturn({
          data: [
            {
              userId,
              type: m.type,
              source: "IMPORT",
              externalId: m.externalId,
              ...columns,
            },
          ],
          skipDuplicates: true,
          select: { id: true, type: true, measuredAt: true },
        });
        const row = created[0];
        if (row) {
          inserted.push(row);
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
              data: columns,
            });
          } catch (err) {
            if (isP2025(err)) {
              tally.stats.skipped++;
              continue;
            }
            throw err;
          }
        }
      } else {
        const row = await prisma.measurement.create({
          data: {
            userId,
            type: m.type,
            source: "IMPORT",
            ...columns,
          },
          select: { id: true, type: true, measuredAt: true },
        });
        inserted.push(row);
      }
      touched.push({ type: m.type as MeasurementType, measuredAt });
      tally.stats.measurements++;
    } catch (err) {
      if (isP2002(err)) {
        tally.stats.skipped++;
        continue;
      }
      tally.writeFailed = true;
      break;
    }
  }
  return { touched, inserted };
}
