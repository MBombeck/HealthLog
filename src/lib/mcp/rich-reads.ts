/**
 * Phase 4 — deep-value MCP read tools (engine glue).
 *
 * Four "bring data into relation" reads, each a THIN re-export of an existing
 * server-authoritative engine — no new statistics, no new business logic
 * (REQ-WONT-2 / catalogue §5):
 *
 *   1. get_correlation     — one named driver pair out of the FDR-controlled,
 *                            lag-aware discovery (`readCoachCorrelations`, the
 *                            same engine the Coach `get_correlations` tool and
 *                            the `/api/insights/correlations` route run).
 *   2. compare_metric      — two trailing-window or two-metric rollup snapshots
 *                            side by side (`readBestGranularityRollups` +
 *                            `aggregateWmyBuckets`) with structured deltas.
 *   3. get_metric_baseline — the metric's personal usual range (median ± k·MAD)
 *                            + today's placement, via `buildCoachReadStrip`
 *                            (the same engine the metric-page "Coach read" strip
 *                            renders).
 *   4. detect_changepoints — level shifts in a metric over the rollup tier, via
 *                            a minimal in-repo CUSUM binary-segmentation over the
 *                            rollup bucket means (no heavy dependency, high
 *                            firing bar).
 *
 * Grounding contract (REQ-SEC-2/3/4, ADR-004): every read returns structured
 * values + units + reference bands + provenance and uses `{ present: false }`
 * for absence / insufficiency — never a silent zero, never a prose verdict or
 * diagnosis. Associations are described, never asserted as causal. `userId` is
 * the session-narrowed id passed by the caller, never a tool argument
 * (REQ-SEC-5). All reads are read-only.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { windowWeighting } from "@/lib/measurements/day-statistic";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import { readCoachCorrelations } from "@/lib/ai/coach/tools/correlations-read";
import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";
import { resolveLocaleForUser } from "@/lib/i18n/user-locale";
import {
  buildLocalisedLabelIndex,
  foldLabel,
  type LocalisedLabelEntry,
} from "@/lib/i18n/localised-label-index";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import {
  readBestGranularityRollups,
  aggregateWmyBuckets,
  type RollupBucketRow,
} from "@/lib/rollups/measurement-read-wmy";
import {
  getMetricStatusMeta,
  METRIC_STATUS_IDS,
  type MetricStatusMetricId,
} from "@/lib/insights/metric-status-registry";
import { allSignals, getSignal } from "@/lib/signals/registry";
import { classifyAgainstEffectiveRange } from "@/lib/labs/reference-range";
import { resolveLabFields } from "@/lib/labs/serialise";
import { sanitizeValueText } from "@/lib/ai/coach/labs-snapshot";
import { scrubFenceMarkers } from "@/lib/ai/coach/data-fence";
import { encodeOffsetCursor } from "@/lib/mcp/pagination";
import type { CoachScopeWindow } from "@/lib/ai/coach/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An explicit, arbitrary ISO date range the rich reads can take in place of one
 * of the five fixed trailing windows. Bounds are inclusive. The range is served
 * over the SAME rollup tier the trailing windows use: the reader fetches the
 * trailing buckets reaching back to `from` (the largest granularity that still
 * resolves that span) and the rich read filters them to `[from, to]` — no new
 * persisted analytics, no recompute. A coarse granularity (WEEK / MONTH /
 * YEAR) is selected automatically for a range that reaches far into the past,
 * and the resolved granularity is reported on the result.
 */
export interface DateRange {
  /** Inclusive lower bound (ISO-8601 instant). */
  from: string;
  /** Inclusive upper bound (ISO-8601 instant). */
  to: string;
}

/**
 * Validate + normalise an explicit `{from,to}` range to millisecond bounds.
 * Returns `null` for a missing, unparseable, or inverted range so the caller
 * falls back to the trailing-window path rather than reading a nonsense span.
 */
function resolveRangeMs(
  range: DateRange | undefined,
): { fromMs: number; toMs: number } | null {
  if (!range) return null;
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  if (toMs <= fromMs) return null;
  return { fromMs, toMs };
}

/** Trailing-day count for each window the rich reads accept. */
const WINDOW_DAYS: Record<CoachScopeWindow, number> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  lastYear: 365,
  // The rollup tier caps "all time" timelines at one year elsewhere; keep the
  // rich reads bounded to the same ceiling so the token budget stays sane.
  allTime: 365,
};

// v1.30.4 (C3, documented not fixed) — the trailing windows above resolve to
// `since = now − N·86400_000ms` (`readBestGranularityRollups`,
// `measurement-read-wmy.ts`), a raw-instant cutoff with no timezone
// awareness. The Coach snapshot path (`get_metric_series`) builds its
// timelines on user-tz day keys (`tzDayKey(userTz)`, the v1.30.3 pattern also
// used by `metric-status.ts`'s cache rollover / `bp-in-target.ts`'s same-day
// pairing); these rich reads (`compare_metric` / `detect_changepoints` /
// `get_metric_baseline`) do not, so a user far from UTC can see a ±1-day edge
// wobble vs. the app for a window boundary that lands mid-day in their own
// tz. This is INTENTIONALLY left as a raw-instant cutoff rather than patched
// with a tz-shifted `since` here: the underlying `MeasurementRollup` DAY /
// WEEK / MONTH / YEAR buckets themselves are written on UTC calendar
// boundaries (`measurement-rollups.ts` buckets on `Date.UTC(...)` /
// `getUTCDay()`), not the user's own tz, so shifting only the outer window
// boundary would not eliminate the wobble — it would just move which
// UTC-anchored bucket sits at the edge, trading one one-sided inconsistency
// for another. A real fix needs the rollup tier itself to bucket per-user-tz,
// which is a write-side change (affecting every rollup consumer, not just
// the rich MCP reads) — out of scope here. Practical impact stays small: the
// exposed windows are all ≥7-day means, so a single boundary day shifts the
// mean by well under its own noise floor.

function windowToDays(window: CoachScopeWindow | undefined): number {
  return WINDOW_DAYS[window ?? "last30days"];
}

// ── Metric resolution ────────────────────────────────────────────────
//
// A scalar metric the rich reads can place on a single rollup series, carrying
// its canonical unit + population reference band (when a broadly-accepted one
// exists). Most entries are derived straight from the single-source
// `metric-status-registry`; a small explicit supplement covers the headline
// specialised metrics (weight / pulse / BMI) the registry intentionally omits.

