/**
 * `kind=glucoseKetoneIndex`: one point per ketone reading that pairs with a
 * glucose reading (#1367). The index is derived at read time by the one
 * pairing rule (`read-glucose-ketone-index.ts`); a client draws the value it
 * is given and never recomputes it. Ketone readings are a few a day at most,
 * so the window is never bucketed.
 */
import { readGlucoseKetoneIndex } from "@/lib/measurements/read-glucose-ketone-index";

import type { SeriesRead } from "./kinds";

export async function readGlucoseKetoneIndexSeries(
  userId: string,
  since: Date,
): Promise<SeriesRead> {
  const points = await readGlucoseKetoneIndex({
    userId,
    from: since,
    // Open-ended: a reading stamped a moment ahead of the server clock is
    // still the latest one.
    to: new Date(Date.now() + 86_400_000),
  });
  return {
    points: points.map((p) => ({
      id: p.ketoneId,
      at: p.at,
      value: p.value,
      secondary: null,
      gki: {
        glucoseId: p.glucoseId,
        glucoseAt: p.glucoseAt,
        glucoseMmol: p.glucoseMmol,
        ketonesMmol: p.ketonesMmol,
      },
    })),
  };
}
