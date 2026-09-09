/**
 * v1.7.0 W6 — unified dashboard first-paint snapshot.
 *
 * `buildDashboardSnapshot` assembles every above-the-fold tile field in
 * a single server round-trip from the existing rollup / mood / widget
 * helpers plus a read-only lift of the pre-generated daily briefing.
 * The whole strip therefore shares one completion moment instead of the
 * legacy four-cell waterfall (slim analytics + thick analytics + mood +
 * widget layout, each gated behind `/api/auth/me`).
 *
 * Two-phase shape — the deliberate trade-off documented in the
 * R-firstpaint spec §6 "Risks":
 *
 *   - `tiles` — fast, ALWAYS present. The slim summaries slice, the
 *     mood block, the resolved widget layout, the derived user profile
 *     fields. These resolve sub-second on a warm rollup tenant.
 *   - `extras` — thick, MAY be null. The BD-Zielbereich (`bpInTargetPct*`)
 *     and per-context glucose tiles ride the slowest reads (the
 *     `computeBpInTargetFastPath` fast-path falls back to multi-second
 *     live SQL on a rollup-coverage miss). Collapsing them into the
 *     fast phase would make the WHOLE strip wait for the slowest
 *     sub-query. Instead the builder runs both phases concurrently
 *     inside one `Promise.all`; on a coverage miss `extras` is emitted
 *     `null` so the BD/glucose tiles fall back to a per-tile shimmer
 *     while every other tile paints together. Warm-rollup tenants get
 *     everything in the single payload because the thick reads resolve
 *     inside the same fast window.
 *
 * No LLM is reachable from this builder. The briefing is lifted
 * read-only from `User.insightsCachedText`; a cache miss / stale row
 * yields `briefingState: "preparing"` (with the last good briefing
 * delivered under `briefingStale: true` when one exists) and the
 * `insight-pregenerate` cron refills it — or `"no-provider"` when no
 * AI provider is configured anywhere, so clients can stop waiting.
 * The builder NEVER POSTs `/api/insights/generate`.
 */
import type { PrismaClient, MeasurementType } from "@/generated/prisma/client";
import { computeSummariesSlice } from "@/lib/analytics/summaries-slice";
import type { SleepSourceDiscrepancy } from "@/lib/analytics/sleep-night";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  summarize,
  type DataPoint,
  type DataSummary,
} from "@/lib/analytics/trends";
import { bpTargetsEqual, getBpTargets } from "@/lib/analytics/bp-targets";
import {
  computeGlucoseClinicalMetrics,
  GLUCOSE_PANEL_WINDOW_DAYS,
  type GlucoseClinicalMetrics,
} from "@/lib/analytics/glucose-metrics";
import { groupByGlucoseContext } from "@/lib/glucose";
import {
  computeBpInTargetFastPath,
  type BpInTargetEnvelope,
} from "@/lib/analytics/bp-in-target-fast-path";
import {
  resolveEffectiveBpTargets,
  resolveWeightTargetOverride,
} from "@/lib/analytics/effective-range";
import { deriveBpWindow90 } from "@/lib/analytics/window-confidence";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import { buildMoodDailySeries } from "@/lib/analytics/mood-series";
import {
  resolveDashboardLayout,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  type DashboardLayout,
  type DashboardWidgetCatalogueId,
} from "@/lib/dashboard-layout";
import { dailyBriefingSchema, type DailyBriefing } from "@/lib/ai/schema";
import { getAssistantFlags } from "@/lib/feature-flags";
import { hasAnyConfiguredProvider } from "@/lib/ai/provider";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import {
  buildMedsTodayBlock,
  type MedsTodayBlock,
} from "@/lib/dashboard/meds-today";
import { computeAndRecordUserHealthScore } from "@/lib/analytics/score/record";
import {
  buildDashboardBands as buildTargetBands,
  type DashboardTargetBands,
} from "@/lib/dashboard/bands";
import type {
  RestModeAnnotation,
  ScoreBand,
  ScoreBasis,
  ScoreDeltaReason,
  ScorePillarId,
} from "@/lib/analytics/score/types";
import type { DerivedConfidence } from "@/lib/insights/derived/types";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { resolveModuleMap, type ModuleKey } from "@/lib/modules/gate";
import {
  buildScoreNarrativeBlock,
  type ScoreTensionDto,
  type ScoreReturnToBandDto,
} from "@/lib/dashboard/score-narrative";
import {
  buildCoachMemoryBlock,
  type CoachMemoryBlock,
} from "@/lib/ai/coach/memory-snapshot";
import {
  buildScoreRingsBlock,
  type DashboardScoreRing,
} from "@/lib/dashboard/score-rings";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import {
  binaryReferenceSex,
  toProfileSex,
  type ProfileSex,
} from "@/lib/profile/sex";

/** Briefing freshness window — mirrors the 24 h TTL on the advisor cache. */
const BRIEFING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * v1.18.0 — the two dashboard module maps live in a client-safe module
 * (`@/lib/dashboard/widget-modules`) so the settings client component can
 * import them without pulling the server snapshot builder (and its
 * `pg` / `dns` chain) into the browser bundle. Re-exported here for the
 * server call sites and the existing tests.
 */
export {
  WIDGET_MODULE_BY_ID,
  SUMMARY_TYPE_MODULE,
} from "@/lib/dashboard/widget-modules";
import {
  WIDGET_MODULE_BY_ID,
  gateSummariesByModules,
  unavailableWidgetIds,
} from "@/lib/dashboard/widget-modules";

/**
 * v1.7.0 — HealthLog `MeasurementType` → iOS `MetricKind` raw value.
 *
 * The iOS client decodes `MetricKind` from these exact raw strings
 * (`MetricKind.swift:30-122`); the snapshot's `metricStates` block is
 * keyed by them so a cold-launch first-paint seeds every tile without
 * a per-metric round-trip. Most map to the lowercase / camel form of
 * the enum, but a handful are non-obvious and locked verbatim in
 * `.planning/ios-coord/v1.7.0-ios-convergence-locks.md` §4b:
 *
 *   - SpO₂ → `oxygenSaturation`
 *   - body water → `totalBodyWater`
 *   - HRV → `heartRateVariability`
 *   - BMI → `bodyMassIndex`
 *   - walking asymmetry → `walkingAsymmetryPercentage`
 *   - walking double support → `walkingDoubleSupportPercentage`
 *   - environmental audio → `environmentalAudioExposure`
 *   - headphone audio → `headphoneAudioExposure`
 *   - active energy → `activeEnergyBurned`
 *
 * Types without an iOS `MetricKind` counterpart are intentionally
 * absent (no key emitted) rather than mapped to a guessed raw. The
 * audio-exposure EVENT flag, walking steadiness, and the Withings-only
 * body-composition metrics (fat-free / muscle mass, PWV, vascular age,
 * visceral fat, skin temperature) have no iOS tile and are omitted.
 */