export interface RichMetric {
  /** The DB `MeasurementType` the rollup tier + baseline engine read against. */
  measurementType: MeasurementType;
  /** Human label for the resolved metric (provenance / narration). */
  label: string;
  /** Canonical storage unit. */
  unit: string;
  /** Population reference band, or `null` when no universal band exists. */
  band: { low: number; high: number } | null;
  /**
   * v1.30.4 (G4/HRV union) — a secondary `MeasurementType` to read instead of
   * `measurementType` when the user has ZERO rows of the primary type. HRV is
   * the only metric that carries one today: Apple Health / Fitbit write SDNN
   * (`HEART_RATE_VARIABILITY`); Oura / Polar / WHOOP write nightly RMSSD
   * (`HRV_RMSSD`) only. Mirrors the app's HRV sub-page fallback
   * (`HealthKitMetricPage`'s `fallbackMeasurementType` prop) so a ring/strap
   * -only account resolves over MCP the same data it sees in the app instead
   * of a false `{ present: false }`.
   */
  fallbackMeasurementType?: MeasurementType;
}

/** Headline specialised metrics the status registry does not carry. */
const SUPPLEMENT: Record<string, RichMetric> = {
  weight: {
    measurementType: "WEIGHT",
    label: "Weight",
    unit: "kg",
    // No universal healthy band — body-size dependent; defer to own baseline.
    band: null,
  },
  pulse: {
    measurementType: "PULSE",
    label: "Pulse",
    unit: "bpm",
    band: { low: 60, high: 100 },
  },
  bmi: {
    measurementType: "BODY_MASS_INDEX",
    label: "Body-mass index",
    unit: "kg/m²",
    band: { low: 18.5, high: 25 },
  },
};

/** Friendly aliases (Coach source slugs + natural phrasings) → registry id. */
const ALIASES: Record<string, string> = {
  resting_hr: "RESTING_HEART_RATE",
  resting_heart_rate: "RESTING_HEART_RATE",
  hrv: "HEART_RATE_VARIABILITY",
  spo2: "OXYGEN_SATURATION",
  blood_oxygen: "OXYGEN_SATURATION",
  vo2_max: "VO2_MAX",
  vo2max: "VO2_MAX",
  steps: "STEPS",
  glucose: "BLOOD_GLUCOSE",
  blood_glucose: "BLOOD_GLUCOSE",
  sleep: "SLEEP_DURATION",
  sleep_duration: "SLEEP_DURATION",
  distance: "WALKING_RUNNING_DISTANCE",
  active_energy: "ACTIVE_ENERGY",
  body_temp: "BODY_TEMPERATURE",
  body_temperature: "BODY_TEMPERATURE",
  daylight: "TIME_IN_DAYLIGHT",
  respiratory_rate: "RESPIRATORY_RATE",
  walking_hr: "WALKING_HEART_RATE_AVERAGE",
};

function fromRegistry(id: string): RichMetric | null {
  const meta = getMetricStatusMeta(id);
  if (!meta) return null;
  // v1.30.4 (C2) — the signal registry's `surfaces.mcp` flag is documented as
  // the SINGLE source of truth for MCP exposure, but the metric-status
  // registry (this function's own source) carries no `surfaces` facet of its
  // own, so an id the signal registry marks `mcp:false` (e.g.
  // `CARDIO_RECOVERY`, `WRIST_TEMPERATURE`, `SLEEP_SCORE`, `DAY_STRAIN`, the
  // stair speeds, …) still resolved here — the two registries disagreeing
  // about the exposure contract, not a live leak (none of those ids are
  // actually sensitive) but a future signal added `mcp:false` + a
  // metric-status entry would leak silently. Treat an EXPLICIT `mcp:false` on
  // the SAME id in the signal registry as a hard veto over a metric-status
  // hit; an id absent from the signal registry (most of `METRIC_STATUS_IDS`)
  // is unaffected — metric-status stays authoritative when the two don't
  // disagree. The one exemption is the reviewed metric-status discovery
  // allowlist (`REVIEWED_DISCOVERY_IDS`): those ids are a deliberate,
  // human-named MCP exposure — co-equal to a signal `mcp:true` — so a
  // `mcp:false` on the same signal must NOT strip their resolvability, or
  // `compare_metric` / `get_metric_baseline` would advertise a metric in
  // discovery that then refuses to resolve.
  const sig = getSignal(id);
  if (
    sig &&
    sig.kind === "measurement" &&
    sig.surfaces.mcp === false &&
    !REVIEWED_DISCOVERY_IDS.has(id)
  ) {
    return null;
  }
  const metric: RichMetric = {
    measurementType: meta.measurementType,
    label: meta.displayName,
    unit: meta.unit,
    band: meta.normalRange
      ? { low: meta.normalRange.low, high: meta.normalRange.high }
      : null,
  };
  // v1.30.4 (G4/HRV union) — single choke point every registry-backed
  // resolution path (alias / exact id / display-name match) flows through,
  // so the RMSSD fallback attaches uniformly regardless of how the caller
  // phrased the metric.
  if (metric.measurementType === "HEART_RATE_VARIABILITY") {
    return { ...metric, fallbackMeasurementType: "HRV_RMSSD" };
  }
  return metric;
}

/**
 * v1.30.4 (G4/HRV union) — swap `metric` to its `fallbackMeasurementType`
 * when the user has zero rows of the primary type but has rows of the
 * fallback. Same primary-then-fallback rule the HRV sub-page applies
 * (`usingFallback = primaryCount === 0 && fallbackCount > 0`); a no-op for
 * every metric that doesn't carry a fallback (i.e. everything but HRV
 * today), and for an HRV account that has SDNN data at all.
 */
async function withHrvFallback(
  userId: string,
  metric: RichMetric,
): Promise<RichMetric> {
  if (!metric.fallbackMeasurementType) return metric;
  const primaryCount = await prisma.measurement.count({
    where: { userId, type: metric.measurementType, deletedAt: null },
  });
  if (primaryCount > 0) return metric;
  const fallbackCount = await prisma.measurement.count({
    where: { userId, type: metric.fallbackMeasurementType, deletedAt: null },
  });
  if (fallbackCount === 0) return metric;
  return { ...metric, measurementType: metric.fallbackMeasurementType };
}

// ── v1.25 clinical signals (registry-grounded, MCP-owned exposure) ────
//
// The v1.25 clinical-signals wave added a set of physical / clinical
// measurements to the signal registry. They sit OFF the Coach snapshot by
// design (`coachSnapshot:false`), so the Coach-driven reads
// (`get_metric_series`, the data inventory) never surface them — that path
// would report no data for a signal it does not carry. The MCP layer exposes
// them here through the rollup-backed rich reads — `compare_metric`,
// `get_metric_baseline`, `detect_changepoints` — and through `search` /
// `fetch`.
//
// The registry's own `surfaces.mcp` flag is the SINGLE source of truth for
// MCP exposure: a signal surfaces here iff it is a measurement marked
// `mcp:true` while staying off the Coach snapshot (`coachSnapshot:false`).
// The `mcp` and `coachSnapshot` facets are independent — a signal can be
// MCP-readable without being on the Coach surface. Deliberately ABSENT and
// therefore unreachable over MCP: the PHQ-9 / GAD-7 mental-health screeners
// and every environmental (`ENV_*`) signal — they carry `mcp:false` and never
// reach AI / MCP by construction.

