/**
 * v1.10.0 — derived-metrics block for the Coach prompt.
 *
 * Folds the v1.10 derived wellness layer into the Coach snapshot as
 * COMPACT summaries — one small object per metric carrying value + band +
 * coverage, never the raw series. The Coach narrates the same numbers the
 * dashboard rings render (single source of truth) without ballooning the
 * ~6k-token snapshot budget: a fully-populated block is ~8 tiny objects.
 *
 * Every entry reads the one `computeDerivedMetric` contract — no recompute.
 * A metric whose value is `insufficient` is OMITTED entirely (we never feed
 * the model "no data" noise; the snapshot's compactSections pass would drop
 * an empty key anyway).
 *
 * Server-only — calls the derived dispatcher, which reads `@/lib/db`.
 */
import {
  computeDerivedMetric,
  computeCoincidentDeviation,
  isDerivedOk,
  type DerivedMetricId,
  type BaselineProfile,
} from "@/lib/insights/derived";
import { prisma } from "@/lib/db";
import {
  isProxyRecovery,
  readCurrentCanonicalRecovery,
} from "@/lib/insights/derived/recovery-resolve";
import { recoverySourceLabelEn } from "@/lib/scores/registry";
import {
  SCORE_GREEN_FLOOR,
  SCORE_YELLOW_FLOOR,
} from "@/lib/analytics/score/shared";
import {
  UNBOUNDED_REACH,
  fitsReach,
  type CoachHistoryReach,
} from "./history-reach";

/**
 * The window each engine reads (its own `DEFAULT_WINDOW_DAYS`). Under a
 * lookback limit a metric whose window does not fit inside it is left out,
 * never computed over a shortened window: a 7-day readiness would disagree
 * with the 30-day ring the dashboard shows under the same name.
 */
const DERIVED_DEFAULT_WINDOW_DAYS: Readonly<
  Partial<Record<DerivedMetricId, number>>
> = {
  READINESS: 30,
  RECOVERY_SCORE: 14,
  STRESS_SCORE: 14,
  STRAIN_SCORE: 14,
  SLEEP_SCORE: 30,
  HRV_BALANCE: 30,
  FITNESS_AGE: 180,
  VASCULAR_AGE_DELTA: 365,
};

/** The coincident-deviation flag's own default window. */
const COINCIDENT_DEFAULT_WINDOW_DAYS = 30;

/** The high-signal derived metrics worth a Coach prompt slot. The vitals
 *  baseline is omitted — the per-vital aggregate block already carries those
 *  numbers; here we add the composites + scores the aggregates can't express. */
const SNAPSHOT_METRICS: DerivedMetricId[] = [
  "READINESS",
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
  "SLEEP_SCORE",
  "HRV_BALANCE",
  "FITNESS_AGE",
  "VASCULAR_AGE_DELTA",
];

/** One compact line per derived metric the model can ground a reply in. */
interface DerivedSnapshotEntry {
  /** 0–100 score, the recent average, or the re-framed device value. */
  value: number;
  /** The metric's band/category in plain words (green/yellow/red, etc.). */
  band?: string;
  /** Confidence 0–100 from the coverage model. */
  confidence?: number;
  /** Days of history backing the value. */
  historyDays: number;
  /**
   * What the number is, when the metric id alone would mislead: a device's
   * recovery under the device's own name ("WHOOP Recovery"), the stress and
   * strain scores as HealthLog's estimates.
   */
  label?: string;
  /**
   * READINESS only, when the blend does not describe today: the local day it
   * rests on. Such an entry carries no band; it is the last blend, not
   * today's.
   */
  asOfDay?: string;
}

/** The label each estimate carries, so the model never reads it as measured. */
const ESTIMATE_LABEL: Partial<Record<DerivedMetricId, string>> = {
  STRESS_SCORE: "stress (HealthLog estimate)",
  STRAIN_SCORE: "strain (HealthLog estimate)",
};

/**
 * v1.21.0 — the coincident-deviation flag, compactly. "Two or more
 * of your vitals are outside their usual band today." Descriptive multi-signal
 * co-movement, never a cause; carries the illness-explained reframe. Folded
 * into the derived block so BOTH Coach paths (the tool path via
 * get_illness_recovery/get_correlations AND the no-tools snapshot floor) can
 * narrate it. Omitted entirely when it did not fire (no noise).
 */
