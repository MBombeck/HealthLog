/**
 * Read the glucose-ketone index of a window (#1367): the ketone readings in
 * it and the glucose readings within pairing reach of one, paired by
 * `pairGlucoseKetoneIndex`. Every surface that shows the index (the series
 * route, the day, the doctor report) reads it here, so the pairing rule has
 * one implementation.
 *
 * Glucose and ketones carry no source ladder (neither is in `RANKED_TYPES`),
 * so every live row of every source is a candidate, as on the glucose chart.
 * The glucose read is bounded by the ketone readings: only rows within the
 * pairing window of one are fetched, so a sensor writing every five minutes
 * contributes a handful of rows per fingerstick, not the window's thousands.
 */
import { prisma } from "@/lib/db";

import {
  GKI_PAIRING_WINDOW_MINUTES,
  GKI_PAIRING_WINDOW_MS,
  pairGlucoseKetoneIndex,
  type GkiReading,
  type GlucoseKetoneIndexPoint,
} from "./glucose-ketone-index";

interface Row {
  id: string;
  value: number;
  measured_at: Date;
  source: string;
}

function toReading(row: Row): GkiReading {
  return {
    id: row.id,
    value: row.value,
    measuredAt: row.measured_at,
    source: row.source,
  };
}

/**
 * The indices of the ketone readings taken in `[from, to)`, oldest first.
 * A glucose reading just outside the window still pairs with a ketone reading
 * just inside it.
 */
export async function readGlucoseKetoneIndex(args: {
  userId: string;
  from: Date;
  to: Date;
}): Promise<GlucoseKetoneIndexPoint[]> {
  const { userId, from, to } = args;
  const ketones = await prisma.$queryRaw<Row[]>`
    SELECT k."id", k."value", k."measured_at", k."source"::text AS "source"
    FROM measurements k
    WHERE k."user_id" = ${userId}
      AND k."type" = 'BLOOD_KETONES'::"measurement_type"
      AND k."deleted_at" IS NULL
      AND k."measured_at" >= ${from}
      AND k."measured_at" < ${to}
      AND k."value" > 0
    ORDER BY k."measured_at" ASC, k."id" ASC
  `;
  if (ketones.length === 0) return [];
  // An interval between two stored instants: no zone enters the arithmetic.
  const reach = `${GKI_PAIRING_WINDOW_MINUTES} minutes`;
  const glucose = await prisma.$queryRaw<Row[]>`
    SELECT g."id", g."value", g."measured_at", g."source"::text AS "source"
    FROM measurements g
    WHERE g."user_id" = ${userId}
      AND g."type" = 'BLOOD_GLUCOSE'::"measurement_type"
      AND g."deleted_at" IS NULL
      AND g."measured_at" >= ${new Date(from.getTime() - GKI_PAIRING_WINDOW_MS)}
      AND g."measured_at" <= ${new Date(to.getTime() + GKI_PAIRING_WINDOW_MS)}
      AND EXISTS (
        SELECT 1 FROM measurements k
        WHERE k."user_id" = ${userId}
          AND k."type" = 'BLOOD_KETONES'::"measurement_type"
          AND k."deleted_at" IS NULL
          AND k."measured_at" >= ${from}
          AND k."measured_at" < ${to}
          AND k."value" > 0
          AND k."measured_at" BETWEEN g."measured_at" - ${reach}::interval
                                  AND g."measured_at" + ${reach}::interval
      )
  `;
  return pairGlucoseKetoneIndex(ketones.map(toReading), glucose.map(toReading));
}