/** Build a `RichMetric` from a registry signal key (measurement-kind only). */
function richMetricFromSignal(key: string): RichMetric | null {
  const sig = getSignal(key);
  if (!sig || sig.kind !== "measurement") return null;
  return {
    measurementType: sig.source.measurementType,
    label: sig.displayName,
    unit: sig.unit,
    band: sig.normalRange
      ? { low: sig.normalRange.low, high: sig.normalRange.high }
      : null,
  };
}

/**
 * The MCP-only clinical signals, derived from the registry: every measurement
 * signal marked `mcp:true` that stays off the Coach snapshot. This is the one
 * place the registry's `surfaces.mcp` flag is consumed for the rich reads —
 * no duplicate allowlist to drift against.
 */
const CLINICAL_SIGNAL_BY_KEY = new Map<string, RichMetric>();
for (const sig of allSignals()) {
  if (
    sig.kind !== "measurement" ||
    sig.surfaces.mcp !== true ||
    sig.surfaces.coachSnapshot !== false
  ) {
    continue;
  }
  const metric = richMetricFromSignal(sig.key);
  if (metric) CLINICAL_SIGNAL_BY_KEY.set(sig.key, metric);
}

/**
 * The clinical signals the MCP surface exposes, for the `search` discovery
 * probe: the registry key (the `metric:` id `fetch` resolves), the backing
 * `MeasurementType` (the presence probe), and the display label.
 */
export const MCP_CLINICAL_SIGNALS: ReadonlyArray<{
  key: string;
  measurementType: MeasurementType;
  label: string;
}> = [...CLINICAL_SIGNAL_BY_KEY.entries()].map(([key, m]) => ({
  key,
  measurementType: m.measurementType,
  label: m.label,
}));

/** Friendly aliases (NL phrasings) → clinical signal key. */
const CLINICAL_ALIASES: Record<string, string> = {
  grip: "GRIP_STRENGTH",
  grip_strength: "GRIP_STRENGTH",
  hand_grip: "GRIP_STRENGTH",
  hand_grip_strength: "GRIP_STRENGTH",
  pain: "PAIN_NRS",
  pain_nrs: "PAIN_NRS",
  pain_score: "PAIN_NRS",
  waist: "WAIST_CIRCUMFERENCE",
  waist_circumference: "WAIST_CIRCUMFERENCE",
  whtr: "WAIST_TO_HEIGHT",
  waist_to_height: "WAIST_TO_HEIGHT",
  waist_to_height_ratio: "WAIST_TO_HEIGHT",
  waist_height_ratio: "WAIST_TO_HEIGHT",
};

/**
 * Resolve a free-text name to a clinical signal the MCP layer exposes, or
 * `null`. Closed by construction to the registry-derived `mcp:true` measurement
 * set, so a screener key (PHQ9_SCORE / GAD7_SCORE) or an `ENV_*` key — all
 * `mcp:false` — can never resolve here even though they exist in the registry.
 */
function resolveClinicalSignal(key: string): RichMetric | null {
  const aliased = CLINICAL_ALIASES[key];
  if (aliased) return CLINICAL_SIGNAL_BY_KEY.get(aliased) ?? null;
  const upper = key.toUpperCase();
  if (CLINICAL_SIGNAL_BY_KEY.has(upper)) {
    return CLINICAL_SIGNAL_BY_KEY.get(upper) ?? null;
  }
  // Display-name match over the allowlist (e.g. "waist-to-height ratio").
  for (const [, metric] of CLINICAL_SIGNAL_BY_KEY) {
    if (metric.label.toLowerCase().replace(/[\s-]+/g, "_") === key) {
      return metric;
    }
  }
  return null;
}

// ── v1.30 coverage review (G5/C4) — metric-status-only discovery ─────
//
// `resolveRichMetric` already resolves any `metric-status-registry` id via an
// exact-id or display-name match (steps 3–4 above), so `compare_metric` /
// `get_metric_baseline` / `detect_changepoints` CAN serve these metrics today.
// But none of them is in the Coach data inventory (`list_metrics`, the
// `measurements-inventory` resource) or the `search` probe, so a
// discover-before-fetch assistant — which the server's own instructions
// direct — never learns they exist. The v1.28.52 dashboard-tile wave
// surfaced several of these ("collected but unsurfaced") in the app; the MCP
// wire still had that gap.
//
// Deliberately a fixed, reviewed allowlist (not derived from `surfaces.mcp` —
// reconciling that flag against this resolution path is a separate follow-up)
// so no metric becomes discoverable here without a human having named it.

const METRIC_STATUS_DISCOVERY_IDS = [
  "WRIST_TEMPERATURE",
  "CARDIO_RECOVERY",
  "SLEEP_SCORE",
  "BREATHING_DISTURBANCES",
  "ANS_CHARGE",
  "DAY_STRAIN",
  "WORKOUT_STRAIN",
  "CARDIO_LOAD",
  "FALL_COUNT",
  "SIX_MINUTE_WALK_DISTANCE",
  "STAIR_ASCENT_SPEED",
  "STAIR_DESCENT_SPEED",
  "ENERGY_EXPENDITURE_KJ",
] as const satisfies readonly MetricStatusMetricId[];

/**
 * The reviewed metric-status discovery allowlist as a membership Set. Each
 * member is a DELIBERATE, human-named MCP exposure (v1.30.4 coverage review) —
 * co-equal to a signal-registry `mcp:true`, just carried in the metric-status
 * layer instead of the signal layer. `fromRegistry`'s `mcp:false` veto exempts
 * these ids so a reviewed metric stays resolvable (`compare_metric` /
 * `get_metric_baseline` / `detect_changepoints`); the veto still fires for any
 * UNREVIEWED `mcp:false` signal that happens to carry a metric-status entry
 * (the two mental-health screeners and every `ENV_*` signal are absent from
 * this list and have no metric-status entry, so they stay unreachable).
 */
const REVIEWED_DISCOVERY_IDS: ReadonlySet<string> = new Set(
  METRIC_STATUS_DISCOVERY_IDS,
);

/**
 * The metric-status-only ids `list_metrics` / the inventory resource /
 * `search` can now discover: the registry id (also the `metric:` id `fetch`
 * resolves), the backing `MeasurementType` (the presence probe), and the
 * display label. Mirrors the shape of `MCP_CLINICAL_SIGNALS`.
 */
