/**
 * The one assembler for the correlation-discovery matrix.
 *
 * `discoverCorrelations` is pure over `NamedSeries[]`. Deciding WHICH series go
 * in is the part that used to be copied: the `/api/insights/correlations` route,
 * the per-metric assessment card, the Coach `get_correlations` tool and the
 * period narrative each folded their own channel list, and three of the four
 * carried a different one. The Coach's was missing the environmental and
 * custom-metric families entirely, so a question about air pressure and sleep
 * met a matrix that had never contained the pair — while the tool's own file
 * header promised "the SAME full-matrix scan the route runs". v1.30.3 hoisted
 * the FETCH discipline into `correlation-channel-series.ts` for exactly this
 * reason and left the assembly duplicated behind; this module finishes that.
 *
 * Every surface that scans the matrix calls {@link assembleDiscoveryMatrix} and
 * gets the same channel set. The differences that remain are declared as
 * options, each with its reason written at the option — a surface cannot drop a
 * channel family by omission any more, only by naming what it is doing.
 *
 * What this does NOT own:
 *
 *  - the scan. Each caller still runs `discoverCorrelations` (and, where it
 *    applies, `discoverEmergingCorrelations`) over the returned series, because
 *    what each does with the result differs — the route persists patterns, the
 *    card filters to one metric, the Coach shapes driver rows, the narrative
 *    cites them. Same input, same statistics, different presentation.
 *  - the labs ↔ outcome pass. `discoverLabOutcomeCorrelations` runs over
 *    `LabDrawPoint[]` (point-vs-window over sparse draws), not the
 *    behaviour × outcome day grid this assembles. Its input comes from
 *    `fetchLabDraws` at the two call sites that want it.
 *  - the cycle-phase matrix. `discoverPhaseCorrelations` builds a deliberately
 *    separate, gated matrix (CYCLE_PHASE × outcomes) that must never reach the
 *    non-gated surfaces; see `src/lib/cycle/phase-crosstab.ts`.
 *
 * The freeze on all of this is `src/__tests__/discovery-matrix-guard.test.ts`.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import {
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  discoveryMeasurementTypes,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import {
  buildMeasurementDailySeries,
  fetchComplianceSeries,
  fetchCustomMetricBehaviourSeries,
  fetchSymptomEventSeries,
  fetchEnvironmentSeries,
  fetchMeasurementDailySeriesTiered,
  fetchMeasurementWindowSeries,
  fetchMoodFactorWindowSeries,
  fetchMoodWindowSeries,
  fetchSymptomSeries,
  type MoodFactorWindowFetch,
} from "@/lib/insights/correlation-channel-series";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { ENVIRONMENT_FIELDS } from "@/lib/environment/fields";
import {
  correlationChannelSurfaceId,
  isSurfaceVisible,
  type SurfaceModuleMap,
} from "@/lib/modules/surface";

/**
 * How the measurement channels are read.
 *
 *  - `"tiered"` takes the DAY rollup read-swap where a channel is eligible and
 *    the user's profile timezone sits in the near-UTC band, falling back to the
 *    raw path per channel on any miss. Cheaper on a dense account; carries the
 *    documented ±3 h day-key tolerance and drops the partial oldest day.
 *  - `"raw"` always reads raw rows and reduces them in process.
 *
 * This is a read-cost decision, NOT a channel-set decision, so it stays a
 * per-caller choice rather than something the assembler picks. The route takes
 * the swap because it scans 180 days on every cache miss; the three library
 * surfaces stayed raw when the swap landed and are left there, because moving
 * them is a value change at the tolerance boundary and belongs in its own
 * change with its own parity proof, not folded into a channel-set fix.
 */
export type DiscoveryMatrixFetchMode = "tiered" | "raw";

