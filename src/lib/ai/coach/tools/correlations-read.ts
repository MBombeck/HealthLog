/**
 * v1.21.0 (C3) — Coach correlations reader.
 *
 * Surfaces the deterministic insight engine's cross-metric intelligence to the
 * Coach via the `get_correlations` tool. Two read-only sources, both already
 * computed elsewhere and reused verbatim here (no new statistics):
 *
 *  - The FDR-controlled, day-D→D+1 lagged all-pairs discovery
 *    (`@/lib/insights/correlation-discovery`), over the channel set the one
 *    shared assembler builds (`@/lib/insights/discovery-matrix`). That is the
 *    same matrix the `/api/insights/correlations` route and the per-metric card
 *    scan, so the Coach never surfaces a pair the insight pages would not, and
 *    never misses one they would — same channels, same Pearson, same exact
 *    p-value, same Benjamini-Hochberg control. We return every surviving pair
 *    (not filtered to one metric) as a descriptive driver row.
 *
 *    This file claimed that parity from v1.21.0 and did not have it. When the
 *    environmental-exposure channels arrived in v1.25 and the custom-metric
 *    channels after them, both landed at the route and at the card and not
 *    here, because each surface folded its own channel list. The sentence above
 *    stayed, which is worse than no sentence: a reader checking whether the
 *    Coach could discuss barometric pressure and sleep found a promise that it
 *    could, and the pair had never been in its matrix. The promise is now
 *    structural — the assembler is the only place a matrix is built, frozen by
 *    `src/__tests__/discovery-matrix-guard.test.ts`.
 *  - The coincident-deviation flag (`computeCoincidentDeviation`): "two or more
 *    of your vitals are outside their usual band today", with the illness-
 *    explained reframe carried through.
 *
 * Grounding posture mirrors the other tools: a structured `{ present: false }`
 * when too little paired data exists for any pattern to survive (or the read
 * fails), never a throw and never an ambiguous empty list. The driver rows are
 * descriptive — direction + lag + n + the engine's own never-causal
 * interpretation string — so the Coach states the observed linkage without
 * inventing a relationship.
 */