export const MCP_METRIC_STATUS_DISCOVERY: ReadonlyArray<{
  key: MetricStatusMetricId;
  measurementType: MeasurementType;
  label: string;
}> = METRIC_STATUS_DISCOVERY_IDS.map((id) => {
  const meta = getMetricStatusMeta(id);
  if (!meta) {
    // Would only trip if the registry ever dropped one of these ids — fail
    // loudly at module load rather than silently under-advertising.
    throw new Error(`metric-status registry is missing discovery id ${id}`);
  }
  return {
    key: id,
    measurementType: meta.measurementType,
    label: meta.displayName,
  };
});

/**
 * Presence + approximate sample count for the metric-status-only discovery
 * set, in the `list_metrics` inventory-row shape — `tool` fixed to
 * `compare_metric` (a resolver-closed metric with no Coach-snapshot series
 * fetches through `compare_metric` / `get_metric_baseline`, never
 * `get_metric_series`). One grouped presence query, mirroring the
 * `MCP_CLINICAL_SIGNALS` `search` probe. `list_metrics` and the
 * `measurements-inventory` resource both append these rows to their own
 * inventory so a discover-before-fetch assistant can find a metric that IS
 * resolvable but sits off the Coach snapshot.
 */
export async function metricStatusDiscoveryRows(userId: string): Promise<
  Array<{
    tool: string;
    domain: string;
    present: boolean;
    count?: number;
    metric: string;
  }>
> {
  const rows = await prisma.measurement.groupBy({
    by: ["type"],
    where: {
      userId,
      type: { in: MCP_METRIC_STATUS_DISCOVERY.map((s) => s.measurementType) },
    },
    _count: { _all: true },
  });
  const countByType = new Map(rows.map((r) => [r.type, r._count._all]));

  // v1.30.22 — drop a metric whose owning module the account has off (or the
  // operator switched off server-wide). Discovery is the assistant's map of
  // what exists; advertising a metric that `compare_metric` will then refuse
  // both leaks the fact that the domain is tracked and sends the assistant
  // down a dead end. Gating here keeps discovery and fetch telling the same
  // story. Metrics no module owns are unaffected.
  const gated = await Promise.all(
    MCP_METRIC_STATUS_DISCOVERY.map(async (sig) => {
      const owner = moduleForMeasurementType(sig.measurementType);
      if (owner && !(await isModuleEnabled(userId, owner))) return null;
      return sig;
    }),
  );

  return gated.flatMap((sig) => {
    if (!sig) return [];
    const count = countByType.get(sig.measurementType);
    return {
      tool: "compare_metric",
      domain: sig.label,
      present: count !== undefined,
      ...(count !== undefined ? { count } : {}),
      metric: sig.key,
    };
  });
}

// ── localised metric names ───────────────────────────────────────────
//
// Every other step of `resolveRichMetric` compares against ENGLISH: the alias
// tables and the metric-status registry's `displayName`. Five of the six
// shipped languages could therefore not name a metric at all — `poids` and
// `sommeil` resolved to nothing over MCP even though the app renders exactly
// those words.
//
// The names are not this file's to invent: `MEASUREMENT_TYPE_LABEL_KEYS`
// already binds every `MeasurementType` to the i18n key the app labels it
// with, and every bundle carries that key. So the index is DERIVED — one
// entry per (measurement type × shipped locale) — and a seventh language
// starts resolving the moment its bundle lands.
//
// A value is attached only for the metrics the English resolver can ALREADY
// produce (`SUPPLEMENT`, the registry-derived clinical allowlist, and the
// metric-status ids that survive `fromRegistry`'s `mcp:false` veto), so the
// index widens SPELLINGS, never exposure. A screener or an `ENV_*` signal is
// value-less here for the same reason it is unresolvable in English.
//
// Every OTHER measurement type is still entered, value-less, because
// ambiguity has to be judged over the whole label space rather than over the
// exposed slice of it. French and Italian once called body fat and fat mass
// by one phrase ("masse grasse" / "massa grassa") while only one of the two
// was exposed, so an index that knew about the exposed one alone would have
// seen no collision and answered kilograms to someone who asked for a
// percentage. Those labels are distinct now; the whole-space check stays so a
// future bundle cannot reintroduce the trap unseen.
//
// The alias tables stay as they are and stay English: `resting_hr`, `spo2`,
// `vo2max` are protocol slugs, not translations of anything.
const LOCALISED_METRIC_INDEX = (() => {
  const exposed = new Map<MeasurementType, RichMetric>();
  const claim = (metric: RichMetric | null) => {
    if (metric && !exposed.has(metric.measurementType)) {
      exposed.set(metric.measurementType, metric);
    }
  };
  for (const metric of Object.values(SUPPLEMENT)) claim(metric);
  for (const metric of CLINICAL_SIGNAL_BY_KEY.values()) claim(metric);
  for (const id of METRIC_STATUS_IDS) claim(fromRegistry(id));

  const entries: LocalisedLabelEntry<RichMetric | null>[] = Object.entries(
    MEASUREMENT_TYPE_LABEL_KEYS,
  ).map(([type, messageKey]) => ({
    id: type,
    messageKey,
    value: exposed.get(type as MeasurementType) ?? null,
  }));
  return buildLocalisedLabelIndex(entries);
})();

/**
 * Words two different measurement types claim in some bundle, and which
 * therefore resolve to neither. Exported so the guard can pin the set, which
 * is empty: a NEW member is a regression to look at rather than something to
 * resolve by coin flip.
 */
export const LOCALISED_METRIC_NAME_COLLISIONS: ReadonlySet<string> =
  LOCALISED_METRIC_INDEX.ambiguous;

/**
 * Resolve a free-text metric name to a single scalar series. Forgiving for an
 * NL assistant (alias, exact id, the metric's name in any shipped language,
 * or an English display-name fragment) but closed — an unresolved name
 * returns `null` so the tool reports `{ present: false }` rather than
 * inventing a series. Multi-series metrics (blood pressure) are not
 * resolvable here by design; the prompt + `get_metric_series` cover BP.
 */
