/**
 * v1.10.0 — FDR-controlled correlation discovery engine.
 *
 * Promotes the legacy three-fixed-hypothesis `correlations.ts` to a bounded
 * ALL-PAIRS discovery over a curated behaviour × outcome matrix, lagged
 * (a behaviour on day D vs an outcome on day D+1), Benjamini-Hochberg
 * FDR-controlled on top of the existing exact Student-t / n ≥ 20 / p < 0.05
 * gates. Only statistically-defensible pairs surface, each with an honest
 * "descriptive, not causal" caveat.
 *
 * Why FDR: scanning many pairs inflates the family-wise false-discovery
 * rate — at p < 0.05 alone, 1-in-20 noise pairs surface as "significant".
 * Benjamini & Hochberg (1995), J. R. Stat. Soc. B 57(1):289–300 controls
 * the expected proportion of false discoveries among the surfaced pairs to
 * `FDR_Q` (default 0.10). A pair surfaces only when its rank-adjusted q
 * clears the threshold — so the card count stays honest as the matrix grows.
 *
 * Lagging: a behaviour (today's daylight, mood, glucose, BP) is paired with
 * the NEXT day's outcome (sleep, HRV, resting HR, weight). The lag encodes
 * the plausible direction ("more daylight today → better sleep tonight")
 * without claiming causation — the caveat is displayed verbatim.
 *
 * Pearson + the exact incomplete-beta p-value are reused from
 * `src/lib/insights/correlations.ts` (its docstring explicitly anticipates
 * this auto-discovery widening the pair grid). This module is PURE over
 * already-fetched daily series — the DB read lives in the route.
 *
 * Framing discipline: descriptive, never causal; every pair carries n, r,
 * p, and the BH-adjusted q.
 *
 * v1.21.0 (FDREXTEND) — medication compliance (a daily adherence rate from the
 * compliance engine's dose-history ledger) and symptom severity (the illness
 * day-log functional-impact / symptom-burden track) are now first-class daily
 * channels in the matrix, so the high-value "adherence dip → symptom flare" and
 * "compliance↓ → a vital drifting" links can finally be discovered. They are
 * the sparsest, noisiest inputs in the system — they flow through the SAME
 * n ≥ 20 / p < 0.05 / BH-FDR / effect-size-floor / shrinkage gates as every
 * other channel, so a thin series degrades to absent rather than to a spurious
 * link. The series builders live in `correlation-series-builders.ts`.
 *
 * v1.42 — every daily pair is tested on seasonally adjusted residuals: the
 * annual cycle (from 120 paired days on) and a linear trend are removed from
 * both series, and the p-value uses the Pyper–Peterman effective sample size
 * instead of n. Two series that only share the calendar no longer surface as
 * related (see `seasonal-adjust.ts` for the method and the simulation behind
 * it). Shrinkage and the phrasing tier read the effective size too, so a
 * strongly autocorrelated pair cannot be narrated as a deep, confident one.
 */