const METRIC_KIND_RAW_BY_TYPE: Partial<Record<MeasurementType, string>> = {
  WEIGHT: "weight",
  BLOOD_PRESSURE_SYS: "bloodPressureSystolic",
  BLOOD_PRESSURE_DIA: "bloodPressureDiastolic",
  PULSE: "pulse",
  BODY_FAT: "bodyFat",
  SLEEP_DURATION: "sleep",
  ACTIVITY_STEPS: "steps",
  BLOOD_GLUCOSE: "bloodGlucose",
  TOTAL_BODY_WATER: "totalBodyWater",
  BONE_MASS: "boneMass",
  OXYGEN_SATURATION: "oxygenSaturation",
  HEART_RATE_VARIABILITY: "heartRateVariability",
  RESTING_HEART_RATE: "restingHeartRate",
  ACTIVE_ENERGY_BURNED: "activeEnergyBurned",
  FLIGHTS_CLIMBED: "flightsClimbed",
  WALKING_RUNNING_DISTANCE: "walkingRunningDistance",
  VO2_MAX: "vo2Max",
  BODY_TEMPERATURE: "bodyTemperature",
  FAT_FREE_MASS: "fatFreeMass",
  FAT_MASS: "fatMass",
  MUSCLE_MASS: "muscleMass",
  RESPIRATORY_RATE: "respiratoryRate",
  BODY_MASS_INDEX: "bodyMassIndex",
  LEAN_BODY_MASS: "leanBodyMass",
  WALKING_HEART_RATE_AVERAGE: "walkingHeartRateAverage",
  WALKING_ASYMMETRY: "walkingAsymmetryPercentage",
  WALKING_DOUBLE_SUPPORT: "walkingDoubleSupportPercentage",
  WALKING_STEP_LENGTH: "walkingStepLength",
  WALKING_SPEED: "walkingSpeed",
  AUDIO_EXPOSURE_ENV: "environmentalAudioExposure",
  AUDIO_EXPOSURE_HEADPHONE: "headphoneAudioExposure",
  TIME_IN_DAYLIGHT: "timeInDaylight",
};

/**
 * v1.15.20 — `"no-provider"` joins the tri-state: the cache is stale or
 * missing AND no AI provider is configured anywhere (user chain, legacy
 * selection, Codex link, operator key), so no warm pass will ever fill
 * it. Clients render a "connect a provider" hint instead of an eternal
 * "preparing" spinner. Existing states keep their exact semantics.
 */
export type BriefingState = "ready" | "preparing" | "disabled" | "no-provider";

export interface DashboardSnapshotUser {
  username: string;
  /**
   * The user's configured zone — the ONE server-resolved input the
   * greeting needs. The wall-clock hour itself is deliberately not on
   * this payload: the body is served stale-while-revalidate for up to an
   * hour, so a baked-in hour can name the wrong salutation long after
   * the boundary passed, and every client already reads a live clock.
   * Resolve the zone here, read the hour there.
   */
  timezone: string;
  heightCm: number | null;
  dateOfBirth: string | null;
  /**
   * Sex as stored, `OTHER` included. Emitting `null` for an account that
   * answered `OTHER` made the value indistinguishable from no answer at
   * all on every client reading this payload.
   */
  gender: ProfileSex;
  glucoseUnit: string | null;
  onboardingTourCompleted: boolean;
}

/**
 * v1.18.6 — server-computed band / target math (audit finding #3).
 *
 * The dashboard used to derive every chart band + tile range CLIENT-side
 * in `page.tsx` from `user.dateOfBirth` / `gender` / `heightCm`. This
 * block resolves the same numbers server-side from the EXISTING band
 * helpers (`getBpTargets`, `getPersonalizedPulseTarget`,
 * `getBodyFatTargetRange`, `buildWeight*FromHeight`,
 * `buildTrafficLightBands`, `buildTrafficRange`) so the client reads them
 * instead of recomputing. Only the NUMERIC structures live here — the
 * `bpTargetZones` array carries `t()`-localised labels, so the client
 * assembles THAT from `bpTargets` (numbers) at render time. Every field
 * is `null` when the driving profile fact is missing (no DOB → BP/pulse
 * personalisation, no height → weight band), matching the client's
 * previous null-guards exactly.
 */
export { buildTargetBands };
export type { DashboardTargetBands };

export interface DashboardSnapshotMoodEntry {
  date: string;
  score: number;
  samples: number;
}

/**
 * Thick analytics slice — `null` when the rollup tier is not warm for
 * this tenant (coverage miss). The dashboard renders a per-tile shimmer
 * for the BD-Zielbereich + glucose tiles in that case and the next
 * snapshot (after the boot backfill converges) carries the values.
 */
export interface DashboardSnapshotExtras {
  bpInTargetPct: number | null;
  bpInTargetPct7d: number | null;
  bpInTargetPct30d: number | null;
  bpInTargetPctAllTime: number | null;
  bpInTargetPctPriorMonth: number | null;
  bpInTargetPctPriorYear: number | null;
  /**
   * v1.17 W1b — number of paired BP readings inside the trailing-90-day
   * window, and the EFFECTIVE label span (real calendar span capped at 90
   * days, or `null` when the window is empty). The BD-Zielbereich tile reads
   * the count against the confidence floor to decide between a percentage and
   * the "collecting data" placeholder, and renders the span in the label so a
   * thin-history user never sees a dishonest static "· 90 T".
   */
  bpInTargetCount90: number | null;
  bpInTargetSpanDays90: number | null;
  glucoseByContext: Record<string, DataSummary>;
  /**
   * v1.17.0 — server-authoritative glucose clinical panel over the trailing
   * 30-day window: the learning gate (+ reason), window/span/count, mean,
   * Battelino TIR distribution, GMI, estimated A1C, SD/CV%/instability, and the
   * advanced J-index + LBGI/HBGI tier. Computed ONCE by
   * `computeGlucoseClinicalMetrics` so the iOS client renders the same numbers
   * the web panel, the coach, and the doctor report do — iOS never re-derives.
   * Always present (even with zero readings) so the native client paints the
   * calm "still learning" state from a populated object.
   */
  glucoseClinical: GlucoseClinicalMetrics;
}

/**
 * v1.7.0 — latest reading per chartable metric, keyed by the iOS
 * `MetricKind` raw value. Additive cold-launch seed: the iOS client
 * paints every tile from this block on first launch without a
 * per-metric round-trip. Derived in-process from the slim summaries
 * slice already fetched for `tiles.summaries` — NO extra DB query.
 */
export interface DashboardMetricState {
  value: number;
  measuredAt: string;
  unit: string;
}

/**
 * v1.7.0 — one widget row in the full catalogue. Mirrors the
 * web-layout `DashboardWidgetConfig` shape (`visible` + `order`) but
 * over the full 27-id catalogue (server-known + iOS-only), so the
 * iOS layout round-trips in one key.
 */
export interface DashboardLayoutCatalogueEntry {
  id: DashboardWidgetCatalogueId;
  visible: boolean;
  order: number;
}

/**
 * Health-score summary for the hero — score + band + week-over-week
 * delta ONLY. The per-pillar component breakdown is deliberately NOT
 * serialised here; the analytics route remains the one surface that
 * exposes components.
 */
