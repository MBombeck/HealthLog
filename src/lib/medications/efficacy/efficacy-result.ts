/**
 * The effect view's result sentence: the before/after comparison's direction
 * and one sentence in the reader's language. Worded on the server so the
 * web page and the app lead with the same line; descriptive only, never a
 * verdict on whether a medication works.
 */
import type {
  EfficacyBeforeAfter,
  EfficacyTargetView,
} from "@/lib/medications/efficacy/build-efficacy";
import { withUnit } from "@/lib/format/unit-join";

/**
 * The comparison's direction and its sentence. `direction` is null while
 * either side lacks the readings for a comparison; the sentence then says
 * which side is short.
 */
export interface EfficacyResult {
  direction: "lower" | "higher" | "unchanged" | null;
  text: string;
}

/** A change under this share of the before-mean reads as unchanged. */
const UNCHANGED_PCT = 2;

/** The comparison's direction, null without a comparison. */
export function efficacyDirection(
  ba: EfficacyBeforeAfter,
): EfficacyResult["direction"] {
  if (!ba.present || !ba.delta) return null;
  const { mean, pct } = ba.delta;
  if (pct !== null ? Math.abs(pct) < UNCHANGED_PCT : mean === 0) {
    return "unchanged";
  }
  return mean < 0 ? "lower" : "higher";
}

/** Word one target's comparison as a sentence in the reader's language. */
export function efficacyResultOf(
  view: Pick<EfficacyTargetView, "beforeAfter" | "unit">,
  minWeeks: number,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
): EfficacyResult {
  const ba = view.beforeAfter;
  const direction = efficacyDirection(ba);
  if (direction === null || !ba.delta) {
    const reason =
      ba.reason === "insufficient_before"
        ? "needBefore"
        : ba.reason === "insufficient_after"
          ? "needAfter"
          : ba.reason === "no_start"
            ? "needStart"
            : "needData";
    return {
      direction: null,
      text: t(`serverText.efficacyResult.${reason}`, { weeks: minWeeks }),
    };
  }
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(Math.abs(ba.delta.mean));
  const amount = withUnit(number, view.unit);
  return {
    direction,
    text: t(`serverText.efficacyResult.${direction}`, { amount }),
  };
}