import {
  pearson,
  seasonallyAdjustedPearson,
  MIN_PAIRED_N,
  type DayPair,
} from "@/lib/insights/correlations";
import { type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { shiftDateKey } from "@/lib/tz/format";

/**
 * Locale-aware string builder — the same signature the server translator
 * exposes. Every user-facing narration in this module routes through one of
 * these so the sentence is emitted in the reader's language, not hardcoded
 * English. Falls back to English (then the raw key) inside the translator.
 */
type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** Default Benjamini-Hochberg target false-discovery rate. */
export const FDR_Q = 0.1;

/**
 * RECON1 (D2-2) — effect-size floor on the SHRUNK |r|. A pair can be
 * statistically significant (p < 0.05, FDR-clean) yet explain a trivial slice
 * of variance — e.g. n=180, r=0.16 explains ~2.5% and is noise-floor signal a
 * human should not chase. Below this floor we DROP the pair from the discovered
 * ranking entirely, so the Coach never narrates a significant-but-trivial pair
 * as a confident "tends to go with" driver. The floor is applied AFTER the D4
 * shrinkage (below), so a thin-data estimate is pulled toward null first.
 */
export const EFFECT_SIZE_FLOOR = 0.2;

/**
 * RECON1 (D2-2 / D2-6) — the |r| at/above which a pair earns CONFIDENT phrasing
 * ("tends to go with"). Between `EFFECT_SIZE_FLOOR` and this, the pair survives
 * but is down-tiered to a hedged "faint hint" so the narrated confidence never
 * outruns the effect.
 */
export const CONFIDENT_EFFECT_THRESHOLD = 0.3;

/**
 * RECON1 (D4) — James-Stein / regression-to-the-mean shrinkage constant. A
 * sparse n-of-1 Pearson estimate is noisy and over-states the effect; we pull
 * it toward null by the factor n/(n+SHRINKAGE_K) before ranking + tiering, so a
 * thin-data correlation cannot out-rank a deep, well-sampled one purely on an
 * inflated point estimate. k=10 means a pair at the n≥20 floor keeps ~67% of
 * its raw r, a 60-day pair keeps ~86%, and a 180-day pair keeps ~95% — light,
 * documented, and reusing nothing more exotic than the paired-day count the
 * MAD-robust baseline infra already surfaces. The shrunk r is used ONLY for
 * ranking, the effect-size floor, and the phrasing tier; the reported `r` and
 * `pValue` stay the honest raw statistics.
 */
export const SHRINKAGE_K = 10;

/**
 * Pull a Pearson r toward null by its sample size (regression-to-the-mean).
 * Pure. Larger n → less shrinkage; a thin pair is discounted toward 0.
 */
export function shrinkEstimate(r: number, n: number): number {
  if (!Number.isFinite(r) || n <= 0) return 0;
  return r * (n / (n + SHRINKAGE_K));
}

/**
 * RECON1 (D2-1) — metric-family key for a discovery channel. Two channels in
 * the same family (e.g. both blood-pressure components) lag-correlate trivially
 * (serial auto-correlation of one physiological signal), so a same-family
 * lagged pair is a near-tautology, not a cross-domain insight. The discovery
 * loop already skips the exact self-pair (`b.key === o.key`); this widens that
 * to the whole family so MOOD→MOOD-class self-lags and any future same-family
 * pairing are excluded from the ranking before they can crowd out genuine
 * cross-domain links. Channels with no shared family return their own key, so
 * only deliberate families collapse.
 */
export function metricFamily(key: string): string {
  // A RATED mood factor (`FACTOR:<name>`) is a sub-component of overall mood, so
  // it shares MOOD's family — a `FACTOR:* → MOOD` lag is the same self-lag
  // tautology as MOOD→MOOD and is excluded too.
  if (key.startsWith(FACTOR_CHANNEL_PREFIX) || key === "MOOD") return "MOOD";
  if (key.startsWith("BLOOD_PRESSURE")) return "BLOOD_PRESSURE";
  // v1.25 (W-ENV) — every environmental-exposure channel (ENV_TEMP_MEAN,
  // ENV_DAYLIGHT, …) shares ONE family so the same-family guard never
  // lag-correlates two same-day weather fields against each other (a
  // near-tautology). They stay free to pair cross-domain against mood / sleep /
  // vitals — the whole point of the module.
  if (key.startsWith("ENV_")) return "ENVIRONMENT";
  if (key.startsWith("CUSTOM_METRIC:")) return key;
  // v1.21.0 (FDREXTEND) — medication compliance and symptom severity each form
  // their OWN single-channel family, so the loop's same-family guard collapses
  // only the self-lag (compliance→compliance, symptom→symptom). The returned
  // key equals the channel key for both, so neither shares a family with any
  // vital / sleep / mood channel — they remain free to pair cross-domain
  // (the whole point: adherence↓ → next-day symptom↑, or compliance↓ → a vital
  // drifting). No special-case branch is needed; the `return key` fall-through
  // already isolates them. This comment documents the deliberate decision.
  return key;
}

/** RECON1 (D2-6) — explicit phrasing tier a low-confidence signal must honour. */
export type ConfidenceTier = "high" | "moderate" | "faint";

/**
 * RECON1 (D2-2 / D2-6) — classify a pair into a phrasing tier from its SHRUNK
 * effect size and paired-day depth. The tier is a contract the narration (and
 * the hallucination tests) can check, so a thin / weak signal is hedged
 * differently from a deep / strong one rather than both reading "tends to go
 * with" at full confidence. `null` means below the effect-size floor — the
 * caller drops the pair entirely.
 */
export function confidenceTier(
  shrunkR: number,
  n: number,
): ConfidenceTier | null {
  const mag = Math.abs(shrunkR);
  if (mag < EFFECT_SIZE_FLOOR) return null;
  if (mag < CONFIDENT_EFFECT_THRESHOLD) return "faint";
  // A confident effect still needs depth to be narrated plainly; a strong r on
  // a barely-qualifying sample is "moderate", not "high".
  return n >= 60 ? "high" : "moderate";
}

/** A single day's value for one metric (daily mean / sum). */
export interface DailySeriesPoint {
  /** Day key YYYY-MM-DD. */
  day: string;
  value: number;
}

/** A named daily series feeding the discovery matrix. */
export interface NamedSeries {
  /** Stable channel key (e.g. "TIME_IN_DAYLIGHT", "MOOD"). */
  key: string;
  /** Whether the channel is a behaviour (lag source) or an outcome (lag target). */
  role: "behaviour" | "outcome";
  /** User-facing label for dynamic channels such as custom metrics. */
  label?: string;
  points: DailySeriesPoint[];
  /**
   * Behaviour channels only: the lag this channel pairs at, overriding the
   * scan's default (1). The environmental-exposure channels set 0 because
   * their points are already the mean of the day before and the day itself
   * (see the environment read in `correlation-channel-series.ts`), so "lag 0"
   * there means the averaged 0–1 window, tested as one hypothesis.
   */
  lagDays?: number;
}

/** One discovered, FDR-surviving correlation pair. */
export interface DiscoveredCorrelation {
  behaviour: string;
  outcome: string;
  behaviourLabel?: string;
  outcomeLabel?: string;
  /** Paired-day count after the lag join. */
  n: number;
  /**
   * Effective sample size after serial correlation (Pyper–Peterman). The
   * p-value, the shrinkage and the tier use it; `n` stays the day count.
   */
  nEff?: number;
  /**
   * Partial correlation of the lag-joined pair with trend (and, from 120
   * paired days, the annual cycle) removed from both series.
   */
  r: number;
  /** Two-sided exact Student-t p-value at `nEff` degrees of freedom. */
  pValue: number;
  /** Benjamini-Hochberg adjusted q-value. */
  qValue: number;
  /**
   * RECON1 (D4) — the sample-size-shrunk r (toward null) used for ranking,
   * the effect-size floor, and the phrasing tier. Display still uses raw `r`.
   */
  shrunkR: number;
  /**
   * RECON1 (D2-6) — phrasing tier the narration must honour: a `faint` signal
   * is hedged, a `high` signal stated plainly. Never `null` here (a below-floor
   * pair is dropped before this list).
   */
  tier: ConfidenceTier;
  /** Conservative, descriptive interpretation — never causal, tier-hedged. */
  interpretation: string;
  /**
   * Lag in days applied: 1 (behaviour day D, outcome D+1) by default; 0 for
   * the environmental channels, whose exposure is the mean of D−1 and D.
   */
  lagDays: number;
  /**
   * v1.22 — which window surfaced the pair. `retrospective` = the standard
   * 180-day scan (the established pattern). `recent` = the rolling
   * early-detection pass over the trailing {@link EARLY_WINDOW_DAYS} days,
   * surfaced ONLY when the pair is not already established retrospectively.
   * Absent on the legacy path so existing consumers read it as the
   * retrospective default.
   */
  window?: "retrospective" | "recent";
  /**
   * v1.22 — true for a `recent`-window emerging pair: it cleared a tighter
   * FDR and a no-faint effect bar over a short window, but rests on fewer days
   * than the retrospective scan, so the narration must hedge it as emerging /
   * provisional rather than established.
   */
  provisional?: boolean;
  /** Persisted server decision for dismissal across recomputation. */
  patternId?: string;
  canonicalKey?: string;
  dismissed?: boolean;
}

export interface CorrelationDiscoveryResult {
  /** Pairs surviving n ≥ 20, p < 0.05, AND the BH-FDR control. */
  discovered: DiscoveredCorrelation[];
  /** How many behaviour × outcome pairs were tested (for the honest footer). */
  pairsTested: number;
  /** The FDR target the surface used. */
  fdrQ: number;
  /** Minimum paired-day count enforced per pair. */
  minPairs: number;
}

/** Add `lagDays` to a YYYY-MM-DD day key, returning the shifted key. */
function shiftDay(day: string, lagDays: number): string {
  return shiftDateKey(day, lagDays);
}

/**
 * Lag-join a behaviour series (day D) against an outcome series (day D+lag).
 * Returns the paired (behaviour, outcome) value arrays. Pure.
 */
export function lagJoin(
  behaviour: DailySeriesPoint[],
  outcome: DailySeriesPoint[],
  lagDays: number,
): { xs: number[]; ys: number[] } {
  const outcomeByDay = new Map(outcome.map((p) => [p.day, p.value]));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of behaviour) {
    const target = outcomeByDay.get(shiftDay(b.day, lagDays));
    if (target != null && Number.isFinite(b.value) && Number.isFinite(target)) {
      xs.push(b.value);
      ys.push(target);
    }
  }
  return { xs, ys };
}

