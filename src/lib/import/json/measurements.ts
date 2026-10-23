/**
 * The measurement rows of a JSON import (`POST /api/import`).
 *
 * The route's schema has already bounded each row (plausible range, entry
 * instant). With an external id a row is inserted or, when the key is taken,
 * updated in place, so a re-import of the same export is idempotent; without
 * one it is a first-write-wins create with a NULL external id, which does
 * duplicate on re-import.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { classifyExternalId } from "@/lib/validations/external-id";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { isP2002, isP2025 } from "@/lib/prisma-errors";

import type { JsonImportMeasurement } from "./schema";
import type { JsonImportTally } from "./tally";

export type { JsonImportMeasurement } from "./schema";

/**
 * A reading's own columns beyond its value: what the reading says, carried
 * whole so a range keeps its bounds, a sleep row its stage and an ECG its
 * verdict. Every arm of the write states them, so a re-import of the same
 * file puts back what an edit in between changed.
 */
function readingColumns(m: JsonImportMeasurement) {
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
    notes: null,
    notesEncrypted: encryptNote(m.notes || null),
  };
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
  for (const m of rows) {
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
      const columns = readingColumns(m);
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