import {
  UNBOUNDED_REACH,
  capDays,
  isBounded,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import { prisma } from "@/lib/db";
import { ENVIRONMENT_FIELDS } from "@/lib/environment/fields";
import type { Locale } from "@/lib/i18n/config";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { isSurfaceVisible } from "@/lib/modules/surface";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import {
  discoverCorrelations,
  discoverEmergingCorrelations,
  discoverLabOutcomeCorrelations,
  EARLY_WINDOW_DAYS,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
} from "@/lib/insights/correlation-discovery";
import { assembleDiscoveryMatrix } from "@/lib/insights/discovery-matrix";
import { fetchLabDraws } from "@/lib/insights/correlation-channel-series";
import {
  computeCoincidentDeviation,
  loadBaselineProfile,
  isDerivedOk,
} from "@/lib/insights/derived";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Trailing window for the discovery scan — mirrors the insight route. */
const WINDOW_DAYS = 180;

/** The coincident-deviation flag's own default window. */
const COINCIDENT_WINDOW_DAYS = 30;

/** One discovered driver pair, descriptive — never causal. */
export interface CoachCorrelationDriver {
  behaviour: string;
  outcome: string;
  /** "higher" / "lower" — sign of the next-day association. */
  direction: "higher" | "lower";
  /** Lag in days (always 1 today). */
  lagDays: number;
  /** Paired-day sample count after the lag join. */
  n: number;
  /** Pearson r, rounded for display. */
  r: number;
  /** The engine's conservative, descriptive interpretation. */
  note: string;
}

/** The coincident-deviation summary the Coach can narrate. */
export interface CoachCoincidentFlag {
  /** True when ≥2 vitals are outside their usual band on the latest day. */
  fired: boolean;
  /** The vitals outside their band (possible factors, never a cause). */
  contributing: Array<{ metric: string; direction: "above" | "below" }>;
  /** The day the flag was evaluated (YYYY-MM-DD). */
  day: string;
  /** True when an active illness episode explains the deviations. */
  illnessExplained: boolean;
}

/** One emerging (recent-window) driver — provisional, hedged. */
export interface CoachEmergingDriver extends CoachCorrelationDriver {
  /** Always true here — a recent-window signal on fewer days. */
  provisional: true;
}

/** One labs ↔ outcome association — descriptive, never causal. */
export interface CoachLabCorrelation {
  /** Display analyte name (LAB: prefix stripped). */
  lab: string;
  /** The outcome it tracks with. */
  outcome: string;
  direction: "higher" | "lower";
  /** Paired draws. */
  n: number;
  r: number;
  note: string;
}

export interface CoachCorrelationsResult {
  present: boolean;
  drivers?: CoachCorrelationDriver[];
  /**
   * v1.22 — emerging recent-window drivers NOT yet established by the 180-day
   * scan: early-detection signals the Coach narrates as provisional.
   */
  emerging?: CoachEmergingDriver[];
  /**
   * v1.22 — labs ↔ outcome associations (each draw vs the contemporaneous
   * outcome window-mean), FDR-controlled. Descriptive, never causal.
   */
  labDrivers?: CoachLabCorrelation[];
  coincident?: CoachCoincidentFlag;
  /** How many behaviour×outcome pairs were tested (honest footer). */
  pairsTested?: number;
  /** Trailing-day window the discovery scanned. */
  windowDays?: number;
  reason?: string;
}

/** Day key (YYYY-MM-DD) for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Natural labels for the non-measurement channel keys (read cleanly in prose).
 *
 * The environmental-exposure channels take their phrase from the one env field
 * vocabulary rather than a second hand-written list, so a new exposure field
 * cannot reach the Coach as "env pressure delta".
 */
const CHANNEL_LABELS: Record<string, string> = {
  [MEDICATION_COMPLIANCE_CHANNEL_KEY]: "medication adherence",
  [SYMPTOM_SEVERITY_CHANNEL_KEY]: "symptom severity",
  ...Object.fromEntries(
    ENVIRONMENT_FIELDS.map((field) => [field.key, field.narrationLabel]),
  ),
};

/**
 * Lower-case, space-separated label for a discovery channel.
 *
 * `label` is the engine's per-pair label for a DYNAMIC channel — today that is
 * a custom metric, whose key is `CUSTOM_METRIC:<cuid>`. It has to win over the
 * key: prettifying that key would put a database id into the Coach's prose.
 */
function humanise(key: string, label?: string): string {
  if (label && label.trim().length > 0) return label.trim().toLowerCase();
  return CHANNEL_LABELS[key] ?? key.replace(/_/g, " ").toLowerCase();
}

/**
 * Build the Coach correlations payload for a user. Returns `{ present: false }`
 * when no driver survives AND the coincident flag is not informative, when the
 * user has no correlatable data, or on any read/compute failure (best-effort —
 * a correlation hiccup must never break the chat turn).
 */
export async function readCoachCorrelations(
  userId: string,
  /**
   * The reader's locale. Every `note` this returns is a finished sentence that
   * some surface prints verbatim — the metric page's "Coach read" strip does
   * exactly that — so the language has to be decided by whoever knows who is
   * reading. No default: a caller that cannot name a locale is a caller that
   * does not know, and guessing English is how the strip came to answer a
   * German page in English.
   */
  locale: Locale,
  options?: {
    /**
     * The Coach's lookback limit: the scan, the early-detection pass and the
     * coincident flag read no further back than it. Absent (MCP, the metric
     * page strip): the fixed 180-day scan as before.
     */
    reach?: CoachHistoryReach;
  },
): Promise<CoachCorrelationsResult> {
  const reach = options?.reach ?? UNBOUNDED_REACH;
  const windowDays = capDays(WINDOW_DAYS, reach);
  const earlyDays = capDays(EARLY_WINDOW_DAYS, reach);
  // v1.30.22 — the `insights` gate lives HERE, at the read, not at each
  // caller. This reader is reached from four places (the Coach
  // `get_correlations` tool, the MCP `get_correlation` rich read, the
  // per-metric "Coach read" strip, and the Coach snapshot); only the REST
  // sibling `/api/insights/correlations` gated, so every other caller
  // defeated both the user's `insights` toggle and the operator availability
  // switch ANDed above it. Gating the reader closes all four at once and
  // means a future caller cannot reintroduce the gap by forgetting.
  //
  // OMIT rather than refuse: this is a per-domain read whose whole contract
  // is already `{ present: false }` for honest absence, and every caller
  // treats a miss as "no pattern to narrate". A throw here would break a
  // Coach turn for a user who simply turned a module off. The distinct
  // `module_disabled` reason keeps it honest — the assistant is told the
  // domain is off, not that no correlation exists.
  //
  // Deliberately OUTSIDE the try/catch: the fail-soft below turns any throw
  // into `{ present: false }`, so a gate placed inside would still close the
  // leak but would silently swallow a real gate failure. Out here, a broken
  // gate is loud.
  if (!(await isModuleEnabled(userId, "insights"))) {
    return { present: false, reason: "module_disabled" };
  }
  try {
    const profile = await loadBaselineProfile(prisma, userId);
    const userRow = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const tz = userRow?.timezone ?? DEFAULT_TIMEZONE;
    const since = new Date(Date.now() - windowDays * MS_PER_DAY);

    // The channel set is the shared one, so the Coach scans exactly what the
    // correlations page scans. The measurement read stays `"raw"` (the route's
    // rollup read-swap is a read-cost choice, not a channel-set one).
    //
    // v1.22 — the lab draws feed a separate point-vs-window pass, not the
    // matrix, so they are fetched alongside rather than assembled in.
    // Switched-off modules never reach the Coach: their channels are left out
    // of the scan and the lab pass is skipped with labs off.
    const modules = await resolveModuleMap(userId);
    const [matrix, coincidentDerived, labDraws] = await Promise.all([
      assembleDiscoveryMatrix(userId, { tz, since, fetchMode: "raw", modules }),
      // Coincident-deviation is its own derived metric — fail-soft to null so a
      // baseline hiccup never sinks the whole correlations read. D2-8: pass the
      // user's tz so the "today" grouping matches the user's calendar day, not
      // UTC's, before the fired flag is narrated as "out of band TODAY".
      computeCoincidentDeviation(userId, profile, {
        tz,
        ...(isBounded(reach)
          ? { windowDays: capDays(COINCIDENT_WINDOW_DAYS, reach) }
          : {}),
      }).catch(() => null),
      isSurfaceVisible("correlation:LAB_DRAWS", modules)
        ? fetchLabDraws(userId, tz, since)
        : Promise.resolve([]),
    ]);
    const { series, diagnostics } = matrix;

    // QA F1 — surfaces when a dense account's window exceeded the read cap,
    // mirroring the route's identical annotation. The cap now falls on the
    // OLDEST rows (desc + take), so a capped read still covers the recent
    // window the emerging-correlations pass below needs.
    annotate({
      action: { name: "coach.correlations.read" },
      meta: {
        measurements_capped: diagnostics.measurementsCapped,
        mood_entries_capped: diagnostics.moodCapped,
        // The environmental-exposure and custom-metric families
        // reach this path for the first time; these say whether they carried
        // anything on a given turn.
        environment_days: diagnostics.environmentDays,
        custom_metric_channels: diagnostics.customMetricChannels,
      },
    });

    const discovery = discoverCorrelations(series, { locale });
    const drivers: CoachCorrelationDriver[] = discovery.discovered.map((d) => ({
      behaviour: humanise(d.behaviour, d.behaviourLabel),
      outcome: humanise(d.outcome, d.outcomeLabel),
      direction: d.r >= 0 ? "higher" : "lower",
      lagDays: d.lagDays,
      n: d.n,
      r: Math.round(d.r * 100) / 100,
      note: d.interpretation,
    }));

    // v1.22 — rolling early-detection pass over the trailing window (re-uses
    // the already-built series). Emerging pairs exclude anything the 180-day
    // scan already established, so the Coach never narrates the same pattern as
    // both "established" and "emerging".
    const recentFromDayKey = tzDayKey(
      new Date(Date.now() - earlyDays * MS_PER_DAY),
      tz,
    );
    const emergingResult = discoverEmergingCorrelations(series, discovery, {
      recentFromDayKey,
      locale,
    });
    const emerging: CoachEmergingDriver[] = emergingResult.emerging.map(
      (d) => ({
        behaviour: humanise(d.behaviour, d.behaviourLabel),
        outcome: humanise(d.outcome, d.outcomeLabel),
        direction: d.r >= 0 ? "higher" : "lower",
        lagDays: d.lagDays,
        n: d.n,
        r: Math.round(d.r * 100) / 100,
        note: d.interpretation,
        provisional: true,
      }),
    );

    // v1.22 — labs ↔ outcome pass (point-vs-window over sparse draws).
    const labResult = discoverLabOutcomeCorrelations(labDraws, series, {
      locale,
    });
    const labDrivers: CoachLabCorrelation[] = labResult.discovered.map((d) => ({
      lab: d.lab.startsWith("LAB:") ? d.lab.slice("LAB:".length) : d.lab,
      // A lab pair's outcome is always a declared channel key, never a dynamic
      // one, so there is no per-pair label to prefer here.
      outcome: humanise(d.outcome),
      direction: d.r >= 0 ? "higher" : "lower",
      n: d.n,
      r: Math.round(d.r * 100) / 100,
      note: d.interpretation,
    }));

    const coincident = buildCoincidentFlag(coincidentDerived);

    // Nothing to say: no surviving driver of any kind AND the coincident flag is
    // either insufficient or quiet (not fired). Report a clean miss.
    if (
      drivers.length === 0 &&
      emerging.length === 0 &&
      labDrivers.length === 0 &&
      (!coincident || !coincident.fired)
    ) {
      return { present: false, reason: "no_significant_pattern" };
    }

    return {
      present: true,
      ...(drivers.length > 0 ? { drivers } : {}),
      ...(emerging.length > 0 ? { emerging } : {}),
      ...(labDrivers.length > 0 ? { labDrivers } : {}),
      ...(coincident ? { coincident } : {}),
      pairsTested: discovery.pairsTested,
      windowDays,
    };
  } catch {
    return { present: false, reason: "retrieval_failed" };
  }
}

/** Shape the derived coincident-deviation value into the Coach summary. */
function buildCoincidentFlag(
  derived: Awaited<ReturnType<typeof computeCoincidentDeviation>> | null,
): CoachCoincidentFlag | undefined {
  if (!derived || !isDerivedOk(derived)) return undefined;
  const v = derived.value;
  return {
    fired: v.fired,
    contributing: v.contributing.map((c) => ({
      metric: humanise(String(c.type)),
      direction: c.direction === "above" ? "above" : "below",
    })),
    day: v.day,
    illnessExplained: v.illnessExplained,
  };
}