export function resolveRichMetric(input: string): RichMetric | null {
  const raw = input.trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");

  // 1. explicit supplement (weight / pulse / bmi).
  if (SUPPLEMENT[key]) return SUPPLEMENT[key];

  // 1b. v1.25 clinical signals the MCP layer opts in (grip strength, pain NRS,
  // waist circumference, waist-to-height). Registry-grounded; the allowlist is
  // closed, so a mental-health screener or an environmental signal never
  // resolves here.
  const clinical = resolveClinicalSignal(key);
  if (clinical) return clinical;

  // 2. friendly alias → registry id.
  const aliased = ALIASES[key];
  if (aliased) return fromRegistry(aliased);

  // 3. exact registry id (case-insensitive).
  const upper = key.toUpperCase();
  if ((METRIC_STATUS_IDS as readonly string[]).includes(upper)) {
    const direct = fromRegistry(upper);
    if (direct) return direct;
  }

  // 4. the metric's own name, in any shipped language, matched EXACTLY.
  //
  // Ahead of the substring pass below on purpose: an exact name beats a loose
  // English fragment. It has to, or a short name in another language loses to
  // an unrelated English word that merely contains it — "Puls" (de/pl) landed
  // on PULSE_WAVE_VELOCITY, because "pulse-wave velocity" contains "puls".
  // A value-less hit (a metric this surface does not expose) falls through
  // rather than short-circuiting, so the English behaviour below is untouched.
  const localised = LOCALISED_METRIC_INDEX.index.get(foldLabel(raw));
  if (localised) return localised;

  // 5. English display-name substring match (e.g. "heart-rate variability").
  const needle = raw.toLowerCase();
  for (const id of METRIC_STATUS_IDS) {
    const meta = getMetricStatusMeta(id);
    if (!meta) continue;
    const name = meta.displayName.toLowerCase();
    if (name === needle || name.includes(needle) || needle.includes(name)) {
      return fromRegistry(id);
    }
  }
  return null;
}

/**
 * v1.30.22 — the module-gated resolver every rich read must use.
 *
 * `resolveRichMetric` answers "does this name resolve to a series?"; it says
 * nothing about whether the account is allowed to read that series. The three
 * rollup-backed reads (`compare_metric` / `get_metric_baseline` /
 * `detect_changepoints`) deliberately bypass `buildCoachSnapshot`, which is
 * where the module narrowing lives for the Coach-routed reads — so they
 * inherited no gate at all. `get_metric_series` honestly reported
 * `{ present: false }` for a glucose-disabled account while
 * `get_metric_baseline` handed back the median, the MAD band and today's
 * placement for the same metric. That defeats the user toggle AND the
 * operator availability switch `resolveModuleMap` ANDs above it — on the one
 * surface that egresses to a third-party assistant.
 *
 * Gating at the RESOLVER rather than per tool is the point: a new read that
 * takes a free-text metric name has to resolve it, and resolving it gates it.
 *
 * OMIT rather than refuse. These are per-domain reads whose contract already
 * carries `{ present: false, reason }` for absence, matching what
 * `get_metric_series` / `get_nutrients` / `get_intraday_pulse` already do for
 * a disabled module. The `module_disabled` reason is distinct from `no_data`
 * so the assistant is told the domain is switched off rather than inferring
 * the user has no readings.
 *
 * A metric no module owns (`moduleForMeasurementType` → `null`) resolves
 * ungated — see `UNSCOPED_REVIEWED_TYPES` for the reviewed set that answers
 * null and why gating them would be wrong.
 */
async function resolveRichMetricForUser(
  userId: string,
  input: string,
): Promise<
  { ok: true; metric: RichMetric } | { ok: false; reason: RichMissReason }
> {
  const resolved = resolveRichMetric(input);
  if (!resolved) return { ok: false, reason: "unknown_metric" };

  const owner = moduleForMeasurementType(resolved.measurementType);
  if (owner && !(await isModuleEnabled(userId, owner))) {
    return { ok: false, reason: "module_disabled" };
  }

  // The HRV union may swap the metric to its RMSSD fallback. Both types are
  // owned by `recovery`, but gate the RESULT too so a future fallback pair
  // that crosses a module boundary cannot smuggle a gated type through.
  const metric = await withHrvFallback(userId, resolved);
  if (metric.measurementType !== resolved.measurementType) {
    const fallbackOwner = moduleForMeasurementType(metric.measurementType);
    if (fallbackOwner && !(await isModuleEnabled(userId, fallbackOwner))) {
      return { ok: false, reason: "module_disabled" };
    }
  }
  return { ok: true, metric };
}

/** The miss reasons the module-gated resolver can produce. */
type RichMissReason = "unknown_metric" | "module_disabled";

// ── 1. get_correlation ───────────────────────────────────────────────

export interface CorrelationResult {
  present: boolean;
  reason?: string;
  /** The matched driver pair (descriptive, never causal). */
  pair?: {
    behaviour: string;
    outcome: string;
    direction: "higher" | "lower";
    lagDays: number;
    n: number;
    r: number;
    note: string;
  };
  /** Honest footer — pairs tested + window the discovery scanned. */
  pairsTested?: number;
  windowDays?: number;
  /** Constant marker so the model never re-frames the link as causal. */
  association?: "descriptive";
}

function norm(label: string): string {
  return label.trim().toLowerCase();
}

/** True when `a`/`b` (either order) match the driver's behaviour/outcome. */
function pairMatches(
  behaviour: string,
  outcome: string,
  a: string,
  b: string,
): boolean {
  const contains = (hay: string, needle: string) =>
    hay.includes(needle) || needle.includes(hay);
  return (
    (contains(behaviour, a) && contains(outcome, b)) ||
    (contains(behaviour, b) && contains(outcome, a))
  );
}

/**
 * Return the FDR-controlled, lag-aware association between two named metrics.
 * Pure re-export: runs the SAME discovery the Coach `get_correlations` tool and
 * the insight route run, then selects the surviving pair (strongest |r|) that
 * matches the requested two metrics — never re-computing a relationship the
 * engine did not surface. Honest `{ present: false }` when no surviving pair
 * matches (sparse data, or the link did not clear the engine's floors).
 */
export async function getCorrelation(
  userId: string,
  args: { metricA: string; metricB: string },
): Promise<CorrelationResult> {
  const a = norm(args.metricA);
  const b = norm(args.metricB);
  // The `note` on each driver is a finished sentence the MCP client shows as
  // it stands, so it is written in the account's language, not English.
  const result = await readCoachCorrelations(
    userId,
    await resolveLocaleForUser(userId),
  );

  if (!result.present || !result.drivers || result.drivers.length === 0) {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_correlation", present: false },
    });
    return {
      present: false,
      reason: result.reason ?? "no_significant_pattern",
      pairsTested: result.pairsTested,
      windowDays: result.windowDays,
    };
  }

  const matches = result.drivers.filter((d) =>
    pairMatches(norm(d.behaviour), norm(d.outcome), a, b),
  );
  if (matches.length === 0) {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_correlation", present: false },
    });
    return {
      present: false,
      reason: "no_significant_pattern_for_pair",
      pairsTested: result.pairsTested,
      windowDays: result.windowDays,
    };
  }

  const best = matches.reduce((acc, cur) =>
    Math.abs(cur.r) > Math.abs(acc.r) ? cur : acc,
  );
  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "get_correlation", present: true },
  });
  return {
    present: true,
    pair: {
      behaviour: best.behaviour,
      outcome: best.outcome,
      direction: best.direction,
      lagDays: best.lagDays,
      n: best.n,
      r: best.r,
      note: best.note,
    },
    pairsTested: result.pairsTested,
    windowDays: result.windowDays,
    association: "descriptive",
  };
}