export interface DiscoveryMatrixOptions {
  /** The user's display timezone — every day key is minted in it. */
  tz: string;
  /** Inclusive start of the read window. */
  since: Date;
  /** See {@link DiscoveryMatrixFetchMode}. */
  fetchMode: DiscoveryMatrixFetchMode;
  /**
   * Admit the user's RATED mood factors as `FACTOR:<key>` channels, in BOTH
   * roles. Off everywhere except the period narrative, deliberately:
   *
   *  - `MoodTag.kind = "RATED"` is FROZEN as of v1.37. The capture sheet stopped
   *    offering factor ratings when the level-A columns landed on `MoodEntry`;
   *    nothing was deleted, so existing scores keep rendering and keep feeding
   *    the factor crosstab, but no new ones are written. Widening a frozen
   *    capture path's reach to three more surfaces is a decision about what to
   *    ask, not a parity fix — the schema comment on that column says so in as
   *    many words.
   *  - The route and the per-metric card PERSIST every surviving pair into
   *    `CorrelationPattern.factorKey` / `.outcomeKey`, plaintext columns. A
   *    custom RATED tag's key is `custom:<cuid>` with its label held encrypted,
   *    so a factor channel on those two surfaces would write a channel key that
   *    only resolves through a decrypt — and would narrate as the raw key
   *    meanwhile.
   *
   * So this is a real distinction, not an accident of where someone stopped:
   * the narrative reads a bounded period and cites factors in prose it does not
   * store. Turning it on costs no extra round-trip — the tag-links ride the
   * existing mood read (see `fetchMoodFactorWindowSeries`) — but it does widen
   * the BH-FDR family, since each factor enters as both lag source and lag
   * target.
   */
  includeMoodFactors?: boolean;
  /**
   * Measurement types to read ALONGSIDE the discovery channels, surfaced in
   * {@link DiscoveryMatrix.byMetric} but never folded into `series`. Lets a
   * caller that needs more per-metric series than the matrix contains (the
   * period narrative's delta metrics and banded vitals) get them from the one
   * measurement read instead of a second one.
   */
  extraMeasurementTypes?: readonly MeasurementType[];
  /**
   * The record's resolved module map. A channel whose module is off
   * (`correlation:<key>` in the surface map: mood and its rated factors,
   * sleep, glucose, medication adherence, symptoms, weather) is left out of
   * `series` and `byMetric`, so no statistic is computed, and no prompt is
   * grounded, on a module the person switched off.
   *
   * Required, not optional: a caller that forgot it would scan every channel
   * and nothing would notice, which is how the Coach tool, the metric card
   * and the period narrative kept scanning switched-off modules after the
   * route stopped. Omitting it is now a compile error. Pass
   * `resolveModuleMap(userId)` for the record being read.
   */
  modules: SurfaceModuleMap;
}

/** Per-channel reach, for the callers' wide-event annotations. */
export interface DiscoveryMatrixDiagnostics {
  /** The raw measurement read hit its cap — the window may miss OLDER rows. */
  measurementsCapped: boolean;
  /** The mood read hit its cap. */
  moodCapped: boolean;
  /** Measurement channels served from the DAY rollup tier (tiered mode only). */
  rollupTypes: MeasurementType[];
  complianceDays: number;
  symptomDays: number;
  /** Stored daily points summed across the environmental-exposure channels. */
  environmentDays: number;
  customMetricChannels: number;
  customMetricDays: number;
  /** `FACTOR:*` channels admitted (0 unless `includeMoodFactors`). */
  moodFactorChannels: number;
  /** `SYMPTOM:*` channels read (before the module mask). */
  symptomEventChannels: number;
}

export interface DiscoveryMatrix {
  /** The behaviour × outcome channel set, ready for `discoverCorrelations`. */
  series: NamedSeries[];
  /**
   * Day-keyed series per metric key — every measurement type read (discovery
   * channels plus `extraMeasurementTypes`), `MOOD`, and each admitted
   * `FACTOR:*` channel. A key with no data is absent; callers read it as
   * `byMetric.get(key) ?? []`.
   */
  byMetric: Map<string, DailySeriesPoint[]>;
  diagnostics: DiscoveryMatrixDiagnostics;
}

/**
 * Leave out every channel whose owning module is off. Pure, and applied after
 * the fold so the order of what remains is the order it was folded in (the
 * ranking stability note on {@link assembleDiscoveryMatrix}).
 *
 * This changes the statistics of the pairs that remain, not only which pairs
 * exist. Benjamini-Hochberg controls the false discovery rate across every
 * pair tested, so a smaller channel set is a smaller family: each surviving
 * pair's q-value is computed against fewer tests and is usually lower (never
 * higher for the same p-values and rank order). Switching a module off can
 * therefore let a borderline pair between two unrelated channels cross the
 * FDR threshold, and switching it back on can push that pair back under.
 * That is the correct correction for the question actually asked (the pairs
 * over what the person tracks); it is also why a persisted pattern's q-value
 * is only comparable to another computed under the same module set.
 */
