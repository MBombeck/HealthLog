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
} from "@/lib/validations/coach-prefs";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { buildGlp1SnapshotBlock } from "./glp1-snapshot";
import type {
  CoachProvenance,
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
const DEFAULT_SOURCES: ReadonlyArray<CoachScopeSource> = [
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
];

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
 * Resolve the working scope. Missing fields fall through to defaults
 * so older native clients (no scope picker) keep getting the full
 * 30-day, all-source snapshot they had before v1.4.20.1.
 */
function resolveScope(scope?: CoachScope): {
  sources: ReadonlySet<CoachScopeSource>;
  window: CoachScopeWindow;
} {
  const sources =
    scope?.sources && scope.sources.length > 0
      ? new Set(scope.sources)
      : new Set(DEFAULT_SOURCES);
  return {
    sources,
    window: scope?.window ?? DEFAULT_WINDOW,
  };
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
 */
export async function buildCoachSnapshot(
  userId: string,
  scope?: CoachScope,
): Promise<CoachSnapshotResult> {
  const { sources: scopedSources, window } = resolveScope(scope);

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
  const prefsRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { coachPrefsJson: true, timezone: true },
  });
  const prefs = parseCoachPrefs(prefsRow?.coachPrefsJson);
  const userTz = prefsRow?.timezone ?? DEFAULT_TIMEZONE;
  const excluded = new Set<CoachExcludeMetric>(prefs.excludeMetrics);
  const sources = new Set<CoachScopeSource>();
  for (const src of scopedSources) {
    // The `excludeMetrics` enum is a strict subset of `CoachScopeSource`
    // (every excludable key is also a valid scope source); this cast is
    // safe and the runtime check is just defence-in-depth.
    if (!excluded.has(src as unknown as CoachExcludeMetric)) {
      sources.add(src);
    }
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

  // Pull raw measurement rows once for the configured window so day
  // and week buckets share a single I/O hop. Mood + compliance live in
  // separate tables and are loaded conditionally below.
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const recentCutoff = new Date(
    now.getTime() - DAILY_TIMELINE_DAYS * 24 * 60 * 60 * 1000,
  );

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
          },
          orderBy: { measuredAt: "asc" },
          select: { type: true, value: true, measuredAt: true },
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
  }
  if (wantsMood && features.mood) {
    // Mood entries live on a separate model. Pull only the recent
    // window for the day-level rows + bucket the rest.
    const moodRows = await prisma.moodEntry.findMany({
      where: { userId, moodLoggedAt: { gte: cutoff } },
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
  type AppleHealthMetric = Exclude<
    CoachProvenance["metrics"][number],
    "general" | "bp" | "weight" | "pulse" | "mood" | "compliance"
  >;
  type AppleHealthBlock = {
    metric: AppleHealthMetric;
    snapshotKey: string;
    type: string;
    enabled: boolean;
  };
  // v1.4.23 W6 (S-04) — `enabled` reads from `sources` directly
  // instead of from a parallel ladder of `wantsHrv/...` booleans. The
  // `type` field still mirrors `METRIC_TYPES[metric][0]` because each
  // Apple Health source maps to exactly one MeasurementType (BP is
  // the only fan-out and lives in its own legacy block above).
  const appleHealthBlocks: AppleHealthBlock[] = [
    {
      metric: "hrv",
      snapshotKey: "heartRateVariability",
      type: "HEART_RATE_VARIABILITY",
      enabled: sources.has("hrv"),
    },
    {
      metric: "sleep",
      snapshotKey: "sleep",
      type: "SLEEP_DURATION",
      enabled: sources.has("sleep"),
    },
    {
      metric: "resting_hr",
      snapshotKey: "restingHeartRate",
      type: "RESTING_HEART_RATE",
      enabled: sources.has("resting_hr"),
    },
    {
      metric: "steps",
      snapshotKey: "steps",
      type: "ACTIVITY_STEPS",
      enabled: sources.has("steps"),
    },
    {
      metric: "active_energy",
      snapshotKey: "activeEnergy",
      type: "ACTIVE_ENERGY_BURNED",
      enabled: sources.has("active_energy"),
    },
    {
      metric: "flights",
      snapshotKey: "flightsClimbed",
      type: "FLIGHTS_CLIMBED",
      enabled: sources.has("flights"),
    },
    {
      metric: "distance",
      snapshotKey: "walkingRunningDistance",
      type: "WALKING_RUNNING_DISTANCE",
      enabled: sources.has("distance"),
    },
    {
      metric: "vo2_max",
      snapshotKey: "vo2Max",
      type: "VO2_MAX",
      enabled: sources.has("vo2_max"),
    },
    {
      metric: "body_temp",
      snapshotKey: "bodyTemperature",
      type: "BODY_TEMPERATURE",
      enabled: sources.has("body_temp"),
    },
  ];
  for (const block of appleHealthBlocks) {
    if (!block.enabled) continue;
    const rows = byType(block.type);
    if (rows.length === 0) continue;
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
  const glp1Block = await buildGlp1SnapshotBlock(userId, now);
  if (glp1Block) {
    snapshot.weeklyContext = { glp1: glp1Block };
    metrics.add("compliance");
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

  return {
    snapshotJson: JSON.stringify(snapshot, null, 2),
    provenance: {
      windows: Array.from(windows),
      metrics: Array.from(metrics),
      counts: Object.keys(counts).length > 0 ? counts : undefined,
    },
  };
}