/** {@link lagJoin} keeping the behaviour day each pair is keyed on. */
function lagJoinPairs(
  behaviour: DailySeriesPoint[],
  outcome: DailySeriesPoint[],
  lagDays: number,
): DayPair[] {
  const outcomeByDay = new Map(outcome.map((p) => [p.day, p.value]));
  const pairs: DayPair[] = [];
  for (const b of behaviour) {
    const target = outcomeByDay.get(shiftDay(b.day, lagDays));
    if (target != null && Number.isFinite(b.value) && Number.isFinite(target)) {
      pairs.push({ day: b.day, x: b.value, y: target });
    }
  }
  return pairs;
}

interface RawPair {
  behaviour: string;
  outcome: string;
  n: number;
  nEff: number;
  r: number;
  pValue: number;
  lagDays: number;
  behaviourLabel?: string;
  outcomeLabel?: string;
}

/**
 * Apply the Benjamini-Hochberg step-up procedure to a set of p-values.
 * Returns the BH-adjusted q-value per input index (monotone-enforced from
 * the largest rank down), so a caller can surface pairs whose q ≤ `fdrQ`.
 * Pure. `m` is the number of tests (the full family), which can exceed
 * `pValues.length` if some pairs were dropped before ranking — but here we
 * pass every tested pair, so `m === pValues.length`.
 */
export function benjaminiHochberg(
  pValues: number[],
  m: number = pValues.length,
): number[] {
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);
  const q = new Array<number>(pValues.length);
  // Walk from the largest p (rank m) down, enforcing monotonicity so a
  // smaller p never gets a larger q than a larger p.
  let prev = 1;
  for (let rank = indexed.length; rank >= 1; rank--) {
    const { p, i } = indexed[rank - 1];
    const raw = (p * m) / rank;
    prev = Math.min(prev, raw);
    q[i] = Math.min(1, prev);
  }
  return q;
}

/**
 * Build a conservative, descriptive interpretation for a surviving pair.
 * Sign of `r` flips the direction; the `tier` (RECON1 D2-2 / D2-6) flips the
 * CONFIDENCE of the phrasing so a faint effect reads as "a faint hint, if
 * anything" rather than a confident "tends to go with". Never claims causation.
 *
 * The sentence is assembled from locale-keyed templates under
 * `insights.correlation.daily.*` (+ a per-locale direction word) so the calm,
 * never-causal framing survives verbatim in every language rather than leaking
 * English into a non-English UI.
 */
function interpret(
  behaviour: string,
  outcome: string,
  r: number,
  tier: ConfidenceTier,
  lagDays: number,
  t: Translate,
  behaviourLabel?: string,
  outcomeLabel?: string,
): string {
  const params = {
    behaviour: behaviourLabel ?? humanise(behaviour, t),
    outcome: outcomeLabel ?? humanise(outcome, t),
    direction: t(
      `insights.correlation.direction.${r < 0 ? "lower" : "higher"}`,
    ),
  };
  // faint = below the confident effect-size threshold (a real-but-small signal,
  // hedged); high = confident "tends to go with"; moderate = the in-between
  // "on the evidence so far" phrasing. Each tier keeps its own template.
  const tierKey =
    tier === "faint" ? "faint" : tier === "high" ? "high" : "moderate";
  // Lag 0 is the averaged same-day window of the exposure channels ("on the
  // day and the day before"); every other pair reads as next-day.
  const template = lagDays === 0 ? "dailySameDay" : "daily";
  return t(`insights.correlation.${template}.${tierKey}`, params);
}