// ── 2. compare_metric ────────────────────────────────────────────────

interface MetricWindowSnapshot {
  label: string;
  unit: string;
  band: { low: number; high: number } | null;
  windowDays: number;
  granularity: string;
  count: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** Lower bound when the side was an explicit `{from,to}` range. */
  from?: string;
  /** Upper bound when the side was an explicit `{from,to}` range. */
  to?: string;
}

export interface CompareMetricResult {
  present: boolean;
  reason?: string;
  mode?: "metric_vs_metric" | "window_vs_window";
  a?: MetricWindowSnapshot;
  b?: MetricWindowSnapshot;
  /** Delta b − a, only when both sides share a unit; null otherwise. */
  delta?: { mean: number; pct: number | null } | null;
}

/** One side's horizon: an explicit range wins over a trailing window. */
interface SideSpec {
  window?: CoachScopeWindow;
  range?: DateRange;
}

async function snapshotMetricWindow(
  userId: string,
  metric: RichMetric,
  windowDays: number,
): Promise<MetricWindowSnapshot | null> {
  const read = await readBestGranularityRollups(
    userId,
    metric.measurementType,
    windowDays,
  );
  if (!read || read.rows.length === 0) return null;
  const agg = aggregateWmyBuckets(
    read.rows,
    windowWeighting(metric.measurementType),
  );
  if (agg.count === 0) return null;
  return {
    label: metric.label,
    unit: metric.unit,
    band: metric.band,
    windowDays,
    granularity: read.granularity,
    count: agg.count,
    mean: agg.mean,
    min: agg.min,
    max: agg.max,
  };
}

/**
 * Snapshot a metric over an explicit `{from,to}` range. Reuses the SAME rollup
 * reader the trailing-window path uses: it fetches the trailing buckets reaching
 * back to `from` (so the largest granularity that still resolves that reach is
 * picked) and filters them to `[from, to]`. No new persisted analytics.
 */
async function snapshotMetricRange(
  userId: string,
  metric: RichMetric,
  fromMs: number,
  toMs: number,
): Promise<MetricWindowSnapshot | null> {
  // Reach back far enough to cover `from`; the upper bound is applied below.
  const reachDays = Math.ceil((Date.now() - fromMs) / DAY_MS);
  if (!Number.isFinite(reachDays) || reachDays <= 0) return null;
  const read = await readBestGranularityRollups(
    userId,
    metric.measurementType,
    reachDays,
  );
  if (!read) return null;
  const rows = read.rows.filter((r) => {
    const t = r.bucketStart.getTime();
    return t >= fromMs && t <= toMs;
  });
  if (rows.length === 0) return null;
  const agg = aggregateWmyBuckets(
    rows,
    windowWeighting(metric.measurementType),
  );
  if (agg.count === 0) return null;
  return {
    label: metric.label,
    unit: metric.unit,
    band: metric.band,
    windowDays: Math.max(1, Math.round((toMs - fromMs) / DAY_MS)),
    granularity: read.granularity,
    count: agg.count,
    mean: agg.mean,
    min: agg.min,
    max: agg.max,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

/** Snapshot one comparison side — an explicit range wins over a window. */
function snapshotSide(
  userId: string,
  metric: RichMetric,
  spec: SideSpec,
): Promise<MetricWindowSnapshot | null> {
  const range = resolveRangeMs(spec.range);
  if (range) {
    return snapshotMetricRange(userId, metric, range.fromMs, range.toMs);
  }
  return snapshotMetricWindow(userId, metric, windowToDays(spec.window));
}

/**
 * Compare a metric against another metric (same horizon) OR a single metric
 * across two horizons. Each horizon is either one of the five fixed trailing
 * windows OR an explicit `{from,to}` range (e.g. before vs after a date). Pure
 * re-export of the WMY rollup reader + the linear `aggregateWmyBuckets`
 * composition — no new math. A delta is only computed when both sides carry the
 * same unit, so the result never compares unlike scales. `{ present: false }`
 * when neither side has data.
 */
export async function compareMetric(
  userId: string,
  args: {
    metric: string;
    metricB?: string;
    window?: CoachScopeWindow;
    windowB?: CoachScopeWindow;
    range?: DateRange;
    rangeB?: DateRange;
  },
): Promise<CompareMetricResult> {
  const resolvedA = await resolveRichMetricForUser(userId, args.metric);
  if (!resolvedA.ok) {
    return { present: false, reason: resolvedA.reason };
  }
  const metricA = resolvedA.metric;
  const sideA: SideSpec = { window: args.window, range: args.range };

  const annotateMiss = () =>
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "compare_metric", present: false },
    });

  let mode: "metric_vs_metric" | "window_vs_window";
  let metricB: RichMetric;
  let sideB: SideSpec;

  if (args.metricB) {
    const resolvedB = await resolveRichMetricForUser(userId, args.metricB);
    if (!resolvedB.ok) {
      annotateMiss();
      // Side B carries its own suffixed miss reasons so the assistant can tell
      // which half of the comparison failed. A gated side B refuses the whole
      // comparison rather than silently degrading to a one-sided answer.
      return {
        present: false,
        reason:
          resolvedB.reason === "module_disabled"
            ? "module_disabled_b"
            : "unknown_metric_b",
      };
    }
    // Both metrics share side A's horizon (window or range).
    mode = "metric_vs_metric";
    metricB = resolvedB.metric;
    sideB = sideA;
  } else if (args.rangeB || args.windowB) {
    mode = "window_vs_window";
    metricB = metricA;
    sideB = { window: args.windowB, range: args.rangeB };
  } else {
    annotateMiss();
    return { present: false, reason: "specify_metricB_window_or_range" };
  }

  const [a, b] = await Promise.all([
    snapshotSide(userId, metricA, sideA),
    snapshotSide(userId, metricB, sideB),
  ]);

  if (!a || !b) {
    annotateMiss();
    return {
      present: false,
      reason: "no_data",
      mode,
      ...(a ? { a } : {}),
      ...(b ? { b } : {}),
    };
  }

  let delta: { mean: number; pct: number | null } | null = null;
  if (a.unit === b.unit && a.mean !== null && b.mean !== null) {
    const diff = b.mean - a.mean;
    delta = {
      mean: diff,
      pct: a.mean !== 0 ? (diff / Math.abs(a.mean)) * 100 : null,
    };
  }

  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "compare_metric", present: true },
  });
  return { present: true, mode, a, b, delta };
}

