/**
 * BP-in-target percentage helper.
 *
 * The "BD im Zielbereich" tile on the dashboard reports the share of
 * recent blood-pressure readings that are at or below the user's
 * age-band ceiling. Up to v1.4.14 this lived inline in
 * `src/app/api/analytics/route.ts` and had two latent bugs that made
 * the tile read 0 % even when the user clearly had readings inside the
 * target band:
 *
 * 1. **Wrong denominator (v1.4.14).** The legacy code divided
 *    `inTarget / sysData.length`, but readings are only countable when
 *    a matching diastolic exists within 5 minutes. v1.4.15 A4 fixed the
 *    denominator to count only paired readings.
 *
 * 2. **Wrong target semantics (v1.4.15 -> v1.4.16 A2 regression).** The
 *    v1.4.15 fix kept the original "within narrow goal band" semantics:
 *    `sys >= sysLow && sys <= sysHigh && dia >= diaLow && dia <= diaHigh`.
 *    With ESH 2023 narrow targets (Sys 120-129, Dia 70-79 for under-65)
 *    this collapses to 0 % for healthy normotensive users whose
 *    readings sit BELOW the goal band — a well-controlled profile has many
 *    readings like 117/79 (textbook normotensive, well-controlled) that
 *    were marked OUT of target because sys < 120. Users intuitively
 *    consider those readings *in target* — and so does clinical
 *    practice ("BP is well-controlled" = "at goal or below the goal
 *    ceiling, not implausibly hypotensive"). The v1.4.16 fix changes
 *    semantics from a narrow band to a one-sided ceiling check with a
 *    clinical floor for true hypotension:
 *
 *      in-target := sys >= 90 AND sys <= sysHigh
 *                  AND dia >= 50 AND dia <= diaHigh
 *
 *    The 90/50 floors are well below any plausible "normal-low" and
 *    flag symptomatic hypotension as out-of-target instead of silently
 *    counting it as good control.
 *
 * 3. **No fallback when timestamps don't pair (v1.4.15 fix).** Withings
 *    imports each write sys + dia as separate
 *    Measurement rows that ought to share a `measuredAt` to the second
 *    — but rounding through different timezones can drift them by
 *    minutes. The 5-minute window was tight; data imported with
 *    hour-level rounding (some legacy Withings ranges) had `timeDiff >
 *    5 min`. The fallback to same-Berlin-day pairing covers that.
 *
 * Pure & deterministic so the unit test suite can pin the exact %.
 */
import type { BpTargets } from "./bp-targets";

export interface BpReading {
  measuredAt: Date;
  value: number;
}

/**
 * Clinical floors below which a reading is symptomatic hypotension and
 * NOT a desirable "well-controlled BP" outcome. Roughly mid-band
 * shock-onset thresholds; well below any reasonable normotensive
 * resting reading.
 */
export const SYS_HYPOTENSION_FLOOR = 90;
export const DIA_HYPOTENSION_FLOOR = 50;

import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/resolver";

/**
 * Pair a systolic reading with its closest diastolic by absolute time
 * delta. Returns the time delta (ms) and the matched dia, or `null` if
 * the dia list is empty.
 */
function findClosestDia(
  sys: BpReading,
  diaSeries: BpReading[],
): { dia: BpReading; deltaMs: number } | null {
  if (diaSeries.length === 0) return null;
  let bestDia = diaSeries[0];
  let bestDelta = Math.abs(
    diaSeries[0].measuredAt.getTime() - sys.measuredAt.getTime(),
  );
  for (let i = 1; i < diaSeries.length; i++) {
    const candidate = diaSeries[i];
    const delta = Math.abs(
      candidate.measuredAt.getTime() - sys.measuredAt.getTime(),
    );
    if (delta < bestDelta) {
      bestDelta = delta;
      bestDia = candidate;
    }
  }
  return { dia: bestDia, deltaMs: bestDelta };
}