/**
 * Localised, human-readable label for a channel key.
 *
 * v1.14.0 — a `FACTOR:<key>` channel (a RATED mood factor folded into the
 * matrix) strips its namespace prefix so the phrasing reads "rated <factor>"
 * rather than leaking the raw key. The prefix exists only to keep a factor
 * key from colliding with a `MeasurementType` in the channel set. The factor
 * name itself is user data, kept verbatim (lower-cased) inside the localised
 * `channelFactor` frame.
 *
 * Every other channel (measurement types, MOOD, medication compliance, symptom
 * severity, and the ENV_* exposure channels) resolves through a stable
 * `insights.correlation.channel.<KEY>` label, translated in all six locales.
 * An unknown key falls back to its prettified form so a newly-added channel
 * never blanks.
 */
function humanise(key: string, t: Translate): string {
  if (key.startsWith(FACTOR_CHANNEL_PREFIX)) {
    const factor = key
      .slice(FACTOR_CHANNEL_PREFIX.length)
      .replace(/[_-]/g, " ")
      .toLowerCase();
    return t("insights.correlation.channelFactor", { factor });
  }
  const labelKey = `insights.correlation.channel.${key}`;
  const label = t(labelKey);
  // The server translator echoes the key on a miss; fall back to a readable
  // prettified form so an unmapped channel degrades gracefully, never English-
  // leaks a raw key.
  return label === labelKey ? key.replace(/_/g, " ").toLowerCase() : label;
}

/** Namespace prefix for a RATED-mood-factor discovery channel (v1.14.0). */
export const FACTOR_CHANNEL_PREFIX = "FACTOR:";

/**
 * v1.21.0 (FDREXTEND) — stable channel key for the daily medication-compliance
 * adherence rate (per-day taken/scheduled, 0–100). Sourced from the compliance
 * engine's unified dose-history ledger, NOT a `MeasurementType`, so the caller
 * builds its series separately (the way MOOD is read from MoodEntry) and folds
 * it in. A BEHAVIOUR channel: the actionable, high-value direction is
 * "adherence dip today → a worse outcome tomorrow" (next-day symptom flare or a
 * vital drifting), so compliance lags the outcome by a day like every other
 * behaviour. It forms its own `metricFamily`, so the only pair the loop skips is
 * the compliance→compliance self-lag.
 */
export const MEDICATION_COMPLIANCE_CHANNEL_KEY = "MEDICATION_COMPLIANCE";

/**
 * v1.21.0 (FDREXTEND) — stable channel key for the daily symptom-severity /
 * functional-impact burden (0–3; 0 = healthy, 3 = bedbound). Sourced from the
 * illness day-log (`functionalImpact`, else max linked symptom severity), NOT a
 * `MeasurementType`. It rides BOTH roles like MOOD: as an OUTCOME it surfaces
 * "adherence dip today → symptom flare tomorrow"; as a BEHAVIOUR it surfaces
 * "symptom burden today → a vital drifting tomorrow". The same-family guard
 * skips only the symptom→symptom self-lag. The series is built only across the
 * span the user actually logs illness (healthy days inside that span = 0); a
 * user who never logs illness yields an EMPTY series that degrades to absent —
 * never a spurious all-zero constant that could fabricate a link.
 */
export const SYMPTOM_SEVERITY_CHANNEL_KEY = "SYMPTOM_SEVERITY";

/**
 * v1.21.0 (FDREXTEND) — discovery channels that are NOT `MeasurementType` enum
 * values: each is backed by a different model (MOOD → MoodEntry,
 * MEDICATION_COMPLIANCE → the dose-history ledger, SYMPTOM_SEVERITY → the
 * illness day-log). EVERY caller that derives a `MeasurementType[]` list from
 * `DISCOVERY_BEHAVIOURS` / `DISCOVERY_OUTCOMES` to feed a Prisma
 * `measurement.findMany({ where: { type: { in } } })` MUST exclude these — a
 * non-enum string in the `IN (...)` list errors the Postgres enum cast. Use
 * {@link discoveryMeasurementTypes} (or this set) rather than re-spelling the
 * `k !== "MOOD"` filter, so a future non-measurement channel cannot be missed at
 * one call site and crash its query.
 */
export const NON_MEASUREMENT_DISCOVERY_CHANNELS: ReadonlySet<string> = new Set([
  "MOOD",
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
]);

/**
 * v1.21.0 (FDREXTEND) — the subset of `keys` that ARE real `MeasurementType`
 * enum values (i.e. excluding every {@link NON_MEASUREMENT_DISCOVERY_CHANNELS}
 * channel), safe to splice into a Prisma `type IN (...)` filter. The cast is the
 * caller's existing `as MeasurementType[]` assertion — this only drops the
 * non-enum keys first.
 */
export function discoveryMeasurementTypes(keys: readonly string[]): string[] {
  return keys.filter((k) => !NON_MEASUREMENT_DISCOVERY_CHANNELS.has(k));
}

/**
 * Run the FDR-controlled discovery over the behaviour × outcome matrix.
 *
 * 1. For every (behaviour, outcome) pair, lag-join (D → D+lag, the series'
 *    own lag or the scan default), remove trend and season from both arms
 *    and run Pearson on the residuals with the effective-n p-value. Pairs
 *    below `minPairs` paired days, or too few to fit the basis, are dropped
 *    (not tested — they cannot be defensibly assessed).
 * 2. Across the tested pairs, compute BH q-values.
 * 3. Surface pairs with p < 0.05 AND q ≤ `fdrQ`, ranked by q then |r|.
 *
 * Pure — the caller fetches the daily series.
 */
