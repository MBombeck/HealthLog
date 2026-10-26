/**
 * Which screener totals in a report were answered in a translation that has
 * not been validated.
 *
 * A questionnaire in a language without a validated version is shown in a
 * translation written for HealthLog, and its result reads as orientation.
 * The report's renderers mark those totals beside the score type's row, so a
 * clinician reads them the same way. Counted per score type the report
 * carries, over the report window; the table is not asked at all when no
 * screener total is in the report.
 */
import { prisma } from "@/lib/db";
import {
  INSTRUMENT_MEASUREMENT_TYPE,
  INSTRUMENT_ORDER,
} from "@/lib/mental-health/instruments";

/**
 * Per score type (`SCI_SCORE`, …), the number of the window's administrations
 * answered in an unvalidated translation. Null when there are none, which is
 * every report of a reader whose language has validated versions.
 */
export async function loadScreenerUnvalidatedTranslations(
  userId: string,
  stats: Readonly<Record<string, unknown>>,
  start: Date,
  end: Date,
): Promise<Record<string, number> | null> {
  const instruments = INSTRUMENT_ORDER.filter(
    (id) => stats[INSTRUMENT_MEASUREMENT_TYPE[id]] !== undefined,
  );
  if (instruments.length === 0) return null;
  const groups = await prisma.mentalHealthAssessment.groupBy({
    by: ["instrument"],
    where: {
      userId,
      deletedAt: null,
      wording: "unvalidated_translation",
      instrument: { in: [...instruments] },
      takenAt: { gte: start, lte: end },
    },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const id of instruments) {
    const count = groups.find((g) => g.instrument === id)?._count._all ?? 0;
    if (count > 0) counts[INSTRUMENT_MEASUREMENT_TYPE[id]] = count;
  }
  return Object.keys(counts).length > 0 ? counts : null;
}