/**
 * `true` when a paired reading is at or below the upper bound for both
 * sys and dia, AND above the clinical hypotension floors. This is the
 * canonical "BP in target" definition shared across every call site
 * (dashboard tile, insight cards, AI snapshot, comprehensive endpoint,
 * targets endpoint). Exported so the other modules don't drift.
 */
export function isBpReadingInTarget(
  sys: number,
  dia: number,
  targets: BpTargets,
): boolean {
  return (
    sys >= SYS_HYPOTENSION_FLOOR &&
    sys <= targets.sysHigh &&
    dia >= DIA_HYPOTENSION_FLOOR &&
    dia <= targets.diaHigh
  );
}

/**
 * Compute the share (0-100, rounded to nearest integer) of paired BP
 * readings inside `targets` over the supplied series. Returns `null`
 * when no pairs can be formed (caller renders the tile as "no data"
 * instead of 0 %).
 *
 * Pairing strategy:
 *   1. For each sys reading, find the closest dia by absolute time
 *      delta.
 *   2. Accept the pair if `deltaMs <= 5 minutes` (legacy bound) — same
 *      session.
 *   3. Otherwise accept the pair if both share the same calendar day IN
 *      THE USER'S OWN TZ (handles imports rounded to the hour or to
 *      noon). v1.30.3 (QA F7) — this used to hardcode the Berlin day
 *      regardless of the caller's actual user, rejecting legitimate
 *      same-local-day pairs for a non-Berlin user whose two readings
 *      straddle Berlin midnight but not their own (e.g. 23:50/00:10
 *      Berlin from a New York evening reading pair) — the in-target %
 *      then ran on fewer pairs than it should have.
 *   4. Discard otherwise.
 *
 * Denominator is the number of accepted pairs, NOT `sysData.length` —
 * that was the v1.4.14 bug that made the tile read 0 % when imports
 * had drifted timestamps.
 *
 * In-target check is the one-sided ceiling defined by
 * `isBpReadingInTarget()` — see file-header comment for the rationale.
 */
export function computeBpInTargetPct(
  sysSeries: BpReading[],
  diaSeries: BpReading[],
  targets: BpTargets,
  /** v1.30.3 — the user's own IANA tz; defaults to Berlin for
   *  legacy callers that haven't threaded it through yet. */
  tz: string = DEFAULT_TIMEZONE,
): { pct: number; pairs: number } | null {
  if (sysSeries.length === 0 || diaSeries.length === 0) return null;

  const SAME_SESSION_MS = 5 * 60 * 1000;
  let pairs = 0;
  let inTarget = 0;

  for (const sys of sysSeries) {
    const match = findClosestDia(sys, diaSeries);
    if (!match) continue;

    const sameSession = match.deltaMs <= SAME_SESSION_MS;
    const sameLocalDay =
      !sameSession &&
      userDayKey(sys.measuredAt, tz) === userDayKey(match.dia.measuredAt, tz);

    if (!sameSession && !sameLocalDay) continue;

    pairs += 1;
    if (isBpReadingInTarget(sys.value, match.dia.value, targets)) {
      inTarget += 1;
    }
  }

  if (pairs === 0) return null;

  return {
    pct: Math.round((inTarget / pairs) * 100),
    pairs,
  };
}

/**
 * v1.15.12 — collect the accepted SYS/DIA pairs (same pairing rules
 * as `computeBpInTargetPct`) as timestamped points, for the graded BP
 * pillar score. Returns `{ at, sys, dia }` per accepted pair using the
 * SYS reading's timestamp as the pair anchor — recency weighting only
 * needs ordering, not sub-second precision. Empty when no pairs form.
 */
export function collectBpPairs(
  sysSeries: BpReading[],
  diaSeries: BpReading[],
  /** v1.30.3 — see `computeBpInTargetPct`'s identical parameter. */
  tz: string = DEFAULT_TIMEZONE,
): Array<{ at: Date; sys: number; dia: number }> {
  if (sysSeries.length === 0 || diaSeries.length === 0) return [];
  const SAME_SESSION_MS = 5 * 60 * 1000;
  const out: Array<{ at: Date; sys: number; dia: number }> = [];
  for (const sys of sysSeries) {
    const match = findClosestDia(sys, diaSeries);
    if (!match) continue;
    const sameSession = match.deltaMs <= SAME_SESSION_MS;
    const sameLocalDay =
      !sameSession &&
      userDayKey(sys.measuredAt, tz) === userDayKey(match.dia.measuredAt, tz);
    if (!sameSession && !sameLocalDay) continue;
    out.push({ at: sys.measuredAt, sys: sys.value, dia: match.dia.value });
  }
  return out;
}