export function discoverCorrelations(
  series: NamedSeries[],
  opts: {
    lagDays?: number;
    minPairs?: number;
    fdrQ?: number;
    /**
     * Reader's locale for the narrated `interpretation`.
     *
     * REQUIRED, and it must stay required. It used to be optional with an
     * English default, and the default is what shipped the bug: a caller could
     * say nothing and still get a finished sentence back, so the "Coach read"
     * strip on a German metric page printed its second line in English under a
     * German first line for months. Nobody had to write anything wrong for that
     * to happen — silence was enough. With no default, a caller that forgets
     * cannot compile, which is the only version of this that stays fixed.
     */
    locale: Locale;
  },
): CorrelationDiscoveryResult {
  const lagDays = opts.lagDays ?? 1;
  const minPairs = opts.minPairs ?? MIN_PAIRED_N;
  const fdrQ = opts.fdrQ ?? FDR_Q;
  // Named `translate` (not `t`) — the pair-mapping callbacks below bind `t` to
  // the RawPair element, so the translator must not shadow-collide with them.
  const { t: translate } = getServerTranslator(opts.locale);

  const behaviours = series.filter((s) => s.role === "behaviour");
  const outcomes = series.filter((s) => s.role === "outcome");

  const tested: RawPair[] = [];
  for (const b of behaviours) {
    for (const o of outcomes) {
      // RECON1 (D2-1) — skip same-metric-FAMILY lagged pairs, not just the exact
      // self-pair. A same-family lag (mood→mood, sys→any-BP) is a serial
      // auto-correlation tautology, not a cross-domain insight; excluding it
      // before testing stops it crowding out genuine cross-metric links.
      if (metricFamily(b.key) === metricFamily(o.key)) continue;
      const pairLag = b.lagDays ?? lagDays;
      const pairs = lagJoinPairs(b.points, o.points, pairLag);
      if (pairs.length < minPairs) continue;
      const result = seasonallyAdjustedPearson(pairs, { minPairs });
      if (result.status !== "ok") continue;
      tested.push({
        behaviour: b.key,
        outcome: o.key,
        n: result.n,
        nEff: result.effectiveN,
        r: result.r,
        pValue: result.pValue,
        lagDays: pairLag,
        behaviourLabel: b.label,
        outcomeLabel: o.label,
      });
    }
  }

  const pairsTested = tested.length;
  if (pairsTested === 0) {
    return { discovered: [], pairsTested: 0, fdrQ, minPairs };
  }

  const qValues = benjaminiHochberg(tested.map((t) => t.pValue));
  const discovered: DiscoveredCorrelation[] = tested
    .map((t, i) => ({ ...t, qValue: qValues[i] }))
    .filter((t) => t.pValue < 0.05 && t.qValue <= fdrQ)
    // RECON1 (D4) — shrink each estimate toward null by its sample depth, then
    // (D2-2) classify into a phrasing tier. A pair below the effect-size floor
    // tiers to `null` and is dropped: it is statistically real but explains too
    // little variance to narrate as a driver.
    .map((t) => {
      // v1.42 — shrink and tier by the EFFECTIVE size: a persistent pair's
      // 180 days may be worth 30 independent ones, and is narrated as such.
      const shrunkR = shrinkEstimate(t.r, t.nEff);
      const tier = confidenceTier(shrunkR, t.nEff);
      return { ...t, shrunkR, tier };
    })
    .filter(
      (
        t,
      ): t is RawPair & {
        qValue: number;
        shrunkR: number;
        tier: ConfidenceTier;
      } => t.tier !== null,
    )
    .map((t) => ({
      behaviour: t.behaviour,
      outcome: t.outcome,
      behaviourLabel: t.behaviourLabel,
      outcomeLabel: t.outcomeLabel,
      n: t.n,
      nEff: t.nEff,
      r: t.r,
      pValue: t.pValue,
      qValue: Math.round(t.qValue * 1000) / 1000,
      shrunkR: Math.round(t.shrunkR * 1000) / 1000,
      tier: t.tier,
      interpretation: interpret(
        t.behaviour,
        t.outcome,
        t.r,
        t.tier,
        t.lagDays,
        translate,
        t.behaviourLabel,
        t.outcomeLabel,
      ),
      lagDays: t.lagDays,
    }))
    // RECON1 (D2-2 / D4) — rank by the SHRUNK effect magnitude (a deep, strong
    // pair leads a thin one even if the thin one's raw r is higher), with q as
    // the tie-break so a tighter FDR still wins on equal effect.
    .sort(
      (a, b) =>
        Math.abs(b.shrunkR) - Math.abs(a.shrunkR) || a.qValue - b.qValue,
    );

  return { discovered, pairsTested, fdrQ, minPairs };
}

/**
 * The curated discovery matrix — the channels the engine pairs. Behaviours
 * (lag sources) on the left, outcomes (lag targets) on the right.
 *
 * v1.21.0 (FDREXTEND) — medication compliance is NOW a behaviour channel (its
 * cadence-aware per-day rate comes from the compliance engine's dose-history
 * ledger; the caller builds the series and folds it in, the way MOOD is read
 * from MoodEntry). Symptom severity rides both roles (see the OUTCOMES note).
 * Both are sparse, noisy inputs — the engine's existing n ≥ 20 / p < 0.05 /
 * BH-FDR / effect-size-floor / shrinkage gates apply UNCHANGED, so a thin
 * compliance or symptom series cannot surface a confident driver.
 */
export const DISCOVERY_BEHAVIOURS = [
  "TIME_IN_DAYLIGHT",
  "MOOD",
  "BLOOD_GLUCOSE",
  "BLOOD_PRESSURE_SYS",
  "ACTIVITY_STEPS",
  // v1.22 — sleep duration as a lag SOURCE too (it was outcome-only). This
  // opens the clinically-obvious "poor sleep last night → next-day mood / HRV /
  // a vital drifting" direction. The same-family guard collapses only the
  // sleep→sleep self-lag (the key is its own family), so sleep stays free to
  // pair cross-domain. The daily series is the same per-day collapse the outcome
  // role already uses, so neither role sees a fabricated value.
  "SLEEP_DURATION",
  // v1.21.0 (FDREXTEND) — daily adherence rate as a lag source: the high-value
  // "adherence dip today → a worse outcome tomorrow" direction.
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  // v1.21.0 (FDREXTEND) — symptom burden as a lag source too: "more symptomatic
  // today → a vital drifting tomorrow". Mirrored as an outcome below.
  SYMPTOM_SEVERITY_CHANNEL_KEY,
] as const;