export interface DashboardSnapshotHealthScore {
  score: number;
  band: ScoreBand;
  delta: number | null;
  confidence?: DerivedConfidence;
  composition?: ScorePillarId[];
  /**
   * v1.35.0 — the resolved "this score is configured" flag: true when the
   * person's own recipe narrows the composition below what the account's
   * defaults would resolve to today. Server-resolved so the hero, the
   * widget and the complication acknowledge an authored recipe without
   * interpreting a config blob; the blob itself never rides this wire,
   * and neither does any per-pillar config detail. Optional on the type
   * (additive contract) so older cached snapshots stay valid; the live
   * builder always sets it.
   */
  configured?: boolean;
  /**
   * v1.38 — what the number rests on: how many distinct areas of health
   * were counted, how many the method recommends, the resulting tier
   * (`full` / `partial` / `minimal`) and whether any counted pillar was a
   * physiological measurement. Since v1.38 a score exists at one or two
   * areas as well as three, computed exactly the same way, so this block
   * is the only thing that tells a narrow score from a broad one — a
   * surface that renders the number should render its basis too.
   * Counting `composition` is not a substitute: three of the seven
   * pillars share the cardiometabolic area. Optional on the type
   * (additive contract) so older cached snapshots stay valid; the live
   * builder always sets it when a score exists.
   */
  scoreBasis?: ScoreBasis;
  deltaReason?: ScoreDeltaReason | null;
  scoreVersion?: number;
  bandSetter?: ScorePillarId | null;
  /**
   * v1.18.1 — Rest Mode annotation. When an illness/condition episode is
   * active the dashboard frames the score ("you were unwell during this
   * window") WITHOUT changing it — the same value-free context the
   * `/api/analytics` payload carries and iOS mirrors. Null when the account
   * is not in Rest Mode. Resolved server-side (fail-soft) so the surface
   * never recomputes it. Optional on the type (additive contract) so older
   * cached snapshots + test fixtures without the field stay valid; the live
   * builder always sets it (null when not in Rest Mode).
   */
  restMode?: RestModeAnnotation | null;
  /**
   * v1.21.2 (A5) — Tension Verdict, locale-agnostic. Fires only when the
   * readiness composite's contributors DISAGREE (≥1 strongly favourable AND ≥1
   * strongly unfavourable); suppressed (`null`) under a clinical red-flag so the
   * red-flag path dominates. `positive` / `negative` carry the readiness
   * contributor KEYS — the client maps each to its localised display label
   * before handing the card its already-localised strings. Null on a coherent
   * day. Optional (additive contract) so older cached snapshots stay valid.
   */
  tension?: ScoreTensionDto | null;
  /**
   * v1.21.2 (A6) — return-to-baseline, locale-agnostic. Present only when a
   * salient metric has come BACK inside the user's own personal range after a
   * prior out-of-band run; at most one (the most salient). `metricType` is the
   * `MeasurementType` the client maps to its localised metric name. Null
   * otherwise. Optional (additive contract).
   */
  returnToBand?: ScoreReturnToBandDto | null;
}

/**
 * v1.21.2 (A4) — the briefing recall + forward-look. Both strings are
 * already-localised, server-resolved prose: `recall` is the prior period's
 * narrative headline; `forward` points ahead to the most salient trend drift
 * (or a calm "holding steady" when nothing drifted). The card renders them
 * verbatim. Null when no prior narrative is on file.
 */
export interface DashboardSnapshotBriefingMemory {
  recall: string;
  forward: string;
}

export interface DashboardSnapshot {
  user: DashboardSnapshotUser;
  layout: DashboardLayout;
  /**
   * v1.7.0 — full 27-id widget catalogue (visibility + order) for the
   * iOS cold-launch seed. Additive alongside the web `layout`; the web
   * page keeps reading `layout` byte-identically.
   */
  layoutCatalogue: DashboardLayoutCatalogueEntry[];
  /**
   * v1.7.0 — per-chartable-metric latest reading, keyed by iOS
   * `MetricKind` raw value. Additive; the web page does not read it.
   */
  metricStates: Record<string, DashboardMetricState>;
  /**
   * v1.18.6 — server-computed band / target math (audit finding #3). The
   * web dashboard reads these instead of recomputing from the profile;
   * additive for iOS.
   */
  targetBands: DashboardTargetBands;
  /** Fast phase — always present. */
  tiles: {
    summaries: Record<string, DataSummary>;
    lastSeenByType: Record<
      string,
      { lastSeenAt: string; daysAgo: number } | null
    >;
    mood: {
      summary: DataSummary | null;
      entries: DashboardSnapshotMoodEntry[];
    };
    /**
     * v1.28.x — source-discrepancy annotation for the latest night behind
     * `summaries.SLEEP_DURATION.latest` (see `SummariesSlice`). Null when
     * the writers agree or the sleep module is off. Optional on the type
     * (additive contract) so older cached snapshots / fixtures stay valid.
     */
    sleepSourceDiscrepancy?: SleepSourceDiscrepancy | null;
  };
  /** Thick phase — null on a rollup-coverage miss. */
  extras: DashboardSnapshotExtras | null;
  /**
   * Fast phase — today's medication block (projection-backed tally +
   * earliest next-due across active medications).
   *
   * Caching contract: the snapshot is served read-through a cache, so
   * `medsToday.nextDueAt` can sit in the past with
   * `medsToday.nextDueOverdue: false` when the slot's anchor passed
   * AFTER the snapshot was built. Consumers MUST render that state as
   * the plain day summary — never as overdue — until a fresh snapshot
   * carries `nextDueOverdue: true` from the band model itself.
   */
  medsToday: MedsTodayBlock;
  /**
   * Warm-phase health score (score + band + delta only — no
   * components). `null` on a rollup-coverage miss (the score rides the
   * thick phase alongside `extras`) and when no pillar is computable.
   */
  healthScore: DashboardSnapshotHealthScore | null;
  /**
   * v1.27.7 — the user-selected hero score rings (max 3), resolved
   * server-side: READINESS / RECOVERY_SCORE / SLEEP_SCORE through the
   * same engines the derived batch route calls, MED_COMPLIANCE as
   * TODAY's dose tally (taken / scheduled, from the snapshot's own
   * medsToday block — v1.27.8; not a trailing 7-day rate). Only
   * rings with data appear (selection order preserved); module-disabled
   * and data-less selections drop out, so the hero row self-gates.
   * Optional on the type (additive contract) so older cached snapshots
   * / fixtures stay valid; the live builder always sets it.
   */
  scoreRings?: DashboardScoreRing[];
  briefing: DailyBriefing | null;
  /**
   * v1.21.2 (A4) — server-resolved recall + forward-look for the briefing card.
   * Null when no prior narrative is on file. Rides the snapshot DTO so iOS reads
   * the same already-localised block. Optional on the type (additive contract)
   * so older cached snapshots / fixtures without it stay valid.
   */
  briefingMemory?: DashboardSnapshotBriefingMemory | null;
  briefingState: BriefingState;
  briefingUpdatedAt: string | null;
  /**
   * v1.15.20 — additive honesty flag. `true` when `briefing` carries the
   * LAST GOOD (expired-TTL) briefing while a refresh is pending
   * (`briefingState: "preparing"`) or will never come
   * (`"no-provider"`). Clients show the stale content with its
   * `briefingUpdatedAt` timestamp instead of a blank tile — the same
   * stale-while-revalidate honesty the insights page uses.
   */
  briefingStale: boolean;
  generatedAt: string;
}

/** Minimal user shape the builder needs — a subset of the Prisma `User`. */
export interface SnapshotUserInput {
  id: string;
  username: string;
  displayName?: string | null;
  timezone: string | null;
  heightCm: number | null;
  dateOfBirth: Date | null;
  gender: string | null;
  glucoseUnit: string | null;
  onboardingTourCompleted: boolean;
  disableCoach: boolean;
  insightsCachedText: string | null;
  insightsCachedAt: Date | null;
  /**
   * Language the cached text was generated in. `null` on rows written before
   * the tag existed (served as-is). A tag that differs from the reader's
   * locale makes the cache count as absent for prose purposes.
   */
  insightsCachedLocale: string | null;
  dashboardWidgetsJson: unknown;
  /** Raw source-priority settings already loaded with the authenticated user. */
  sourcePriorityJson?: unknown;
  /**
   * Raw personal targets used by the unscored weight-goal context row and
   * dashboard reference bands.
   */
  thresholdsJson: unknown;
  /**
   * Raw per-user Health Score recipe. Part of the number's identity, so
   * it is required rather than optional: a snapshot built without it
   * would show a score composed from someone else's rules.
   */
  healthScoreConfigJson: unknown;
}