interface CoincidentSnapshotEntry {
  fired: true;
  /** The out-of-band vitals (possible factors), e.g. "resting heart rate above". */
  contributing: string[];
  /** The day the flag was evaluated (YYYY-MM-DD). */
  day: string;
  /** True when an active illness episode explains the deviations. */
  illnessExplained: boolean;
}

/**
 * v1.21.2 — the Tension Verdict flag, compactly. The readiness/recovery
 * composite blends several contributors; when they DISAGREE (e.g. good sleep
 * but a suppressed HRV-balance or an elevated resting pulse) the single band
 * hides the conflict. This flag names the honest "internal read" the model
 * narrates on the health-score card — "good sleep, but resting pulse is up — the
 * composite lands yellow" — instead of papering the conflict over.
 *
 * DESCRIPTIVE multi-signal disagreement, never a cause. Computed deterministically
 * server-side off the readiness contributors (each 0..100, higher = better); the
 * model narrates the flag, it never invents it. Omitted entirely when the
 * contributors agree (no tension to surface).
 *
 * CLINICAL-FLOORS OVERRIDE: `clinicalOverride` is true when a clinical red-flag
 * is in play (the coincident-deviation flag fired WITHOUT an illness explanation).
 * The narration must NOT reconcile a real red-flag away into a calm verdict — the
 * flag carries the bit so the prompt clause can refuse the soft landing.
 */
interface TensionSnapshotEntry {
  fired: true;
  /** The composite band the disagreement resolved to (green/yellow/red). */
  band: string;
  /** Contributors reading FAVOURABLY, e.g. "sleep". */
  positive: string[];
  /** Contributors reading UNFAVOURABLY, e.g. "resting heart rate", "HRV balance". */
  negative: string[];
  /** True when a real clinical red-flag is in play — never reconcile it away. */
  clinicalOverride: boolean;
}

/**
 * The derived block: per-metric compact score entries (keyed by metric id),
 * plus the optional fired-only coincident-deviation flag under its own reserved
 * `COINCIDENT_DEVIATION` key. The score entries keep their `DerivedSnapshotEntry`
 * shape (so callers + tests read `block.READINESS.value` directly); the
 * coincident + tension flags ride alongside without widening the score index
 * signature.
 */
type DerivedSnapshotBlock = Record<string, DerivedSnapshotEntry> & {
  COINCIDENT_DEVIATION?: CoincidentSnapshotEntry;
  TENSION?: TensionSnapshotEntry;
};

/**
 * v1.21.2 — a contributor reading at/above this 0..100 score is FAVOURABLE;
 * at/below `TENSION_LOW_SCORE` it is UNFAVOURABLE. The gap in the middle is
 * "neutral" — neither side of a disagreement. A genuine tension needs at least
 * one contributor on EACH side.
 */
export const TENSION_HIGH_SCORE = SCORE_GREEN_FLOOR;
/**
 * The highest contributor score that still reads unfavourably: the top of
 * the red band of the one band rule (`scoreBand`, red below
 * `SCORE_YELLOW_FLOOR`), so "unfavourable" here and "red" on the ring are the
 * same judgement. `TENSION_HIGH_SCORE` is the green floor for the same reason.
 */
export const TENSION_LOW_SCORE = SCORE_YELLOW_FLOOR - 1;

/** Human-readable contributor labels (no internal enum names reach the model). */
const READINESS_CONTRIBUTOR_LABEL: Record<string, string> = {
  rhr: "resting heart rate",
  hrv: "HRV balance",
  sleep: "sleep",
  respiratory: "respiratory rate",
  mood: "mood stability",
};

/**
 * v1.21.2 — derive the Tension Verdict from the readiness contributors.
 * Pure: a list of `{ key, value }` contributors (value 0..100, higher = better,
 * null = absent) plus the composite band and the clinical-override bit. Returns
 * the fired flag ONLY when at least one contributor reads favourably AND at least
 * one reads unfavourably — a genuine internal disagreement. Null otherwise.
 */