// ── 3. get_metric_baseline ───────────────────────────────────────────

export interface MetricBaselineResult {
  present: boolean;
  reason?: string;
  metric?: string;
  unit?: string;
  /** The user's personal usual range (median ± k·MAD) + sample transparency. */
  baseline?: { low: number; high: number; sampleDays: number };
  /** Today's latest reading. */
  latest?: number;
  /** Where the latest reading sits relative to the personal band. */
  placement?: "within" | "above" | "below";
  /** Population reference band, or `null` when none exists for the metric. */
  referenceBand?: { low: number; high: number } | null;
  /** The single strongest lagged driver of this metric, or `null`. */
  driver?: { note: string; behaviour: string; outcome: string } | null;
}

/**
 * Return where today's value sits against the user's own usual range. Pure
 * re-export of `buildCoachReadStrip` — the SAME median ± k·MAD baseline engine
 * (`computeVitalsBaseline`) + lagged-driver pick the metric page renders. Below
 * the engine's 7-day history floor the band is not asserted (`{ present: false,
 * reason: "insufficient_history" }`) — never a fabricated range. The population
 * reference band rides along as general context even on a miss.
 */
export async function getMetricBaseline(
  userId: string,
  args: { metric: string },
): Promise<MetricBaselineResult> {
  const resolved = await resolveRichMetricForUser(userId, args.metric);
  if (!resolved.ok) {
    return { present: false, reason: resolved.reason };
  }
  const metric = resolved.metric;

  const strip = await buildCoachReadStrip(
    userId,
    metric.measurementType,
    await resolveLocaleForUser(userId),
  );

  if (!strip.baseline) {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_metric_baseline", present: false },
    });
    return {
      present: false,
      reason: strip.learning ? "insufficient_history" : "no_data",
      metric: metric.label,
      unit: metric.unit,
      referenceBand: metric.band,
    };
  }

  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "get_metric_baseline", present: true },
  });
  return {
    present: true,
    metric: metric.label,
    unit: metric.unit,
    baseline: {
      low: strip.baseline.low,
      high: strip.baseline.high,
      sampleDays: strip.baseline.sampleDays,
    },
    latest: strip.baseline.latest,
    placement: strip.baseline.placement,
    referenceBand: metric.band,
    driver: strip.driver,
  };
}

// ── 4. detect_changepoints ───────────────────────────────────────────

export interface Changepoint {
  /** Bucket-start ISO timestamp of the first bucket of the new regime. */
  at: string;
  direction: "increase" | "decrease";
  beforeMean: number;
  afterMean: number;
  delta: number;
}

export interface ChangepointsResult {
  present: boolean;
  reason?: string;
  metric?: string;
  unit?: string;
  granularity?: string;
  windowDays?: number;
  bucketsAnalysed?: number;
  changepoints?: Changepoint[];
}

const MIN_SEGMENT = 5;
/** Mean shift must clear this many series standard deviations to fire. */
const SHIFT_SD_FLOOR = 1.5;
const MAX_CHANGEPOINTS = 5;

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Minimal CUSUM binary-segmentation changepoint detector over a 1-D series.
 *
 * For a segment, the cumulative sum of mean-centred deviations peaks at the most
 * likely split. The split fires ONLY when the resulting mean shift clears a
 * conservative effect-size floor (≥ SHIFT_SD_FLOOR · series SD) and both halves
 * are at least MIN_SEGMENT long — a deliberately high bar so noise does not
 * register (honest-null over false positives). Accepted splits recurse on each
 * half; the result is capped to the strongest MAX_CHANGEPOINTS shifts by the
 * caller.
 *
 * Indices are into the original series. Pure / dependency-free.
 */
function cusumSegment(
  values: number[],
  lo: number,
  hi: number,
  out: Array<{ index: number; beforeMean: number; afterMean: number }>,
): void {
  const n = hi - lo;
  if (n < 2 * MIN_SEGMENT) return;

  const segment = values.slice(lo, hi);
  const segMean = mean(segment);
  const sd = stdDev(segment);
  if (sd <= 0) return;

  // Cumulative sum of mean-centred deviations; track the extreme position.
  let cusum = 0;
  let maxAbs = 0;
  let splitRel = -1;
  for (let i = 0; i < n; i++) {
    cusum += segment[i] - segMean;
    if (Math.abs(cusum) > maxAbs) {
      maxAbs = Math.abs(cusum);
      // The new regime starts at the bucket AFTER the accumulation peak.
      splitRel = i + 1;
    }
  }
  if (splitRel < MIN_SEGMENT || n - splitRel < MIN_SEGMENT) return;

  const before = segment.slice(0, splitRel);
  const after = segment.slice(splitRel);
  const beforeMean = mean(before);
  const afterMean = mean(after);
  if (Math.abs(afterMean - beforeMean) < SHIFT_SD_FLOOR * sd) return;

  out.push({ index: lo + splitRel, beforeMean, afterMean });
  cusumSegment(values, lo, lo + splitRel, out);
  cusumSegment(values, lo + splitRel, hi, out);
}

/**
 * Surface level shifts in a metric over the rollup tier. Reads the trailing
 * window's rollup buckets (`readBestGranularityRollups` — DAY for ≤90 days,
 * coarser for longer windows; the resolved granularity is reported) and runs
 * the minimal CUSUM above over the bucket means. High firing bar — returns
 * `{ present: false }` when too few buckets exist or no shift clears the floor.
 * Re-uses the rollup tier's already-computed bucket means; adds no new
 * persisted analytics.
 */