function enrichLastSeen(
  raw: Record<string, { lastSeenAt: string } | null>,
  nowMs: number,
): Record<string, { lastSeenAt: string; daysAgo: number } | null> {
  const out: Record<string, { lastSeenAt: string; daysAgo: number } | null> =
    {};
  for (const [type, slot] of Object.entries(raw)) {
    if (slot === null) {
      out[type] = null;
      continue;
    }
    const lastMs = new Date(slot.lastSeenAt).getTime();
    const daysAgo = Math.floor((nowMs - lastMs) / (24 * 60 * 60 * 1000));
    out[type] = { lastSeenAt: slot.lastSeenAt, daysAgo };
  }
  return out;
}

/**
 * Read-only mood block. v1.17.1 — delegates to the single mood engine
 * `buildMoodDailySeries` so the dashboard tile reads the exact numbers
 * `/api/mood/analytics` (the insights mood sparkline source) returns.
 */
async function buildMoodBlock(
  client: PrismaClient,
  userId: string,
): Promise<{
  summary: DataSummary | null;
  entries: DashboardSnapshotMoodEntry[];
}> {
  const series = await buildMoodDailySeries(userId, client);
  return { summary: series.summary, entries: series.entries };
}

/**
 * v1.29 — fluid-intake dashboard tile block, read from `NutrientIntakeDay`
 * (nutrient="water", last 30 day-keys, summed ACROSS SOURCES per day —
 * migration 0249 can carry an APPLE_HEALTH row and a MANUAL row for the
 * same day). ≤ 60 rows off the existing `(userId, nutrient, day desc)`
 * index. Sparse by construction (only days with an actual write become a
 * `DataPoint`) — matching the convention every real `MeasurementType`
 * summary follows: an unlogged day is absent, not a zero reading. `null`
 * when there is no water data in the window; the caller strips the
 * synthetic `NUTRIENT_WATER` key entirely in that case (mirrors mood).
 * Always fetched (cheap, indexed) and stripped post-hoc by
 * `gateSummariesByModules` when the `nutrients` module is off — the same
 * fetch-then-gate posture the sleep/glucose/recovery types already use.
 */