export const DISCOVERY_OUTCOMES = [
  "SLEEP_DURATION",
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "WEIGHT",
  // v1.22 — blood pressure as an OUTCOME (it was behaviour-only). This makes
  // the clinically-obvious "medication adherence → next-day BP control" link
  // discoverable (compliance reached HRV / RHR / weight but never BP). Both
  // components are added so diastolic — previously never a candidate channel at
  // all — can correlate too. The same-family guard skips every
  // BP-behaviour → BP-outcome self/cross-component lag (serial autocorrelation),
  // so only genuine cross-domain behaviours (compliance, mood, daylight, …) →
  // BP survive. BH-FDR controls the wider pair family this opens up.
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  // v1.11.5 (F3) — mood is now an OUTCOME channel too, not only a behaviour.
  // The discovery loop skips the MOOD→MOOD self-pair (`b.key === o.key`), so
  // promoting it lets the FDR scan surface "behaviour today → next-day mood"
  // relations (e.g. more daylight today → better mood tomorrow) in addition
  // to the existing "mood today → next-day outcome" direction. BH-FDR
  // already controls the larger pair family this opens up.
  "MOOD",
  // v1.21.0 (FDREXTEND) — symptom severity as an OUTCOME: the flagship
  // "adherence dip today → symptom flare tomorrow" link (compliance behaviour →
  // symptom outcome). The same-family guard skips the symptom→symptom self-lag;
  // BH-FDR controls the wider family the dual-role channel opens up.
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  // Wrist temperature is a credible future OUTCOME channel (near-daily, so
  // n ≥ 20 is reachable; "did a hard workout / late alcohol raise next-night
  // temperature?"), but it is deliberately NOT a channel yet: it is
  // privacy-sensitive and deviation-framed, and folding it into the FDR
  // matrix risks surfacing a cycle-phase correlation that strays into
  // reproductive inference. Held pending a deliberate privacy review —
  // documented here so the omission is intentional, not a gap (same posture
  // as the medication-compliance omission above).
] as const;

// ─── v1.22 — rolling early-detection window ───────────────────────────────

/**
 * v1.22 — trailing window (days) for the rolling EARLY-detection pass.
 *
 * The standard discovery scan is retrospective: it needs n ≥ 20 paired days, so
 * a pattern only surfaces once ~3 weeks of overlap have accrued INSIDE the
 * 180-day window — it explains the past well but reacts slowly to an emerging
 * shift (an illness pulling HRV + sleep down together over the last fortnight).
 * This shorter window re-runs the SAME engine over only the trailing days so a
 * fresh, concentrated pattern can surface before the long window dilutes it.
 */
export const EARLY_WINDOW_DAYS = 21;

/**
 * v1.22 — paired-day floor for the early window. Lower than the retrospective
 * `MIN_PAIRED_N` (20) because 21 days cannot reach 20 lagged pairs, but still
 * high enough that Pearson is defensible. The shorter, noisier series is
 * counter-balanced by a TIGHTER FDR ({@link EARLY_FDR_Q}) and a no-faint effect
 * bar (see {@link discoverEmergingCorrelations}), so the early pass keeps a HIGH
 * firing bar despite the smaller n.
 */
export const EARLY_MIN_PAIRS = 12;

/**
 * v1.22 — tighter Benjamini-Hochberg target for the early window (vs the
 * retrospective {@link FDR_Q} = 0.10). A short window is noisier, so the early
 * pass demands a stricter false-discovery rate before it will narrate an
 * emerging pattern.
 */
export const EARLY_FDR_Q = 0.05;

/** Pure: keep only the points on/after `fromDayKey` (inclusive). */
export function filterSeriesToWindow(
  series: NamedSeries[],
  fromDayKey: string,
): NamedSeries[] {
  return series.map((s) => ({
    ...s,
    points: s.points.filter((p) => p.day >= fromDayKey),
  }));
}

/**
 * Separator joining the two channel names into a stable pair key. The
 * unit-separator character (U+241F) cannot appear in a correlation-channel
 * name, so two distinct pairs never collide. The key is used only for Set
 * membership (never split back), and lives for one discovery pass.
 */
const PAIR_KEY_SEP = "\u241F";

/** Stable pair identity for double-count exclusion. */
function pairKey(behaviour: string, outcome: string): string {
  return `${behaviour}${PAIR_KEY_SEP}${outcome}`;
}

export interface EmergingCorrelationResult {
  /**
   * Recent-window pairs that are NOT already established by the retrospective
   * scan — the genuinely emerging signals. Each is flagged `window: "recent"`
   * and `provisional: true`.
   */
  emerging: DiscoveredCorrelation[];
  /** Trailing window (days) the early pass scanned. */
  windowDays: number;
  /** Paired-day floor enforced for the early pass. */
  minPairs: number;
  /** FDR target the early pass used. */
  fdrQ: number;
  /** How many pairs were tested in the early window (honest footer). */
  pairsTested: number;
}

/**
 * v1.22 — rolling early-detection pass.
 *
 * Re-runs {@link discoverCorrelations} over only the trailing
 * {@link EARLY_WINDOW_DAYS} days (a lower n floor, a tighter FDR), then keeps
 * ONLY pairs that:
 *  1. are not already in the retrospective `discovered` set (no double-count —
 *     an established pattern is reported once, retrospectively), and
 *  2. clear a no-`faint` effect bar — over a short, noisy window a faint signal
 *     is too likely to be transient noise to narrate as "emerging".
 *
 * The early window runs its OWN Benjamini-Hochberg control across its OWN tested
 * family, so FDR discipline holds independently in each pass. Pure — the caller
 * passes the full series and the day key of the early-window start.
 */
