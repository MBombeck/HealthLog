/**
 * Achievements result builder.
 *
 * v1.18.1 — extracted out of `src/app/api/gamification/achievements/route.ts`
 * (a 1247-LOC API file with the whole aggregation inline). The route is now a
 * thin auth → gate → cached → apiSuccess shell; this module owns the
 * day-series / completion-date / streak plumbing and `buildAchievementsResult`.
 * Behaviour-preserving: every function moved verbatim.
 *
 * The builder returns the locale-agnostic web payload plus an internal
 * `pendingUnlocks` carrier the handler persists after the cache read (the write
 * stays OUT of the cached factory — see v1.18.0 B5 notes on the route).
 */
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/api-handler";
import type { ModuleKey } from "@/lib/modules/gate";
import {
  ACHIEVEMENT_DEFINITIONS,
  GAMIFICATION_ROLLOUT_AT,
  applyDiscoveryFilter,
  bridgeFrozenStreakGaps,
  calculateLongestStreak,
  evaluateAchievementsWithCompletionDates,
  moduleForMetric,
  type AchievementMetrics,
  type AchievementProgress,
} from "@/lib/gamification/achievements";
import {
  buildExpansionMetricValues,
  getEarnabilityFlags,
} from "@/lib/gamification/expansion-metrics";
import {
  getMissFreeDayKeys,
  getWeeklyConsistency,
} from "@/lib/gamification/care-metrics";
import {
  classifyBMI,
  classifyBP,
  classifyPulse,
} from "@/lib/analytics/classifications";
import { classifyIntakeTiming } from "@/lib/analytics/compliance";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE, userDayKey, validTimezoneOr } from "@/lib/tz/format";
import {
  TRACKED_INTAKE_EVENT_WHERE,
  TRACKED_INTAKE_WHERE,
} from "@/lib/medications/intake-tracking";

export type AuthedUser = Awaited<ReturnType<typeof requireAuth>>["user"];

export type AchievementsResult = Awaited<
  ReturnType<typeof buildAchievementsResult>
>;

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLING_WINDOW_DAYS = 30;

// v1.16.1 — weekly measurement-consistency badge: 4 consecutive weeks
// with at least 5 distinct active vitals days each. Mirrors the
// `measurement-weeks-4` definition's target.
const MEASUREMENT_CONSISTENCY_MIN_DAYS_PER_WEEK = 5;
const MEASUREMENT_CONSISTENCY_TARGET_WEEKS = 4;

type IntakeEventRecord = {
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  /** v1.16.1 — feeds the miss-free day streak. */
  autoMissed: boolean;
};

type MedicationScheduleRecord = {
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
};

/**
 * v1.28.25 — one SQL-aggregated vitals bucket: every non-deleted, non-import
 * row of `type` inside the badge-owner's LOCAL hour `hour` of day `dayKey`
 * (DATAINT M4 — was hardcoded Berlin; the query now binds the caller's own
 * `User.timezone`), folded to a row count + value sum by the database. The
 * vitals window is rollout-date → now and grows forever, and PULSE can be
 * per-sample heart rate (six figures on a long-tenured wearable account) —
 * reading raw rows here was the scale hazard. Every consumer's semantics
 * survive the fold: green-day classification needs the per-day per-type MEAN
 * (= Σsum / Σcount across the day's hour buckets — identical to the raw mean
 * up to floating-point summation order), the count badges need row counts,
 * the engagement / consistency series need day presence, and the hidden
 * night-owl / early-bird / leap-day tallies need per-hour row counts.
 */
type VitalsHourBucket = {
  type: "WEIGHT" | "BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA" | "PULSE";
  /** User-local YYYY-MM-DD. */
  dayKey: string;
  /** User-local hour 0–23. */
  hour: number;
  /** Number of raw rows folded into this bucket. */
  rowCount: number;
  /** Sum of the raw rows' values (feeds the per-day mean). */
  valueSum: number;
};

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

/**
 * v1.18.1 P4 — every local day key covered by an illness episode (onset day
 * through the resolved day, or through `now` while ongoing), inclusive on
 * both ends. These are the days a streak is allowed to lapse across without
 * breaking (the Rest Mode freeze). Uses the same `tz` day anchoring every
 * other streak series uses (DATAINT M4 — was hardcoded Berlin), so the
 * frozen days line up with the qualifying days exactly.
 */
function collectIllnessDayKeys(
  episodes: Array<{ onsetAt: Date; resolvedAt: Date | null }>,
  now: Date,
  tz: string,
): Set<string> {
  const frozen = new Set<string>();
  for (const ep of episodes) {
    const startSerial = dayKeyToSerial(userDayKey(ep.onsetAt, tz));
    const endSerial = dayKeyToSerial(userDayKey(ep.resolvedAt ?? now, tz));
    for (let serial = startSerial; serial <= endSerial; serial++) {
      frozen.add(serialToDayKey(serial));
    }
  }
  return frozen;
}