export function deriveTension(
  contributors: Array<{ key: string; value: number | null }>,
  band: string | undefined,
  clinicalOverride: boolean,
): TensionSnapshotEntry | null {
  const positive: string[] = [];
  const negative: string[] = [];
  for (const c of contributors) {
    if (c.value === null) continue;
    const label = READINESS_CONTRIBUTOR_LABEL[c.key] ?? c.key;
    if (c.value >= TENSION_HIGH_SCORE) positive.push(label);
    else if (c.value <= TENSION_LOW_SCORE) negative.push(label);
  }
  if (positive.length === 0 || negative.length === 0) return null;
  return {
    fired: true,
    band: band ?? "yellow",
    positive,
    negative,
    clinicalOverride,
  };
}

/** Pull the headline number + band off each metric's value shape. */
function summariseValue(
  metric: DerivedMetricId,
  value: unknown,
): { value: number; band?: string } | null {
  const v = value as Record<string, unknown>;
  switch (metric) {
    case "READINESS":
    case "SLEEP_SCORE":
    case "RECOVERY_SCORE":
    case "STRESS_SCORE":
    case "STRAIN_SCORE":
      return typeof v.score === "number"
        ? {
            value: v.score,
            band: typeof v.band === "string" ? v.band : undefined,
          }
        : null;
    case "HRV_BALANCE":
      return typeof v.recentAvg === "number"
        ? {
            value: Math.round(v.recentAvg),
            band: typeof v.band === "string" ? v.band : undefined,
          }
        : null;
    case "FITNESS_AGE":
      return typeof v.vo2Max === "number"
        ? {
            value: Math.round(v.vo2Max * 10) / 10,
            band:
              typeof v.fitnessAgeDeltaYears === "number"
                ? `${v.fitnessAgeDeltaYears >= 0 ? "+" : ""}${v.fitnessAgeDeltaYears}yr vs age`
                : undefined,
          }
        : null;
    case "VASCULAR_AGE_DELTA":
      return typeof v.vascularAge === "number"
        ? {
            value: Math.round(v.vascularAge),
            band:
              typeof v.deltaYears === "number"
                ? `${v.deltaYears >= 0 ? "+" : ""}${Math.round(v.deltaYears)}yr vs age`
                : undefined,
          }
        : null;
    default:
      return null;
  }
}

/**
 * Build the compact derived block, or `null` when no derived metric resolved
 * to `ok`. Each entry is value + band + confidence + historyDays — the model
 * never sees the underlying series. Computes the metrics sequentially off the
 * one shared profile (no per-metric profile re-read).
 */
