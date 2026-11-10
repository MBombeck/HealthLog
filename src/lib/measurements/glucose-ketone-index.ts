/**
 * The glucose-ketone index (GKI), derived from a ketone reading and the
 * glucose reading taken with it (#1367).
 *
 *   GKI = glucose (mmol/L) / beta-hydroxybutyrate (mmol/L)
 *
 * Glucose is stored in mg/dL and converted with {@link MGDL_PER_MMOL}, the one
 * factor the tree uses for that conversion, then rounded to the one decimal
 * the index is shown beside, so the glucose a GKI is built from is the same
 * number every glucose surface shows. The index is computed when
 * it is read and never stored: a stored ratio drifts the moment either reading
 * it came from is edited or deleted, which is the failure a hand-typed GKI has.
 *
 * Pairing, per ketone reading:
 *
 *   1. A glucose reading at the same instant wins. A fingerstick entry writes
 *      both readings with one timestamp, so this is the usual case.
 *   2. Otherwise the nearest glucose reading no more than
 *      {@link GKI_PAIRING_WINDOW_MINUTES} minutes before or after it.
 *   3. Nothing further away. A ketone reading with no glucose inside the
 *      window, or with a value of zero, has no index.
 *
 * Ties at the same distance go to the reading from the same source as the
 * ketone reading (a manual fingerstick pairs with the manual glucose rather
 * than with a sensor reading at the same minute), then to the earlier one. One
 * glucose reading may serve two ketone readings taken close together; each
 * index names the glucose reading it was built from.
 *
 * The figure is descriptive. Nothing here grades it: what a GKI should be is a
 * matter for the plan a clinician sets.
 */
import { MGDL_PER_MMOL } from "@/lib/glucose";

/**
 * The widest gap between a ketone and a glucose reading that still pairs.
 *
 * Fifteen minutes covers two strips taken one after the other, a meter that
 * reads ketones from a second drop, a reading typed in a few minutes late, and
 * a sensor that samples every five minutes, while staying short enough that
 * glucose has not moved on: after a meal it can rise by a few mg/dL a minute,
 * so an hour-old reading describes a different moment and the ratio built from
 * it would describe neither.
 */
export const GKI_PAIRING_WINDOW_MINUTES = 15;

/**
 * The unit both components of the index are in. Fixed, not the reader's
 * glucose unit: the index is defined on mmol/L, and a ratio taken over mg/dL
 * would be eighteen times larger and mean something else.
 */
export const GKI_COMPONENT_UNIT = "mmol/L";
export const GKI_PAIRING_WINDOW_MS = GKI_PAIRING_WINDOW_MINUTES * 60_000;

/**
 * The decimals a ketone reading is shown with beside its index: as recorded,
 * one or two. A meter that reads 0.25 must not print as 0.3, or the pair on
 * screen no longer divides to the index beside it.
 */
export function ketoneFractionDigits(ketonesMmol: number): 1 | 2 {
  const tenths = ketonesMmol * 10;
  return Math.abs(tenths - Math.round(tenths)) < 1e-9 ? 1 : 2;
}

/** One stored reading, as the pairing needs it. */
export interface GkiReading {
  id: string;
  measuredAt: Date;
  /** Ketones in mmol/L; glucose in canonical mg/dL. */
  value: number;
  source: string;
}

/** One derived index, with the two readings it was built from. */
export interface GlucoseKetoneIndexPoint {
  /** The ketone reading's id. The index belongs to the ketone reading. */
  ketoneId: string;
  /** The glucose reading it was paired with. */
  glucoseId: string;
  /** The ketone reading's instant, ISO 8601. */
  at: string;
  /** The glucose reading's instant, ISO 8601. */
  glucoseAt: string;
  /** The index, to one decimal. */
  value: number;
  /** Beta-hydroxybutyrate as recorded, mmol/L. */
  ketonesMmol: number;
  /** The paired glucose in mmol/L, to one decimal. */
  glucoseMmol: number;
}