export function maskSeriesByModules(
  series: readonly NamedSeries[],
  modules: SurfaceModuleMap | null | undefined,
): NamedSeries[] {
  return series.filter((s) =>
    isSurfaceVisible(correlationChannelSurfaceId(s.key), modules),
  );
}

/**
 * The mood read, normalised to the factor-carrying shape. With factors off the
 * factor map is empty, so the fold below has one code path rather than two.
 */
async function readMood(
  userId: string,
  tz: string,
  since: Date,
  withFactors: boolean,
): Promise<MoodFactorWindowFetch> {
  if (withFactors) return fetchMoodFactorWindowSeries(userId, tz, since);
  const plain = await fetchMoodWindowSeries(userId, tz, since);
  return { ...plain, factorSeries: new Map() };
}

/** One measurement read, reduced to per-day series under the chosen mode. */
async function readMeasurementDaily(
  userId: string,
  tz: string,
  since: Date,
  types: MeasurementType[],
  mode: DiscoveryMatrixFetchMode,
): Promise<{
  byType: Map<string, DailySeriesPoint[]>;
  measurementsCapped: boolean;
  rollupTypes: MeasurementType[];
}> {
  if (mode === "tiered") {
    const tiered = await fetchMeasurementDailySeriesTiered(
      userId,
      tz,
      since,
      types,
    );
    return {
      byType: tiered.byType,
      measurementsCapped: tiered.measurementsCapped,
      rollupTypes: tiered.rollupTypes,
    };
  }

  const [raw, priorityJson] = await Promise.all([
    fetchMeasurementWindowSeries(userId, since, types),
    loadUserSourcePriority(userId),
  ]);
  const byType = new Map<string, DailySeriesPoint[]>();
  for (const type of types) {
    const rows = raw.byType.get(type);
    if (!rows || rows.length === 0) continue;
    byType.set(type, buildMeasurementDailySeries(type, rows, tz, priorityJson));
  }
  return {
    byType,
    measurementsCapped: raw.measurementsCapped,
    rollupTypes: [],
  };
}

/**
 * Build the full discovery matrix for a user over a window.
 *
 * Reads every channel family in parallel and folds them in one fixed order:
 * the declared behaviours, the declared outcomes, the environmental-exposure
 * channels, the opt-in custom-metric channels, then (only when asked) the
 * RATED mood factors in both roles. A family the user has no data for yields
 * an empty series and drops out of the scan at the n ≥ 20 floor — absence is
 * never a fabricated constant.
 *
 * The order is fixed on purpose. `discoverCorrelations` ranks by shrunk effect
 * then q, and `Array.prototype.sort` is stable, so two pairs equal on both
 * come out in the order they were tested — which is the order the channels
 * were folded. A stable fold keeps two runs over the same data ranked the same
 * way, and keeps this route's ranking identical to what it was before the
 * assembly moved here.
 */
