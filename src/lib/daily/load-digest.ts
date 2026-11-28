/**
 * IO seam for the daily digest (P3) — gathers the ALREADY-CACHED inputs and
 * hands them to the pure `buildDailyDigest` composer.
 *
 * The heavy read (health score, meds-today, sleep last-seen, the daily
 * briefing lift) rides `readDashboardSnapshotCached` — the SAME SWR cell the
 * dashboard already serves, so the digest never re-runs the snapshot builder
 * within its TTL and never reaches an AI provider (the briefing is lifted
 * read-only from `User.insightsCachedTextEncrypted`). Two light deterministic reads add
 * the rail's non-snapshot inputs: broken integrations and overdue Vorsorge
 * reminders. Module gating is inherited from the snapshot (already
 * module-gated at the build layer) plus the resolved module map the item
 * builders consult.
 */
import type { SessionUser } from "@/lib/auth/session-user";
import { firstNameFromDisplayName } from "@/lib/ai/prompts/opener-archetype";
import { resolveJobLocale } from "@/lib/i18n/job-locale";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { resolveModuleMap } from "@/lib/modules/gate";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import {
  aiCapabilityForRecord,
  aiCapabilityToServe,
} from "@/lib/ai/capabilities/gate";
import { userDayKey } from "@/lib/tz/format";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { calendarDaysUntil } from "@/lib/measurement-reminders/due-day";
import { isCheckupDueNow } from "@/lib/measurement-reminders/due-now";
import { hasLongCycle } from "@/lib/measurement-reminders/holds-open";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import { isArrivalKind } from "@/lib/arrivals/types";
import {
  buildDailyDigest,
  type DailyDigest,
  type DailyDigestAi,
  type DailyDigestArrival,
  type DailyDigestCoachPlan,
  type DailyDigestEcg,
  type DailyDigestPreventiveDue,
  type DailyDigestUpcomingVisit,
  type DailyDigestScore,
  type DailyDigestSameTime,
  type DailyDigestSyncIssue,
  type DailyDigestTensionWindow,
} from "@/lib/daily/digest";
import {
  ecgItemKey,
  milestoneItemKey,
  sameTimeBaselineItemKey,
  tensionWindowItemKey,
} from "@/lib/daily/priority-item-key";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { readDayMeanSeries } from "@/lib/insights/derived/baseline";
import { detectStreak, type StreakPoint } from "@/lib/insights/streak-detector";
import {
  MILESTONE_SALIENT_TYPES,
  milestoneFromRecord,
  milestonesFromStreak,
  selectFreshMilestone,
  type Milestone,
} from "@/lib/daily/milestones";
import { loadIntradayPulse } from "@/lib/analytics/intraday-pulse-io";
import { computeSameTimeBaseline } from "@/lib/insights/derived/same-time-baseline";
import { HERO_ITEM_KINDS, type HeroItemKind } from "@/lib/daily/priority-item";
import type { MeasurementType } from "@/generated/prisma/client";
import { computeCoincidentDeviation } from "@/lib/insights/derived/coincident-deviation";
import { loadBaselineProfile } from "@/lib/insights/derived/baseline";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import {
  applyDisplayTransform,
  getReadingTransform,
  resolveUnitPreferences,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { readTodayCycle, type TodayCycleRead } from "@/lib/cycle/today-verdict";
import { addDays, dayDiff } from "@/lib/cycle/day-math";
import { makeFormatters, resolveIntlLocale } from "@/lib/format-locale";
import { vitalDisplayDecimals } from "@/lib/measurements/vital-precision";
import type {
  DateFormatPreference,
  TimeFormatPreference,
} from "@/lib/format-locale";
import {
  STEADY_READ_DAYS,
  steadyRun,
  type StoredScoreDay,
} from "@/lib/daily/score-steady";
import type {
  TodayCycle,
  TodayRestMode,
  TodayVital,
} from "@/lib/daily/today-overview";
import { nextDoseOpensAt } from "@/lib/daily/today-medications-fact";
import { lastNightFromSnapshot, readLastNight } from "@/lib/daily/last-night";
import { translateOrNull } from "@/lib/i18n/translate-code";
import {
  loadQuietSources,
  wordQuietSources,
} from "@/lib/sync-stall/quiet-load";
import { readAskInputs } from "@/lib/daily/asks-load";

/** Integration states that mean "your action is needed to keep data flowing". */
const SYNC_ISSUE_STATES = ["error_reauth", "parked"] as const;

/**
 * How far ahead the rail mentions a booked appointment: the next 48 hours, on
 * top of everything booked for the local today.
 *
 * The rail is a "what about today" surface, so anything further out is not a
 * thing to act on this morning. Two days rather than one because an evening
 * reader wants tomorrow's 08:00 appointment, and a 24-hour window would hide it
 * from them.
 */
const UPCOMING_VISIT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** Defensive cap on how many planned visits the rail read returns. */
const UPCOMING_VISIT_READ_LIMIT = 10;

/** Defensive cap on how many overdue reminders we read for the rail summary. */
const PREVENTIVE_DUE_READ_LIMIT = 20;

/** Standing plan states that can carry a check-in (§2.3). */
const CHECKIN_PLAN_STATES = ["active", "reviewed"] as const;

/** Cap on plans scanned for the (one/day) check-in candidate. */
const CHECKIN_PLAN_READ_LIMIT = 50;

/** Trailing window the milestone streak read uses (matches score-narrative). */
const MILESTONE_STREAK_WINDOW_DAYS = 30;

/** How far back to scan for a just-set personal best (a couple of days is ample). */
const MILESTONE_RECORD_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Gather today's single freshly-reached milestone (or null) from the
 * engines that ALREADY exist. Two cheap, fail-soft reads reused verbatim:
 *   - `detectStreak` over the salient vitals' day-mean series (the exact
 *     `score-narrative` pattern) → return-to-range + sustained-in-range states;
 *   - a bounded `PersonalRecord` scan (the `pr-detection` output) → new bests.
 * The reached-once gate (`selectFreshMilestone`) admits at most one, only on the
 * day it was reached. Any failure leaves the reward quiet rather than guessing.
 */