/**
 * v1.4.18 A1 → v1.4.19 A1 — windowed in-target shares for the dashboard
 * tile.
 *
 * The "BD im Zielbereich" tile renders three numbers:
 *  - Headline: the **all-time** in-target % across every paired reading.
 *  - `7T:`    the in-target % over the trailing 7 days.
 *  - `30T:`   the in-target % over the trailing 30 days.
 *
 * History of the bug:
 *
 *  - Up to v1.4.17 only the 30-day figure was computed; the tile showed
 *    `avg7={null}, avg30={null}` so `7T: —, 30T: —` rendered the dash
 *    fallback even when paired readings existed.
 *  - v1.4.18 A1 wired `avg7` + `avg30` from `computeBpInTargetWindows`,
 *    BUT the analytics route also routed the **headline**
 *    (`bpInTargetPct`) through `windows.last30Days?.pct` — i.e. the
 *    headline was a literal copy of `bpInTargetPct30d`. For a long history
 *    (572 paired readings over four years, recent 30 days = 50 %, all-time
 *    ≈ 11 %) the tile rendered `50 %` headline, `7T: 50, 30T: 50` and
 *    looked algorithmically pinned to 50/50/50. That was hypothesis-1
 *    from the v1.4.19 A1 brief: "the 7T/30T branches reuse the all-time
 *    percentage" — actually the *other* direction (the all-time headline
 *    reused the 30-day value).
 *  - v1.4.19 A1 surfaces a third `allTime` window so the headline gets
 *    the genuinely-different aggregate. Callers must use `allTime` for
 *    the headline now; the test suite pins this contract.
 *
 * `null` for any window means "no paired readings in that window"; the
 * caller renders the "—" placeholder instead of `0`. Caller must pass
 * UNFILTERED series for `allTime` to produce the correct value — the
 * helper does the windowing internally.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export function computeBpInTargetWindows(
  sysSeries: BpReading[],
  diaSeries: BpReading[],
  targets: BpTargets,
  now: Date = new Date(),
  /** v1.30.3 — see `computeBpInTargetPct`'s identical parameter. */
  tz: string = DEFAULT_TIMEZONE,
): {
  last7Days: { pct: number; pairs: number } | null;
  last30Days: { pct: number; pairs: number } | null;
  /**
   * v1.17 — the trailing-90-day window. This is the canonical window
   * the BD-Zielbereich headline, the Health-Score BP pillar and the coach
   * grounding number all standardise on (a 90-day arc balances recency
   * against enough pairs to be stable). The all-time aggregate stays
   * available below but is reserved for the BP detail page's long view.
   */
  last90Days: { pct: number; pairs: number } | null;
  /**
   * v1.17 — timestamp of the oldest accepted pair inside the
   * trailing-90-day window, or `null` when the window holds no pairs.
   * Feeds `computeWindowConfidence` so the BD-Zielbereich tile can label
   * the EFFECTIVE span ("· 23 T" until ~90 days of history exist) rather
   * than a dishonest static "· 90 T".
   */
  last90EarliestAt: Date | null;
  allTime: { pct: number; pairs: number } | null;
  /**
   * v1.4.22 — period-aligned 30-day window
   * shifted back by one month (now-60d … now-30d). Used by the
   * BD-Zielbereich tile's comparison-overlay caption when the user's
   * `comparisonBaseline === "lastMonth"` so the rendered "Δ X% vs.
   * last month" is honest. Null when the prior window has no pairs.
   */
  priorMonth: { pct: number; pairs: number } | null;
  /**
   * v1.4.22 — same shape, shifted back one
   * year (now-395d … now-365d) for `comparisonBaseline === "lastYear"`.
   */
  priorYear: { pct: number; pairs: number } | null;
} {
  const sevenDaysAgoMs = now.getTime() - 7 * DAY_MS;
  const thirtyDaysAgoMs = now.getTime() - 30 * DAY_MS;
  const ninetyDaysAgoMs = now.getTime() - 90 * DAY_MS;
  const sixtyDaysAgoMs = now.getTime() - 60 * DAY_MS;
  const oneYearMinus30DaysAgoMs = now.getTime() - 365 * DAY_MS;
  const oneYearAgoMs = now.getTime() - 395 * DAY_MS;

  const sysLast7 = sysSeries.filter(
    (r) => r.measuredAt.getTime() >= sevenDaysAgoMs,
  );
  const diaLast7 = diaSeries.filter(
    (r) => r.measuredAt.getTime() >= sevenDaysAgoMs,
  );
  const sysLast30 = sysSeries.filter(
    (r) => r.measuredAt.getTime() >= thirtyDaysAgoMs,
  );
  const diaLast30 = diaSeries.filter(
    (r) => r.measuredAt.getTime() >= thirtyDaysAgoMs,
  );
  const sysLast90 = sysSeries.filter(
    (r) => r.measuredAt.getTime() >= ninetyDaysAgoMs,
  );
  const diaLast90 = diaSeries.filter(
    (r) => r.measuredAt.getTime() >= ninetyDaysAgoMs,
  );

  // Period-aligned prior windows. Same 30-day arc, shifted by 30 / 365
  // days respectively. Bounds are inclusive on the lower end and
  // exclusive on the upper to avoid double-counting the boundary
  // reading in both windows.
  const sysPriorMonth = sysSeries.filter(
    (r) =>
      r.measuredAt.getTime() >= sixtyDaysAgoMs &&
      r.measuredAt.getTime() < thirtyDaysAgoMs,
  );
  const diaPriorMonth = diaSeries.filter(
    (r) =>
      r.measuredAt.getTime() >= sixtyDaysAgoMs &&
      r.measuredAt.getTime() < thirtyDaysAgoMs,
  );
  const sysPriorYear = sysSeries.filter(
    (r) =>
      r.measuredAt.getTime() >= oneYearAgoMs &&
      r.measuredAt.getTime() < oneYearMinus30DaysAgoMs,
  );
  const diaPriorYear = diaSeries.filter(
    (r) =>
      r.measuredAt.getTime() >= oneYearAgoMs &&
      r.measuredAt.getTime() < oneYearMinus30DaysAgoMs,
  );

  // v1.17 — oldest accepted pair inside the 90-day window for the
  // effective-span label. `collectBpPairs` applies the same pairing rules
  // as `computeBpInTargetPct`, so the anchor matches the counted pairs.
  const pairsLast90 = collectBpPairs(sysLast90, diaLast90, tz);
  const last90EarliestAt =
    pairsLast90.length === 0
      ? null
      : pairsLast90.reduce(
          (min, p) => (p.at.getTime() < min.getTime() ? p.at : min),
          pairsLast90[0].at,
        );

  return {
    last7Days: computeBpInTargetPct(sysLast7, diaLast7, targets, tz),
    last30Days: computeBpInTargetPct(sysLast30, diaLast30, targets, tz),
    // v1.17 — canonical headline / score / coach window.
    last90Days: computeBpInTargetPct(sysLast90, diaLast90, targets, tz),
    last90EarliestAt,
    // v1.4.19 — independent aggregate over EVERY paired reading. The
    // analytics route now routes the dashboard tile's headline through
    // this so it stops mirroring `last30Days`.
    allTime: computeBpInTargetPct(sysSeries, diaSeries, targets, tz),
    priorMonth: computeBpInTargetPct(sysPriorMonth, diaPriorMonth, targets, tz),
    priorYear: computeBpInTargetPct(sysPriorYear, diaPriorYear, targets, tz),
  };
}