async function buildNutrientWaterBlock(
  prisma: PrismaClient,
  userId: string,
): Promise<{ summary: DataSummary; lastSeenAt: string } | null> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const rows = await prisma.nutrientIntakeDay.findMany({
    where: { userId, nutrient: "water", day: { gte: since } },
    select: { day: true, amount: true },
  });
  if (rows.length === 0) return null;

  const sumByDay = new Map<string, number>();
  for (const row of rows) {
    sumByDay.set(row.day, (sumByDay.get(row.day) ?? 0) + row.amount);
  }
  const points: DataPoint[] = [...sumByDay.entries()]
    .map(([day, amount]) => ({
      date: new Date(`${day}T00:00:00.000Z`),
      value: amount,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return {
    summary: summarize(points),
    lastSeenAt: points[points.length - 1].date.toISOString(),
  };
}

/**
 * Thick slice — BD-Zielbereich + per-context glucose + health score.
 * Only called by the builder when the rollup tier is warm for the
 * types this slice actually reads (`isThickPhaseWarm`); the BP
 * fast-path then stays on the sub-second rollup branch and never drops
 * into the multi-second live fallback that would make the whole strip
 * wait. On a coverage miss for one of those types the builder skips
 * this entirely and emits `extras: null` + `healthScore: null`
 * (per-tile shimmer until the boot backfill converges).
 *
 * The Health Score rides this warm phase because it reuses the BP windows and
 * coverage map. Weight remains in the warm gate for the unscored personal-goal
 * row, which must not force a dense live fallback while the rollup backfill is
 * pending.
 *
 * v1.34 — takes the resolved module map so a disabled mental-assessment module
 * cannot leave WELLBEING in this composition while Insights omits it.
 */
async function buildExtras(
  prisma: PrismaClient,
  user: SnapshotUserInput,
  userTz: string,
  coverage: RollupCoverageMap,
  now: Date,
  time: <T>(label: string, fn: () => Promise<T>) => Promise<T>,
  modules: Record<ModuleKey, boolean>,
): Promise<{
  extras: DashboardSnapshotExtras;
  healthScore: DashboardSnapshotHealthScore | null;
}> {
  let bpInTargetPct: number | null = null;
  let bpInTargetPct7d: number | null = null;
  let bpInTargetPct30d: number | null = null;
  let bpInTargetPctAllTime: number | null = null;
  let bpInTargetPctPriorMonth: number | null = null;
  let bpInTargetPctPriorYear: number | null = null;
  let bpInTargetCount90: number | null = null;
  let bpInTargetSpanDays90: number | null = null;
  // v1.17 W1b — hold the current + prior-week BP envelopes so the shared
  // Health-Score input builder grades the pillar off the identical shape the
  // analytics route uses.
  let bpEnvelope: BpInTargetEnvelope | null = null;
  let bpEnvelopePriorWeek: BpInTargetEnvelope | null = null;
  let bpEnvelopePriorTwoWeeks: BpInTargetEnvelope | null = null;

  const bpTargets = resolveEffectiveBpTargets(
    {
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      heightCm: user.heightCm ?? null,
    },
    user.thresholdsJson,
  );
  const clinicalBpTargets = getBpTargets(user.dateOfBirth);
  if (bpTargets) {
    // v1.17 W1b — two runs (current + prior-week), identical to the
    // analytics route, so the dashboard ring's week-over-week delta reflects
    // BP movement instead of zeroing it out. Both reuse the already-probed
    // coverage map and share the rollup/live branch decision.
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const [windows, windowsPriorWeek, windowsPriorTwoWeeks] = await Promise.all(
      [
        computeBpInTargetFastPath({
          userId: user.id,
          targets: bpTargets,
          now,
          coverage,
          userTz,
        }),
        computeBpInTargetFastPath({
          userId: user.id,
          targets: bpTargets,
          now: sevenDaysAgo,
          coverage,
          userTz,
        }),
        computeBpInTargetFastPath({
          userId: user.id,
          targets: bpTargets,
          now: fourteenDaysAgo,
          coverage,
          userTz,
        }),
      ],
    );
    if (bpTargetsEqual(bpTargets, clinicalBpTargets)) {
      bpEnvelope = windows;
      bpEnvelopePriorWeek = windowsPriorWeek;
      bpEnvelopePriorTwoWeeks = windowsPriorTwoWeeks;
    } else if (clinicalBpTargets) {
      [bpEnvelope, bpEnvelopePriorWeek, bpEnvelopePriorTwoWeeks] =
        await Promise.all([
          computeBpInTargetFastPath({
            userId: user.id,
            targets: clinicalBpTargets,
            now,
            coverage,
            userTz,
          }),
          computeBpInTargetFastPath({
            userId: user.id,
            targets: clinicalBpTargets,
            now: sevenDaysAgo,
            coverage,
            userTz,
          }),
          computeBpInTargetFastPath({
            userId: user.id,
            targets: clinicalBpTargets,
            now: fourteenDaysAgo,
            coverage,
            userTz,
          }),
        ]);
    }
    // v1.17 W1d — the headline standardises on the trailing-90-day
    // window (labelled "· 90 T" in the tile), identical to the analytics
    // route, so the dashboard tile and the insights surface never narrate
    // two windows for the same metric. All-time stays carried for the
    // detail page's long view only.
    bpInTargetPct = windows.last90Days?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
    bpInTargetPctAllTime = windows.allTime?.pct ?? null;
    bpInTargetPctPriorMonth = windows.priorMonth?.pct ?? null;
    bpInTargetPctPriorYear = windows.priorYear?.pct ?? null;
    // v1.17 W1b — count + effective span for the tile's confidence gate,
    // derived through the shared helper so this surface and `/api/analytics`
    // can never disagree on the gate or the label span.
    const bpWindow = deriveBpWindow90(
      windows.last90Days,
      windows.last90EarliestAt,
      now,
    );
    bpInTargetCount90 = bpWindow.count;
    bpInTargetSpanDays90 = bpWindow.spanDays;
  }

  // Health score — reuses the BP windows captured above plus the
  // already-probed coverage map (no second probe). Score + band +
  // delta only; the component breakdown stays off this wire.
  //
  // v1.17 W1b — the BP-pillar inputs come from the ONE shared
  // `buildHealthScoreBpInputs` builder the analytics route also uses, so the
  // ring and the insights card grade the pillar off identical inputs (same
  // 90-day window via W1d, same all-time fallback, same graded score, same
  // prior-week delta values). Closes the dashboard-vs-insights divergence.
  const scoreSourcePriority = user.sourcePriorityJson ?? null;
  const scoreResult = await time("healthScore", () =>
    computeAndRecordUserHealthScore({
      prisma,
      userId: user.id,
      now,
      profile: {
        dateOfBirth: user.dateOfBirth,
        heightCm: user.heightCm,
        timezone: userTz,
        sourcePriorityJson: scoreSourcePriority,
        thresholdsJson: user.thresholdsJson,
      },
      modules: {
        glucose: modules.glucose !== false,
        labs: modules.labs !== false,
        sleep: modules.sleep !== false,
        mentalHealth: modules.mentalHealth !== false,
      },
      healthScoreConfigJson: user.healthScoreConfigJson,
      bpTargets: clinicalBpTargets,
      bpEnvelope,
      bpEnvelopePriorWeek,
      bpEnvelopePriorTwoWeeks,
    }),
  );
  // v1.18.1 — resolve the value-free Rest Mode annotation alongside the score
  // so the dashboard hero can frame (never penalise) the number, matching the
  // `/api/analytics` payload + iOS. Fail-soft inside `resolveRestMode`, and
  // only resolved when a score actually rendered.
  const restMode: RestModeAnnotation | null =
    scoreResult.composite.status === "ok"
      ? await (async () => {
          const ctx = await resolveRestMode(user.id, now);
          return ctx.active
            ? {
                active: true,
                since: ctx.since,
                episodeCount: ctx.episodeCount,
              }
            : null;
        })()
      : null;
  const healthScore: DashboardSnapshotHealthScore | null =
    scoreResult.composite.status === "ok"
      ? {
          score: scoreResult.composite.value.score,
          band: scoreResult.composite.value.band,
          delta: scoreResult.delta,
          confidence: scoreResult.composite.confidence,
          composition: scoreResult.composite.value.composition,
          configured: scoreResult.composite.value.configured,
          scoreBasis: scoreResult.composite.value.scoreBasis,
          deltaReason: scoreResult.deltaReason,
          scoreVersion: scoreResult.scoreVersion,
          bandSetter: scoreResult.composite.value.bandSetter,
          restMode,
        }
      : null;

  const glucoseSince = new Date(
    Date.now() - GLUCOSE_PANEL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const glucoseRows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "BLOOD_GLUCOSE",
      measuredAt: { gte: glucoseSince },
      deletedAt: null,
    },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, glucoseContext: true },
  });
  // #943 — grouped through the shared bucket resolver, so readings with no
  // meal-time tag land in `UNSPECIFIED` instead of being dropped on the floor.
  const glucoseByContext: Record<string, DataSummary> = {};
  for (const [bucket, ctxRows] of groupByGlucoseContext(
    glucoseRows,
    (r) => r.glucoseContext,
  )) {
    glucoseByContext[bucket] = summarize(
      ctxRows.map((r): DataPoint => ({ date: r.measuredAt, value: r.value })),
    );
  }

  // v1.17.0 — clinical panel from the SAME 30-day glucose rows already read
  // above (no extra DB hop), computed by the one literature-locked engine so
  // the iOS cold-launch seed matches the web panel / coach / doctor report.
  const glucoseClinical = computeGlucoseClinicalMetrics(
    glucoseRows.map((r) => ({ measuredAt: r.measuredAt, mgdl: r.value })),
    { windowDays: GLUCOSE_PANEL_WINDOW_DAYS, now },
  );

  return {
    extras: {
      bpInTargetPct,
      bpInTargetPct7d,
      bpInTargetPct30d,
      bpInTargetPctAllTime,
      bpInTargetPctPriorMonth,
      bpInTargetPctPriorYear,
      bpInTargetCount90,
      bpInTargetSpanDays90,
      glucoseByContext,
      glucoseClinical,
    },
    healthScore,
  };
}

