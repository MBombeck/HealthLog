/**
 * One blood-pressure reading is up to three rows: systolic, diastolic and
 * the pulse the cuff measured with them. No column links them. What makes
 * them one reading is how every writer stores it: the entry form, the MCP
 * write, a Withings measure group and a HealthKit correlation all write the
 * halves with the same source at the same instant, and the FHIR read pairs a
 * diastolic onto its systolic by exactly that instant.
 *
 * So the rule here is the strict one: same owner, same source, identical
 * `measuredAt`. The series and in-target reads pair more loosely (nearest
 * diastolic within five minutes) because they only draw a point; a delete
 * takes rows away, so it takes only the rows that can be nothing else.
 *
 * Deleting a systolic or a diastolic takes the whole reading with it.
 * Deleting a pulse takes only the pulse: a pulse is also a value of its own,
 * and removing one is no reason to remove a blood pressure.
 */
import type { MeasurementType, Prisma } from "@/generated/prisma/client";

/** The types that anchor a reading: deleting one deletes the reading. */
const BP_HALVES: ReadonlySet<string> = new Set([
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
]);

/** Every type a reading's rows can carry. */
const BP_READING_TYPES: MeasurementType[] = [
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
];

export interface ReadingAnchor {
  id: string;
  type: MeasurementType | string;
  source: string;
  measuredAt: Date;
  deletedAt?: Date | null;
}

type MeasurementReader = {
  measurement: Pick<Prisma.TransactionClient["measurement"], "findMany">;
};

export interface ReadingSibling {
  id: string;
  type: MeasurementType;
  measuredAt: Date;
}

/**
 * The other rows of the readings `rows` belong to, not counting `rows`
 * themselves. `state: "live"` finds the rows a delete takes with it;
 * `state: "deletedWith"` finds the rows that were tombstoned in the same
 * statement as their anchor (the identical `deletedAt`), which is what a
 * restore brings back with it, and never a row deleted on its own.
 */
export async function bloodPressureSiblings(
  db: MeasurementReader,
  userId: string,
  rows: readonly ReadingAnchor[],
  state: "live" | "deletedWith",
): Promise<ReadingSibling[]> {
  const anchors = rows.filter(
    (r) => BP_HALVES.has(r.type) && (state === "live" || r.deletedAt),
  );
  if (anchors.length === 0) return [];
  const found = await db.measurement.findMany({
    where: {
      userId,
      id: { notIn: rows.map((r) => r.id) },
      type: { in: BP_READING_TYPES },
      OR: anchors.map((a) => ({
        source: a.source as Prisma.MeasurementWhereInput["source"],
        measuredAt: a.measuredAt,
        deletedAt: state === "live" ? null : a.deletedAt,
      })),
    },
    select: { id: true, type: true, measuredAt: true },
  });
  return found;
}
