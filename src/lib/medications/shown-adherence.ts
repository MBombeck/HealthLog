/**
 * The adherence a medication surface shows, and the one rule behind it: a
 * rate with no eligible dose behind it is not a number.
 *
 * The compliance engine answers `rate: 100` for a window that expected
 * nothing (nothing expected, nothing missed), which keeps a "0 %" alarm off
 * every consumer that reads the rate as arithmetic. Shown as adherence it is
 * a claim without data: a medication added an hour ago read "Adherence
 * 100 %" twice on its card while the history beside it said "No doses to
 * score yet". Every web surface that renders the two rates (card, GLP-1
 * card, detail page, table) reads them through here, so a window whose
 * denominator is zero renders as "no doses yet" and never as a figure. The
 * Insights medications page reads the overview rows through `scoredRate`.
 *
 * Client-safe and pure.
 */

interface DisplayRow {
  rate: number;
  /** The rate's denominator (taken plus missed). */
  expected?: number;
}

interface ComplianceLike {
  complianceDisplay?: {
    shortDays: number;
    longDays: number;
    short: DisplayRow & { streak: number };
    long: DisplayRow;
  } | null;
  compliance7?: { rate: number; streak?: number } | null;
  compliance30?: { rate: number } | null;
}

export interface ShownAdherence {
  shortDays: number;
  longDays: number;
  /** Null when the short window holds no dose to score. */
  rate7: number | null;
  /** Null when the long window holds no dose to score. */
  rate30: number | null;
  streak: number;
}

/**
 * A rate as shown: null when its denominator (`expected`, the doses it
 * counts) is zero. An unknown denominator (an older payload) keeps the rate.
 */
export function scoredRate(
  rate: number,
  expected: number | undefined,
): number | null {
  return expected === 0 ? null : rate;
}

function scored(row: DisplayRow): number | null {
  return scoredRate(row.rate, row.expected);
}

export function shownAdherence(
  compliance: ComplianceLike | null | undefined,
): ShownAdherence {
  const display = compliance?.complianceDisplay ?? null;
  if (display) {
    return {
      shortDays: display.shortDays,
      longDays: display.longDays,
      rate7: scored(display.short),
      rate30: scored(display.long),
      streak: display.short.expected === 0 ? 0 : display.short.streak,
    };
  }
  // The legacy fields carry no denominator; a payload without the display
  // block is an old cached one, and its rates are shown as they were.
  return {
    shortDays: 7,
    longDays: 30,
    rate7: compliance?.compliance7?.rate ?? null,
    rate30: compliance?.compliance30?.rate ?? null,
    streak: compliance?.compliance7?.streak ?? 0,
  };
}