export async function detectChangepoints(
  userId: string,
  args: { metric: string; window?: CoachScopeWindow; range?: DateRange },
): Promise<ChangepointsResult> {
  const resolved = await resolveRichMetricForUser(userId, args.metric);
  if (!resolved.ok) {
    return { present: false, reason: resolved.reason };
  }
  const metric = resolved.metric;

  // Either an explicit `{from,to}` range (reach-back + filter) or one of the
  // five fixed trailing windows — both land on the same rollup reader.
  const rangeMs = resolveRangeMs(args.range);
  let windowDays: number;
  let rangeRows: RollupBucketRow[] | null = null;
  let read: Awaited<ReturnType<typeof readBestGranularityRollups>> = null;

  if (rangeMs) {
    windowDays = Math.max(
      1,
      Math.round((rangeMs.toMs - rangeMs.fromMs) / DAY_MS),
    );
    const reachDays = Math.ceil((Date.now() - rangeMs.fromMs) / DAY_MS);
    read =
      Number.isFinite(reachDays) && reachDays > 0
        ? await readBestGranularityRollups(
            userId,
            metric.measurementType,
            reachDays,
          )
        : null;
    rangeRows =
      read?.rows.filter((r) => {
        const t = r.bucketStart.getTime();
        return t >= rangeMs.fromMs && t <= rangeMs.toMs;
      }) ?? null;
  } else {
    windowDays = windowToDays(args.window ?? "last90days");
    read = await readBestGranularityRollups(
      userId,
      metric.measurementType,
      windowDays,
    );
    rangeRows = read?.rows ?? null;
  }

  const miss = (reason: string): ChangepointsResult => {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "detect_changepoints", present: false },
    });
    return {
      present: false,
      reason,
      metric: metric.label,
      unit: metric.unit,
      windowDays,
    };
  };

  if (!read || !rangeRows || rangeRows.length < 2 * MIN_SEGMENT) {
    return miss("insufficient_data");
  }

  const rows = rangeRows;
  const values = rows.map((r) => r.mean);
  const found: Array<{ index: number; beforeMean: number; afterMean: number }> =
    [];
  cusumSegment(values, 0, values.length, found);

  if (found.length === 0) {
    return {
      ...miss("no_changepoint"),
      granularity: read.granularity,
      bucketsAnalysed: values.length,
    };
  }

  const changepoints: Changepoint[] = found
    .sort(
      (x, y) =>
        Math.abs(y.afterMean - y.beforeMean) -
        Math.abs(x.afterMean - x.beforeMean),
    )
    .slice(0, MAX_CHANGEPOINTS)
    .map((cp) => ({
      at: rows[cp.index].bucketStart.toISOString(),
      direction:
        cp.afterMean >= cp.beforeMean
          ? ("increase" as const)
          : ("decrease" as const),
      beforeMean: cp.beforeMean,
      afterMean: cp.afterMean,
      delta: cp.afterMean - cp.beforeMean,
    }))
    .sort((x, y) => (x.at < y.at ? -1 : 1));

  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "detect_changepoints", present: true },
  });
  return {
    present: true,
    metric: metric.label,
    unit: metric.unit,
    granularity: read.granularity,
    windowDays,
    bucketsAnalysed: values.length,
    changepoints,
  };
}

// ── 5. get_lab_history (per-analyte trajectory) ──────────────────────

/** One reading on a single analyte's trajectory. */
export interface LabHistoryReading {
  /** Numeric reading; null for a qualitative row (see `valueText`). */
  value: number | null;
  /** Qualitative result text ("negativ" / …); null for a numeric row. */
  valueText: string | null;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** in-range / below / above / unknown — computed from the resolved bounds. */
  rangeStatus: "in-range" | "below" | "above" | "unknown";
  /** Measured date (ISO). */
  takenAt: string;
}

export interface LabHistoryResult {
  present: boolean;
  reason?: string;
  /** The canonical analyte the trajectory resolved to. */
  analyte?: string;
  /** Newest-first readings for this analyte (the requested page). */
  readings?: LabHistoryReading[];
  /** Opaque cursor for the next page; absent when the last page was returned. */
  nextCursor?: string;
}

/** Hard ceiling per page so a heavy panel history never balloons the wire. */
export const LAB_HISTORY_MAX_LIMIT = 50;

/**
 * Return ONE analyte's reading trajectory (newest first) over the user's own
 * lab record. Re-uses the SAME resolver + range classifier the latest-only labs
 * snapshot and the Labs API use (`resolveLabFields` / `classifyReferenceRange`)
 * — no new analytics, no fabricated value. DB-paginated by `offset` so a long
 * history stays token-bounded: the page carries at most `limit` readings and a
 * `nextCursor` when more exist. The encrypted `noteEncrypted` column is never
 * selected, so a decrypted note can never reach the wire. `{ present: false }`
 * when no reading matches the analyte.
 */
export async function getLabHistory(
  userId: string,
  args: { analyte: string; offset?: number; limit?: number },
): Promise<LabHistoryResult> {
  const needle = args.analyte.trim();
  if (!needle) {
    return { present: false, reason: "analyte_required" };
  }
  const offset =
    typeof args.offset === "number" &&
    Number.isFinite(args.offset) &&
    args.offset > 0
      ? Math.floor(args.offset)
      : 0;
  const rawLimit =
    typeof args.limit === "number" &&
    Number.isFinite(args.limit) &&
    args.limit > 0
      ? Math.floor(args.limit)
      : LAB_HISTORY_MAX_LIMIT;
  const limit = Math.min(LAB_HISTORY_MAX_LIMIT, rawLimit);

  // Match the analyte either on the LabResult's own `analyte` column or on the
  // linked Biomarker's canonical name. `take: limit + 1` peeks one row past the
  // page to decide whether a `nextCursor` is warranted. Field-by-field `where`.
  const rows = await prisma.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      OR: [
        { analyte: { contains: needle, mode: "insensitive" } },
        { biomarker: { name: { contains: needle, mode: "insensitive" } } },
      ],
    },
    orderBy: { takenAt: "desc" },
    skip: offset,
    take: limit + 1,
    select: {
      analyte: true,
      panel: true,
      value: true,
      valueText: true,
      unit: true,
      referenceLow: true,
      referenceHigh: true,
      sourceReferenceLow: true,
      sourceReferenceHigh: true,
      sourceReferenceText: true,
      takenAt: true,
      biomarkerId: true,
      biomarker: {
        select: {
          id: true,
          name: true,
          unit: true,
          lowerBound: true,
          upperBound: true,
          panel: true,
        },
      },
    },
  });

  if (rows.length === 0) {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_labs", present: false },
    });
    return { present: false, reason: "analyte_not_found" };
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const readings: LabHistoryReading[] = page.map((row) => {
    const resolved = resolveLabFields(row, row.biomarker);
    return {
      value: row.value,
      valueText: row.valueText ? sanitizeValueText(row.valueText) : null,
      unit: resolved.unit,
      referenceLow: resolved.referenceLow,
      referenceHigh: resolved.referenceHigh,
      rangeStatus: classifyAgainstEffectiveRange(
        row.value,
        resolved.effectiveRange,
      ),
      takenAt: row.takenAt.toISOString(),
    };
  });

  // Canonical analyte for the trajectory — take the first (newest) resolved
  // row. Document-derived free text: scrub fence markers (the forging class
  // the sibling fields already defend against) and sanitize control chars,
  // exactly like the default get_labs path treats the same name.
  const canonical = scrubFenceMarkers(
    sanitizeValueText(resolveLabFields(page[0], page[0].biomarker).analyte),
  );

  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "get_labs", present: true },
  });
  return {
    present: true,
    analyte: canonical,
    readings,
    ...(hasMore ? { nextCursor: encodeOffsetCursor(offset + limit) } : {}),
  };
}
