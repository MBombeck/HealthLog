/**
 * Snapshot builder for the Coach prompt.
 *
 * Reuses the analytics features pipeline so the Coach narrates the
 * exact same numbers the dashboard tiles render — single source of
 * truth for every "your avg30 BP is …" claim. The output is a compact
 * JSON block the system + user prompt frame as the SNAPSHOT for the
 * model to ground its reply in.
 *
 * v1.4.20.1 — extended with a day-level `timeline` block. The earlier
 * shipping shape carried only aggregated statistics (mean, slope, SD,
 * range, count) per metric, so a Coach turn could not answer questions
 * keyed to a specific day or weekday ("why was BP higher last
 * Monday?"). The timeline now ships the last 14 days as raw daily
 * values with weekday labels and aggregates the older window into
 * weekly buckets so the prompt budget stays tight.
 */
import { prisma } from "@/lib/db";
import { extractFeatures } from "@/lib/insights/features";
import {
  parseCoachPrefs,
  type CoachExcludeMetric,
  type CoachDataCluster,
} from "@/lib/validations/coach-prefs";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import { annotate } from "@/lib/logging/context";
import { buildGlp1SnapshotBlock } from "./glp1-snapshot";
import {
  CLUSTER_PRIORITY,
  clusterSourcesFromPrefs,
  sourceCluster,
} from "./clusters";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScope,
  CoachScopeSource,
  CoachScopeWindow,
} from "./types";

export interface CoachSnapshotResult {
  snapshotJson: string;
  /**
   * Provenance built from snapshot keys actually present. Stays in
   * sync with the SNAPSHOT block so the source-chip row mirrors what
   * the model could see.
   */
  provenance: CoachProvenance;
}

/**
 * Day-level cap for the raw timeline. Days within this window are kept
 * verbatim (one entry per day with weekday). Older days inside the
 * snapshot window are folded into weekly means so a 90-day window
 * lands at ~14 day-rows + ~11 week-rows ≈ 25 rows per metric — well
 * under the 3 000-token Coach turn budget on a 5-metric snapshot.
 */
const DAILY_TIMELINE_DAYS = 14;

/** Default window when the caller doesn't pass a scope. */
const DEFAULT_WINDOW: CoachScopeWindow = "last30days";

/**
 * v1.7.0 — assembled-snapshot soft char cap. After the snapshot is
 * built we measure `JSON.stringify(snapshot).length` as a ~4-chars-per-
 * token proxy and, if it exceeds this cap, progressively degrade the
 * lowest-priority clusters (drop `timeline.recent`, then collapse the
 * weekly buckets) until it fits. ~24 000 chars ≈ ~6 000 tokens, which
 * sits comfortably inside every provider's context alongside the system
 * prompt + history window. The daily token ledger (`budget.ts`) stays
 * the per-day cost backstop; this is the per-prompt shape backstop.
 */
const MAX_SNAPSHOT_CHARS = 24_000;

/**
 * v1.7.0 — when more than this many clusters are active, cap the
 * additive (non-core) clusters' timeline window so a 10-cluster,
 * allTime request can't fan the timeline out across every series at
 * once. The core clinical clusters keep the user-chosen window.
 */
const MULTI_CLUSTER_THRESHOLD = 6;
const MULTI_CLUSTER_WINDOW_CAP: CoachScopeWindow = "last90days";

/**
 * v1.7.0 — the workouts block never dumps every session. It carries
 * the most-recent N sessions verbatim plus a per-sport rollup for the
 * tail, so a heavy-training account at a long window stays bounded.
 */
const WORKOUT_RECENT_CAP = 15;
/**
 * Clusters that keep the user-chosen window even under the multi-cluster
 * cap — the high-signal clinical series.
 */
const CORE_CLUSTERS: ReadonlySet<CoachDataCluster> = new Set<CoachDataCluster>([
  "medication",
  "cardio",
  "glucose",
]);

const WEEKDAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function windowToDays(window: CoachScopeWindow): number {
  switch (window) {
    case "last7days":
      return 7;
    case "last30days":
      return 30;
    case "last90days":
      return 90;
    case "lastYear":
      // v1.4.27 B7 / BL-P6-4 — year-in-review window. Same 365-day
      // ceiling as the historical `allTime` cap so the prompt budget
      // stays bounded, but with explicit semantics — the Coach knows
      // the user is asking about a long-horizon view rather than the
      // unbounded "all time" backfill.
      return 365;
    case "allTime":
      // Cap "allTime" at one year for the timeline. The aggregate
      // section already cites multi-year ranges via the features
      // pipeline; the timeline stays tight to keep token budget sane.
      return 365;
  }
}

/**
 * YYYY-MM-DD day key anchored to the user's display timezone. The
 * prompt asks the Coach "did you read at 23:50 last night?" — that
 * "last night" answer has to use the user's clock, not UTC. Up to
 * v1.4.24 the day-key was UTC, so a 23:50 Pacific/Auckland reading
 * landed in the next UTC day's bucket and the Coach couldn't pair it
 * with the user's mental model.
 */
