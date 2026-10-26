/**
 * The body of `GET /api/dashboard/summary`, built on a cache miss: greeting,
 * intake-day streak, today's medication compliance, and the metric cards
 * with latest value, sparkline, trend and verdict, plus the sleep rhythm.
 *
 * Every per-type read is bounded (see `@/lib/dashboard/summary-reads`): one
 * row per type for the latest reading, at most `SPARK_DAYS` DAY-rollup
 * buckets per type for the sparkline, the all-time counts from the DAY
 * rollups, and the set of local day keys with activity in the streak window.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { type Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { userDayKey } from "@/lib/tz/resolver";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import { buildMedsTodayBlock } from "@/lib/dashboard/meds-today";
import { computeStreak } from "@/lib/dashboard/streak";
import {
  readActivityDayKeys,
  readAllTimeCounts,
  readLatestEver,
  readSparkBuckets,
} from "@/lib/dashboard/summary-reads";
import {
  summarizeSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { loadBaselineProfile } from "@/lib/insights/derived/baseline";
import { computeBmi } from "@/lib/insights/derived/bmi";
import { isDerivedOk } from "@/lib/insights/derived/types";
import { buildMoodDailySeries } from "@/lib/analytics/mood-series";
import { loadFreeWeekdaySpans } from "@/lib/profile/life-circumstances";
import {
  reconstructNights,
  sleepNeedMinutes,
} from "@/lib/insights/derived/sleep-score";
import {
  computeSleepRhythmFromNights,
  type SleepRhythmDto,
} from "@/lib/insights/derived/sleep-rhythm";

import { plainCard, SPARK_DAYS, withVerdicts, type MetricCard } from "./cards";
import { summaryLookups, type SummaryLookups } from "./lookups";
import { measurementCards } from "./measurement-cards";

const STREAK_WINDOW_DAYS = 365;

export interface SummaryBuilderContext {
  greetingName: string;
  locale: Locale;
}

export async function buildSummaryContext(user: {
  displayName: string | null;
  username: string;
  locale: string | null;
}): Promise<SummaryBuilderContext> {
  const greetingName = user.displayName ?? user.username;
  // The greeting salutation and the streak label are the two strings this
  // route still translates server-side, and the native client is its only
  // caller: a Bearer request carries no locale cookie and no meaningful
  // Accept-Language, so the stored column is the only per-user signal. That
  // is exactly the shape `resolveJobLocale` exists for: stored user locale,
  // then the operator's configured default, then English.
  const locale: Locale = await resolveJobLocale(user.locale);
  return { greetingName, locale };
}

/**
 * Mood is the one metric on this payload that is not a `Measurement`. The
 * daily series is the canonical `buildMoodDailySeries` output (rollup
 * fast-path, 1..5 scale, one entry per day with an average score), the same
 * series the web mood analytics and the dashboard snapshot render. Emitted
 * only when the account has ever logged a mood.
 */
function moodCard(
  moodSeries: Awaited<ReturnType<typeof buildMoodDailySeries>>,
  userTz: string,
): MetricCard | null {
  if (moodSeries.entryCount === 0) return null;
  const spark = moodSeries.entries.slice(-SPARK_DAYS).map((e) => e.score);
  const latestEntry = moodSeries.entries[moodSeries.entries.length - 1];
  // The series carries the user's LOCAL day keys (`MoodEntry.date`), not
  // timestamps, so the only honest instant is the first instant of that day
  // in the user's zone. Writing the key as `T00:00Z` instead put the instant
  // on the previous calendar day for anyone west of UTC.
  const latestAt = latestEntry
    ? startOfLocalDayKey(latestEntry.date, userTz).toISOString()
    : null;
  return plainCard("mood", "mood", {
    latestValue: latestEntry?.score ?? null,
    spark,
    updatedAt: latestAt,
    allTimeCount: moodSeries.entryCount,
    lastSeenAt: latestAt,
  });
}

/**
 * BMI, derived from the latest weight at the profile height by
 * `computeBmi`, the single implementation the web vitals dashboard also
 * renders. Omitted when the derivation is insufficient (no height on the
 * profile, or no weight inside its window): the card shape has no "unknown"
 * state to express honestly, and a card with a null value would read as a
 * logging gap rather than a missing profile field.
 */
function bmiCard(
  bmiDerived: Awaited<ReturnType<typeof computeBmi>>,
  lookups: SummaryLookups,
): MetricCard | null {
  if (!isDerivedOk(bmiDerived)) return null;
  const spark = bmiDerived.value.series.slice(-SPARK_DAYS);
  // BMI moves exactly when weight does, so the weight metadata is the honest
  // recency signal: there is no separate BMI reading.
  return plainCard("bmi", "bmi", {
    latestValue: bmiDerived.value.bmi,
    spark,
    updatedAt: lookups.metaForType("WEIGHT").lastSeenAt,
    allTimeCount: lookups.metaForType("WEIGHT").allTimeCount,
    lastSeenAt: lookups.metaForType("WEIGHT").lastSeenAt,
  });
}