export function discoverEmergingCorrelations(
  fullSeries: NamedSeries[],
  retrospective: CorrelationDiscoveryResult,
  opts: {
    recentFromDayKey: string;
    windowDays?: number;
    lagDays?: number;
    minPairs?: number;
    fdrQ?: number;
    /**
     * Reader's locale, threaded to the inner scan's narration. Required for the
     * same reason it is required on {@link discoverCorrelations} — an optional
     * locale here would put the English default straight back, one call deeper.
     */
    locale: Locale;
  },
): EmergingCorrelationResult {
  const windowDays = opts.windowDays ?? EARLY_WINDOW_DAYS;
  const minPairs = opts.minPairs ?? EARLY_MIN_PAIRS;
  const fdrQ = opts.fdrQ ?? EARLY_FDR_Q;

  const recentSeries = filterSeriesToWindow(fullSeries, opts.recentFromDayKey);
  const recent = discoverCorrelations(recentSeries, {
    lagDays: opts.lagDays,
    minPairs,
    fdrQ,
    locale: opts.locale,
  });

  const established = new Set(
    retrospective.discovered.map((d) => pairKey(d.behaviour, d.outcome)),
  );

  const emerging = recent.discovered
    // High firing bar for the noisier short window: drop faint-tier signals.
    .filter((d) => d.tier !== "faint")
    // No double-count: an already-established retrospective pair is reported
    // once (retrospectively), never re-surfaced as "emerging".
    .filter((d) => !established.has(pairKey(d.behaviour, d.outcome)))
    .map((d) => ({
      ...d,
      window: "recent" as const,
      provisional: true,
    }));

  return {
    emerging,
    windowDays,
    minPairs,
    fdrQ,
    pairsTested: recent.pairsTested,
  };
}

// ─── v1.22 — labs ↔ outcome correlation ───────────────────────────────────

/**
 * v1.22 — why labs are NOT a daily-lag channel in the matrix above.
 *
 * Lab draws are sparse and irregular (a panel every few months), so a day-D →
 * day-D+1 lagged Pearson with an n ≥ 20 paired-DAY floor is structurally
 * unreachable for a biomarker — folding `LAB:*` into `DISCOVERY_*` would only
 * add channels that always degrade to absent (dead candidates). The clinically
 * meaningful object for a sparse marker is different: each draw vs the
 * CONTEMPORANEOUS windowed mean of an outcome the marker plausibly reflects
 * (HbA1c ↔ the period's mean glucose; lipids ↔ weight). That is a point-vs-window
 * statistic over the DRAWS (n = number of draws), not a daily lag — so it gets
 * its own FDR-controlled pass here rather than a forced, never-firing channel.
 */

/** A single lab draw, day-keyed in the user's tz. */
export interface LabDrawPoint {
  /** Stable channel key — `LAB:<analyte>`. */
  key: string;
  /** Day key YYYY-MM-DD of the draw. */
  day: string;
  /** Numeric reading (qualitative rows are excluded by the caller). */
  value: number;
}

/** One discovered lab ↔ outcome association — descriptive, never causal. */
export interface DiscoveredLabCorrelation {
  /** `LAB:<analyte>` channel key (display strips the prefix). */
  lab: string;
  /** Outcome channel key it tracks with. */
  outcome: string;
  /** Number of draws paired with a usable contemporaneous outcome window. */
  n: number;
  /** Pearson r across (draw value, contemporaneous outcome window-mean). */
  r: number;
  pValue: number;
  qValue: number;
  /** Trailing days each draw's outcome window spanned. */
  windowDays: number;
  /** Conservative, descriptive interpretation — never causal. */
  interpretation: string;
}

export interface LabCorrelationResult {
  discovered: DiscoveredLabCorrelation[];
  /** Lab × outcome pairs assessed (honest footer). */
  pairsTested: number;
  fdrQ: number;
  /** Minimum paired-draw count enforced per pair. */
  minDraws: number;
}

/**
 * v1.22 — curated outcome channels a lab biomarker is paired against. Kept
 * small and physiologically broad (the flagship clinical wins the integration
 * audit names) so the lab × outcome family stays tight and BH-FDR stays honest:
 * a biomarker that tracks the period's mean weight, glucose, or systolic BP.
 */
export const LAB_OUTCOME_TARGETS: readonly string[] = [
  "WEIGHT",
  "BLOOD_GLUCOSE",
  "BLOOD_PRESSURE_SYS",
];

/** Default trailing window (days) each draw's outcome mean is taken over. */
export const LAB_OUTCOME_WINDOW_DAYS = 28;

/** Default minimum draws (paired with a usable outcome window) per lab pair. */
export const LAB_MIN_DRAWS = 5;

/** Default minimum outcome points inside a draw's window for it to count. */
export const LAB_MIN_WINDOW_POINTS = 5;

/** YYYY-MM-DD `daysBack` days before `day` (inclusive lower bound). */
function shiftDayBack(day: string, daysBack: number): string {
  return shiftDay(day, -daysBack);
}

/**
 * Mean of an outcome series over `(drawDay - windowDays, drawDay]` — the period
 * the marker physiologically reflects. Returns `null` when too few outcome
 * points fall in the window for a defensible mean. Pure.
 */
function outcomeWindowMean(
  outcome: DailySeriesPoint[],
  drawDay: string,
  windowDays: number,
  minPoints: number,
): number | null {
  const lower = shiftDayBack(drawDay, windowDays);
  let sum = 0;
  let count = 0;
  for (const p of outcome) {
    if (p.day > lower && p.day <= drawDay && Number.isFinite(p.value)) {
      sum += p.value;
      count += 1;
    }
  }
  return count >= minPoints ? sum / count : null;
}