function tzDayKey(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * 0..6 → "Sun".."Sat" using the user's tz so "last Monday" in the
 * prompt agrees with the calendar the user is looking at.
 */
function tzWeekday(date: Date, tz: string): string {
  const wk = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(date);
  // Normalise "Mon" / "Mon," — modern engines drop the comma but
  // older ones may include it.
  const canon = wk.slice(0, 3) as (typeof WEEKDAY_KEYS)[number];
  return WEEKDAY_KEYS.includes(canon) ? canon : WEEKDAY_KEYS[date.getUTCDay()];
}

/**
 * ISO week key like 2026-W19. We derive the week from the user-tz
 * day-key so a Sunday-evening reading in Auckland (which is already
 * Monday UTC) labels under the Auckland week.
 */
function isoWeekKey(date: Date, tz: string): string {
  // Resolve the wall-clock date in the user's tz, then compute the ISO
  // week from that calendar date. The Thursday-alignment math is the
  // standard ISO 8601 algorithm.
  const dayKey = tzDayKey(date, tz);
  const [y, m, d] = dayKey.split("-").map(Number);
  const localMidnight = new Date(Date.UTC(y, m - 1, d));
  const dayNum = localMidnight.getUTCDay() || 7;
  localMidnight.setUTCDate(localMidnight.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(localMidnight.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((localMidnight.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${localMidnight.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

interface DailyValueRow {
  date: string;
  weekday: string;
  value: number;
}

interface DailyBpRow {
  date: string;
  weekday: string;
  sys: number;
  dia: number;
}

interface WeeklyBucket {
  weekISO: string;
  mean: number;
  count: number;
}

/**
 * Group raw measurements (one per row, possibly several per day) into
 * one entry per user-tz day. Multiple readings on the same day are
 * folded into the daily mean — clinically the morning reading is what
 * the Coach is usually asked about, but the snapshot stays pre-clinical
 * and takes the straight mean to avoid presenting a fabricated number.
 */
function dailyMeans<T extends { measuredAt: Date; value: number }>(
  rows: T[],
  tz: string,
): Map<string, { date: Date; values: number[] }> {
  const grouped = new Map<string, { date: Date; values: number[] }>();
  for (const r of rows) {
    const key = tzDayKey(r.measuredAt, tz);
    const existing = grouped.get(key);
    if (existing) {
      existing.values.push(r.value);
    } else {
      grouped.set(key, { date: r.measuredAt, values: [r.value] });
    }
  }
  return grouped;
}

function bucketWeekly(
  rows: Array<{ measuredAt: Date; value: number }>,
  tz: string,
): WeeklyBucket[] {
  const grouped = new Map<string, number[]>();
  for (const r of rows) {
    const key = isoWeekKey(r.measuredAt, tz);
    const list = grouped.get(key);
    if (list) {
      list.push(r.value);
    } else {
      grouped.set(key, [r.value]);
    }
  }
  return Array.from(grouped.entries())
    .map(([weekISO, values]) => ({
      weekISO,
      mean:
        Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) /
        10,
      count: values.length,
    }))
    .sort((a, b) => a.weekISO.localeCompare(b.weekISO));
}

function buildDailyValueRows(
  rows: Array<{ measuredAt: Date; value: number }>,
  recentCutoff: Date,
  tz: string,
): DailyValueRow[] {
  const recent = rows.filter((r) => r.measuredAt >= recentCutoff);
  const grouped = dailyMeans(recent, tz);
  return Array.from(grouped.entries())
    .map(([date, info]) => {
      const mean = info.values.reduce((s, v) => s + v, 0) / info.values.length;
      return {
        date,
        weekday: tzWeekday(info.date, tz),
        value: Math.round(mean * 10) / 10,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Pair systolic + diastolic into one row per day. Days with only one
 * side measured are dropped — the Coach is asked about "BP" as a pair,
 * and a half-measured day would invite a fabricated complement.
 */
function buildDailyBpRows(
  sysRows: Array<{ measuredAt: Date; value: number }>,
  diaRows: Array<{ measuredAt: Date; value: number }>,
  recentCutoff: Date,
  tz: string,
): DailyBpRow[] {
  const sysRecent = sysRows.filter((r) => r.measuredAt >= recentCutoff);
  const diaRecent = diaRows.filter((r) => r.measuredAt >= recentCutoff);
  const sysByDay = dailyMeans(sysRecent, tz);
  const diaByDay = dailyMeans(diaRecent, tz);
  const out: DailyBpRow[] = [];
  for (const [day, info] of sysByDay) {
    const dia = diaByDay.get(day);
    if (!dia) continue;
    const sysMean = info.values.reduce((s, v) => s + v, 0) / info.values.length;
    const diaMean = dia.values.reduce((s, v) => s + v, 0) / dia.values.length;
    out.push({
      date: day,
      weekday: tzWeekday(info.date, tz),
      sys: Math.round(sysMean),
      dia: Math.round(diaMean),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Resolve the working scope. The explicit request `scope.sources`
 * always wins as the maximum set (an iOS client can pin an exact
 * list). When it is absent the builder expands the user's saved
 * `dataClusters` instead — `clusterDefault` carries that expansion.
 * When neither is present (no prefs row at all, legacy native client)
 * the cluster resolver still returns `DEFAULT_COACH_CLUSTERS`, so the
 * legacy five domains stay the floor.
 *
 * v1.7.0 — replaces the constant `DEFAULT_SOURCES` fallback with the
 * cluster expansion threaded in by `buildCoachSnapshotImpl`.
 */
function resolveScope(
  scope: CoachScope | undefined,
  clusterDefault: ReadonlySet<CoachScopeSource>,
): {
  sources: ReadonlySet<CoachScopeSource>;
  window: CoachScopeWindow;
} {
  const sources =
    scope?.sources && scope.sources.length > 0
      ? new Set(scope.sources)
      : clusterDefault;
  return {
    sources,
    window: scope?.window ?? DEFAULT_WINDOW,
  };
}

/**
 * v1.4.33 — 60-second in-memory cache for `buildCoachSnapshot()`. The
 * snapshot reads only persisted data; a single chat conversation sends
 * 2-4 turns within a minute and the snapshot would otherwise rebuild
 * from the same rows each turn. Caching the result for 60s shaves the
 * ~10 measurement reads + the GLP-1 / mood / intake side-fetches off
 * every turn after the first, which `.planning/round-v1433-audit-perf.md`
 * §3.3 estimates at 200-800 ms of server-side tail.
 *
 * Scope is part of the cache key so a switch from `last30days` to
 * `last7days` (or a different `sources` set) computes fresh. The map
 * is bounded at 64 entries — a multi-tenant deployment with a few
 * active power users sits well inside that ceiling even if each cycles
 * through several scopes per minute.
 */
const SNAPSHOT_TTL_MS = 60_000;
const SNAPSHOT_LRU_MAX = 64;
const snapshotCache = new Map<
  string,
  { expiresAt: number; result: CoachSnapshotResult }
>();

function snapshotCacheKey(userId: string, scope: CoachScope | undefined): string {
  // v1.7.0 — when the request pins an explicit source list, key on it.
  // Otherwise the source set is derived from the user's saved
  // `dataClusters`, which we don't read here (the cache must stay
  // I/O-free on a hit) — key on a stable `clusters` marker instead.
  // A cluster change is reflected on the next cache miss (≤60 s), the
  // same staleness window every other pref change already tolerates.
  const window = scope?.window ?? DEFAULT_WINDOW;
  const sourceList =
    scope?.sources && scope.sources.length > 0
      ? Array.from(scope.sources).sort().join(",")
      : "clusters";
  return `${userId}|${window}|${sourceList}`;
}

function readSnapshotCache(key: string): CoachSnapshotResult | null {
  const entry = snapshotCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    snapshotCache.delete(key);
    return null;
  }
  // Touch for LRU — re-insert moves to the end of the Map's iteration order.
  snapshotCache.delete(key);
  snapshotCache.set(key, entry);
  return entry.result;
}

function writeSnapshotCache(key: string, result: CoachSnapshotResult): void {
  if (snapshotCache.size >= SNAPSHOT_LRU_MAX) {
    // Evict the oldest entry — JS Map iteration order is insertion order,
    // so the first key is the least-recently inserted/touched.
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) {
      snapshotCache.delete(oldest);
    }
  }
  snapshotCache.set(key, {
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    result,
  });
}

/** Clear the snapshot cache. Test-only escape hatch. */
export function __resetCoachSnapshotCacheForTests(): void {
  snapshotCache.clear();
}

/**
 * Build the Coach prompt snapshot for `userId`. Always uses
 * `includeRaw=false` because the Coach replies are conversational and
 * the user is asking the model — they should never depend on raw
 * measurement timestamps that the privacy mode controls.
 *
 * The snapshot now carries two sections per active metric:
 *   - aggregate: the v1.4.20 shape (mean, slope, SD, range, count)
 *   - timeline.recent: last `DAILY_TIMELINE_DAYS` days as raw daily
 *     values with weekday labels so the Coach can answer
 *     day/weekday-specific questions
 *   - timeline.weekly: ISO-week buckets covering the rest of the
 *     window so the Coach can still cite older weeks without ballooning
 *     the prompt
 *
 * v1.4.25 W7b — every day-key + weekday label is now anchored to the
 * user's display timezone (read from `User.timezone`). Falls back to
 * Europe/Berlin when the column is missing so the legacy snapshot
 * stays byte-identical for the only path the v1.4.24 suite tested.
 *
 * v1.4.33 — wraps the previous `buildCoachSnapshotImpl` with a 60s
 * in-memory LRU keyed on `(userId, window, sources)`. The Coach's
 * chat handler calls this once per turn; within the same conversation
 * the second+ turn lands a cache hit and skips the row-level reads.
 */
export async function buildCoachSnapshot(
  userId: string,
  scope?: CoachScope,
): Promise<CoachSnapshotResult> {
  const key = snapshotCacheKey(userId, scope);
  const cached = readSnapshotCache(key);
  if (cached) return cached;
  const result = await buildCoachSnapshotImpl(userId, scope);
  writeSnapshotCache(key, result);
  return result;
}

async function buildCoachSnapshotImpl(
  userId: string,
  scope?: CoachScope,
): Promise<CoachSnapshotResult> {
  // v1.4.23 H4 — apply per-user `excludeMetrics` BEFORE we read any
  // measurement rows so the model never sees data the user opted out
  // of. The filter intersects with the resolved scope (the explicit
  // `scope` argument from the request body still wins for the
  // _maximum_ set; prefs only narrow further).
  //
  // v1.4.25 W7b — the same prefs read also returns the user's
  // displayTimezone so the day-key and weekday labels below match the
  // calendar the user is looking at. Reading both columns in one
  // query keeps the snapshot's read budget the same as before.
  //
  // v1.7.0 — the prefs read now also drives the source default: when
  // the request omits an explicit `scope.sources`, the resolved scope
  // expands the user's saved `dataClusters` (legacy default when the
  // key is absent). So the prefs read must precede `resolveScope`.
  const prefsRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { coachPrefsJson: true, timezone: true },
  });
  const prefs = parseCoachPrefs(prefsRow?.coachPrefsJson);
  const clusterDefault = clusterSourcesFromPrefs(prefs.dataClusters);
  const { sources: scopedSources, window } = resolveScope(
    scope,
    clusterDefault,
  );
  const userTz = prefsRow?.timezone ?? DEFAULT_TIMEZONE;
  const excluded = new Set<CoachExcludeMetric>(prefs.excludeMetrics);
  // v1.4.36 W3 T2 — `medications` and `anthropometrics` are
  // exclude-only toggles (not in `CoachScopeSource`); they gate the
  // GLP-1 weeklyContext / compliance branch and the anthropometrics
  // block respectively. The mapping below treats them as additive to
  // the existing source-level exclusions.
  const excludesMedications = excluded.has("medications");
  const excludesAnthropometrics = excluded.has("anthropometrics");
  const sources = new Set<CoachScopeSource>();
  for (const src of scopedSources) {
    // The `excludeMetrics` enum is a superset of `CoachScopeSource` now
    // (medications + anthropometrics live on the exclude-only side);
    // the cast was safe before v1.4.36 because the enums matched 1:1,
    // and the runtime `excluded.has` check still only catches the
    // overlapping members.
    if (!excluded.has(src as unknown as CoachExcludeMetric)) {
      sources.add(src);
    }
  }
  // `medications` exclusion also drops the compliance source so the
  // intake-event branch below short-circuits — keeps the contract
  // consistent (excluding medications == no medication data at all).
  if (excludesMedications) {
    sources.delete("compliance");
  }

  const windowDays = windowToDays(window);
  const features = await extractFeatures(userId, false, {
    sinceDays: windowDays,
  });

  // Trim down to the metrics the Coach narrates. extractFeatures
  // returns more (sleep, steps, etc.) — the Coach surface keeps the
  // snapshot tight so each turn fits inside the provider's context
  // budget for free-tier accounts.
  const snapshot: Record<string, unknown> = {};
  const windows = new Set<CoachProvenance["windows"][number]>();
  // v1.4.27 B7 / BL-P6-4 — seed the provenance window set with the
  // user's resolved scope so the year-in-review window surfaces in the
  // provenance envelope even when the per-metric branches below only
  // emit `last30days` / `last90days` chips. Older windows are added
  // by the metric branches as before.
  if (window === "lastYear" || window === "allTime") {
    windows.add(window);
  }
  const metrics = new Set<CoachProvenance["metrics"][number]>();
  const counts: NonNullable<CoachProvenance["counts"]> = {};

  // v1.7.0 — block registry. Maps each emitted snapshot top-level key
  // to the cluster it belongs to so the soft-cap degradation pass
  // (below) can walk blocks in reverse cluster-priority order and shed
  // the lowest-signal detail first. Core legacy blocks register too so
  // the degrader can reach them as a last resort.
  const blockClusters = new Map<string, CoachDataCluster>();
  // Snapshot top-level keys that carry an `aggregate` companion — the
  // degrader can drop `timeline.recent` from these and still leave the
  // aggregate for the Coach to reason from.
  const registerBlock = (key: string, source: CoachScopeSource) => {
    const cluster = sourceCluster(source);
    if (cluster) blockClusters.set(key, cluster);
  };

  // Pull raw measurement rows once for the configured window so day
  // and week buckets share a single I/O hop. Mood + compliance live in
  // separate tables and are loaded conditionally below.
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const recentCutoff = new Date(
    now.getTime() - DAILY_TIMELINE_DAYS * 24 * 60 * 60 * 1000,
  );

  // v1.7.0 — when many clusters are active, cap the timeline read
  // window for the ADDITIVE (non-core) clusters so a 10-cluster /
  // allTime request cannot fan a dense timeline across every series at
  // once. The core clinical clusters keep the user-chosen window.
  const activeClusters = new Set<CoachDataCluster>();
  for (const src of sources) {
    const c = sourceCluster(src);
    if (c) activeClusters.add(c);
  }
  const multiClusterCapActive = activeClusters.size > MULTI_CLUSTER_THRESHOLD;
  // v1.7.0 — record which clusters resolved active for this build so
  // the observability dashboards can track cluster adoption + the
  // multi-cluster cap firing rate.
  annotate({
    action: { name: "coach.clusters.resolved" },
    meta: {
      active: Array.from(activeClusters).sort(),
      window,
      multiClusterCap: multiClusterCapActive,
    },
  });
  const additiveCapDays = windowToDays(MULTI_CLUSTER_WINDOW_CAP);
  const additiveCapCutoff = new Date(
    now.getTime() - additiveCapDays * 24 * 60 * 60 * 1000,
  );
  // Effective `cutoff` for an additive block under the multi-cluster
  // cap — the later of the window cutoff and the cap cutoff. Core
  // clusters always use the full window cutoff.
  const additiveCutoff = (source: CoachScopeSource): Date => {
    const cluster = sourceCluster(source);
    if (
      multiClusterCapActive &&
      cluster !== null &&
      !CORE_CLUSTERS.has(cluster) &&
      additiveCapCutoff > cutoff
    ) {
      return additiveCapCutoff;
    }
    return cutoff;
  };

  const wantsBp = sources.has("bp");
  const wantsWeight = sources.has("weight");
  const wantsPulse = sources.has("pulse");
  const wantsMood = sources.has("mood");
  const wantsCompliance = sources.has("compliance");

  // v1.4.23 W6 (S-04) — single source of truth for the
  // CoachScopeSource → MeasurementType[] mapping. Drives both the
  // SQL `WHERE type IN (…)` build below and the Apple-Health timeline
  // block table downstream, so adding a new metric is one entry
  // instead of three (boolean + push + appleHealthBlocks row).
  // Default Coach scope leaves the Apple Health rows off; non-iOS
  // accounts never pay the type-IN overhead because their `sources`
  // set never enables them.
  // v1.7.0 — extended with the full clustered taxonomy. `mood`,
  // `compliance`, and `workouts` map to no `MeasurementType` because
  // they read separate models (MoodEntry / MedicationIntakeEvent /
  // Workout) and are handled by their own branches below. `glucose`
  // also reads `Measurement` but needs the `glucoseContext` column, so
  // its block is built separately rather than from the shared
  // `byType()` rows.
  const METRIC_TYPES: Record<CoachScopeSource, string[]> = {
    bp: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
    weight: ["WEIGHT"],
    pulse: ["PULSE"],
    mood: [],
    compliance: [],
    hrv: ["HEART_RATE_VARIABILITY"],
    sleep: ["SLEEP_DURATION"],
    resting_hr: ["RESTING_HEART_RATE"],
    steps: ["ACTIVITY_STEPS"],
    active_energy: ["ACTIVE_ENERGY_BURNED"],
    flights: ["FLIGHTS_CLIMBED"],
    distance: ["WALKING_RUNNING_DISTANCE"],
    vo2_max: ["VO2_MAX"],
    body_temp: ["BODY_TEMPERATURE"],
    // ── cardio composition / vascular ──
    walking_hr: ["WALKING_HEART_RATE_AVERAGE"],
    respiratory_rate: ["RESPIRATORY_RATE"],
    spo2: ["OXYGEN_SATURATION"],
    pulse_wave_velocity: ["PULSE_WAVE_VELOCITY"],
    vascular_age: ["VASCULAR_AGE"],
    // ── body composition ──
    body_fat: ["BODY_FAT"],
    fat_mass: ["FAT_MASS"],
    fat_free_mass: ["FAT_FREE_MASS"],
    muscle_mass: ["MUSCLE_MASS"],
    lean_body_mass: ["LEAN_BODY_MASS"],
    bone_mass: ["BONE_MASS"],
    total_body_water: ["TOTAL_BODY_WATER"],
    bmi: ["BODY_MASS_INDEX"],
    visceral_fat: ["VISCERAL_FAT"],
    // ── metabolic — built via the dedicated glucose branch ──
    glucose: ["BLOOD_GLUCOSE"],
    // ── mobility & gait ──
    walking_steadiness: ["WALKING_STEADINESS"],
    walking_asymmetry: ["WALKING_ASYMMETRY"],
    walking_double_support: ["WALKING_DOUBLE_SUPPORT"],
    walking_step_length: ["WALKING_STEP_LENGTH"],
    walking_speed: ["WALKING_SPEED"],
    // ── environment / exposure ──
    audio_env: ["AUDIO_EXPOSURE_ENV"],
    audio_headphone: ["AUDIO_EXPOSURE_HEADPHONE"],
    audio_event: ["AUDIO_EXPOSURE_EVENT"],
    daylight: ["TIME_IN_DAYLIGHT"],
    skin_temp: ["SKIN_TEMPERATURE"],
    // ── workouts — read from the Workout model, not Measurement ──
    workouts: [],
  };

  // Single fetch for all measurement types — Prisma's filter pushes
  // the type list into one SQL `WHERE type IN (…)` so we don't pay
  // per-metric round-trips.
  const wantedTypes = Array.from(sources).flatMap(
    (source) => METRIC_TYPES[source] ?? [],
  );

  const measurementRows =
    wantedTypes.length > 0
      ? await prisma.measurement.findMany({
          where: {
            userId,
            type: { in: wantedTypes as never[] },
            measuredAt: { gte: cutoff },
            deletedAt: null,
          },
          orderBy: { measuredAt: "asc" },
          // v1.7.0 — `glucoseContext` rides along so the glucose block
          // can split fasting / postprandial / random / bedtime without
          // a second query. NULL on every non-glucose row.
          select: {
            type: true,
            value: true,
            measuredAt: true,
            glucoseContext: true,
          },
        })
      : [];

  const byType = (t: string) =>
    measurementRows
      .filter((r) => r.type === t)
      .map((r) => ({
        measuredAt: r.measuredAt,
        value: r.value,
      }));

  if (wantsBp && features.bloodPressure) {
    const sysRows = byType("BLOOD_PRESSURE_SYS");
    const diaRows = byType("BLOOD_PRESSURE_DIA");
    const recentDaily = buildDailyBpRows(
      sysRows,
      diaRows,
      recentCutoff,
      userTz,
    );
    const olderSys = sysRows.filter((r) => r.measuredAt < recentCutoff);
    const olderDia = diaRows.filter((r) => r.measuredAt < recentCutoff);
    snapshot.bloodPressure = {
      aggregate: features.bloodPressure,
      timeline: {
        recent: recentDaily,
        weeklySys: bucketWeekly(olderSys, userTz),
        weeklyDia: bucketWeekly(olderDia, userTz),
      },
    };
    metrics.add("bp");
    windows.add("last30days");
    windows.add("last90days");
    counts.bp = features.bloodPressure.coverage?.count ?? undefined;
    registerBlock("bloodPressure", "bp");
  }
  if (wantsWeight && features.weight) {
    const rows = byType("WEIGHT");
    snapshot.weight = {
      aggregate: features.weight,
      timeline: {
        recent: buildDailyValueRows(rows, recentCutoff, userTz),
        weekly: bucketWeekly(
          rows.filter((r) => r.measuredAt < recentCutoff),
          userTz,
        ),
      },
    };
    metrics.add("weight");
    windows.add("last7days");
    windows.add("last30days");
    counts.weight = features.weight.coverage?.count ?? undefined;
    registerBlock("weight", "weight");
  }
  if (wantsPulse && features.pulse) {
    const rows = byType("PULSE");
    snapshot.pulse = {
      aggregate: features.pulse,
      timeline: {
        recent: buildDailyValueRows(rows, recentCutoff, userTz),
        weekly: bucketWeekly(
          rows.filter((r) => r.measuredAt < recentCutoff),
          userTz,
        ),
      },
    };
    metrics.add("pulse");
    windows.add("last7days");
    windows.add("last30days");
    windows.add("last90days");
    counts.pulse = features.pulse.coverage?.count ?? undefined;
    registerBlock("pulse", "pulse");
  }
  if (wantsMood && features.mood) {
    // Mood entries live on a separate model. Pull only the recent
    // window for the day-level rows + bucket the rest.
    const moodRows = await prisma.moodEntry.findMany({
      // v1.7.0 sync — exclude tombstoned rows from the Coach snapshot.
      where: { userId, deletedAt: null, moodLoggedAt: { gte: cutoff } },
      orderBy: { moodLoggedAt: "asc" },
      select: { moodLoggedAt: true, score: true },
    });
    const normalised = moodRows.map((m) => ({
      measuredAt: m.moodLoggedAt,
      value: m.score,
    }));
    snapshot.mood = {
      aggregate: features.mood,
      timeline: {
        recent: buildDailyValueRows(normalised, recentCutoff, userTz),
        weekly: bucketWeekly(
          normalised.filter((r) => r.measuredAt < recentCutoff),
          userTz,
        ),
      },
    };
    metrics.add("mood");
    windows.add("last7days");
    windows.add("last30days");
    counts.mood = features.mood.coverage?.count ?? undefined;
    registerBlock("mood", "mood");
  }

  if (wantsCompliance) {
    // Medication compliance lives outside the structured features
    // today — the legacy Coach surface labelled it as "general"
    // provenance only. v1.4.20.1 ships a per-day adherence row built
    // from the intake-event log so the Coach can answer "did I miss
    // my dose on Tuesday?" without inventing the schedule.
    const intakeRows = await prisma.medicationIntakeEvent.findMany({
      where: { userId, scheduledFor: { gte: cutoff } },
      orderBy: { scheduledFor: "asc" },
      select: { scheduledFor: true, takenAt: true, skipped: true },
    });
    if (intakeRows.length > 0) {
      // Per-day adherence rate within the recent window. Older days
      // collapse into a single weekly bucket.
      const recent = intakeRows.filter((r) => r.scheduledFor >= recentCutoff);
      const olderRows = intakeRows.filter((r) => r.scheduledFor < recentCutoff);
      const recentByDay = new Map<
        string,
        { date: Date; total: number; taken: number }
      >();
      for (const r of recent) {
        const key = tzDayKey(r.scheduledFor, userTz);
        const e = recentByDay.get(key) ?? {
          date: r.scheduledFor,
          total: 0,
          taken: 0,
        };
        e.total += 1;
        if (r.takenAt && !r.skipped) e.taken += 1;
        recentByDay.set(key, e);
      }
      const recentRows = Array.from(recentByDay.entries())
        .map(([date, info]) => ({
          date,
          weekday: tzWeekday(info.date, userTz),
          rate: Math.round((info.taken / info.total) * 100) / 100,
          taken: info.taken,
          total: info.total,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const olderByWeek = new Map<string, { taken: number; total: number }>();
      for (const r of olderRows) {
        const key = isoWeekKey(r.scheduledFor, userTz);
        const e = olderByWeek.get(key) ?? { taken: 0, total: 0 };
        e.total += 1;
        if (r.takenAt && !r.skipped) e.taken += 1;
        olderByWeek.set(key, e);
      }
      const weeklyRows = Array.from(olderByWeek.entries())
        .map(([weekISO, v]) => ({
          weekISO,
          rate: v.total > 0 ? Math.round((v.taken / v.total) * 100) / 100 : 0,
          taken: v.taken,
          total: v.total,
        }))
        .sort((a, b) => a.weekISO.localeCompare(b.weekISO));
      snapshot.compliance = {
        timeline: { recent: recentRows, weekly: weeklyRows },
      };
      metrics.add("compliance");
      counts.compliance = intakeRows.length;
      registerBlock("compliance", "compliance");
    } else {
      // v1.7.0 — toggled-on cluster with no rows. Annotate so the
      // dashboards can distinguish "user has no medication data" from
      // "medication cluster was off".
      annotate({
        action: { name: "coach.cluster.empty_skipped" },
        meta: { cluster: "medication" },
      });
    }
  }

  // ── v1.4.23 Apple Health additive blocks ─────────────────────────
  //
  // Each new HealthKit-derived metric ships as a timeline-only block
  // (recent day rows + older weekly buckets). The aggregate features
  // pipeline doesn't carry them yet — that's a v1.5 follow-up — but
  // the timeline alone is enough for the Coach to ground "your HRV
  // last Tuesday was X" replies in real numbers without inventing a
  // baseline. The block is omitted entirely when the user has no rows
  // for that metric, so accounts without iOS data never see a void
  // section in the prompt.
  type ValueMetric = Exclude<
    CoachProvenanceMetric,
    "general" | "bp" | "weight" | "pulse" | "mood" | "compliance" | "glucose"
  >;
  type ValueBlock = {
    metric: ValueMetric;
    source: CoachScopeSource;
    snapshotKey: string;
    type: string;
  };
  // v1.4.23 W6 (S-04) / v1.7.0 — every single-`MeasurementType`
  // additive series ships as a timeline-only block (recent day rows +
  // older weekly buckets). One entry per source; `source` drives both
  // the `sources.has` gate and the cluster lookup (for the
  // multi-cluster window cap + degradation priority). `glucose` and
  // `workouts` are NOT in this table — they have dedicated branches
  // (glucose carries `glucoseContext`, workouts reads the Workout
  // model). The block is omitted entirely when the user has no rows,
  // so accounts without that data never see a void section.
  const valueBlocks: ValueBlock[] = [
    // ── cardio ──
    { metric: "hrv", source: "hrv", snapshotKey: "heartRateVariability", type: "HEART_RATE_VARIABILITY" },
    { metric: "resting_hr", source: "resting_hr", snapshotKey: "restingHeartRate", type: "RESTING_HEART_RATE" },
    { metric: "walking_hr", source: "walking_hr", snapshotKey: "walkingHeartRateAverage", type: "WALKING_HEART_RATE_AVERAGE" },
    { metric: "respiratory_rate", source: "respiratory_rate", snapshotKey: "respiratoryRate", type: "RESPIRATORY_RATE" },
    { metric: "spo2", source: "spo2", snapshotKey: "oxygenSaturation", type: "OXYGEN_SATURATION" },
    { metric: "pulse_wave_velocity", source: "pulse_wave_velocity", snapshotKey: "pulseWaveVelocity", type: "PULSE_WAVE_VELOCITY" },
    { metric: "vascular_age", source: "vascular_age", snapshotKey: "vascularAge", type: "VASCULAR_AGE" },
    // ── body composition ──
    { metric: "body_fat", source: "body_fat", snapshotKey: "bodyFat", type: "BODY_FAT" },
    { metric: "fat_mass", source: "fat_mass", snapshotKey: "fatMass", type: "FAT_MASS" },
    { metric: "fat_free_mass", source: "fat_free_mass", snapshotKey: "fatFreeMass", type: "FAT_FREE_MASS" },
    { metric: "muscle_mass", source: "muscle_mass", snapshotKey: "muscleMass", type: "MUSCLE_MASS" },
    { metric: "lean_body_mass", source: "lean_body_mass", snapshotKey: "leanBodyMass", type: "LEAN_BODY_MASS" },
    { metric: "bone_mass", source: "bone_mass", snapshotKey: "boneMass", type: "BONE_MASS" },
    { metric: "total_body_water", source: "total_body_water", snapshotKey: "totalBodyWater", type: "TOTAL_BODY_WATER" },
    { metric: "bmi", source: "bmi", snapshotKey: "bodyMassIndex", type: "BODY_MASS_INDEX" },
    { metric: "visceral_fat", source: "visceral_fat", snapshotKey: "visceralFat", type: "VISCERAL_FAT" },
    // ── activity ──
    { metric: "steps", source: "steps", snapshotKey: "steps", type: "ACTIVITY_STEPS" },
    { metric: "active_energy", source: "active_energy", snapshotKey: "activeEnergy", type: "ACTIVE_ENERGY_BURNED" },
    { metric: "flights", source: "flights", snapshotKey: "flightsClimbed", type: "FLIGHTS_CLIMBED" },
    { metric: "distance", source: "distance", snapshotKey: "walkingRunningDistance", type: "WALKING_RUNNING_DISTANCE" },
    { metric: "vo2_max", source: "vo2_max", snapshotKey: "vo2Max", type: "VO2_MAX" },
    // ── mobility & gait ──
    { metric: "walking_steadiness", source: "walking_steadiness", snapshotKey: "walkingSteadiness", type: "WALKING_STEADINESS" },
    { metric: "walking_asymmetry", source: "walking_asymmetry", snapshotKey: "walkingAsymmetry", type: "WALKING_ASYMMETRY" },
    { metric: "walking_double_support", source: "walking_double_support", snapshotKey: "walkingDoubleSupport", type: "WALKING_DOUBLE_SUPPORT" },
    { metric: "walking_step_length", source: "walking_step_length", snapshotKey: "walkingStepLength", type: "WALKING_STEP_LENGTH" },
    { metric: "walking_speed", source: "walking_speed", snapshotKey: "walkingSpeed", type: "WALKING_SPEED" },
    // ── environment / exposure ──
    { metric: "audio_env", source: "audio_env", snapshotKey: "audioExposureEnvironment", type: "AUDIO_EXPOSURE_ENV" },
    { metric: "audio_headphone", source: "audio_headphone", snapshotKey: "audioExposureHeadphone", type: "AUDIO_EXPOSURE_HEADPHONE" },
    { metric: "audio_event", source: "audio_event", snapshotKey: "audioExposureEvent", type: "AUDIO_EXPOSURE_EVENT" },
    { metric: "daylight", source: "daylight", snapshotKey: "timeInDaylight", type: "TIME_IN_DAYLIGHT" },
    { metric: "skin_temp", source: "skin_temp", snapshotKey: "skinTemperature", type: "SKIN_TEMPERATURE" },
    { metric: "body_temp", source: "body_temp", snapshotKey: "bodyTemperature", type: "BODY_TEMPERATURE" },
  ];
  for (const block of valueBlocks) {
    if (!sources.has(block.source)) continue;
    const blockCutoff = additiveCutoff(block.source);
    const rows = byType(block.type).filter((r) => r.measuredAt >= blockCutoff);
    if (rows.length === 0) {
      const cluster = sourceCluster(block.source);
      if (cluster) {
        annotate({
          action: { name: "coach.cluster.empty_skipped" },
          meta: { cluster, source: block.source },
        });
      }
      continue;
    }
    snapshot[block.snapshotKey] = {
      timeline: {
        recent: buildDailyValueRows(rows, recentCutoff, userTz),
        weekly: bucketWeekly(
          rows.filter((r) => r.measuredAt < recentCutoff),
          userTz,
        ),
      },
    };
    metrics.add(block.metric);
    counts[block.metric] = rows.length;
    registerBlock(block.snapshotKey, block.source);
  }

  // ── v1.7.0 sleep block (with optional per-stage enrichment) ───────
  //
  // Sleep needs the `sleepStage` column so the Coach can narrate REM /
  // core / deep / awake minutes per night instead of a flat duration.
  // The shared `byType("SLEEP_DURATION")` rows above already cover the
  // duration timeline, but they drop the stage label — so the sleep
  // branch builds its own block. Per-night stage minutes come from a
  // dedicated read of the SLEEP_DURATION rows that carry a non-null
  // stage; the duration timeline is built from the same rows summed per
  // night (one night = the sum of its per-stage rows).
  if (sources.has("sleep")) {
    const sleepCutoff = additiveCutoff("sleep");
    const sleepRows = await prisma.measurement.findMany({
      where: {
        userId,
        type: "SLEEP_DURATION" as never,
        measuredAt: { gte: sleepCutoff },
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
      select: { value: true, measuredAt: true, sleepStage: true },
    });
    if (sleepRows.length === 0) {
      annotate({
        action: { name: "coach.cluster.empty_skipped" },
        meta: { cluster: "sleep", source: "sleep" },
      });
    } else {
      // Per-night total minutes (sum of all stage rows that night) for
      // the duration timeline.
      const perNight = new Map<
        string,
        { date: Date; total: number; stages: Record<string, number> }
      >();
      for (const r of sleepRows) {
        const key = tzDayKey(r.measuredAt, userTz);
        const e = perNight.get(key) ?? {
          date: r.measuredAt,
          total: 0,
          stages: {},
        };
        e.total += r.value;
        if (r.sleepStage) {
          const stage = String(r.sleepStage).toLowerCase();
          e.stages[stage] = (e.stages[stage] ?? 0) + r.value;
        }
        perNight.set(key, e);
      }
      // Recent nights: duration + stage breakdown when present.
      const recentNights = Array.from(perNight.entries())
        .filter(([, info]) => info.date >= recentCutoff)
        .map(([date, info]) => {
          const row: Record<string, unknown> = {
            date,
            weekday: tzWeekday(info.date, userTz),
            minutes: Math.round(info.total),
          };
          if (Object.keys(info.stages).length > 0) {
            row.stages = Object.fromEntries(
              Object.entries(info.stages).map(([k, v]) => [k, Math.round(v)]),
            );
          }
          return row;
        })
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const olderNights = Array.from(perNight.values())
        .filter((info) => info.date < recentCutoff)
        .map((info) => ({ measuredAt: info.date, value: info.total }));
      snapshot.sleep = {
        timeline: {
          recent: recentNights,
          weekly: bucketWeekly(olderNights, userTz),
        },
      };
      metrics.add("sleep");
      counts.sleep = sleepRows.length;
      registerBlock("sleep", "sleep");
    }
  }

  // ── v1.7.0 glucose block (per-context daily means) ────────────────
  //
  // Glucose is summarised per `GlucoseContext` so the Coach can tell
  // fasting from postprandial without seeing raw samples. Each context
  // gets its own per-day mean timeline; the block omits when no rows.
  if (sources.has("glucose")) {
    const glucoseCutoff = additiveCutoff("glucose");
    const glucoseRows = measurementRows.filter(
      (r) => r.type === "BLOOD_GLUCOSE" && r.measuredAt >= glucoseCutoff,
    );
    if (glucoseRows.length === 0) {
      annotate({
        action: { name: "coach.cluster.empty_skipped" },
        meta: { cluster: "glucose", source: "glucose" },
      });
    } else {
      // Group by context (NULL → "unspecified"), then per-day mean.
      const byContext = new Map<
        string,
        Array<{ measuredAt: Date; value: number }>
      >();
      for (const r of glucoseRows) {
        const ctx = r.glucoseContext
          ? String(r.glucoseContext).toLowerCase()
          : "unspecified";
        const list = byContext.get(ctx) ?? [];
        list.push({ measuredAt: r.measuredAt, value: r.value });
        byContext.set(ctx, list);
      }
      const contexts: Record<string, unknown> = {};
      for (const [ctx, rows] of byContext) {
        contexts[ctx] = {
          recent: buildDailyValueRows(rows, recentCutoff, userTz),
          weekly: bucketWeekly(
            rows.filter((r) => r.measuredAt < recentCutoff),
            userTz,
          ),
        };
      }
      snapshot.glucose = { byContext: contexts };
      metrics.add("glucose");
      counts.glucose = glucoseRows.length;
      registerBlock("glucose", "glucose");
    }
  }

  // ── v1.7.0 workouts block (capped list + per-sport rollup) ────────
  //
  // The Workout model is never dumped row-for-row. The block carries
  // the most recent `WORKOUT_RECENT_CAP` sessions (sport, duration,
  // energy, distance, avg/max HR) plus a per-sport weekly count + total
  // duration/energy rollup for the tail so the prompt stays bounded
  // even for a heavy-training account at a long window.
  if (sources.has("workouts")) {
    const workoutCutoff = additiveCutoff("workouts");
    const workoutRows = await prisma.workout.findMany({
      where: { userId, startedAt: { gte: workoutCutoff } },
      orderBy: { startedAt: "desc" },
      select: {
        sportType: true,
        startedAt: true,
        durationSec: true,
        totalEnergyKcal: true,
        totalDistanceM: true,
        avgHeartRate: true,
        maxHeartRate: true,
      },
    });
    if (workoutRows.length === 0) {
      annotate({
        action: { name: "coach.cluster.empty_skipped" },
        meta: { cluster: "workouts", source: "workouts" },
      });
    } else {
      const recentList = workoutRows.slice(0, WORKOUT_RECENT_CAP).map((w) => ({
        date: tzDayKey(w.startedAt, userTz),
        weekday: tzWeekday(w.startedAt, userTz),
        sport: w.sportType,
        durationMin: Math.round(w.durationSec / 60),
        energyKcal: w.totalEnergyKcal ?? null,
        distanceM: w.totalDistanceM ?? null,
        avgHr: w.avgHeartRate ?? null,
        maxHr: w.maxHeartRate ?? null,
      }));
      // Per-sport rollup over the whole window.
      const bySport = new Map<
        string,
        { count: number; durationMin: number; energyKcal: number }
      >();
      for (const w of workoutRows) {
        const e = bySport.get(w.sportType) ?? {
          count: 0,
          durationMin: 0,
          energyKcal: 0,
        };
        e.count += 1;
        e.durationMin += Math.round(w.durationSec / 60);
        e.energyKcal += w.totalEnergyKcal ?? 0;
        bySport.set(w.sportType, e);
      }
      const sportRollup = Array.from(bySport.entries())
        .map(([sport, v]) => ({
          sport,
          count: v.count,
          totalDurationMin: v.durationMin,
          totalEnergyKcal: Math.round(v.energyKcal),
        }))
        .sort((a, b) => b.count - a.count);
      snapshot.workouts = {
        recent: recentList,
        perSport: sportRollup,
        totalInWindow: workoutRows.length,
      };
      metrics.add("workouts");
      counts.workouts = workoutRows.length;
      registerBlock("workouts", "workouts");
    }
  }

  // ── v1.4.25 W4d — GLP-1 weeklyContext block ──────────────────────
  //
  // Only emitted when the user has at least one active GLP-1 medication
  // (Medication.treatmentClass = GLP1). Web-only generic accounts never
  // pay the read cost — the helper short-circuits to `null` after a
  // single indexed Prisma lookup.
  //
  // The block names the drug, current dose, titration history, last +
  // next injection, pen inventory, and recent side-effect tags. The
  // Coach's GROUND RULE 9 forbids dose prescriptions — this block
  // exists so the reply can SAY "your Mounjaro 7.5 mg" instead of
  // "your medication", never to make recommendations.
  // v1.4.36 W3 T2 — gated on `medications` exclusion. When excluded
  // we skip the Prisma lookup entirely so the read cost vanishes too.
  if (!excludesMedications) {
    const glp1Block = await buildGlp1SnapshotBlock(userId, now);
    if (glp1Block) {
      snapshot.weeklyContext = { glp1: glp1Block };
      metrics.add("compliance");
      registerBlock("weeklyContext", "compliance");
    }
  }

  // v1.4.36 W3 T2 — anthropometrics block (height / age / gender).
  // Sourced from `features.context`, which already reads
  // `User.heightCm / dateOfBirth / gender`. Gated on the
  // `anthropometrics` exclusion AND on at least one non-null field
  // — accounts with no profile info never see an empty block. The
  // `ctx?` guard tolerates mocked feature shapes in the test suite
  // that don't populate the `context` object.
  if (!excludesAnthropometrics) {
    const ctx = features.context;
    if (
      ctx &&
      (ctx.heightCm !== null ||
        ctx.ageYears !== null ||
        ctx.gender !== null)
    ) {
      snapshot.anthropometrics = {
        heightCm: ctx.heightCm,
        ageYears: ctx.ageYears,
        gender: ctx.gender,
      };
    }
  }

  if (Object.keys(snapshot).length === 0) {
    metrics.add("general");
  }

  // Pin the scope onto the snapshot itself so the model knows which
  // windows + sources are in-bounds for the reply. The system prompt
  // tells the model to read from this block for day-level questions.
  snapshot.scope = {
    window,
    sources: Array.from(sources),
    timelineRecentDays: DAILY_TIMELINE_DAYS,
  };

  // v1.4.36 W3 T4 — compactSections drops any zero-row block before
  // serialisation so the prompt never carries a labelled-empty key.
  // The snapshot is built conditionally above so most empty paths are
  // already skipped, but the helper catches future regressions and
  // matches the contract the /insights/generate route applies on its
  // side of the prompt.
  const compactSnapshot = compactSections(snapshot);

  // v1.7.0 — assembled-snapshot soft cap. Enabling every cluster at a
  // long window can balloon the prompt; degrade progressively by
  // reverse cluster priority until the serialised size fits
  // `MAX_SNAPSHOT_CHARS`. The `scope` block is exempt — the model
  // needs it to know what is in-bounds. The helper emits its own
  // `coach.snapshot.truncated` annotation when it sheds anything.
  degradeToBudget(compactSnapshot, blockClusters);

  return {
    snapshotJson: JSON.stringify(compactSnapshot, null, 2),
    provenance: {
      windows: Array.from(windows),
      metrics: Array.from(metrics),
      counts: Object.keys(counts).length > 0 ? counts : undefined,
    },
  };
}

/**
 * v1.7.0 — progressive degradation to the snapshot char budget.
 *
 * Mutates `snapshot` in place. Walks the blocks in REVERSE cluster
 * priority (lowest-signal first) over two passes:
 *   1. drop `timeline.recent` (keep `aggregate` + `timeline.weekly`),
 *   2. collapse `timeline.weekly` too (keep only `aggregate` / the
 *      smallest summary the block carries).
 * Stops as soon as the serialised size fits. Emits one
 * `coach.snapshot.truncated` annotation describing what was shed.
 *
 * Returns the list of `{ key, cluster, pass }` it degraded — empty when
 * the snapshot already fit.
 */
function degradeToBudget(
  snapshot: Record<string, unknown>,
  blockClusters: Map<string, CoachDataCluster>,
): Array<{ key: string; cluster: CoachDataCluster; pass: number }> {
  const degraded: Array<{
    key: string;
    cluster: CoachDataCluster;
    pass: number;
  }> = [];
  // Measure against the SAME pretty-printed form the prompt ships
  // (`JSON.stringify(snapshot, null, 2)`), not the compact form —
  // otherwise the cap under-counts by ~2× and the prompt overflows.
  const size = () => JSON.stringify(snapshot, null, 2).length;
  if (size() <= MAX_SNAPSHOT_CHARS) return degraded;

  // Build a degrade order: blocks grouped by cluster, lowest priority
  // first. A block with no registered cluster (e.g. anthropometrics,
  // scope) is never touched — those are tiny + load-bearing.
  const priorityIndex = new Map<CoachDataCluster, number>();
  CLUSTER_PRIORITY.forEach((c, i) => priorityIndex.set(c, i));
  const orderedKeys = Array.from(blockClusters.entries()).sort((a, b) => {
    const pa = priorityIndex.get(a[1]) ?? -1;
    const pb = priorityIndex.get(b[1]) ?? -1;
    // Higher priority index = lower signal = degrade first.
    return pb - pa;
  });

  const asRecord = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;

  // Drop the dense per-day detail from a block, leaving the coarser
  // weekly / aggregate summary. Handles the three block shapes:
  //   - timeline-bearing blocks (`timeline.recent`)
  //   - glucose (`byContext.<ctx>.recent`)
  //   - workouts (`recent` at the top level)
  const dropRecent = (key: string): boolean => {
    const block = asRecord(snapshot[key]);
    if (!block) return false;
    let changed = false;
    const timeline = asRecord(block.timeline);
    if (timeline && "recent" in timeline) {
      delete timeline.recent;
      changed = true;
    }
    const byContext = asRecord(block.byContext);
    if (byContext) {
      for (const ctx of Object.keys(byContext)) {
        const c = asRecord(byContext[ctx]);
        if (c && "recent" in c) {
          delete c.recent;
          changed = true;
        }
      }
    }
    if ("recent" in block) {
      delete block.recent;
      changed = true;
    }
    return changed;
  };

  // Collapse the weekly buckets too — leaves only the aggregate /
  // smallest summary the block carries.
  const dropWeekly = (key: string): boolean => {
    const block = asRecord(snapshot[key]);
    if (!block) return false;
    let changed = false;
    const timeline = asRecord(block.timeline);
    if (timeline) {
      for (const field of ["weekly", "weeklySys", "weeklyDia"]) {
        if (field in timeline) {
          delete timeline[field];
          changed = true;
        }
      }
      if (Object.keys(timeline).length === 0) {
        delete block.timeline;
      }
    }
    const byContext = asRecord(block.byContext);
    if (byContext) {
      for (const ctx of Object.keys(byContext)) {
        const c = asRecord(byContext[ctx]);
        if (c && "weekly" in c) {
          delete c.weekly;
          changed = true;
        }
      }
    }
    return changed;
  };

  // Last resort: replace the whole block with a compact marker so the
  // model still knows the cluster exists without paying for its rows.
  const dropBlock = (key: string): boolean => {
    if (key in snapshot) {
      snapshot[key] = { omitted: "trimmed for prompt budget" };
      return true;
    }
    return false;
  };

  // Degrade per-block, LOWEST priority first, collapsing each block as
  // far as needed before advancing to the next (higher-priority) one.
  // For each block in turn: drop the dense per-day detail, then the
  // weekly buckets, then — only if it still overflows — replace the
  // whole block with a marker. A higher-priority block is touched only
  // once every lower-priority block is already fully collapsed and the
  // prompt still exceeds the cap, so the clinical core keeps its detail
  // until it is genuinely the last lever left.
  for (const [key, cluster] of orderedKeys) {
    if (size() <= MAX_SNAPSHOT_CHARS) break;
    if (dropRecent(key)) degraded.push({ key, cluster, pass: 1 });
    if (size() <= MAX_SNAPSHOT_CHARS) break;
    if (dropWeekly(key)) degraded.push({ key, cluster, pass: 2 });
    if (size() <= MAX_SNAPSHOT_CHARS) break;
    if (dropBlock(key)) degraded.push({ key, cluster, pass: 3 });
  }

  if (degraded.length > 0) {
    const droppedClusters = Array.from(
      new Set(degraded.map((d) => d.cluster)),
    );
    annotate({
      action: { name: "coach.snapshot.truncated" },
      meta: {
        droppedClusters,
        droppedBlocks: degraded.map((d) => d.key),
        finalChars: size(),
      },
    });
  }
  return degraded;
}