async function gatherFreshMilestone(
  userId: string,
  timezone: string,
  now: Date,
): Promise<Milestone | null> {
  // Every day key here is the user's own calendar day: today's key, the
  // streak series (folded on local days) and each record's day. UTC keys
  // named tomorrow "today" through a New York evening.
  const todayKey = userDayKey(now, timezone);
  const candidates: Milestone[] = [];

  const coverage = await probeRollupCoverage(userId).catch(() => null);
  if (coverage) {
    const perMetric = await Promise.all(
      MILESTONE_SALIENT_TYPES.map(async (type) => {
        try {
          const { points } = await readDayMeanSeries(
            userId,
            type,
            MILESTONE_STREAK_WINDOW_DAYS,
            now,
            coverage,
            timezone,
          );
          if (points.length === 0) return [] as Milestone[];
          const series: StreakPoint[] = points.map((p) => ({
            day: p.day,
            value: p.mean,
          }));
          const latestDayKey = points[points.length - 1].day;
          return milestonesFromStreak(type, detectStreak(series), latestDayKey);
        } catch {
          return [] as Milestone[];
        }
      }),
    );
    candidates.push(...perMetric.flat());
  }

  try {
    const records = await prisma.personalRecord.findMany({
      where: {
        userId,
        metricType: { in: [...MILESTONE_SALIENT_TYPES] },
        achievedAt: {
          gte: new Date(now.getTime() - MILESTONE_RECORD_LOOKBACK_MS),
        },
      },
      select: { metricType: true, achievedAt: true },
      orderBy: { achievedAt: "desc" },
      take: 10,
    });
    for (const record of records) {
      candidates.push(
        milestoneFromRecord(
          record.metricType,
          userDayKey(record.achievedAt, timezone),
        ),
      );
    }
  } catch {
    // A read hiccup just leaves the reward quiet — never a fabricated one.
  }

  return selectFreshMilestone(candidates, todayKey);
}

/**
 * P — the milestone gather (~8.5k rows via the streak/PR reads) and the
 * intraday-tension read (a bounded but real per-sample day read) are the two
 * heaviest inputs the digest computes on every request, yet both are usually
 * null and change at most once per local day. Every open tab's 120 s poll
 * (`DASHBOARD_REFETCH_INTERVAL_MS`) was re-deriving them from scratch.
 *
 * Cached together in ONE cell — keyed `${userId}|daily-digest-extras|${dateKey}`
 * under the shared `analytics` bucket so the write-invalidation semantics
 * `readDashboardSnapshotCached` already relies on cover this cell too: every
 * measurement write sweeps the `${userId}|` prefix (mark-stale for a
 * background sync, hard-evict for an interactive write — see
 * `invalidateUserMeasurements`), so a fresh sleep/vitals landing still
 * refreshes this within the same SWR contract the snapshot cell uses. TTL
 * mirrors `SNAPSHOT_CACHE_TTL_MS` — strictly greater than the client poll
 * interval so a scheduled refetch lands warm.
 */