export async function buildDerivedSnapshotBlock(
  userId: string,
  profile: BaselineProfile,
  now: Date,
  tz?: string,
  reach: CoachHistoryReach = UNBOUNDED_REACH,
): Promise<DerivedSnapshotBlock | null> {
  const block: Record<string, DerivedSnapshotEntry> = {};
  // Every engine keeps its own window; one that does not fit is not run.
  const fits = (metric: DerivedMetricId) =>
    fitsReach(
      DERIVED_DEFAULT_WINDOW_DAYS[metric] ?? COINCIDENT_DEFAULT_WINDOW_DAYS,
      reach,
    );

  // v1.21.0 — the coincident-deviation flag, fired-only. Computed
  // off the one shared profile alongside the scores; fail-soft to null so a
  // baseline hiccup never sinks the derived block. Only attached when it
  // FIRED (≥2 vitals out of band today) — a quiet day adds no entry, keeping
  // the snapshot noise-free. D2-8: pass the user's tz so the "today" grouping
  // matches the user's calendar day, not UTC's.
  // Its 30-day baseline is left out, like any block, under a shorter limit.
  const coincidentPromise = fitsReach(COINCIDENT_DEFAULT_WINDOW_DAYS, reach)
    ? computeCoincidentDeviation(userId, profile, {
        now,
        ...(tz ? { tz } : {}),
      }).catch(() => null)
    : Promise.resolve(null);

  // The metrics are independent passthrough reads off the one shared profile —
  // no ordering dependency — so compute them concurrently. Per-metric fault
  // isolation: a transient failure on one must never sink the whole Coach turn,
  // so each compute resolves to null on throw rather than rejecting the batch.
  const computed = await Promise.all(
    SNAPSHOT_METRICS.filter(fits).map(async (metric) => {
      try {
        return {
          metric,
          derived: await computeDerivedMetric({
            metric,
            userId,
            profile,
            now,
          }),
        };
      } catch {
        return { metric, derived: null };
      }
    }),
  );

  // v1.21.2 — capture the readiness contributors so the Tension Verdict can
  // read the per-contributor directions the composite band hides. Only the
  // readiness blend exposes them; recovery resolves to the same proxy when no
  // device-native row exists, so reading readiness once is enough.
  let readinessContributors: Array<{ key: string; value: number | null }> = [];
  let readinessBand: string | undefined;
  let readinessFresh = false;

  for (const { metric, derived } of computed) {
    if (derived === null) continue;
    if (!isDerivedOk(derived)) continue; // omit insufficient — no noise
    const summary = summariseValue(metric, derived.value);
    if (!summary) continue;
    const entry: DerivedSnapshotEntry = {
      value: summary.value,
      band: summary.band,
      confidence: derived.confidence.score,
      historyDays: derived.coverage.historyDays,
    };
    const estimate = ESTIMATE_LABEL[metric];
    if (estimate) entry.label = estimate;
    if (metric === "READINESS") {
      const v = derived.value as {
        band?: string;
        fresh?: boolean;
        asOfDay?: string;
        components?: Array<{ key: string; value: number | null }>;
      };
      readinessFresh = v.fresh === true;
      readinessBand = typeof v.band === "string" ? v.band : undefined;
      readinessContributors = Array.isArray(v.components)
        ? v.components.map((c) => ({ key: c.key, value: c.value }))
        : [];
      // A blend that does not describe today is the last one, not today's:
      // no band, and the day it rests on.
      if (!readinessFresh) {
        delete entry.band;
        if (typeof v.asOfDay === "string") entry.asOfDay = v.asOfDay;
      }
    }
    block[metric] = entry;
  }

  // Recovery: one rule (`isProxyRecovery`). The recovery value rests on the
  // canonical row of the latest night. When that row is the COMPUTED proxy it
  // is HealthLog's own readiness blend, so beside READINESS it would hand the
  // model one measure under two names: drop it. A device's recovery (WHOOP,
  // Oura, Polar) stays even when it equals readiness, under the device's own
  // name, since it is a different measure.
  if (block.RECOVERY_SCORE !== undefined) {
    // The recovery line exists only when its 14-day window fits, so this
    // read of the same window lies inside the limit too.
    const current = await readCurrentCanonicalRecovery(
      prisma,
      userId,
      now,
      tz,
    ).catch(() => null);
    if (current === null) {
      delete block.RECOVERY_SCORE;
    } else if (isProxyRecovery(current)) {
      if (block.READINESS !== undefined) delete block.RECOVERY_SCORE;
    } else {
      block.RECOVERY_SCORE.label = `${recoverySourceLabelEn(current.source)} (device score)`;
    }
  }

  // Attach the coincident-deviation flag (fired-only) — the await happens here
  // so the score computes above run concurrently with it. It rides under its
  // own reserved key alongside the score entries.
  const out: DerivedSnapshotBlock = block;
  const coincident = await coincidentPromise;
  const coincidentFired =
    coincident !== null && isDerivedOk(coincident) && coincident.value.fired;
  if (coincidentFired) {
    out.COINCIDENT_DEVIATION = {
      fired: true,
      contributing: coincident.value.contributing.map(
        (c) =>
          `${String(c.type).replace(/_/g, " ").toLowerCase()} ${c.direction}`,
      ),
      day: coincident.value.day,
      illnessExplained: coincident.value.illnessExplained,
    };
  }

  // v1.21.2 — the Tension Verdict. A real clinical red-flag is in play when
  // the coincident-deviation flag fired WITHOUT an illness explanation; the flag
  // carries that bit so the narration never reconciles a red-flag into a calm
  // verdict (clinical-floors override). Only attached when the contributors
  // genuinely disagree — a coherent readiness adds no entry.
  const clinicalOverride =
    coincidentFired && !coincident.value.illnessExplained;
  // A stale blend's contributors describe an earlier day; no tension on them.
  const tension = readinessFresh
    ? deriveTension(readinessContributors, readinessBand, clinicalOverride)
    : null;
  if (tension) out.TENSION = tension;

  return Object.keys(out).length > 0 ? out : null;
}