/** Parse + validate the cached `dailyBriefing` block; null when unusable. */
function parseCachedBriefing(cachedText: string | null): DailyBriefing | null {
  if (!cachedText) return null;
  try {
    const parsed = JSON.parse(cachedText) as Record<string, unknown>;
    const candidate = parsed?.dailyBriefing;
    if (candidate == null) return null;
    const validated = dailyBriefingSchema.safeParse(candidate);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

/**
 * Read-only briefing lift. Parses `User.insightsCachedText`, validates
 * the `dailyBriefing` block, and reports a four-state. NEVER calls the
 * provider chain — `hasProvider` is a credential-PRESENCE thunk (two
 * narrow reads, no decrypt, no network) evaluated only on the
 * stale/missing path, so the common warm-cache snapshot pays nothing.
 *
 * v1.15.20 — two honesty upgrades over the old tri-state:
 *   - a stale-but-parseable briefing is DELIVERED with
 *     `briefingStale: true` (plus its timestamp) instead of `null`, so
 *     the tile can show yesterday's content while the warm pass runs;
 *   - when no provider is configured anywhere the state is
 *     `"no-provider"` instead of an eternal `"preparing"`, so clients
 *     can point at Settings → AI rather than spin forever.
 */
async function liftBriefing(
  user: SnapshotUserInput,
  coachEnabled: boolean,
  hasProvider: () => Promise<boolean>,
  readerLocale: Locale,
): Promise<{
  briefing: DailyBriefing | null;
  briefingState: BriefingState;
  briefingUpdatedAt: string | null;
  briefingStale: boolean;
}> {
  if (!coachEnabled || user.disableCoach) {
    return {
      briefing: null,
      briefingState: "disabled",
      briefingUpdatedAt: null,
      briefingStale: false,
    };
  }

  // The cache is one slot per user with no per-language copy. Prose written
  // in another language is never the reader's briefing, stale or not, so a
  // differing tag makes the slot count as never generated: no text, no
  // timestamp. The advisor read (`GET /api/insights/generate`) enqueues the
  // re-warm in the reader's language on the same condition. An untagged row
  // predates the tag and is served as before.
  const cachedLocale = user.insightsCachedLocale;
  const languageMismatch =
    cachedLocale !== null && cachedLocale !== readerLocale;
  const cachedAt = languageMismatch ? null : user.insightsCachedAt;
  const updatedAt = cachedAt?.toISOString() ?? null;
  const stale = !cachedAt || Date.now() - cachedAt.getTime() >= BRIEFING_TTL_MS;
  const cachedBriefing = languageMismatch
    ? null
    : parseCachedBriefing(user.insightsCachedText);

  if (!stale && cachedBriefing) {
    return {
      briefing: cachedBriefing,
      briefingState: "ready",
      briefingUpdatedAt: updatedAt,
      briefingStale: false,
    };
  }

  // Stale or unusable cache — distinguish "a warm pass will fill this"
  // from "nothing ever will" so the client can stop waiting honestly.
  const briefingState: BriefingState = (await hasProvider())
    ? "preparing"
    : "no-provider";
  return {
    // Serve the last good briefing (when one parses) instead of a blank
    // tile; `briefingStale: true` + the timestamp carry the honesty.
    briefing: cachedBriefing,
    briefingState,
    briefingUpdatedAt: updatedAt,
    briefingStale: cachedBriefing !== null,
  };
}

/**
 * v1.7.0 — derive the per-metric latest-reading block from the slim
 * summaries slice already fetched for `tiles.summaries`. ZERO extra DB
 * round-trips: the slim slice's `DISTINCT ON (type)` read already
 * carries the latest `value` (`summaries[type].latest`) and the
 * matching timestamp (`lastSeenByType[type].lastSeenAt`); the unit is
 * the static canonical-unit lookup. This keeps the snapshot pool-safe
 * — no new query is issued against the shared Prisma pool.
 *
 * Keyed by the iOS `MetricKind` raw value so the iOS cold-launch seed
 * can decode each entry directly. Types with no iOS counterpart, no
 * latest value, or no timestamp are omitted (no key emitted).
 */
function buildMetricStates(
  summaries: Record<string, DataSummary>,
  lastSeenByType: Record<string, { lastSeenAt: string } | null>,
): Record<string, DashboardMetricState> {
  const out: Record<string, DashboardMetricState> = {};
  for (const [type, metricKindRaw] of Object.entries(METRIC_KIND_RAW_BY_TYPE)) {
    if (!metricKindRaw) continue;
    const summary = summaries[type];
    const lastSeen = lastSeenByType[type];
    if (!summary || summary.latest === null || !lastSeen) continue;
    // v1.11.4 — `summaries.SLEEP_DURATION.latest` now carries last night's
    // TIME-ASLEEP total in MINUTES (the slim slice collapses the per-stage
    // rows). Emit the cold-launch seed in HOURS with an explicit `unit:
    // "h"` so it matches the `/api/dashboard/summary` sleep tile, which
    // already emits hours. Every other metric passes through with its
    // canonical stored unit.
    if (type === "SLEEP_DURATION") {
      out[metricKindRaw] = {
        value: Math.round((summary.latest / 60) * 100) / 100,
        measuredAt: lastSeen.lastSeenAt,
        unit: "h",
      };
      continue;
    }
    out[metricKindRaw] = {
      value: summary.latest,
      measuredAt: lastSeen.lastSeenAt,
      unit: getUnitForType(type),
    };
  }
  return out;
}

/**
 * v1.7.0 — full 27-id widget catalogue (visibility + order). The
 * server-known ids inherit the user's resolved layout (the same
 * `visible` / `order` the web `layout` block carries); the 11 iOS-only
 * ids are appended default-invisible after the highest known order so
 * the catalogue round-trips in one key. Pure projection over the
 * already-resolved layout — no DB read.
 */
function buildLayoutCatalogue(
  layout: DashboardLayout,
): DashboardLayoutCatalogueEntry[] {
  const knownById = new Map<string, { visible: boolean; order: number }>();
  for (const w of layout.widgets) {
    knownById.set(w.id, { visible: w.visible, order: w.order });
  }
  let nextOrder =
    layout.widgets.length > 0
      ? Math.max(...layout.widgets.map((w) => w.order)) + 1
      : 0;
  const out: DashboardLayoutCatalogueEntry[] = [];
  for (const id of DASHBOARD_WIDGET_CATALOGUE_IDS) {
    const known = knownById.get(id);
    if (known) {
      out.push({ id, visible: known.visible, order: known.order });
    } else {
      // iOS-only id — not in the user's saved layout. Append
      // default-invisible after the known ids, mirroring the on-read
      // auto-upgrade convention for newly-introduced widgets.
      out.push({ id, visible: false, order: nextOrder });
      nextOrder += 1;
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

/**
 * Per-type warm gate for the thick phase (extras + healthScore),
 * replacing the all-types `isFullyCovered` AND. The all-types gate
 * nulled the whole thick phase whenever ANY unrelated type lacked a
 * DAY bucket — one fresh wearable reading whose async fold hadn't
 * landed yet zeroed the hero score, while the insights analytics
 * route (which calls the self-gating helpers unconditionally) kept
 * showing a score for the same account. Gate only the dense types the thick
 * phase might otherwise read live: blood-pressure pairs and activity slices.
 * Sparse weight rows feed the unscored personal-goal disclosure and remain
 * cheap; every other score input is naturally sparse.
 *
 * `!== false` rather than `=== true`: a type ABSENT from the map has
 * zero measurements, so the helpers' own live fallbacks are trivially
 * cheap (empty reads) and absence must not cold the phase. A type
 * present-but-`false` has live rows without buckets — for these dense types
 * that is exactly the multi-second live fallback the snapshot must never
 * wait on, so the phase stays `null` until the backfill converges.
 * An empty map is a fresh account with no measurements at all — nothing to
 * compute, so the thick phase stays `null`.
 */
function isThickPhaseWarm(coverage: RollupCoverageMap): boolean {
  if (coverage.size === 0) return false;
  return (
    coverage.get("WEIGHT") !== false &&
    coverage.get("BLOOD_PRESSURE_SYS") !== false &&
    coverage.get("BLOOD_PRESSURE_DIA") !== false &&
    coverage.get("ACTIVITY_STEPS") !== false
  );
}

/**
 * v1.18.0 — force every widget whose module is disabled to invisible on
 * the resolved layout (both `visible` and `tileVisible`). Order is
 * preserved so a re-enable restores the user's saved position. Pure
 * projection — the persisted `dashboardWidgetsJson` is untouched; only
 * what the snapshot publishes is gated.
 */
function gateLayoutByModules(
  layout: DashboardLayout,
  modules: Record<ModuleKey, boolean>,
  summaries: Record<string, DataSummary>,
): DashboardLayout {
  // Widgets that cannot paint for THIS account, on the same rule the
  // Settings screen hides their toggle with — so the layout the dashboard
  // renders and the switches the user is offered never disagree.
  const unavailable = new Set(
    unavailableWidgetIds(modules, {
      hasSdnn: (summaries.HEART_RATE_VARIABILITY?.count ?? 0) > 0,
    }),
  );
  return {
    ...layout,
    widgets: layout.widgets.map((w) => {
      const moduleKey = WIDGET_MODULE_BY_ID[w.id];
      if (moduleKey && modules[moduleKey] === false) {
        return { ...w, visible: false, tileVisible: false };
      }
      if (unavailable.has(w.id)) {
        return { ...w, visible: false, tileVisible: false };
      }
      return w;
    }),
  };
}

/**
 * v1.21.2 (A4) — map the machine-derived coach memory block onto the briefing
 * card's `{ recall, forward }` shape, both already-localised. `recall` is the
 * prior period's narrative headline (locale-generated prose). `forward` points
 * ahead from the single most salient trend drift (a metric whose current-period
 * center has moved OUT of its prior personal band), or a calm "holding steady"
 * line when nothing drifted. Returns `null` when there is no prior narrative to
 * recall — silence is the default, never a fabricated callback.
 *
 * Localised through the server translator + the EXISTING metric-name keys
 * (`measurements.type*`). Two NEW forward-look template keys
 * (`insights.briefing.memory.forwardWatch` / `forwardHolding`) are reported to
 * the orchestrator; they degrade to the raw key string until the bundle lands.
 */
function mapBriefingMemory(
  block: CoachMemoryBlock | null,
  locale: Locale,
): DashboardSnapshotBriefingMemory | null {
  if (!block?.priorNarrative) return null;
  const recall = block.priorNarrative.headline.trim();
  if (recall.length === 0) return null;

  const { t } = getServerTranslator(locale);

  // The most salient drift: a trend metric whose current-period center sits
  // OUT of its prior band. Deterministic — first in canonical map order. When
  // none drifted, the forward-look is the calm "holding steady" line.
  const driftType = Object.keys(block.trendMemory).find(
    (type) => block.trendMemory[type]?.currentBand !== "in",
  );
  let forward: string;
  if (driftType) {
    const metricLabel = localisedMeasurementLabel(driftType, t);
    forward = t("insights.briefing.memory.forwardWatch", {
      metric: metricLabel,
    });
  } else {
    forward = t("insights.briefing.memory.forwardHolding");
  }
  return { recall, forward };
}

/**
 * Localised display name for a `MeasurementType`, via the existing
 * `measurements.type*` keys (reused — no new metric-name keys). Falls back to
 * the prettified raw type when no key resolves so a new type never blanks.
 */
function localisedMeasurementLabel(
  type: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  // `WALKING_RUNNING_DISTANCE` → `measurements.typeWalkingRunningDistance`.
  const camel = type
    .toLowerCase()
    .split("_")
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  const key = `measurements.type${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
  const resolved = t(key);
  // The server translator echoes the key on a miss; fall back to a readable form.
  return resolved === key ? type.replace(/_/g, " ").toLowerCase() : resolved;
}

/**
 * The narrative row is keyed by the full six-locale union — the pipeline
 * generates and stores a row per UI locale — so the briefing memory recall
 * reads the caller's locale directly. This used to narrow to de/en, which
 * would now read a row a fr/es/it/pl account never has.
 */

/**
 * Assemble the full snapshot in ONE `Promise.all`. Every sub-read is
 * timed via the optional `time` wrapper so a regression is attributable
 * through `meta.snapshot.sub_*_ms` without re-instrumenting the route.
 */
export async function buildDashboardSnapshot(
  prisma: PrismaClient,
  user: SnapshotUserInput,
  options: {
    /** Optional per-sub-query timing sink (route surfaces it under `meta`). */
    time?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
    /**
     * Provider credential-presence probe for the briefing lift —
     * injectable for tests. Defaults to the cheap presence check in
     * `@/lib/ai/provider` (no decrypt, no network).
     */
    hasProvider?: () => Promise<boolean>;
    /**
     * v1.18.0 — resolved per-user module map. Injectable for tests;
     * defaults to `resolveModuleMap(user.id)` (memoised per request).
     * Disabled toggleable modules have their dashboard tiles / data
     * stripped from the snapshot at the build layer so nothing leaks to
     * the client.
     */
    modules?: () => Promise<Record<ModuleKey, boolean>>;
    /**
     * v1.21.2 — active locale for the A4 briefing memory prose. Defaults to
     * English; the route resolves it from the request (cookie / header / user
     * preference). The recall headline is read locale-specific: the narrative
     * row `buildCoachMemoryBlock` reads is keyed by this exact locale.
     */
    locale?: Locale;
    /**
     * v1.21.2 — injectable narrative-memory builder so the snapshot tests can
     * exercise the A4 wire without a narrative row. Defaults to the real
     * `buildCoachMemoryBlock`.
     */
    coachMemory?: typeof buildCoachMemoryBlock;
    /**
     * v1.21.2 — injectable score-narrative builder (A5 tension + A6
     * return-to-baseline) so the snapshot tests can drive the wire without the
     * derived engines. Defaults to the real `buildScoreNarrativeBlock`.
     */
    scoreNarrative?: typeof buildScoreNarrativeBlock;
    /**
     * v1.27.7 — injectable hero score-ring resolver so the snapshot tests
     * can pin the wire without the derived engines / compliance reads.
     * Defaults to the real `buildScoreRingsBlock`.
     */
    scoreRings?: typeof buildScoreRingsBlock;
  } = {},
): Promise<DashboardSnapshot> {
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;
  const now = new Date();
  const nowMs = now.getTime();
  const time =
    options.time ?? (<T>(_label: string, fn: () => Promise<T>) => fn());

  // Probe coverage once up front so the thick `extras` phase only runs
  // when the rollup tier is warm for the types it reads. A coverage
  // miss on one of those types returns `extras: null` immediately
  // rather than dropping into the live-SQL fallback that would make
  // the whole strip wait on the slowest read (R-firstpaint §6 —
  // paint-together vs slowest-wins). Unrelated uncovered types do NOT
  // cold the phase (see `isThickPhaseWarm`).
  const coverage = await time("coverage", () => probeRollupCoverage(user.id));
  const warm = isThickPhaseWarm(coverage);

  // Resolve the stored layout once up front: the hero score rings read
  // the `selectedScoreRings` preference off it, and the module-gated
  // `layout` block below reuses the same resolution.
  const storedLayout = resolveDashboardLayout(user.dashboardWidgetsJson);

  // v1.18.0 — resolved module map (memoised per request); gates the
  // toggleable tiles below at the build layer. Held as a shared promise
  // so the score-ring task can await it inside the same `Promise.all`
  // without a second resolver call.
  const modulesPromise = time("modules", () =>
    (options.modules ?? (() => resolveModuleMap(user.id)))(),
  );

  // Fast phase — projection-backed today tally + earliest next-due. Held
  // as a shared promise (the `modulesPromise` pattern) so the score-ring
  // task can read today's dose tally inside the same `Promise.all`
  // without a second builder call.
  const medsTodayPromise = time("medsToday", () =>
    buildMedsTodayBlock(prisma, user.id, userTz, now),
  );

  const [
    slimRaw,
    moodRaw,
    extrasResult,
    flags,
    medsToday,
    modules,
    scoreRings,
    nutrientWater,
  ] = await Promise.all([
    // A5 — reuse the coverage map already probed above so the slice
    // doesn't re-run the identical `probeRollupCoverage` query.
    time("summaries", () => computeSummariesSlice(user.id, coverage)),
    time("mood", () => buildMoodBlock(prisma, user.id)),
    // v1.34 — the thick slice awaits the shared `modulesPromise` (the same
    // pattern the score-ring task uses) so the hero ring's health score can
    // gate its mood pillar on the resolved module map without a second
    // resolver call or a serialised phase.
    warm
      ? time("extras", async () =>
          buildExtras(
            prisma,
            user,
            userTz,
            coverage,
            now,
            time,
            await modulesPromise,
          ),
        )
      : Promise.resolve(null),
    time("flags", () => getAssistantFlags()),
    medsTodayPromise,
    modulesPromise,
    // v1.27.7 — the selected hero score rings, resolved through the
    // same engines the derived batch route calls; the dose ring reads
    // today's tally off the shared medsToday block. Fail-soft: a
    // throwing resolver yields no rings, never a sunk snapshot.
    time("scoreRings", async () =>
      (options.scoreRings ?? buildScoreRingsBlock)(
        prisma,
        user.id,
        storedLayout.selectedScoreRings ?? [],
        await modulesPromise,
        now,
        await medsTodayPromise,
      ),
    ).catch(() => [] as DashboardScoreRing[]),
    // v1.29 — fluid-intake tile block (see `buildNutrientWaterBlock`).
    time("nutrientWater", () => buildNutrientWaterBlock(prisma, user.id)),
  ]);

  // v1.29 — fold the water block into the slim slice under a synthetic
  // `NUTRIENT_WATER` key BEFORE the module gate below strips it (like
  // every other summary type) when `nutrients` is off. Not a real
  // `MeasurementType` — see the widened `SUMMARY_TYPE_MODULE` note.
  if (nutrientWater) {
    const lastMs = new Date(nutrientWater.lastSeenAt).getTime();
    const daysAgo = Math.floor((nowMs - lastMs) / (24 * 60 * 60 * 1000));
    slimRaw.summaries = {
      ...slimRaw.summaries,
      NUTRIENT_WATER: nutrientWater.summary,
    };
    slimRaw.lastSeenByType = {
      ...slimRaw.lastSeenByType,
      NUTRIENT_WATER: { lastSeenAt: nutrientWater.lastSeenAt, daysAgo },
    };
  }

  // v1.18.0 — strip disabled-module data before it leaves the server.
  // Mood is blanked when the mood module is off; sleep / glucose summary
  // types are dropped from the slim slice; the glucose clinical panel +
  // per-context block are cleared when glucose is off; the layout +
  // catalogue hide every disabled-module widget.
  const slim = gateSummariesByModules(
    slimRaw.summaries,
    slimRaw.lastSeenByType,
    modules,
  );
  const mood =
    modules.mood === false
      ? { summary: null, entries: [] as DashboardSnapshotMoodEntry[] }
      : moodRaw;
  if (extrasResult && modules.glucose === false) {
    extrasResult.extras.glucoseByContext = {};
    extrasResult.extras.glucoseClinical = computeGlucoseClinicalMetrics([], {
      windowDays: GLUCOSE_PANEL_WINDOW_DAYS,
      now,
    });
  }

  const layout = gateLayoutByModules(storedLayout, modules, slim.summaries);
  // v1.18.0 — the Daily Briefing is the dashboard's AI-narrative surface,
  // so the `insights` module gates it alongside the operator briefing
  // flag + per-user coach opt-out. Disabling `insights` yields the same
  // `briefingState: "disabled"` empty surface the existing flags produce
  // (the raw weight/BP/pulse data stays untouched — `insights` is the
  // narrative layer, not the data layer).
  // The reader's locale: the route resolves it from the request; the builder
  // defaults to English. It decides which cached briefing counts as the
  // reader's and which narrative row the briefing memory reads.
  const locale = options.locale ?? "en";
  const briefing = await liftBriefing(
    user,
    flags.briefing && modules.insights !== false,
    options.hasProvider ?? (() => hasAnyConfiguredProvider(user.id)),
    locale,
  );

  // v1.21.2 (A4 / A5 / A6) — the score-card narrative (Tension Verdict +
  // return-to-baseline) and the briefing recall + forward-look. Gated like the
  // briefing on the `insights` module so a narrative-off account carries none.
  // Both are fail-soft — a transient derived-engine read resolves to null and
  // never sinks the snapshot. The narrative block rides the warm phase's
  // healthScore; memory rides the briefing card.
  const narrativeSex = binaryReferenceSex(user.gender);
  const narrativeProfile = {
    ageYears: getAgeFromDateOfBirth(user.dateOfBirth),
    sex: narrativeSex,
    heightCm: user.heightCm ?? null,
  };
  // The Tension Verdict only adds signal once a health score actually rendered
  // (a coherent ring with no contributors is nothing to reconcile); memory only
  // matters once a briefing is shown.
  const narrativeEnabled =
    modules.insights !== false && extrasResult?.healthScore != null;
  const [scoreNarrative, coachMemoryBlock] = await Promise.all([
    narrativeEnabled
      ? time("scoreNarrative", () =>
          (options.scoreNarrative ?? buildScoreNarrativeBlock)(
            user.id,
            narrativeProfile,
            now,
            userTz,
            coverage,
          ),
        ).catch(() => null)
      : Promise.resolve(null),
    briefing.briefing !== null && modules.insights !== false
      ? time("coachMemory", () =>
          (options.coachMemory ?? buildCoachMemoryBlock)(
            user.id,
            narrativeProfile,
            now,
            locale,
          ),
        ).catch(() => null)
      : Promise.resolve(null),
  ]);
  const briefingMemory = mapBriefingMemory(coachMemoryBlock, locale);

  const gender = toProfileSex(user.gender);

  return {
    user: {
      username: user.displayName?.trim() || user.username,
      timezone: userTz,
      heightCm: user.heightCm ?? null,
      dateOfBirth: user.dateOfBirth?.toISOString() ?? null,
      gender,
      glucoseUnit: user.glucoseUnit ?? null,
      onboardingTourCompleted: user.onboardingTourCompleted,
    },
    layout,
    layoutCatalogue: buildLayoutCatalogue(layout),
    metricStates: buildMetricStates(slim.summaries, slim.lastSeenByType),
    targetBands: buildTargetBands({
      dateOfBirth: user.dateOfBirth,
      gender,
      heightCm: user.heightCm ?? null,
      // v1.34 — the user's own weight target, when they set one, replaces the
      // height-derived band on the tile + the chart. Resolved off the same
      // `thresholdsJson` blob the health score reads.
      weightTargetOverride: resolveWeightTargetOverride(user.thresholdsJson),
    }),
    tiles: {
      summaries: slim.summaries,
      lastSeenByType: enrichLastSeen(slim.lastSeenByType, nowMs),
      mood: {
        summary: mood.entries.length > 0 ? mood.summary : null,
        entries: mood.entries,
      },
      // v1.28.x — gated like the SLEEP_DURATION summary itself: a
      // disabled sleep module carries no sleep annotation either.
      sleepSourceDiscrepancy:
        modules.sleep === false ? null : slimRaw.sleepSourceDiscrepancy,
    },
    extras: extrasResult?.extras ?? null,
    medsToday,
    // v1.21.2 (A5 / A6) — fold the score-card narrative onto the health score so
    // the hero reads tension + return-to-baseline off the resolved score DTO.
    healthScore: extrasResult?.healthScore
      ? {
          ...extrasResult.healthScore,
          tension: scoreNarrative?.tension ?? null,
          returnToBand: scoreNarrative?.returnToBand ?? null,
        }
      : null,
    // v1.27.7 — the resolved hero score rings (selection order, data-
    // gated). Always set by the live builder; optional on the type so
    // older cached snapshots stay valid.
    scoreRings,
    briefing: briefing.briefing,
    // v1.21.2 (A4) — the briefing recall + forward-look. Null when there is no
    // prior narrative on file or no briefing is shown.
    briefingMemory: briefing.briefing !== null ? briefingMemory : null,
    briefingState: briefing.briefingState,
    briefingUpdatedAt: briefing.briefingUpdatedAt,
    briefingStale: briefing.briefingStale,
    generatedAt: now.toISOString(),
  };
}