type Timed = <T>(label: string, builder: () => Promise<T>) => Promise<T>;

/** The summary's reads, in their three rounds, each timed under its label. */
async function readSummaryInputs(
  userId: string,
  userTz: string,
  now: Date,
  time: Timed,
) {
  // The latest-reading and sparkline reads take the most recent N rows per
  // type regardless of age; only the streak window anchors on a calendar
  // slice.
  const streakWindowStart = new Date(
    now.getTime() - STREAK_WINDOW_DAYS * 86_400_000,
  );
  // Derived from the canonical enum so a new measurement type is
  // auto-included. The card builders decide which types render as cards.
  const measurementTypes = [
    ...measurementTypeEnum.options,
  ] as MeasurementType[];

  const [
    latestEver,
    sparkBuckets,
    allTimeAggregate,
    medsToday,
    streakActivity,
    measurementStreakDays,
    sleepStageRows,
  ] = await Promise.all([
    // Both reads live in `@/lib/dashboard/summary-reads`: the SQL is a
    // contract the integration suite exercises directly against Postgres,
    // and each carries the reason it names the type list at its definition.
    // Short version: PostgreSQL 16 has no index skip scan, so "one row per
    // type" has to be driven FROM the type list or it degrades to a full
    // pass over the account.
    time("latestEver", () => readLatestEver(prisma, userId, measurementTypes)),
    time("sparkline", () =>
      readSparkBuckets(prisma, userId, measurementTypes, SPARK_DAYS),
    ),
    // Counted from the DAY rollups where they cover the days, not by one
    // index entry per reading (see `readAllTimeCounts`).
    time("allTime", () =>
      readAllTimeCounts(prisma, userId, measurementTypes, now),
    ),
    // The shared `buildMedsTodayBlock` runs the same idempotent projection
    // the intake route runs (`skipDuplicates: true` so a concurrent
    // intake-route hit can't race a duplicate row in) before its
    // today-window tally, so this route and the dashboard snapshot count the
    // identical row set. Daily schedules have no row to read until the
    // projection writes one.
    time("medsToday", () => buildMedsTodayBlock(prisma, userId, userTz, now)),
    time("streakIntakes", () =>
      prisma.medicationIntakeEvent.findMany({
        where: {
          userId,
          // Tombstoned rows do not count towards a streak.
          deletedAt: null,
          scheduledFor: { gte: streakWindowStart },
          OR: [{ takenAt: { not: null } }, { skipped: true }],
        },
        select: { takenAt: true, scheduledFor: true },
      }),
    ),
    time("streakDays", () =>
      readActivityDayKeys(prisma, userId, userTz, streakWindowStart, now),
    ),
    // Raw per-stage SLEEP_DURATION rows for the night-total tile.
    // `SLEEP_DURATION` is stored one row per STAGE per night (minutes), so
    // the single most recent row (the `latestEver` path) is just ONE stage,
    // not the night. Bounded to the streak window (about a year of ~5
    // rows/night); the headline only needs the most recent night but the
    // window also feeds the sparkline night totals.
    time("sleepNights", () =>
      prisma.measurement.findMany({
        where: {
          userId,
          type: "SLEEP_DURATION",
          deletedAt: null,
          measuredAt: { gte: streakWindowStart },
        },
        orderBy: { measuredAt: "asc" },
        // Writer-level collapse: two HealthKit apps behind one source
        // (watch stages vs phone in-bed) must not blend into one night.
        select: {
          value: true,
          measuredAt: true,
          sleepStage: true,
          source: true,
          deviceType: true,
        },
      }),
    ),
  ]);

  // The user's sleep source-priority ladder collapses a dual-source night
  // (e.g. WHOOP + Apple Health) to one canonical source before the per-night
  // reconstruction sums it. The baseline profile rides along (one read) so
  // the sleep-rhythm block resolves the age-based sleep need.
  const [sleepPriorityJson, sleepProfile, moodSeries] = await Promise.all([
    loadUserSourcePriority(userId),
    loadBaselineProfile(prisma, userId),
    // The mood card reads the SAME canonical daily series the web mood
    // analytics and the dashboard snapshot read, rollup fast-path included:
    // never a second aggregation.
    time("moodSeries", () => buildMoodDailySeries(userId, prisma)),
  ]);

  // BMI is derived, not measured: it needs the profile height loaded above,
  // so it cannot join the round before it.
  const bmiDerived = await time("bmi", () =>
    computeBmi(userId, sleepProfile, { now }),
  );

  return {
    latestEver,
    sparkBuckets,
    allTimeAggregate,
    medsToday,
    streakActivity,
    measurementStreakDays,
    sleepStageRows,
    sleepPriorityJson,
    sleepProfile,
    moodSeries,
    bmiDerived,
  };
}