const DIGEST_EXTRAS_CACHE_TTL_MS = DASHBOARD_REFETCH_INTERVAL_MS + 60_000;

interface DailyDigestExtras {
  milestone: Milestone | null;
  tensionWindow: DailyDigestTensionWindow | null;
  /**
   * The cached cell holds the same-time read WITHOUT its locale-formatted
   * labels: the cell is keyed on (user, local day) and a locale-specific
   * string in it would be served to a reader who has since switched language.
   * The labels are grouped at the call site, where the locale is resolved.
   */
  sameTime: Omit<DailyDigestSameTime, "todayLabel" | "typicalLabel"> | null;
  /**
   * Each banded vital's standing against its personal range, from the
   * coincident-deviation engine. Canonical numbers only: the labels depend on
   * the reader's units and locale and are rendered per request.
   */
  vitals: ExtrasVital[];
  /** The stored daily scores the "steady for" line is read from. */
  scoreDays: StoredScoreDay[];
  /**
   * Today's place in the cycle, read only while the cycle module is on. A
   * cycle write hard-evicts the cell (`invalidateUserHealthContext`), and a
   * module switch does too (`invalidateUserHealthScore`), so a cached
   * answer never outlives the rows or the switch it was read under.
   */
  cycle: TodayCycleRead | null;
}

interface ExtrasVital {
  type: MeasurementType;
  value: number;
  low: number;
  high: number;
  direction: "above" | "below" | "in";
  daysAgo: number;
  /** Held against the same hours of earlier days, see `VitalDeviation`. */
  basis?: "sameHours";
}

/**
 * The vitals read for the Today overview: every banded vital's latest day
 * against its personal range. Fault-isolated, like every extras input; an
 * engine that cannot answer (too few banded vitals) leaves the list empty,
 * and the overview simply has no vitals line.
 */
async function gatherVitals(
  userId: string,
  timezone: string,
  now: Date,
): Promise<ExtrasVital[]> {
  try {
    const profile = await loadBaselineProfile(prisma, userId);
    const result = await computeCoincidentDeviation(userId, profile, {
      now,
      tz: timezone,
    });
    if (result.status !== "ok") return [];
    return result.value.vitals.map((v) => ({
      type: v.type,
      value: v.value,
      low: v.low,
      high: v.high,
      direction: v.direction,
      daysAgo: Number.isFinite(v.daysAgo) ? v.daysAgo : Number.MAX_SAFE_INTEGER,
      ...(v.basis ? { basis: v.basis } : {}),
    }));
  } catch {
    return [];
  }
}

/** The stored daily scores for the "steady for" read. Fault-isolated. */
async function gatherScoreDays(
  userId: string,
  todayLocalDate: string,
): Promise<StoredScoreDay[]> {
  try {
    // Calendar arithmetic on the reader's own day key, the space the stored
    // rows are keyed in.
    const since = addDays(todayLocalDate, -STEADY_READ_DAYS);
    const rows = await prisma.healthScoreRecord.findMany({
      where: { userId, dayKey: { gte: since } },
      orderBy: { dayKey: "desc" },
      take: STEADY_READ_DAYS + 1,
      select: {
        dayKey: true,
        composite: true,
        band: true,
        scoreVersion: true,
        composition: true,
      },
    });
    return rows.map((row) => ({
      dayKey: row.dayKey,
      composite: row.composite,
      band: String(row.band),
      scoreVersion: row.scoreVersion,
      composition: row.composition,
    }));
  } catch {
    return [];
  }
}

