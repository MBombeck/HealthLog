/**
 * IO seam for the morning read (`morning.ts`): gathers the facts the rules
 * read and hands them to the pure builder.
 *
 * Only two callers: `GET /api/daily/morning` and the server render of `/`.
 * The digest loader stays as it was, so the reaction-line job and the daily
 * push, which read the digest, never compute a morning; the one job that
 * warms it is `morning-digest-refresh`, once last night's sleep is in.
 *
 * The heavy reads (the coincident engine, readiness, the sleep score, the
 * device scores of the day) share one SWR cell keyed by the reader's local
 * day, like the digest's extras cell, so the first visit of the morning pays
 * once and the next ones are warm. What must be true the moment it changes
 * stays outside the cell and is read on every request: a confirmed safety
 * floor, Rest mode, a quiet source, a visit, and the snapshot's dose count.
 *
 * Data, not AI: no model is reachable from here and nothing here reaches one
 * (`morning-model-free-guard.test.ts`).
 */
import { SESSION_USER_SELECT, type SessionUser } from "@/lib/auth/session-user";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";
import { healthScoreFlag } from "@/lib/daily/in-range-claim";
import {
  lastNightFromSnapshot,
  MORNING_CACHE_TTL_MS,
  morningCacheKey,
  morningExtrasCacheKey,
  readLastNight,
} from "@/lib/daily/last-night";
import { resolveModuleMap } from "@/lib/modules/gate";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { translateOrNull } from "@/lib/i18n/translate-code";
import type { Locale } from "@/lib/i18n/config";
import {
  makeFormatters,
  resolveIntlLocale,
  type DateFormatPreference,
  type TimeFormatPreference,
} from "@/lib/format-locale";
import { hourInTz, userDayKey } from "@/lib/tz/format";
import { readingDayKey } from "@/lib/tz/reading-zone";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { dayDiff } from "@/lib/cycle/day-math";
import { convertGlucose, type GlucoseUnit } from "@/lib/glucose";
import { computeCoincidentDeviation } from "@/lib/insights/derived/coincident-deviation";
import {
  computeDerivedMetric,
  loadBaselineProfile,
} from "@/lib/insights/derived";
import type { ReadinessValue } from "@/lib/insights/derived/readiness";
import type { SleepScoreValue } from "@/lib/insights/derived/sleep-score";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import {
  applyDisplayTransform,
  getReadingTransform,
  resolveUnitPreferences,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import { vitalDisplayDecimals } from "@/lib/measurements/vital-precision";
import { CONNECTION_LABELS } from "@/lib/integrations/connection-health";
import { loadQuietSources } from "@/lib/sync-stall/quiet-load";
import {
  floorFromReadings,
  type MorningFloor,
} from "@/lib/daily/morning-floor";
import type { TodayRestMode, TodayVital } from "@/lib/daily/today-overview";
import {
  buildDailyMorning,
  type Band,
  type DailyMorning,
  type DeviceSourceValue,
  type MorningInput,
  type MorningReadiness,
  type MorningSleepScore,
} from "@/lib/daily/morning";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** Same lifetime as the digest's extras cell: a poll and a minute. */

/** How long a confirmed floor answers the morning: the push's own window. */
const FLOOR_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The ledger key prefix `notifySafetyFloor` claims under. */
const FLOOR_LEDGER_PREFIX = "safety_floor:";

/** Device scores of the night; read back far enough to reach last night's. */
const DEVICE_SCORE_LOOKBACK_MS = 36 * 60 * 60 * 1000;

const DEVICE_SCORE_TYPES = [
  "RECOVERY_SCORE",
  "SLEEP_SCORE",
  "SLEEP_PERFORMANCE",
] as const;

/** One banded vital's standing, before it is worded for the reader. */
interface MorningVital {
  type: MeasurementType;
  value: number;
  low: number;
  high: number;
  direction: "above" | "below" | "in";
  daysAgo: number;
  basis?: "sameHours";
}

interface DeviceScoreRow {
  type: string;
  source: string;
  value: number;
  measuredAt: Date;
  /** The zone the reading was taken in, when the client sent one. */
  timeZone: string | null;
}

/** What the day's cell holds: the reads that cost, computed once a day. */
interface MorningExtras {
  vitals: MorningVital[];
  illnessExplained: boolean;
  readiness: MorningReadiness | null;
  sleepScore: MorningSleepScore | null;
  deviceScores: DeviceScoreRow[];
}

async function readVitals(
  userId: string,
  profile: Awaited<ReturnType<typeof loadBaselineProfile>>,
  now: Date,
  tz: string,
): Promise<{ vitals: MorningVital[]; illnessExplained: boolean }> {
  try {
    const result = await computeCoincidentDeviation(userId, profile, {
      now,
      tz,
    });
    if (result.status !== "ok") return { vitals: [], illnessExplained: false };
    return {
      vitals: result.value.vitals.map((v) => ({
        type: v.type,
        value: v.value,
        low: v.low,
        high: v.high,
        direction: v.direction,
        daysAgo: Number.isFinite(v.daysAgo)
          ? v.daysAgo
          : Number.MAX_SAFE_INTEGER,
        ...(v.basis ? { basis: v.basis } : {}),
      })),
      illnessExplained: result.value.illnessExplained,
    };
  } catch {
    return { vitals: [], illnessExplained: false };
  }
}

/** Readiness exactly as the derived batch route computes it. */
async function readReadiness(
  userId: string,
  profile: Awaited<ReturnType<typeof loadBaselineProfile>>,
  now: Date,
  tz: string,
): Promise<MorningReadiness | null> {
  try {
    const derived = await computeDerivedMetric({
      metric: "READINESS",
      userId,
      profile,
      now,
      tz,
    });
    if (derived.status !== "ok" || !derived.value) return null;
    // Not fresh means no number, no band and no sentence (`fresh`, `asOfDay`).
    const value = derived.value as ReadinessValue;
    const { fresh, asOfDay } = value;
    return {
      score: value.score,
      band: value.band as Band,
      components: value.components.map((c) => ({
        key: c.key,
        value: c.value,
        weight: c.weight,
      })),
      fresh,
      asOfDay,
    };
  } catch {
    return null;
  }
}

async function readSleepScore(
  userId: string,
  profile: Awaited<ReturnType<typeof loadBaselineProfile>>,
  now: Date,
  tz: string,
): Promise<MorningSleepScore | null> {
  try {
    const derived = await computeDerivedMetric({
      metric: "SLEEP_SCORE",
      userId,
      profile,
      now,
      tz,
    });
    if (derived.status !== "ok" || !derived.value) return null;
    const value = derived.value as SleepScoreValue;
    return {
      score: value.score,
      band: value.band,
      night: value.night,
      asleepMinutes: value.asleepMinutes,
    };
  } catch {
    return null;
  }
}

async function readDeviceScores(
  userId: string,
  now: Date,
): Promise<DeviceScoreRow[]> {
  try {
    // dense-take: one score per source and night, 36 hours back; twenty rows
    // hold every source's last two nights several times over.
    const rows = await prisma.measurement.findMany({
      where: {
        userId,
        type: { in: [...DEVICE_SCORE_TYPES] },
        // The proxy is HealthLog's own blend and reaches the card as
        // readiness; only a device's own score is a source value.
        source: { not: "COMPUTED" },
        measuredAt: {
          gte: new Date(now.getTime() - DEVICE_SCORE_LOOKBACK_MS),
          lte: now,
        },
      },
      orderBy: { measuredAt: "desc" },
      take: 20,
      select: {
        type: true,
        source: true,
        value: true,
        measuredAt: true,
        timeZone: true,
      },
    });
    return rows.map((r) => ({
      type: String(r.type),
      source: String(r.source),
      value: r.value,
      measuredAt: r.measuredAt,
      timeZone: r.timeZone,
    }));
  } catch {
    return [];
  }
}

function loadMorningExtrasCached(
  user: SessionUser,
  todayKey: string,
  now: Date,
  modules: { sleep: boolean; recovery: boolean },
): Promise<MorningExtras> {
  return cachedSwr(
    caches.analytics as ServerCache<MorningExtras>,
    morningExtrasCacheKey(user.id, todayKey, modules),
    async () => {
      const profile = await loadBaselineProfile(prisma, user.id);
      const [vitals, readiness, sleepScore, deviceScores] = await Promise.all([
        readVitals(user.id, profile, now, user.timezone),
        modules.recovery
          ? readReadiness(user.id, profile, now, user.timezone)
          : Promise.resolve(null),
        modules.sleep
          ? readSleepScore(user.id, profile, now, user.timezone)
          : Promise.resolve(null),
        readDeviceScores(user.id, now),
      ]);
      return {
        vitals: vitals.vitals,
        illnessExplained: vitals.illnessExplained,
        readiness,
        sleepScore,
        deviceScores,
      };
    },
    annotate,
    MORNING_CACHE_TTL_MS,
  );
}

/** The confirmed floor reasons of the last 24 hours, newest first. */
async function readFloorReasons(userId: string, now: Date): Promise<string[]> {
  try {
    const rows = await prisma.notificationEvent.findMany({
      where: {
        recordUserId: userId,
        eventType: "SYSTEM_ALERT",
        dedupKey: { startsWith: FLOOR_LEDGER_PREFIX },
        createdAt: { gte: new Date(now.getTime() - FLOOR_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { dedupKey: true },
    });
    return rows.map((r) => r.dedupKey.slice(FLOOR_LEDGER_PREFIX.length));
  } catch {
    return [];
  }
}

/**
 * The floor facts of the last 24 hours, in the reader's units: the reading
 * behind the newest confirmed floor, and, when none is confirmed, a reading
 * past a floor that the engine has not confirmed yet (`floorReading`). Both
 * are the extreme reading in the floor's direction (`floorFromReadings`).
 */
async function readFloor(
  userId: string,
  now: Date,
  glucoseUnit: GlucoseUnit,
): Promise<{ floor: MorningFloor | null; floorReading: MorningFloor | null }> {
  const none = { floor: null, floorReading: null };
  const inWindow = {
    userId,
    deletedAt: null,
    measuredAt: { gte: new Date(now.getTime() - FLOOR_WINDOW_MS), lte: now },
  };
  const [[reason], rows, glucoseRange] = await Promise.all([
    readFloorReasons(userId, now),
    prisma.measurement
      .findMany({
        where: {
          ...inWindow,
          type: { in: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] },
        },
        select: { type: true, value: true, measuredAt: true },
        orderBy: { measuredAt: "desc" },
        take: 200,
      })
      .catch(() => null),
    // A sensor writes glucose densely; only the window's two extremes can
    // cross a floor, so read those rather than the rows.
    prisma.measurement
      .aggregate({
        where: { ...inWindow, type: "BLOOD_GLUCOSE" },
        _min: { value: true },
        _max: { value: true },
      })
      .catch(() => null),
  ]);
  if (!rows || !glucoseRange) return none;
  const byInstant = new Map<number, { sys?: number; dia?: number }>();
  for (const row of rows) {
    const key = row.measuredAt.getTime();
    const pair = byInstant.get(key) ?? {};
    if (row.type === "BLOOD_PRESSURE_SYS") pair.sys = row.value;
    else pair.dia = row.value;
    byInstant.set(key, pair);
  }
  const glucose = [glucoseRange._min.value, glucoseRange._max.value].filter(
    (v): v is number => v !== null,
  );
  const readings = {
    bp: [...byInstant.values()].filter(
      (p): p is { sys: number; dia: number } =>
        p.sys !== undefined && p.dia !== undefined,
    ),
    glucose,
  };
  const label = (mgdl: number) =>
    `${convertGlucose(mgdl, glucoseUnit)} ${glucoseUnit}`;
  if (isFloorReason(reason)) {
    return {
      floor: floorFromReadings(readings, reason, label),
      floorReading: null,
    };
  }
  return {
    floor: null,
    floorReading: floorFromReadings(readings, null, label),
  };
}

function isFloorReason(
  reason: string | undefined,
): reason is MorningFloor["reason"] {
  return (
    reason === "bp_hypertensive" ||
    reason === "bp_hypotensive" ||
    reason === "glucose_hypo" ||
    reason === "glucose_hypo_severe" ||
    reason === "glucose_hyper"
  );
}

/** Render one vital's value and range in the reader's units and locale. */
export function renderMorningVital(
  vital: MorningVital,
  units: UnitPreferences,
  locale: Locale,
  t: Translate,
): TodayVital {
  // The same rendering as the digest's Today vitals, so a value reads the
  // same in the morning sentence and in the hero it may fall back to.
  const transform = getReadingTransform(vital.type, units);
  const decimals = vitalDisplayDecimals(vital.type, transform.decimals);
  const number = new Intl.NumberFormat(resolveIntlLocale(locale), {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
  const shown = (raw: number) =>
    number.format(applyDisplayTransform(raw, transform));
  const unit = transform.displayUnit;
  const range = t("daily.today.rangeWithUnit", {
    low: shown(vital.low),
    high: shown(vital.high),
    unit,
  });
  return {
    type: vital.type,
    value: vital.value,
    low: vital.low,
    high: vital.high,
    direction: vital.direction,
    daysAgo: vital.daysAgo,
    valueLabel: t("daily.today.valueWithUnit", {
      value: shown(vital.value),
      unit,
    }),
    rangeLabel:
      vital.basis === "sameHours"
        ? t("daily.today.rangeAtThisTime", { range })
        : range,
    moduleKey: moduleForMeasurementType(vital.type),
  };
}

/** A device's own name for a score row ("WHOOP Recovery"). */
const SOURCE_NAMES: Record<string, string> = {
  WHOOP: "WHOOP",
  OURA: "Oura",
  POLAR: "Polar",
  GARMIN: "Garmin",
  WITHINGS: "Withings",
  GOOGLE_HEALTH: "Google Health",
  APPLE_HEALTH: "Apple Health",
  FITBIT: "Fitbit",
};

function sourceName(source: string): string {
  return (
    SOURCE_NAMES[source] ??
    source.charAt(0) + source.slice(1).toLowerCase().replace(/_/g, " ")
  );
}

/**
 * A device score on its vendor's own scale, under the vendor's own name, and
 * without a HealthLog band. Polar's Nightly Recharge is stored rescaled to 0
 * to 100 (`polar/map.ts`) and shown back on its 1 to 6 scale.
 */
export function toDeviceSourceValue(
  row: DeviceScoreRow,
  t: Translate,
): DeviceSourceValue {
  const polarRecharge = row.type === "RECOVERY_SCORE" && row.source === "POLAR";
  const label =
    row.type === "RECOVERY_SCORE"
      ? (translateOrNull(
          t,
          `daily.morningCard.source.recovery.${row.source}`,
        ) ??
        t("daily.morningCard.source.recoveryGeneric", {
          source: sourceName(row.source),
        }))
      : row.type === "SLEEP_PERFORMANCE"
        ? t("daily.morningCard.source.sleepPerformance")
        : t("daily.morningCard.source.sleepScore", {
            source: sourceName(row.source),
          });
  return {
    source: row.source,
    label,
    value: polarRecharge
      ? Math.round(1 + (row.value / 100) * 5)
      : Math.round(row.value),
    scaleMax: polarRecharge ? 6 : 100,
    measuredAt: row.measuredAt.toISOString(),
  };
}

/** The newest row per source and type that falls on the reader's today. */
function todaysDeviceValues(
  rows: readonly DeviceScoreRow[],
  types: readonly string[],
  todayKey: string,
  tz: string,
  t: Translate,
): DeviceSourceValue[] {
  const seen = new Set<string>();
  const out: DeviceSourceValue[] = [];
  for (const row of rows) {
    if (!types.includes(row.type)) continue;
    if (readingDayKey(row.measuredAt, row.timeZone, tz) !== todayKey) continue;
    const key = `${row.type}|${row.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toDeviceSourceValue(row, t));
  }
  return out;
}

/** A local day key as a short date ("Nov 24"), for "Last 81 on". */
function shortDate(dayKey: string, locale: Locale): string {
  return new Intl.DateTimeFormat(resolveIntlLocale(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${dayKey}T12:00:00Z`));
}

export interface DailyMorningLoadOptions {
  /** The app's own language, when the request carried one (native clients). */
  locale?: Locale;
}

export async function loadDailyMorning(
  user: SessionUser,
  now: Date = new Date(),
  options: DailyMorningLoadOptions = {},
): Promise<DailyMorning> {
  const tz = user.timezone;
  const todayKey = userDayKey(now, tz);
  const todayBounds = getUserTodayBounds(now, tz);
  const modulesRead = resolveModuleMap(user.id);
  const units = resolveUnitPreferences({
    unitPreference: user.unitPreference,
    glucoseUnit: user.glucoseUnit,
  });

  const [
    { body: snapshot, locale },
    modules,
    restModeContext,
    extras,
    night,
    { floor, floorReading },
    quiet,
    visit,
  ] = await Promise.all([
    readDashboardSnapshotCached(user, undefined, {
      locale: options.locale,
      now,
    }),
    modulesRead,
    modulesRead.then((m) =>
      m.illness !== false ? resolveRestMode(user.id, now) : null,
    ),
    modulesRead.then((m) =>
      loadMorningExtrasCached(user, todayKey, now, {
        sleep: m.sleep !== false,
        recovery: m.recovery !== false,
      }),
    ),
    modulesRead.then((m) =>
      m.sleep !== false ? readLastNight(user.id, tz, todayKey, now) : null,
    ),
    readFloor(user.id, now, units.glucoseUnit),
    modulesRead.then((m) => loadQuietSources(user.id, now, m)).catch(() => []),
    prisma.encounter
      .findFirst({
        where: {
          userId: user.id,
          deletedAt: null,
          status: "PLANNED",
          occurredAt: { gte: todayBounds.start, lte: todayBounds.end },
        },
        orderBy: { occurredAt: "asc" },
        select: { occurredAt: true },
      })
      .catch(() => null),
  ]);

  const { t } = getServerTranslator(locale);
  const formatters = makeFormatters(
    locale,
    tz,
    (user.timeFormat ?? "AUTO") as TimeFormatPreference,
    (user.dateFormat ?? "AUTO") as DateFormatPreference,
  );

  // Sleep: whether sleep is tracked at all comes from the snapshot; whether
  // last night is in comes from one rule (`resolveLastNight`) over the night
  // `readLastNight` read, which the sentence, the line, the ring and the
  // pending state all read. The digest reads the same night the same way.
  const sleepOn = modules.sleep !== false;
  const sleepScore = extras.sleepScore;
  const { lastNight, sleepExpected } = lastNightFromSnapshot({
    snapshot,
    todayKey,
    sleepOn,
    morningRefreshedToday: user.morningDigestRefreshedOn === todayKey,
    night,
  });

  const restMode: TodayRestMode | null =
    restModeContext?.active && restModeContext.since
      ? {
          day:
            Math.max(
              0,
              dayDiff(
                todayKey,
                userDayKey(new Date(restModeContext.since), tz),
              ),
            ) + 1,
        }
      : null;

  const readiness = extras.readiness;
  const input: MorningInput = {
    locale,
    modules,
    now,
    todayKey,
    localHour: hourInTz(now, tz),
    floor,
    floorReading,
    restMode,
    vitals: extras.vitals.map((v) => renderMorningVital(v, units, locale, t)),
    illnessExplained: extras.illnessExplained,
    sleepExpected,
    sleepPending: lastNight.sleepPending,
    sleep: lastNight.sleep,
    latestNightLabel: lastNight.latestNightDay
      ? shortDate(lastNight.latestNightDay, locale)
      : null,
    sleepScore,
    sleepSourceValues: sleepOn
      ? todaysDeviceValues(
          extras.deviceScores,
          ["SLEEP_SCORE", "SLEEP_PERFORMANCE"],
          todayKey,
          tz,
          t,
        )
      : [],
    quiet: quiet.map((q) => ({
      name: CONNECTION_LABELS[q.source],
      since: q.since,
      sinceDay: userDayKey(q.since, tz),
    })),
    readiness,
    recoverySourceValues:
      modules.recovery !== false
        ? todaysDeviceValues(
            extras.deviceScores,
            ["RECOVERY_SCORE"],
            todayKey,
            tz,
            t,
          )
        : [],
    dosesToday: snapshot.medsToday.scheduledToday,
    visitToday: visit ? { timeLabel: formatters.time(visit.occurredAt) } : null,
    readinessAsOfLabel: readiness?.asOfDay
      ? shortDate(readiness.asOfDay, locale)
      : null,
    scoreFlag: healthScoreFlag(snapshot.healthScore),
  };

  const morning = buildDailyMorning(input, t);
  annotate({
    action: { name: "daily.morning.build" },
    meta: {
      daily_morning_rank: morning.lead.rank,
      daily_morning_card_count: morning.cards.length,
      daily_morning_readiness_fresh: readiness?.fresh ?? null,
    },
  });
  return morning;
}

/**
 * Settle the digest and the morning together for the server render of `/`:
 * both or neither. The morning block renders only from both, and a page that
 * seeded one of them would paint the fallback hero and swap in the morning
 * after hydration, a sentence that changes under the reader. Undefined is
 * "not settled in time or failed"; the client then fetches both.
 */
export function settleTodayPair<D, M>(
  digest: D | undefined,
  morning: M | undefined,
): { digest: D; morning: M } | null {
  return digest !== undefined && morning !== undefined
    ? { digest, morning }
    : null;
}

/**
 * Warm the morning for one account, after last night's sleep is in: the cell
 * of the day is dropped and rebuilt, so the first visit of the morning reads
 * the night that just arrived. Fail-soft: a warm that fails leaves the next
 * request to build it.
 */
export async function warmDailyMorning(
  userId: string,
  localDate: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    caches.analytics.deleteByPrefix(morningCacheKey(userId, localDate));
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: SESSION_USER_SELECT,
    });
    if (!user) return false;
    // No request to read a language from: the account's own, as the push.
    await loadDailyMorning(user, now, {
      locale: await resolveJobLocale(user.locale),
    });
    return true;
  } catch {
    return false;
  }
}