export async function buildDashboardSummary(
  userId: string,
  userTz: string,
  ctx: SummaryBuilderContext,
) {
  const now = new Date();
  // Per-sub-query wall-clock timing, reported under
  // `meta.dashboard.sub_*_ms` so a regression can be attributed to a
  // specific sub-query without re-instrumenting the route. Captured on the
  // cache-miss path only; a cache hit skips this whole builder.
  const timings: Record<string, number> = {};
  const time = async <T>(
    label: string,
    builder: () => Promise<T>,
  ): Promise<T> => {
    const t0 = Date.now();
    const result = await builder();
    timings[`dashboard.sub_${label}_ms`] = Date.now() - t0;
    return result;
  };

  const {
    latestEver,
    sparkBuckets,
    allTimeAggregate,
    medsToday,
    streakActivity,
    measurementStreakDays,
    sleepStageRows,
    sleepPriorityJson,
    sleepProfile,
    moodSeries,
    bmiDerived,
  } = await readSummaryInputs(userId, userTz, now, time);

  const lookups = summaryLookups({
    latestEver,
    sparkBuckets,
    allTimeAggregate,
  });

  // The activity-day set from the bounded streak reads. The measurement
  // side arrives as local YYYY-MM-DD keys, the same keys
  // `userDayKey(measuredAt, userTz)` produces for the intakes.
  const activityDays = new Set<string>(measurementStreakDays);
  for (const e of streakActivity) {
    activityDays.add(userDayKey(e.takenAt ?? e.scheduledFor, userTz));
  }
  const streak = computeStreak(activityDays, userTz);

  const sleepRows = sleepStageRows as SleepStageRow[];
  const sleepSummary = summarizeSleepNights(
    sleepRows,
    userTz,
    sleepPriorityJson,
  );

  // Server-authoritative sleep-rhythm DTO (sleep debt + chronotype) off the
  // SAME canonical reconstruction the Sleep page + Sleep Score read, so iOS
  // renders identical values. Both signals carry a calm partial / learning
  // state below their night thresholds, never an assertion off thin data.
  const sleepRhythm: SleepRhythmDto = computeSleepRhythmFromNights(
    reconstructNights(sleepRows, userTz, sleepPriorityJson),
    sleepNeedMinutes(sleepProfile.ageYears),
    "COMPUTED",
    await loadFreeWeekdaySpans(userId),
  );

  const metrics = measurementCards(lookups, {
    summary: sleepSummary,
    rows: sleepRows,
    tz: userTz,
    priorityJson: sleepPriorityJson,
  });
  const mood = moodCard(moodSeries, userTz);
  if (mood) metrics.push(mood);
  const bmi = bmiCard(bmiDerived, lookups);
  if (bmi) metrics.push(bmi);

  const t = getServerTranslator(ctx.locale).t;

  // The record's profile and own targets, for the card verdicts.
  const verdictProfile = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dateOfBirth: true,
      gender: true,
      heightCm: true,
      thresholdsJson: true,
    },
  });

  annotate({ meta: timings });

  return {
    greeting: {
      salutation: t("dashboard.greetingSalutation", { name: ctx.greetingName }),
      date: now.toISOString(),
    },
    streak: {
      currentDays: streak.currentDays,
      longest: streak.longest,
      label: t("dashboard.streakLabel"),
    },
    // The shared builder carries the exact tally semantics this tile always
    // had (scheduled = every today-window row; taken = `takenAt` set and not
    // skipped). The wire shape of `compliance` is locked for iOS.
    compliance: {
      scheduledToday: medsToday.scheduledToday,
      takenToday: medsToday.takenToday,
    },
    highlightInsight: null,
    metrics: withVerdicts(metrics, {
      profile: {
        dateOfBirth: verdictProfile?.dateOfBirth ?? null,
        gender: verdictProfile?.gender ?? null,
        heightCm: verdictProfile?.heightCm ?? null,
      },
      thresholdsJson: verdictProfile?.thresholdsJson ?? null,
    }),
    // Sleep debt + chronotype, server-authoritative. Same values the Sleep
    // page's `/api/sleep/rhythm` read returns.
    sleepRhythm,
    lastUpdated: now.toISOString(),
  };
}