function dayKeyToSerial(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function serialToDayKey(serial: number): string {
  const date = new Date(serial * DAY_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayKeyToDate(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function findCountCompletionDate(dates: Date[], target: number): Date | null {
  if (dates.length < target) return null;
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  return sorted[target - 1] ?? null;
}

function findStreakCompletionDate(
  dayKeys: string[],
  target: number,
  firstDateByDay: Map<string, Date>,
): Date | null {
  if (dayKeys.length === 0) return null;

  let streak = 1;
  if (target === 1) {
    return firstDateByDay.get(dayKeys[0]) ?? null;
  }

  for (let i = 1; i < dayKeys.length; i++) {
    const previous = dayKeyToSerial(dayKeys[i - 1]);
    const current = dayKeyToSerial(dayKeys[i]);
    streak = current - previous === 1 ? streak + 1 : 1;

    if (streak >= target) {
      return firstDateByDay.get(dayKeys[i]) ?? null;
    }
  }

  return null;
}

function toDaySeries(dayKeys: string[]): {
  dayKeys: string[];
  firstDateByDay: Map<string, Date>;
} {
  const sortedKeys = [...new Set(dayKeys)].sort();
  const firstDateByDay = new Map<string, Date>(
    sortedKeys.map((key) => [key, dayKeyToDate(key)]),
  );

  return {
    dayKeys: sortedKeys,
    firstDateByDay,
  };
}

function getEventDaySeries(
  dates: Date[],
  tz: string,
): {
  dayKeys: string[];
  firstDateByDay: Map<string, Date>;
} {
  const firstDateByDay = new Map<string, Date>();

  for (const date of dates) {
    const dayKey = userDayKey(date, tz);
    const existing = firstDateByDay.get(dayKey);

    if (!existing || date < existing) {
      firstDateByDay.set(dayKey, date);
    }
  }

  return {
    dayKeys: Array.from(firstDateByDay.keys()).sort(),
    firstDateByDay,
  };
}

// v1.28.25 — consumes the SQL hour buckets instead of raw rows. The per-day
// per-type mean is Σ(valueSum) / Σ(rowCount) over the day's buckets — the
// same mean the raw-row version computed (up to floating-point summation
// order), feeding the identical classify → green-day → streak pipeline.
function getHealthGreenDaySeries(
  buckets: VitalsHourBucket[],
  heightCm: number | null,
) {
  type Acc = { sum: number; count: number };
  const dayStats = new Map<
    string,
    { weight: Acc; bpSys: Acc; bpDia: Acc; pulse: Acc }
  >();

  for (const b of buckets) {
    const slot = dayStats.get(b.dayKey) ?? {
      weight: { sum: 0, count: 0 },
      bpSys: { sum: 0, count: 0 },
      bpDia: { sum: 0, count: 0 },
      pulse: { sum: 0, count: 0 },
    };
    const acc =
      b.type === "WEIGHT"
        ? slot.weight
        : b.type === "BLOOD_PRESSURE_SYS"
          ? slot.bpSys
          : b.type === "BLOOD_PRESSURE_DIA"
            ? slot.bpDia
            : slot.pulse;
    acc.sum += b.valueSum;
    acc.count += b.rowCount;
    dayStats.set(b.dayKey, slot);
  }

  const bmiGreenDays: string[] = [];
  const bpGreenDays: string[] = [];
  const pulseGreenDays: string[] = [];

  for (const [dayKey, slot] of dayStats.entries()) {
    if (heightCm && slot.weight.count > 0) {
      const bmi = slot.weight.sum / slot.weight.count / (heightCm / 100) ** 2;
      if (classifyBMI(bmi).severity === "normal") {
        bmiGreenDays.push(dayKey);
      }
    }

    if (slot.bpSys.count > 0 && slot.bpDia.count > 0) {
      const bpClass = classifyBP(
        slot.bpSys.sum / slot.bpSys.count,
        slot.bpDia.sum / slot.bpDia.count,
      );
      if (bpClass.severity === "normal") {
        bpGreenDays.push(dayKey);
      }
    }

    if (slot.pulse.count > 0) {
      const pulseClass = classifyPulse(slot.pulse.sum / slot.pulse.count);
      if (pulseClass.severity === "normal") {
        pulseGreenDays.push(dayKey);
      }
    }
  }

  return {
    bmi: toDaySeries(bmiGreenDays),
    bp: toDaySeries(bpGreenDays),
    pulse: toDaySeries(pulseGreenDays),
  };
}

function getOnTimePerfectDaySeries(
  intakeEvents: IntakeEventRecord[],
  schedulesByMedicationId: Map<string, MedicationScheduleRecord[]>,
  tz: string,
) {
  const eventsByDay = new Map<string, IntakeEventRecord[]>();

  for (const event of intakeEvents) {
    // DATAINT M4 — was `toBerlinDayKey`; this function already threads `tz`
    // for the schedule-window classification below, but the day-BUCKETING
    // key itself was still hardcoded Berlin.
    const dayKey = userDayKey(event.scheduledFor, tz);
    const list = eventsByDay.get(dayKey) ?? [];
    list.push(event);
    eventsByDay.set(dayKey, list);
  }

  const perfectDays: string[] = [];

  for (const [dayKey, events] of eventsByDay.entries()) {
    if (events.length === 0) continue;

    let isPerfectDay = true;

    for (const event of events) {
      if (event.skipped || event.takenAt === null) {
        isPerfectDay = false;
        break;
      }

      const schedules = schedulesByMedicationId.get(event.medicationId) ?? [];
      if (schedules.length === 0) {
        continue;
      }

      // The scheduled minute-of-day must be read in the user's zone: the raw
      // `getUTCHours()` would push a non-UTC user's on-time dose past the 3h
      // grace and misread a genuinely-perfect day as imperfect.
      const scheduledWall = wallClockInTz(event.scheduledFor, tz);
      const eventMinutes = scheduledWall.hour * 60 + scheduledWall.minute;

      let bestSchedule = schedules[0];
      let bestDistance = Infinity;

      for (const schedule of schedules) {
        const [h, m] = schedule.windowStart.split(":").map(Number);
        const scheduleMinutes = h * 60 + m;
        const distance = Math.abs(eventMinutes - scheduleMinutes);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestSchedule = schedule;
        }
      }

      // Classify punctuality against the slot's real local day: pass the
      // canonical instant as the anchor and the user's zone so the window
      // `HH:mm` resolves to the correct local wall time, not 08:00 UTC.
      const timing = classifyIntakeTiming(
        event.takenAt,
        bestSchedule.windowStart,
        bestSchedule.windowEnd,
        event.scheduledFor,
        { tz },
      );

      // v1.4.34 IW-C — `early` is also a compliant bucket (dose taken
      // within the 3h pre-window grace), so it preserves a perfect day.
      if (timing !== "on_time" && timing !== "early") {
        isPerfectDay = false;
        break;
      }
    }

    if (isPerfectDay) {
      perfectDays.push(dayKey);
    }
  }

  return toDaySeries(perfectDays);
}

function parseDaysOfWeek(daysOfWeek: string | null): Set<number> | null {
  if (!daysOfWeek) return null;

  const values = daysOfWeek
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

  return values.length > 0 ? new Set(values) : null;
}

function getExpectedIntakesForDay(
  schedules: MedicationScheduleRecord[],
  dayKey: string,
): number {
  if (schedules.length === 0) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return 0;

  const day = dayKeyToDate(dayKey).getUTCDay();
  let expected = 0;

  for (const schedule of schedules) {
    const allowedDays = parseDaysOfWeek(schedule.daysOfWeek);
    if (!allowedDays || allowedDays.has(day)) {
      expected += 1;
    }
  }

  return expected;
}

function getIntakeIssueMetrics(
  intakeEvents: IntakeEventRecord[],
  schedulesByMedicationId: Map<string, MedicationScheduleRecord[]>,
  tz: string,
) {
  const skippedIntakeDates = intakeEvents
    .filter((event) => event.skipped)
    .map((event) => event.scheduledFor)
    .sort((a, b) => a.getTime() - b.getTime());

  const eventsByMedicationDay = new Map<
    string,
    Map<string, IntakeEventRecord[]>
  >();

  for (const event of intakeEvents) {
    if (!event.medicationId || Number.isNaN(event.scheduledFor.getTime())) {
      continue;
    }

    const dayKey = userDayKey(event.scheduledFor, tz);
    const byDay = eventsByMedicationDay.get(event.medicationId) ?? new Map();
    const list = byDay.get(dayKey) ?? [];
    list.push(event);
    byDay.set(dayKey, list);
    eventsByMedicationDay.set(event.medicationId, byDay);
  }

  let overIntakeCount = 0;
  const overIntakeDates: Date[] = [];

  for (const [medicationId, dayMap] of eventsByMedicationDay.entries()) {
    const schedules = schedulesByMedicationId.get(medicationId) ?? [];

    for (const [dayKey, events] of dayMap.entries()) {
      const expectedCount = getExpectedIntakesForDay(schedules, dayKey);

      if (expectedCount <= 0) {
        continue;
      }

      const takenEvents = events
        .filter((event) => !event.skipped && event.takenAt !== null)
        .sort((a, b) => {
          const aTime = (a.takenAt ?? a.scheduledFor).getTime();
          const bTime = (b.takenAt ?? b.scheduledFor).getTime();
          return aTime - bTime;
        });

      const excessCount = Math.max(0, takenEvents.length - expectedCount);
      if (excessCount === 0) {
        continue;
      }

      overIntakeCount += excessCount;

      for (
        let index = takenEvents.length - excessCount;
        index < takenEvents.length;
        index++
      ) {
        const event = takenEvents[index];
        if (!event) continue;
        overIntakeDates.push(event.takenAt ?? event.scheduledFor);
      }
    }
  }

  overIntakeDates.sort((a, b) => a.getTime() - b.getTime());

  return {
    skippedIntakeCount: skippedIntakeDates.length,
    skippedIntakeDates,
    overIntakeCount,
    overIntakeDates,
  };
}

function getCompliance80DaySeries(
  intakeEvents: IntakeEventRecord[],
  startDate: Date,
  endDate: Date,
  tz: string,
) {
  const perDayCounts = new Map<number, { logged: number; taken: number }>();

  for (const event of intakeEvents) {
    const serial = dayKeyToSerial(userDayKey(event.scheduledFor, tz));
    const current = perDayCounts.get(serial) ?? { logged: 0, taken: 0 };

    const logged = event.skipped || event.takenAt !== null;
    const taken = !event.skipped && event.takenAt !== null;

    if (logged) current.logged += 1;
    if (taken) current.taken += 1;

    perDayCounts.set(serial, current);
  }

  const startSerial = dayKeyToSerial(userDayKey(startDate, tz));
  const endSerial = dayKeyToSerial(userDayKey(endDate, tz));

  let rollingLogged = 0;
  let rollingTaken = 0;
  const greenDays: string[] = [];

  for (let serial = startSerial; serial <= endSerial; serial++) {
    const todayCounts = perDayCounts.get(serial);
    if (todayCounts) {
      rollingLogged += todayCounts.logged;
      rollingTaken += todayCounts.taken;
    }

    const outOfWindowCounts = perDayCounts.get(serial - ROLLING_WINDOW_DAYS);
    if (outOfWindowCounts) {
      rollingLogged -= outOfWindowCounts.logged;
      rollingTaken -= outOfWindowCounts.taken;
    }

    const hasFullWindow = serial >= startSerial + (ROLLING_WINDOW_DAYS - 1);
    if (!hasFullWindow || rollingLogged <= 0) continue;

    const compliance = Math.round((rollingTaken / rollingLogged) * 100);
    if (compliance >= 80) {
      greenDays.push(serialToDayKey(serial));
    }
  }

  return toDaySeries(greenDays);
}

/**
 * v1.4.34 IW-G — pulled out of the GET handler so `cached()` can wrap
 * the heavy aggregation. Returns the locale-agnostic web payload; the
 * iOS-format transform runs in the handler after the cache read.
 *
 * v1.18.0 B5 — this builder NO LONGER writes. It computes the not-yet-
 * persisted unlocks and returns them as `pendingUnlocks`; the handler
 * performs the idempotent `createMany({ skipDuplicates: true })` on every
 * request after the cache read. That keeps the persistence off the cached
 * path (a cache hit can't silently skip it, a concurrent miss can't
 * duplicate it) while the unique `(userId, achievementId)` makes a repeat
 * write a no-op.
 */
export async function buildAchievementsResult(
  user: AuthedUser,
  moduleMap: Record<ModuleKey, boolean>,
) {
  const now = new Date();
  const userId = user.id;
  const startDate = maxDate(user.createdAt, GAMIFICATION_ROLLOUT_AT);
  // v1.30 (DATAINT M4) — every day-key derivation below anchors on the
  // BADGE OWNER's own timezone, not a hardcoded Berlin default. Before this,
  // a non-CET user's evening entries could fold into the wrong calendar day
  // (or merge two real local days into one), silently breaking every
  // day-streak badge (login, entry, weekend, miss-free, sleep-log, on-time,
  // compliance-80) plus the hidden night-owl / early-bird / leap-day
  // triggers for every non-CET account.
  const tz = validTimezoneOr(user.timezone, DEFAULT_TIMEZONE);

  const [
    vitalsBuckets,
    intakeEvents,
    medications,
    passkeys,
    auditEvents,
    moodEntries,
    sleepMeasurements,
    healthProfile,
    illnessEpisodes,
  ] = await Promise.all([
    // v1.28.25 — vitals folded to (type, local day, local hour) buckets in
    // SQL instead of one row per sample. The window (rollout → now) grows
    // forever and PULSE can be per-sample heart rate, so the raw read ran to
    // six figures on long-tenured wearable accounts; the bucket set is
    // bounded by 4 types × 24 hours × window days and every downstream
    // metric derives exactly from (count, sum) per bucket — see the
    // `VitalsHourBucket` doc for the semantics argument. Filters mirror the
    // previous findMany exactly: the type allowlist is a closed literal set
    // (never user input), source ≠ IMPORT, and soft-deleted rows stay
    // excluded (v1.4.41 W-DELETED-2) so deleting a row immediately rolls
    // back any streak / count badge it earned. `AT TIME ZONE 'UTC' AT TIME
    // ZONE ${tz}` re-tags the naive UTC `measured_at` and converts it to the
    // BADGE OWNER's own wall clock (DATAINT M4 — was hardcoded
    // 'Europe/Berlin'; `tz` is bound as a query parameter, never spliced, and
    // is only ever a value `PUT /api/auth/me/timezone` already validated
    // against `Intl`'s IANA zone list before it reached the column).
    // Ordering pins day → hour → type for determinism.
    prisma.$queryRaw<VitalsHourBucket[]>`
      SELECT
        m."type"::text AS "type",
        to_char(
          (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tz},
          'YYYY-MM-DD'
        ) AS "dayKey",
        EXTRACT(
          HOUR FROM (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}
        )::int AS "hour",
        COUNT(*)::int AS "rowCount",
        SUM(m."value")::double precision AS "valueSum"
      FROM "measurements" m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${startDate}
        AND m."measured_at" <= ${now}
        AND m."source"::text <> 'IMPORT'
        AND m."type"::text IN ('WEIGHT', 'BLOOD_PRESSURE_SYS', 'BLOOD_PRESSURE_DIA', 'PULSE')
        AND m."deleted_at" IS NULL
      GROUP BY 1, 2, 3
      ORDER BY 2, 3, 1
    `,
    prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        // v1.7.0 sync — exclude tombstoned rows from streak counting.
        deletedAt: null,
        source: { not: "IMPORT" },
        scheduledFor: { gte: startDate, lte: now },
        // v1.39.1 (#1033) — doses of a medication with intake tracking off
        // count toward no streak or badge.
        ...TRACKED_INTAKE_EVENT_WHERE,
      },
      select: {
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
        // v1.16.1 — the miss-free streak disqualifies a day on any
        // auto-missed slot.
        autoMissed: true,
      },
    }),
    prisma.medication.findMany({
      where: { userId, ...TRACKED_INTAKE_WHERE },
      select: {
        id: true,
        schedules: {
          select: {
            windowStart: true,
            windowEnd: true,
            daysOfWeek: true,
          },
        },
      },
    }),
    prisma.passkey.findMany({
      where: {
        userId,
        createdAt: { gte: startDate, lte: now },
      },
      select: {
        createdAt: true,
      },
    }),
    prisma.auditLog.findMany({
      where: {
        userId,
        createdAt: { gte: startDate, lte: now },
        action: {
          in: [
            "auth.login.passkey",
            "auth.login.password",
            // v1.4.18 — hidden Easter-egg triggers
            "doctor-report.generate",
            "doctor-report.pdf.generate",
            "settings.locale.update",
          ],
        },
      },
      select: {
        action: true,
        createdAt: true,
      },
    }),
    // v1.4.18 — mood entries feed the new mood badges + the
    // entry-streak/consistent-month engagement metrics. Synced from
    // imported or entered directly; we intentionally include all
    // sources because consistency-of-tracking is what the badge
    // rewards.
    prisma.moodEntry.findMany({
      where: {
        userId,
        // v1.7.0 sync — exclude tombstoned rows from streak counting.
        deletedAt: null,
        moodLoggedAt: { gte: startDate, lte: now },
      },
      select: {
        date: true,
        score: true,
        moodLoggedAt: true,
      },
    }),
    // v1.16.1 — sleep samples feed the sleep-logging streak. Read
    // separately from the vitals query above so passive sleep syncs
    // never inflate the entry-day / consistent-month engagement
    // metrics, which reward ACTIVE tracking.
    prisma.measurement.findMany({
      where: {
        userId,
        measuredAt: { gte: startDate, lte: now },
        source: { not: "IMPORT" },
        type: "SLEEP_DURATION",
        deletedAt: null,
      },
      select: { measuredAt: true },
    }),
    // v1.16.1 — presence-only read of the self-context questionnaire
    // (nothing is decrypted) for the maintained-self-report badge.
    prisma.userHealthProfile.findUnique({
      where: { userId },
      select: {
        aboutMeEncrypted: true,
        conditionsEncrypted: true,
        allergiesEncrypted: true,
        coachFocusEncrypted: true,
        updatedAt: true,
      },
    }),
    // v1.18.1 P4 — illness episodes over the window, for the streak-freeze.
    // Gated on the illness module so a non-illness account does no read and
    // never freezes anything. Both ongoing and already-resolved episodes are
    // read: a past illness should not retroactively break a historical
    // streak, just as an active one should not break the current run.
    moduleMap.illness !== false
      ? prisma.illnessEpisode.findMany({
          where: {
            userId,
            deletedAt: null,
            onsetAt: { lte: now },
            OR: [{ resolvedAt: null }, { resolvedAt: { gte: startDate } }],
          },
          select: { onsetAt: true, resolvedAt: true },
        })
      : Promise.resolve([]),
  ]);

  // v1.18.1 P4 — Rest Mode streak-freeze. Build the set of local-day keys
  // covered by an illness episode (onset → resolved, or → now while
  // ongoing). A day-streak that lapses only across these days is bridged
  // rather than broken (see `bridgeFrozenStreakGaps`): being unwell pauses a
  // streak, it does not fail it.
  const frozenIllnessDayKeys = collectIllnessDayKeys(illnessEpisodes, now, tz);
  const freeze = (dayKeys: string[]): string[] =>
    bridgeFrozenStreakGaps(dayKeys, frozenIllnessDayKeys);

  const schedulesByMedicationId = new Map(
    medications.map((med) => [med.id, med.schedules]),
  );
  const intakeIssueMetrics = getIntakeIssueMetrics(
    intakeEvents,
    schedulesByMedicationId,
    tz,
  );

  const takenIntakeDates = intakeEvents
    .filter((event) => !event.skipped && event.takenAt !== null)
    .map((event) => event.takenAt as Date);
  const passkeyCreatedDates = passkeys.map((passkey) => passkey.createdAt);
  const passkeyLoginDates = auditEvents
    .filter((event) => event.action === "auth.login.passkey")
    .map((event) => event.createdAt);
  const passwordLoginDates = auditEvents
    .filter((event) => event.action === "auth.login.password")
    .map((event) => event.createdAt);
  const loginDaySeries = getEventDaySeries(
    [...passkeyLoginDates, ...passwordLoginDates],
    tz,
  );

  // v1.28.25 — the buckets already carry the local day-key + hour straight
  // from SQL (superseding the v1.18.11 Intl-once optimisation: no Intl pass
  // over the vitals remains at all). The parallel arrays thread into every
  // consumer exactly as the per-row keys did; day-presence consumers dedup
  // by key, so bucket-level duplicates (several hours / types on one day)
  // are harmless.
  const vitalsDayKeys = vitalsBuckets.map((b) => b.dayKey);
  const vitalsHours = vitalsBuckets.map((b) => b.hour);
  // Weighted records for the expansion metrics: one record per bucket,
  // `count` carrying the folded row multiplicity. The `measuredAt` anchor is
  // never read on this path (day-keys + hours ride the parallel arrays
  // above) — it only satisfies the record shape.
  const vitalsRecords = vitalsBuckets.map((b) => ({
    type: b.type,
    measuredAt: dayKeyToDate(b.dayKey),
    count: b.rowCount,
  }));

  const healthSeries = getHealthGreenDaySeries(vitalsBuckets, user.heightCm);
  const onTimeSeries = getOnTimePerfectDaySeries(
    intakeEvents,
    schedulesByMedicationId,
    tz,
  );
  const complianceSeries = getCompliance80DaySeries(
    intakeEvents,
    startDate,
    now,
    tz,
  );

  // v1.16.1 — care-routine series. Miss-free days and sleep-logging
  // days reuse the standard day-series plumbing; the weekly measurement
  // consistency folds distinct active vitals days into Monday-anchored
  // weeks (≥5 active days each, 4 consecutive weeks for the badge).
  const missFreeSeries = toDaySeries(getMissFreeDayKeys(intakeEvents, tz));
  const sleepSeries = getEventDaySeries(
    sleepMeasurements.map((m) => m.measuredAt),
    tz,
  );
  const weeklyConsistency = getWeeklyConsistency(
    // Bucket day-keys — `getWeeklyConsistency` dedups to distinct days, so
    // the per-hour multiplicity is irrelevant.
    vitalsDayKeys,
    MEASUREMENT_CONSISTENCY_MIN_DAYS_PER_WEEK,
    MEASUREMENT_CONSISTENCY_TARGET_WEEKS,
  );
  const selfContextComplete =
    healthProfile !== null &&
    healthProfile.aboutMeEncrypted !== null &&
    healthProfile.conditionsEncrypted !== null &&
    healthProfile.allergiesEncrypted !== null &&
    healthProfile.coachFocusEncrypted !== null
      ? 1
      : 0;

  const expansionValues = buildExpansionMetricValues({
    measurements: vitalsRecords,
    moodEntries,
    intakeEvents,
    auditEvents,
    // The SQL-derived local day-keys + hours ride in parallel to the
    // weighted bucket records — the expansion passes never touch a bucket's
    // representative `measuredAt`.
    measurementDayKeys: vitalsDayKeys,
    measurementHours: vitalsHours,
    tz,
  });
  const earnability = getEarnabilityFlags({
    hasMedication: medications.length > 0,
    moodEntryCount: expansionValues.moodEntryCount,
    measurementCounts: {
      weightCount: expansionValues.weightMeasurementCount,
      bpCount: expansionValues.bpMeasurementCount,
      pulseCount: expansionValues.pulseMeasurementCount,
    },
    sleepSampleCount: sleepMeasurements.length,
  });

  const metrics = {
    totalTakenIntakes: takenIntakeDates.length,
    overIntakeCount: intakeIssueMetrics.overIntakeCount,
    skippedIntakeCount: intakeIssueMetrics.skippedIntakeCount,
    // v1.18.1 P4 — every day-streak runs through `freeze(...)` so an active
    // or past illness episode bridges (does not break) the run across the
    // days the user was unwell.
    bmiGreenStreak: calculateLongestStreak(freeze(healthSeries.bmi.dayKeys)),
    bpGreenStreak: calculateLongestStreak(freeze(healthSeries.bp.dayKeys)),
    pulseGreenStreak: calculateLongestStreak(
      freeze(healthSeries.pulse.dayKeys),
    ),
    onTimePerfectDayStreak: calculateLongestStreak(
      freeze(onTimeSeries.dayKeys),
    ),
    compliance80DayStreak: calculateLongestStreak(
      freeze(complianceSeries.dayKeys),
    ),
    passkeyCreatedCount: passkeyCreatedDates.length,
    passkeyLoginCount: passkeyLoginDates.length,
    passwordLoginCount: passwordLoginDates.length,
    loginDayStreak: calculateLongestStreak(freeze(loginDaySeries.dayKeys)),
    ...expansionValues,
    // v1.16.1 — care-routine metrics.
    missFreeDayStreak: calculateLongestStreak(freeze(missFreeSeries.dayKeys)),
    measurementConsistencyWeeks: weeklyConsistency.longestRunWeeks,
    selfContextCompleteCount: selfContextComplete,
    sleepLogDayStreak: calculateLongestStreak(freeze(sleepSeries.dayKeys)),
  };

  const completionDates: Partial<Record<string, Date>> = {};

  for (const definition of ACHIEVEMENT_DEFINITIONS) {
    if (definition.metric === "totalTakenIntakes") {
      const completedAt = findCountCompletionDate(
        takenIntakeDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "passkeyCreatedCount") {
      const completedAt = findCountCompletionDate(
        passkeyCreatedDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "passkeyLoginCount") {
      const completedAt = findCountCompletionDate(
        passkeyLoginDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "passwordLoginCount") {
      const completedAt = findCountCompletionDate(
        passwordLoginDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "overIntakeCount") {
      const completedAt = findCountCompletionDate(
        intakeIssueMetrics.overIntakeDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "skippedIntakeCount") {
      const completedAt = findCountCompletionDate(
        intakeIssueMetrics.skippedIntakeDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "loginDayStreak") {
      const completedAt = findStreakCompletionDate(
        loginDaySeries.dayKeys,
        definition.target,
        loginDaySeries.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "bmiGreenStreak") {
      const completedAt = findStreakCompletionDate(
        healthSeries.bmi.dayKeys,
        definition.target,
        healthSeries.bmi.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "bpGreenStreak") {
      const completedAt = findStreakCompletionDate(
        healthSeries.bp.dayKeys,
        definition.target,
        healthSeries.bp.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "pulseGreenStreak") {
      const completedAt = findStreakCompletionDate(
        healthSeries.pulse.dayKeys,
        definition.target,
        healthSeries.pulse.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "onTimePerfectDayStreak") {
      const completedAt = findStreakCompletionDate(
        onTimeSeries.dayKeys,
        definition.target,
        onTimeSeries.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "compliance80DayStreak") {
      const completedAt = findStreakCompletionDate(
        complianceSeries.dayKeys,
        definition.target,
        complianceSeries.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    // ── v1.16.1 ─ care-routine completion dates ─────────────────────
    if (definition.metric === "missFreeDayStreak") {
      const completedAt = findStreakCompletionDate(
        missFreeSeries.dayKeys,
        definition.target,
        missFreeSeries.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "sleepLogDayStreak") {
      const completedAt = findStreakCompletionDate(
        sleepSeries.dayKeys,
        definition.target,
        sleepSeries.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "measurementConsistencyWeeks") {
      if (weeklyConsistency.completionDayKey) {
        completionDates[definition.id] = dayKeyToDate(
          weeklyConsistency.completionDayKey,
        );
      }
      continue;
    }

    if (definition.metric === "selfContextCompleteCount") {
      if (selfContextComplete === 1 && healthProfile) {
        completionDates[definition.id] = healthProfile.updatedAt;
      }
    }
  }

  // Load persisted achievements
  const persisted = await prisma.userAchievement.findMany({
    where: { userId },
    select: { achievementId: true, unlockedAt: true },
  });
  const persistedMap = new Map(
    persisted.map((p) => [p.achievementId, p.unlockedAt]),
  );

  // Merge: persisted dates take priority, then calculated dates
  for (const [id, date] of Object.entries(completionDates)) {
    if (!persistedMap.has(id) && date) {
      persistedMap.set(id, date);
    }
  }

  // Use persisted dates as the source of truth
  const mergedDates: Partial<Record<string, Date>> = {};
  for (const [id, date] of persistedMap) {
    mergedDates[id] = date;
  }

  const fullResult = evaluateAchievementsWithCompletionDates(
    metrics,
    mergedDates,
  );

  // v1.18.0 B5 — drop badges whose owning module is disabled BEFORE both
  // unlock-persistence and serialisation. A sleep badge must never unlock
  // (or render) while the sleep module is off; same for mood badges when
  // mood is off, etc. Core-domain and account-wide badges return a null
  // owner from `moduleForMetric` and always pass through.
  const moduleEnabledAchievements = fullResult.achievements.filter((a) => {
    const owner = moduleForMetric(a.metric);
    if (owner === null) return true;
    return moduleMap[owner as ModuleKey] !== false;
  });

  // v1.18.0 B5 — compute the newly unlocked rows here but DON'T write them
  // inside the cached factory: a write must not be a side effect of a
  // cached GET (a cache hit would silently skip it, a concurrent miss
  // could duplicate it). The handler performs the idempotent
  // `createMany({ skipDuplicates: true })` on every request after the
  // cache read, so the persistence runs regardless of cache outcome and
  // is safe to repeat.
  const pendingUnlocks: PendingUnlock[] = moduleEnabledAchievements
    .filter(
      (a) =>
        a.unlocked &&
        a.completedAt &&
        !persisted.some((p) => p.achievementId === a.id),
    )
    .map((a) => ({ achievementId: a.id, unlockedAt: a.completedAt! }));

  // v1.4.18 — apply the discovery filter so locked badges that the
  // user has *no path* to earn (e.g. mood badges for someone who has
  // never logged a mood entry) don't clutter the page. Hidden Easter-
  // eggs always pass through. Already-unlocked badges always pass
  // through (regression guard).
  const visibleAchievements = applyDiscoveryFilter(
    moduleEnabledAchievements,
    earnability,
  );

  // Recompute the summary so the headline counters reflect the
  // discovered set. Hidden achievements that are still locked are
  // counted toward `totalCount` so the user sees they exist.
  const visibleUnlocked = visibleAchievements.filter((a) => a.unlocked);
  const visibleEarned = visibleUnlocked.reduce((acc, a) => acc + a.points, 0);
  const visibleTotalPoints = visibleAchievements.reduce(
    (acc, a) => acc + a.points,
    0,
  );
  const nextAchievement =
    visibleAchievements
      .filter((a) => !a.unlocked && !a.isHidden)
      .sort((a, b) => b.progressPercent - a.progressPercent)[0] ?? null;

  // v1.4.18 reconcile — redact hidden+locked entries before serialising
  // so a curious user opening DevTools/Network can't read the trigger
  // semantics from `metric`, `titleKey`, `descriptionKey`, `icon`,
  // `target`, `current`, or `progressPercent`. The DOM render path
  // already short-circuits on `isHidden && !unlocked`; this closes the
  // wire-shape leak. Once an Easter-egg unlocks, the real fields ship
  // (the unlock IS the moment to reveal the surprise).
  const redactedAchievements = visibleAchievements.map((a) =>
    redactIfHiddenLocked(a),
  );
  const redactedNextAchievement = nextAchievement
    ? redactIfHiddenLocked(nextAchievement)
    : null;
  const redactedMetrics = redactHiddenMetrics(
    fullResult.metrics,
    visibleAchievements,
  );

  const result = {
    summary: {
      unlockedCount: visibleUnlocked.length,
      totalCount: visibleAchievements.length,
      earnedPoints: visibleEarned,
      totalPoints: visibleTotalPoints,
      completionPercent:
        visibleAchievements.length === 0
          ? 100
          : Math.round(
              (visibleUnlocked.length / visibleAchievements.length) * 100,
            ),
      nextAchievement: redactedNextAchievement,
    },
    achievements: redactedAchievements,
    metrics: redactedMetrics,
    // v1.18.0 B5 — carried out of the cached factory so the handler can
    // persist them on every read (idempotent), not as a write side effect
    // that a cache hit would skip. NOT part of the serialised payload.
    pendingUnlocks,
  };

  return result;
}

/** v1.18.0 B5 — a not-yet-persisted unlock the handler writes after the cache read. */
interface PendingUnlock {
  achievementId: string;
  unlockedAt: string;
}

/**
 * Hidden Easter-eggs ship to the client *only* as opaque cards while
 * locked. Returning the full `AchievementProgress` shape would let a
 * snooper read the trigger semantics from `metric`, `titleKey`, etc.
 * This helper projects locked+hidden entries down to the safe shape
 * the UI's opaque-placeholder branch needs.
 *
 * Unlocked hidden achievements pass through unchanged — the unlock IS
 * the reveal moment, so the toast and the unlocked card show the real
 * strings.
 */
function redactIfHiddenLocked(
  achievement: AchievementProgress,
): AchievementProgress {
  if (!achievement.isHidden || achievement.unlocked) return achievement;
  return {
    id: achievement.id,
    metric: "totalTakenIntakes",
    category: "hidden",
    titleKey: "achievements.hiddenCard.title",
    descriptionKey: "achievements.hiddenCard.description",
    icon: "HelpCircle",
    format: "count",
    target: 0,
    current: 0,
    points: achievement.points,
    unlocked: false,
    progressPercent: 0,
    completedAt: null,
    isHidden: true,
  };
}

/**
 * Drop hidden-only metric counters from the response `metrics` block
 * unless any hidden achievement they back is unlocked. The DOM never
 * reads these counters today — the only consumer is the iOS client's
 * progress bar — so removing the hidden ones from the wire is a pure
 * spoiler shield with zero UI impact.
 */
function redactHiddenMetrics(
  metrics: AchievementMetrics,
  achievements: AchievementProgress[],
): Partial<AchievementMetrics> {
  const HIDDEN_METRIC_KEYS = [
    "nightOwlCount",
    "earlyBirdCount",
    "leapDayCount",
    "doctorPdfCount",
    "localeFlipCount",
  ] as const;
  const safe: Partial<AchievementMetrics> = { ...metrics };
  for (const key of HIDDEN_METRIC_KEYS) {
    const backing = achievements.find(
      (a) => a.isHidden && a.metric === key && a.unlocked,
    );
    if (!backing) {
      delete safe[key];
    }
  }
  return safe;
}