/** Render one vital's value and range in the reader's units and locale. */
function toTodayVital(
  vital: ExtrasVital,
  units: UnitPreferences,
  locale: Locale,
  t: (key: string, params?: Record<string, string | number>) => string,
): TodayVital {
  const transform = getReadingTransform(vital.type, units);
  const decimals = vitalDisplayDecimals(vital.type, transform.decimals);
  const number = new Intl.NumberFormat(resolveIntlLocale(locale), {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
  const shown = (raw: number) =>
    number.format(applyDisplayTransform(raw, transform));
  const unit = transform.displayUnit;
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
    rangeLabel: (() => {
      const range = t("daily.today.rangeWithUnit", {
        low: shown(vital.low),
        high: shown(vital.high),
        unit,
      });
      // A range read off the same hours of earlier days is the usual range
      // for this time of day, not the whole-day band shown elsewhere.
      return vital.basis === "sameHours"
        ? t("daily.today.rangeAtThisTime", { range })
        : range;
    })(),
    moduleKey: moduleForMeasurementType(vital.type),
  };
}

/**
 * v1.34.0 — the rail's same-time read is STEPS only.
 *
 * All four cumulative metrics carry a same-time baseline and all four have a
 * tile in the Insights grid. The rail is a glance of at most three items, so
 * putting four activity cards on it would crowd out an overdue dose to say the
 * same thing four ways. Steps is the number people actually check.
 */
const SAME_TIME_RAIL_TYPE = "ACTIVITY_STEPS";

function digestExtrasCacheKey(userId: string, dateKey: string): string {
  return `${userId}|daily-digest-extras|${dateKey}`;
}

async function loadDailyDigestExtrasCached(
  userId: string,
  timezone: string,
  todayLocalDate: string,
  now: Date,
  cycleOn: boolean,
): Promise<DailyDigestExtras> {
  return cachedSwr(
    caches.analytics as ServerCache<DailyDigestExtras>,
    digestExtrasCacheKey(userId, todayLocalDate),
    async () => {
      // Independent reads, hoisted into one Promise.all (a prior
      // revision ran them sequentially). Each is already fault-isolated
      // internally (a milestone read-hiccup or a tension-read failure leaves
      // its own field quiet rather than breaking the other).
      const [milestone, tensionWindow, sameTime, vitals, scoreDays, cycle] =
        await Promise.all([
          gatherFreshMilestone(userId, timezone, now),
          loadIntradayPulse(userId, timezone, todayLocalDate)
            .then((r) =>
              r.tension ? { partOfDay: r.tension.partOfDay } : null,
            )
            .catch(() => null),
          // The engine gates itself (still learning, no reading today, the
          // day's first hour unfinished). Only the hourly `ok` arm reaches the
          // rail: the day-total form is "not yet" every morning, no news worth
          // a rail slot. Passing no profile because the engine reads none;
          // fault-isolated like its siblings, since the digest must not fail.
          computeSameTimeBaseline(userId, null, {
            type: SAME_TIME_RAIL_TYPE,
            now,
          })
            .then((d): DailyDigestExtras["sameTime"] =>
              d.status === "ok" && d.value.mode === "hourly"
                ? {
                    type: d.value.type,
                    band: d.value.band,
                    asOfHour: d.value.asOfHour,
                    todayValue: Math.round(d.value.todayValue),
                    typicalValue: Math.round(d.value.typicalValue),
                  }
                : null,
            )
            .catch(() => null),
          gatherVitals(userId, timezone, now),
          gatherScoreDays(userId, todayLocalDate),
          // The whole cycle history, 90 days of day logs and wrist
          // temperature: too much to read on every 120 s poll.
          cycleOn
            ? readTodayCycle(userId, timezone, now).catch(() => null)
            : Promise.resolve(null),
        ]);
      return { milestone, tensionWindow, sameTime, vitals, scoreDays, cycle };
    },
    annotate,
    DIGEST_EXTRAS_CACHE_TTL_MS,
  );
}

/** How recently an ECG recording counts as "new" for the rail read. */
const ECG_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CoachPlanRow {
  id: string;
  status: string;
  reviewDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  ifCueEncrypted: Uint8Array;
  thenActionEncrypted: Uint8Array;
}

/**
 * Decrypt a plan's if→then prose fault-isolated (an undecryptable row keeps a
 * null text, never throws) so the check-in card can echo the user's own words.
 */
function toCoachPlanCandidate(row: CoachPlanRow): DailyDigestCoachPlan {
  let planText: string | null = null;
  try {
    planText = `${decryptFromBytes(row.ifCueEncrypted)} → ${decryptFromBytes(
      row.thenActionEncrypted,
    )}`;
  } catch {
    planText = null;
  }
  return {
    id: row.id,
    status: row.status,
    reviewDate: row.reviewDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    planText,
  };
}

/**
 * Today's arrival markers, decrypted fault-isolated.
 *
 * One indexed read on `[userId, localDate]` — the exact shape of the model's
 * `@@index`, and at most one row per arrival kind, so the result is bounded by
 * the closed `ARRIVAL_KINDS` enum rather than by anything the user can grow.
 *
 * A line that fails to decrypt (a key rotated out from under the row) yields a
 * null line, never a throw: the digest is a hot, must-not-fail path, and the
 * marker itself — which is what actually drives the "just in" chip — survives
 * a lost sentence intact. Same discipline as `toCoachPlanCandidate` above.
 */
function toDigestArrival(
  row: {
    kind: string;
    occurredAt: Date;
    arrivedAt: Date;
    lineEncrypted: Uint8Array | null;
    generatedAt: Date | null;
  },
  /** Whether the record's `reactionLines` text may be shown. */
  linesServable: boolean,
): DailyDigestArrival | null {
  // A kind this build does not know about (a row written by a newer version)
  // is dropped rather than widened — the DTO's kind union is closed.
  if (!isArrivalKind(row.kind)) return null;

  let line: string | null = null;
  // The ciphertext rides only once the generation actually COMMITTED. A row
  // mid-generation carries no `generatedAt`, and its line must not surface.
  // A model-written line is never served (nor decrypted) while
  // `reactionLines` is unavailable for the record; the marker still is.
  if (linesServable && row.generatedAt !== null && row.lineEncrypted !== null) {
    try {
      line = decryptFromBytes(row.lineEncrypted);
    } catch {
      line = null;
    }
  }

  return {
    kind: row.kind,
    occurredAt: row.occurredAt,
    arrivedAt: row.arrivedAt,
    line,
  };
}

export interface DailyDigestLoadOptions {
  /**
   * Overrides the dashboard's hero visibility for non-hero consumers.
   * Passing `PRIORITY_ITEM_KINDS` keeps notification eligibility independent
   * from which cards the user chose to display in the Today hero.
   */
  enabledItemKinds?: readonly HeroItemKind[];
  /**
   * A locale already resolved by a background caller (the morning briefing
   * push). Request-driven readers leave it unset and the snapshot read
   * resolves the locale from the request.
   */
  locale?: Locale;
  /** Ask the admin question; a browser session on its own record only. */
  adminAsks?: boolean;
  /**
   * The instance origin the request reached, on the reader's own record:
   * whether a Wallet pass can be made there decides the emergency-wallet
   * ask. Unset, the ask is not offered (a background caller, a delegate).
   */
  walletOrigin?: string | null;
}

/**
 * The reads the module map gates, started once it resolves, in the snapshot's
 * round. Rest Mode is skipped when its module is off; the extras ride the
 * cached, single-flight `loadDailyDigestExtrasCached` cell (see its docblock).
 */
function startGatedReads(user: SessionUser, todayLocalDate: string, now: Date) {
  const modulesRead = resolveModuleMap(user.id);
  return {
    modulesRead,
    restModeRead: modulesRead.then((m) =>
      m.illness !== false ? resolveRestMode(user.id, now) : null,
    ),
    extrasRead: modulesRead.then((m) =>
      loadDailyDigestExtrasCached(
        user.id,
        user.timezone,
        todayLocalDate,
        now,
        m.cycle !== false,
      ),
    ),
  };
}

export async function loadDailyDigest(
  user: SessionUser,
  now: Date = new Date(),
  options: DailyDigestLoadOptions = {},
): Promise<DailyDigest> {
  // Computed before the fan-out because the arrival read is keyed on it. Pure
  // (a tz format of `now`), so hoisting it costs nothing.
  const todayLocalDate = userDayKey(now, user.timezone);
  // First instant of the user's NEXT local day (profile tz) — bounds the
  // dose-window rail to today's business. `getUserTodayBounds` returns the
  // inclusive last millisecond of today; +1 ms is exactly tomorrow's start.
  const todayBounds = getUserTodayBounds(now, user.timezone);
  const todayEndExclusive = new Date(todayBounds.end.getTime() + 1);

  const gated = startGatedReads(user, todayLocalDate, now);
  const [
    { body: snapshot, locale },
    modules,
    restModeContext,
    { milestone, tensionWindow, sameTime, vitals, scoreDays, cycle: cycleRead },
    reactionLanguage,
    syncRows,
    quietRows,
    dueReminders,
    planRows,
    ecgRow,
    arrivalRows,
    visitRows,
    coachAi,
    reactionLinesAi,
  ] = await Promise.all([
    readDashboardSnapshotCached(user, undefined, {
      locale: options.locale,
      now,
    }),
    gated.modulesRead,
    gated.restModeRead,
    gated.extrasRead,
    resolveJobLocale(user.locale),
    prisma.integrationStatus.findMany({
      where: { userId: user.id, state: { in: [...SYNC_ISSUE_STATES] } },
      select: { integration: true, state: true, lastSuccessAt: true },
      orderBy: { integration: "asc" },
    }),
    loadQuietSources(user.id, now).catch(() => []),
    prisma.measurementReminder.findMany({
      // A booked visit's one-shot reminder rides this same engine with
      // `origin: ENCOUNTER`. It is not a checkup and must not appear on a
      // Vorsorge surface, or the list fills with appointments. Four read
      // sites carry this exclusion; `encounter-reminder-exclusion.test.ts`
      // proves every one of them, and the DTO mapper refuses such a row
      // outright so a site that lost its filter fails loudly.
      //
      // Read up to the end of the person's local day; the filter below keeps
      // what is due now, plus what is due later today when it is a reminder
      // on a long cycle (see `hasLongCycle`). A reminder that stays due after
      // it is sent (`holdsOpenAfterReminder`) keeps its due date, so the
      // overdue ones stay here until they are satisfied, skipped or snoozed.
      where: {
        userId: user.id,
        enabled: true,
        deletedAt: null,
        origin: { not: "ENCOUNTER" },
        nextDueAt: { not: null, lt: todayEndExclusive },
      },
      select: {
        label: true,
        origin: true,
        intervalDays: true,
        rrule: true,
        anchorDate: true,
        notifyHour: true,
        lastSatisfiedAt: true,
        createdAt: true,
        nextDueAt: true,
      },
      orderBy: { nextDueAt: "asc" },
      take: PREVENTIVE_DUE_READ_LIMIT,
    }),
    // Standing plans for the (one/day) check-in candidate. The plaintext
    // columns decide due-ness; the encrypted prose is only decrypted below,
    // and only for a coach-enabled account (disabled-module data never
    // enters the digest — the builder also drops it, this skips the decrypt).
    prisma.coachPlan.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        status: { in: [...CHECKIN_PLAN_STATES] },
      },
      select: {
        id: true,
        status: true,
        reviewDate: true,
        createdAt: true,
        updatedAt: true,
        ifCueEncrypted: true,
        thenActionEncrypted: true,
      },
      orderBy: { updatedAt: "desc" },
      take: CHECKIN_PLAN_READ_LIMIT,
    }),
    // The freshest ECG recording within the last-day window, for the
    // `ecg_new_recording` rail item. Descriptors only (verdict + recordedAt) —
    // the encrypted waveform is never selected, so no decrypt and no trace
    // crosses into the digest. The builder gates on the `insights` module.
    prisma.ecgRecording.findFirst({
      where: {
        userId: user.id,
        recordedAt: { gte: new Date(now.getTime() - ECG_NEW_WINDOW_MS) },
      },
      orderBy: { recordedAt: "desc" },
      select: { recordedAt: true, rhythmClassification: true },
    }),
    // The arrival spine's markers for the user's CURRENT local day. At most
    // one row per arrival kind by the model's unique constraint, so this is a
    // bounded indexed read, not a scan.
    prisma.arrivalReaction.findMany({
      where: { userId: user.id, localDate: todayLocalDate },
      select: {
        kind: true,
        occurredAt: true,
        arrivedAt: true,
        lineEncrypted: true,
        generatedAt: true,
      },
    }),
    // Every PLANNED visit from the start of the local today to the end of the
    // two-day horizon. Read straight off the visit table, never off the
    // reminder engine — see the mapping below for why the exclusion above
    // must stay untouched.
    prisma.encounter.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        status: "PLANNED",
        occurredAt: {
          gte: todayBounds.start,
          lte: new Date(now.getTime() + UPCOMING_VISIT_WINDOW_MS),
        },
      },
      orderBy: { occurredAt: "asc" },
      take: UPCOMING_VISIT_READ_LIMIT,
      select: {
        id: true,
        kind: true,
        occurredAt: true,
        practitioner: { select: { name: true } },
      },
    }),
    // The check-in opens the Coach, so it asks as the person in front of
    // the screen; the reaction line is stored text, shown whenever the
    // record's own state allows it, whoever is reading.
    aiCapabilityForRecord(user.id, "coach"),
    aiCapabilityToServe(user.id, "reactionLines"),
  ]);

  // The snapshot read has already applied the `briefing` capability and
  // publishes the state it applied; the fallback only covers an older cached
  // body shape and fails closed.
  const ai: DailyDigestAi = {
    briefing: snapshot.briefingAi ?? {
      available: false,
      reason: "check_failed",
      onDeviceAllowed: false,
    },
    coach: coachAi,
    reactionLines: reactionLinesAi,
  };

  const score: DailyDigestScore | null = snapshot.healthScore
    ? {
        value: snapshot.healthScore.score,
        band: snapshot.healthScore.band,
        numberBand:
          snapshot.healthScore.numberBand ?? snapshot.healthScore.band,
        delta: snapshot.healthScore.delta,
        deltaReason: snapshot.healthScore.deltaReason,
        scoreVersion: snapshot.healthScore.scoreVersion,
        composition: snapshot.healthScore.composition,
        configured: snapshot.healthScore.configured,
        scoreBasis: snapshot.healthScore.scoreBasis,
        bandSetter: snapshot.healthScore.bandSetter ?? null,
        bandSetterBand: snapshot.healthScore.bandSetterBand ?? null,
        bandSetterLine: snapshot.healthScore.bandSetterLine ?? null,
      }
    : null;

  // Last night by the one rule (`resolveLastNight`) over the night the
  // morning reads too (`readLastNight`), whether or not the morning was read
  // today. The `morningDigestRefreshedOn` stamp is read fresh off the row,
  // so the day settles the instant the sleep-arrival refresh runs, ahead of
  // the snapshot cache.
  const sleepOn = modules.sleep !== false;
  const { lastNight } = lastNightFromSnapshot({
    snapshot,
    todayKey: todayLocalDate,
    sleepOn,
    morningRefreshedToday: user.morningDigestRefreshedOn === todayLocalDate,
    night: sleepOn
      ? await readLastNight(user.id, user.timezone, todayLocalDate, now)
      : null,
  });

  const syncIssues: DailyDigestSyncIssue[] = syncRows.map((row) => ({
    ...row,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
  }));

  /**
   * The booked visits of the local today and the next 48 hours, read from the
   * VISIT table.
   *
   * Not from the reminder table. An ENCOUNTER-origin reminder is excluded from
   * every preventive-care read, which is right — an appointment is not a
   * checkup — but a notification about something the app never shows is worse
   * than none. So the appointment reaches the rail from the record it lives
   * in, and the exclusion above stays exactly as it is. A diff here that
   * touches `origin` is the wrong fix.
   *
   * `occurredAt >= todayStart`, not `> now`: a visit's reminder fires at its
   * start time, and a rail that dropped the visit at that very moment showed a
   * notification about something the start page no longer mentioned. A visit
   * that is still PLANNED stays on the rail until its day ends.
   */
  // The start time on the person's own clock, rendered here in their profile
  // timezone and hour-cycle preference. Done on the server so every reader of
  // the digest prints the same time for the same visit, whatever zone their
  // device is in.
  const localTime = makeFormatters(
    locale,
    user.timezone,
    (user.timeFormat ?? "AUTO") as TimeFormatPreference,
    (user.dateFormat ?? "AUTO") as DateFormatPreference,
  ).time;
  const upcomingVisits: DailyDigestUpcomingVisit[] = visitRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    practitionerName: row.practitioner?.name ?? null,
    dayOffset: calendarDaysUntil(row.occurredAt, now, user.timezone),
    timeLabel: localTime(row.occurredAt),
  }));

  const restMode: TodayRestMode | null =
    restModeContext?.active && restModeContext.since
      ? {
          day:
            Math.max(
              0,
              dayDiff(
                todayLocalDate,
                userDayKey(new Date(restModeContext.since), user.timezone),
              ),
            ) + 1,
        }
      : null;

  // The builder decides "new" and gates on `insights`. An ECG row carries
  // only an AFib-screening verdict; any other member of the shared enum maps
  // to null rather than leaking into the device-verdict copy.
  const verdict = ecgRow?.rhythmClassification;
  const latestEcg: DailyDigestEcg | null = ecgRow
    ? {
        recordedAt: ecgRow.recordedAt,
        deviceVerdict:
          verdict === "IRREGULAR" ||
          verdict === "NOT_DETECTED" ||
          verdict === "INCONCLUSIVE"
            ? verdict
            : null,
      }
    : null;

  // Only decrypt plan prose while the Coach is available; the builder gates
  // the check-in on the same capability, so it never surfaces otherwise.
  const coachPlans: DailyDigestCoachPlan[] = coachAi.available
    ? planRows.map((row) => toCoachPlanCandidate(row as CoachPlanRow))
    : [];

  const cycle: TodayCycle | null = cycleRead
    ? { dayOfCycle: cycleRead.dayOfCycle, phase: cycleRead.phase }
    : null;

  // Dismiss ledger (P — Today rail dismiss). Only the OBSERVATIONAL kinds
  // (milestone / ecg_new_recording / tension_window) can ever be dismissed, so
  // only their candidate keys are worth looking up — never a full per-user
  // history read. At most 3 keys, so this is a single indexed `IN (...)`.
  const candidateItemKeys = [
    milestone ? milestoneItemKey(milestone) : null,
    latestEcg ? ecgItemKey(latestEcg.recordedAt) : null,
    tensionWindow
      ? tensionWindowItemKey(todayLocalDate, tensionWindow.partOfDay)
      : null,
    sameTime ? sameTimeBaselineItemKey(todayLocalDate, sameTime.type) : null,
  ].filter((k): k is string => k !== null);

  const dismissedRows =
    candidateItemKeys.length > 0
      ? await prisma.dismissedPriorityItem.findMany({
          where: { userId: user.id, itemKey: { in: candidateItemKeys } },
          select: { itemKey: true },
        })
      : [];
  const dismissedItemKeys = new Set(dismissedRows.map((r) => r.itemKey));

  const resolvedLocale: Locale = locale;
  const { t } = getServerTranslator(resolvedLocale);
  const units = resolveUnitPreferences({
    unitPreference: user.unitPreference,
    glucoseUnit: user.glucoseUnit,
  });

  // A Coach-suggested measurement cadence stores its label as a bundle key;
  // the checkups page and the dashboard card translate it, and so does this
  // line. A free-text label (every other row) is the person's own words.
  //
  // A reminder on a cycle longer than a week (a fortnightly questionnaire, a
  // yearly check-up) is on the rail for its whole due day and keeps its place
  // under the cap. A short-cycle one (a daily weigh-in, a twice-daily course)
  // is a rhythm: it shows only once its time has come and is not pinned; a
  // missed rolling one then stays here, overdue, until its reading lands.
  const preventiveDue: DailyDigestPreventiveDue[] = [];
  for (const row of dueReminders) {
    if (!row.nextDueAt || !isCheckupDueNow(row, user.timezone, now)) continue;
    const longCycle = hasLongCycle(row, user.timezone, row.nextDueAt);
    let label = row.label;
    if (row.origin === "COACH") {
      label = translateOrNull(t, row.label) ?? label;
    }
    preventiveDue.push({ label, longCycle });
  }

  // Grouped figures: the one locale-aware step outside the translator.
  const groupNumber = new Intl.NumberFormat(resolvedLocale).format;
  const sameTimeItem: DailyDigestSameTime | null = sameTime
    ? {
        ...sameTime,
        todayLabel: groupNumber(sameTime.todayValue),
        typicalLabel: groupNumber(sameTime.typicalValue),
      }
    : null;

  const nextOpensAt = nextDoseOpensAt(snapshot.medsToday);
  const digest = buildDailyDigest(
    {
      now,
      ai,
      todayEndExclusive,
      modules,
      enabledHeroItemKinds:
        options.enabledItemKinds ??
        snapshot.layout.enabledHeroItemKinds ??
        HERO_ITEM_KINDS,
      score,
      // Resolved for today by the snapshot read (`applyBriefingForToday`).
      briefing: snapshot.briefing,
      medsToday: snapshot.medsToday,
      // #176 — the briefing is served only in the reader's language or
      // untagged (written before the tag existed), so its tag says which; the
      // reaction line is written in the account's language.
      briefingLanguage: snapshot.briefing
        ? (user.insightsCachedLocale ?? null)
        : null,
      reactionLanguage,
      firstName: firstNameFromDisplayName(user.displayName),
      nextDoseTimeLabel: nextOpensAt ? localTime(new Date(nextOpensAt)) : null,
      localTime,
      lastNight,
      syncIssues,
      quietSources: wordQuietSources(quietRows, now, user.timezone, locale),
      preventiveDue,
      upcomingVisits,
      coachPlans,
      milestone,
      tensionWindow,
      sameTime: sameTimeItem,
      latestEcg,
      todayLocalDate,
      dismissedItemKeys,
      arrivals: arrivalRows
        .map((row) => toDigestArrival(row, reactionLinesAi.available))
        .filter((a): a is DailyDigestArrival => a !== null),
      locale: resolvedLocale,
      restMode,
      vitals: (vitals ?? []).map((v) =>
        toTodayVital(v, units, resolvedLocale, t),
      ),
      cycle,
      ...(await readAskInputs(user, snapshot.medsToday, now, options)),
      scoreSteady: score
        ? steadyRun(scoreDays ?? [], todayLocalDate, {
            value: score.value,
            band: score.band,
            ...(score.scoreVersion !== undefined
              ? { scoreVersion: score.scoreVersion }
              : {}),
            ...(score.composition !== undefined
              ? { composition: score.composition }
              : {}),
          })
        : null,
    },
    t,
  );

  annotate({
    action: { name: "daily.digest.build" },
    meta: {
      daily_digest_phase: digest.phase,
      daily_digest_sleep_pending: digest.sleepPending,
      daily_digest_item_count: digest.worthALook.length,
      daily_digest_has_score: digest.score !== null,
      daily_digest_has_checkin: digest.worthALook.some(
        (i) => i.kind === "coach_checkin",
      ),
      daily_digest_has_milestone: digest.worthALook.some(
        (i) => i.kind === "milestone",
      ),
      daily_digest_just_in_kind: digest.justIn?.kind ?? null,
      daily_digest_has_reaction_line: digest.reactionLine !== null,
    },
  });

  return digest;
}