/**
 * The index of one glucose (mg/dL) and one ketone (mmol/L) value, unrounded,
 * or null when it is undefined: no ketones, or a value that is not a positive
 * finite number on either side.
 */
export function glucoseKetoneIndex(
  glucoseMgdl: number,
  ketonesMmol: number,
): number | null {
  if (!Number.isFinite(glucoseMgdl) || !Number.isFinite(ketonesMmol)) {
    return null;
  }
  if (ketonesMmol <= 0 || glucoseMgdl <= 0) return null;
  return glucoseMgdl / MGDL_PER_MMOL / ketonesMmol;
}

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Pair every ketone reading with its glucose reading and compute the index.
 * Pure. Both lists may come in any order; the answer is in ketone-reading
 * order (oldest first). Ketone readings without a partner are left out.
 */
export function pairGlucoseKetoneIndex(
  ketones: readonly GkiReading[],
  glucose: readonly GkiReading[],
): GlucoseKetoneIndexPoint[] {
  // The id breaks the last tie, so two glucose readings alike in time and
  // source always give the same pair, whatever order the rows came in.
  const sortedGlucose = [...glucose].sort(
    (a, b) =>
      a.measuredAt.getTime() - b.measuredAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const sortedKetones = [...ketones].sort(
    (a, b) =>
      a.measuredAt.getTime() - b.measuredAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const out: GlucoseKetoneIndexPoint[] = [];
  let lo = 0;
  for (const ketone of sortedKetones) {
    if (!(ketone.value > 0)) continue;
    const at = ketone.measuredAt.getTime();
    // Ketone readings are walked in time order, so the window's lower edge
    // only ever moves forward.
    while (
      lo < sortedGlucose.length &&
      sortedGlucose[lo]!.measuredAt.getTime() < at - GKI_PAIRING_WINDOW_MS
    ) {
      lo++;
    }
    let best: GkiReading | null = null;
    let bestRank: [number, number, number] | null = null;
    for (let i = lo; i < sortedGlucose.length; i++) {
      const candidate = sortedGlucose[i]!;
      const t = candidate.measuredAt.getTime();
      if (t > at + GKI_PAIRING_WINDOW_MS) break;
      const rank: [number, number, number] = [
        Math.abs(t - at),
        candidate.source === ketone.source ? 0 : 1,
        t,
      ];
      if (
        bestRank === null ||
        rank[0] < bestRank[0] ||
        (rank[0] === bestRank[0] &&
          (rank[1] < bestRank[1] ||
            (rank[1] === bestRank[1] && rank[2] < bestRank[2])))
      ) {
        best = candidate;
        bestRank = rank;
      }
    }
    if (best === null) continue;
    if (glucoseKetoneIndex(best.value, ketone.value) === null) continue;
    // The index is built from the glucose as it is shown beside it, so the
    // printed pair divides to the printed index. A reading entered in mmol/L
    // is stored as whole mg/dL; dividing the unrounded conversion would land
    // a tenth away from the pair on screen.
    const glucoseMmol = oneDecimal(best.value / MGDL_PER_MMOL);
    out.push({
      ketoneId: ketone.id,
      glucoseId: best.id,
      at: ketone.measuredAt.toISOString(),
      glucoseAt: best.measuredAt.toISOString(),
      value: oneDecimal(glucoseMmol / ketone.value),
      ketonesMmol: ketone.value,
      glucoseMmol,
    });
  }
  return out;
}

/** Count, mean, min, max and latest of a run of indices, or null when empty. */
export interface GlucoseKetoneIndexSummary {
  count: number;
  mean: number;
  min: number;
  max: number;
  latest: number;
}

export function summariseGlucoseKetoneIndex(
  points: readonly GlucoseKetoneIndexPoint[],
): GlucoseKetoneIndexSummary | null {
  if (points.length === 0) return null;
  const values = points.map((p) => p.value);
  return {
    count: values.length,
    mean: oneDecimal(values.reduce((a, b) => a + b, 0) / values.length),
    min: Math.min(...values),
    max: Math.max(...values),
    latest: values[values.length - 1]!,
  };
}