/**
 * v1.22 — FDR-controlled labs ↔ outcome discovery.
 *
 * For each biomarker (grouped by `LabDrawPoint.key`) and each
 * {@link LAB_OUTCOME_TARGETS} outcome, pair every draw value with the
 * contemporaneous trailing-window mean of that outcome, then run Pearson + the
 * exact p-value across the draws. Benjamini-Hochberg controls the lab × outcome
 * family; the same effect-size floor + James-Stein shrinkage as the daily engine
 * gate the survivors. A sparse marker simply fails the `minDraws` floor and
 * degrades to absent — it never fabricates a link. Pure over already-fetched
 * draws + outcome series.
 */
export function discoverLabOutcomeCorrelations(
  labDraws: LabDrawPoint[],
  series: NamedSeries[],
  opts: {
    windowDays?: number;
    minDraws?: number;
    minWindowPoints?: number;
    fdrQ?: number;
    /**
     * Reader's locale for the narrated `interpretation`. Required — see
     * {@link discoverCorrelations}; a lab sentence leaks English just as
     * happily as a daily one.
     */
    locale: Locale;
  },
): LabCorrelationResult {
  const windowDays = opts.windowDays ?? LAB_OUTCOME_WINDOW_DAYS;
  const minDraws = opts.minDraws ?? LAB_MIN_DRAWS;
  const minWindowPoints = opts.minWindowPoints ?? LAB_MIN_WINDOW_POINTS;
  const fdrQ = opts.fdrQ ?? FDR_Q;
  // Named `translate` — the pair-mapping callback below binds `t` to its element.
  const { t: translate } = getServerTranslator(opts.locale);

  // Group draws by biomarker key (newest-irrelevant; Pearson is order-free).
  const drawsByLab = new Map<string, LabDrawPoint[]>();
  for (const d of labDraws) {
    if (!Number.isFinite(d.value)) continue;
    const list = drawsByLab.get(d.key) ?? [];
    list.push(d);
    drawsByLab.set(d.key, list);
  }

  // Index the curated outcome series by key (last-write keeps a single series
  // per key even when a channel appears in both roles).
  const outcomeByKey = new Map<string, DailySeriesPoint[]>();
  for (const s of series) {
    if (LAB_OUTCOME_TARGETS.includes(s.key)) outcomeByKey.set(s.key, s.points);
  }

  interface RawLabPair {
    lab: string;
    outcome: string;
    n: number;
    r: number;
    pValue: number;
  }
  const tested: RawLabPair[] = [];
  for (const [lab, draws] of drawsByLab) {
    for (const outcomeKey of LAB_OUTCOME_TARGETS) {
      const outcome = outcomeByKey.get(outcomeKey);
      if (!outcome || outcome.length === 0) continue;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const draw of draws) {
        const mean = outcomeWindowMean(
          outcome,
          draw.day,
          windowDays,
          minWindowPoints,
        );
        if (mean === null) continue;
        xs.push(draw.value);
        ys.push(mean);
      }
      if (xs.length < minDraws) continue;
      const result = pearson({ xs, ys, minPairs: minDraws });
      if (result.status !== "ok") continue;
      tested.push({
        lab,
        outcome: outcomeKey,
        n: result.n,
        r: result.r,
        pValue: result.pValue,
      });
    }
  }

  const pairsTested = tested.length;
  if (pairsTested === 0) {
    return { discovered: [], pairsTested: 0, fdrQ, minDraws };
  }

  const qValues = benjaminiHochberg(tested.map((t) => t.pValue));
  const discovered: DiscoveredLabCorrelation[] = tested
    .map((t, i) => ({ ...t, qValue: qValues[i] }))
    .filter((t) => t.pValue < 0.05 && t.qValue <= fdrQ)
    .map((t) => {
      const shrunkR = shrinkEstimate(t.r, t.n);
      const tier = confidenceTier(shrunkR, t.n);
      return { ...t, shrunkR, tier };
    })
    .filter(
      (
        t,
      ): t is RawLabPair & {
        qValue: number;
        shrunkR: number;
        tier: ConfidenceTier;
      } => t.tier !== null,
    )
    .map((t) => ({
      lab: t.lab,
      outcome: t.outcome,
      n: t.n,
      r: t.r,
      pValue: t.pValue,
      qValue: Math.round(t.qValue * 1000) / 1000,
      windowDays,
      interpretation: interpretLab(t.lab, t.outcome, t.r, t.tier, translate),
    }))
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r) || a.qValue - b.qValue);

  return { discovered, pairsTested, fdrQ, minDraws };
}

/** Strip the `LAB:` prefix for display. */
function humaniseLab(key: string): string {
  return key.startsWith("LAB:") ? key.slice("LAB:".length) : key;
}

/**
 * Descriptive, never-causal interpretation for a lab ↔ outcome pair.
 *
 * v1.22 — honour the confidence tier the way the daily engine's `interpret`
 * does: a surviving `faint`-tier pair (real, but below the confident
 * effect-size bar) reads as "a faint hint, if anything" rather than the
 * confident "line up with", so the narrated confidence never outruns the
 * effect. The clinician caveat stays on every tier.
 */
function interpretLab(
  lab: string,
  outcome: string,
  r: number,
  tier: ConfidenceTier,
  t: Translate,
): string {
  const params = {
    // The analyte name is user data — kept verbatim inside the localised frame.
    lab: humaniseLab(lab),
    outcome: humanise(outcome, t),
    direction: t(
      `insights.correlation.direction.${r < 0 ? "lower" : "higher"}`,
    ),
  };
  const tierKey = tier === "faint" ? "faint" : "default";
  return t(`insights.correlation.lab.${tierKey}`, params);
}