export async function assembleDiscoveryMatrix(
  userId: string,
  opts: DiscoveryMatrixOptions,
): Promise<DiscoveryMatrix> {
  const { tz, since, fetchMode } = opts;

  // The non-MeasurementType channels (MOOD, MEDICATION_COMPLIANCE,
  // SYMPTOM_SEVERITY) are backed by other models, so `discoveryMeasurementTypes`
  // drops them before the list reaches a Postgres `type IN (...)` enum cast —
  // a non-enum string in that list errors the cast. Each is sourced below.
  const measurementTypes = Array.from(
    new Set<string>([
      ...discoveryMeasurementTypes(DISCOVERY_BEHAVIOURS),
      ...discoveryMeasurementTypes(DISCOVERY_OUTCOMES),
      ...(opts.extraMeasurementTypes ?? []),
    ]),
  ) as MeasurementType[];

  const [
    measurements,
    mood,
    complianceSeries,
    symptomSeries,
    environmentSeries,
    customMetricSeries,
    symptomEventSeries,
  ] = await Promise.all([
    readMeasurementDaily(userId, tz, since, measurementTypes, fetchMode),
    readMood(userId, tz, since, opts.includeMoodFactors === true),
    fetchComplianceSeries(userId, tz, since),
    fetchSymptomSeries(userId, tz, since),
    // The weather read is skipped outright when the environment module is off:
    // the mask below would drop every ENV_* series anyway, so reading them
    // was a wasted query on every scan. Probed through the first field's
    // surface id, which the surface map owns (all ENV_* share one module).
    isSurfaceVisible(
      correlationChannelSurfaceId(ENVIRONMENT_FIELDS[0].key),
      opts.modules,
    )
      ? fetchEnvironmentSeries(userId, since)
      : Promise.resolve([] as NamedSeries[]),
    fetchCustomMetricBehaviourSeries(userId, tz, since),
    fetchSymptomEventSeries(userId, tz, since),
  ]);

  const { factorSeries } = mood;

  const points = (key: string): DailySeriesPoint[] =>
    key === "MOOD" ? mood.moodDaily : (measurements.byType.get(key) ?? []);

  const series: NamedSeries[] = [];
  for (const key of DISCOVERY_BEHAVIOURS) {
    if (key === MEDICATION_COMPLIANCE_CHANNEL_KEY) {
      series.push(complianceSeries);
    } else if (key === SYMPTOM_SEVERITY_CHANNEL_KEY) {
      // The symptom builder returns the outcome role; the points are
      // role-invariant, so the behaviour arm re-tags the same series.
      series.push({ ...symptomSeries, role: "behaviour" });
    } else {
      series.push({ key, role: "behaviour", points: points(key) });
    }
  }
  for (const key of DISCOVERY_OUTCOMES) {
    if (key === SYMPTOM_SEVERITY_CHANNEL_KEY) {
      series.push({ ...symptomSeries, role: "outcome" });
    } else {
      series.push({ key, role: "outcome", points: points(key) });
    }
  }
  // Environmental exposure and custom metrics are lag SOURCES only. Custom
  // metrics pair D → D+1; the environmental series carry `lagDays: 0` over an
  // exposure already averaged across D−1 and D (see `fetchEnvironmentSeries`).
  // Both run under the same n ≥ 20 / FDR / effect-size gates, so a thin
  // weather or custom series degrades to absent.
  series.push(...environmentSeries, ...customMetricSeries);
  // The person's own symptoms are OUTCOMES: "short sleep, then an aura the
  // next day" is the question they log them to answer. Each is its own
  // channel and its own family, capped at eight; the illness module owns them
  // through the `SYMPTOM:` prefix rule in the surface map.
  series.push(...symptomEventSeries);
  // A factor is plausibly both a lag source ("rated work today → next-day
  // sleep") and a lag target ("steps today → next-day rated energy"), so it
  // enters as both roles. The engine skips self-pairs — every factor shares
  // MOOD's family — and BH-FDR controls the wider family this opens.
  for (const [key, factorPoints] of factorSeries) {
    series.push({ key, role: "behaviour", points: factorPoints });
    series.push({ key, role: "outcome", points: factorPoints });
  }

  const byMetric = new Map(measurements.byType);
  if (mood.moodDaily.length > 0) byMetric.set("MOOD", mood.moodDaily);
  for (const [key, factorPoints] of factorSeries) {
    byMetric.set(key, factorPoints);
  }

  for (const key of [...byMetric.keys()]) {
    if (!isSurfaceVisible(correlationChannelSurfaceId(key), opts.modules)) {
      byMetric.delete(key);
    }
  }

  return {
    series: maskSeriesByModules(series, opts.modules),
    byMetric,
    diagnostics: {
      measurementsCapped: measurements.measurementsCapped,
      moodCapped: mood.moodCapped,
      rollupTypes: measurements.rollupTypes,
      complianceDays: complianceSeries.points.length,
      symptomDays: symptomSeries.points.length,
      environmentDays: environmentSeries.reduce(
        (sum, s) => sum + s.points.length,
        0,
      ),
      customMetricChannels: customMetricSeries.length,
      customMetricDays: customMetricSeries.reduce(
        (sum, s) => sum + s.points.length,
        0,
      ),
      moodFactorChannels: factorSeries.size,
      symptomEventChannels: symptomEventSeries.length,
    },
  };
}
