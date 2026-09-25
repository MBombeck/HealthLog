import { prisma } from "@/lib/db";
import { probeProviderPresence } from "@/lib/ai/provider";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { apiError, apiSuccess } from "@/lib/api-response";
import type { DataPoint, DataSummary } from "@/lib/analytics/trends";
import { summarize } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { computeBpInTargetPct } from "@/lib/analytics/bp-in-target";
import {
  classifyBMI,
  classifyBP,
  generateAlerts,
} from "@/lib/analytics/classifications";
import {
  pearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  expectsDoses,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import { getMedicationCategories } from "@/lib/medication-category";
import { resolveRestingPulseSeries } from "@/lib/analytics/resting-pulse";
import {
  apiHandler,
  requireRecordAuth,
  type AuthContext,
} from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import {
  cachedSwrWithMeta,
  caches,
  type ServerCache,
} from "@/lib/cache/server-cache";
import { buildComprehensiveAggregate } from "@/lib/insights/comprehensive-aggregator";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";
import { userDayKey } from "@/lib/tz/format";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");
  // v1.15.20 — shared analytics-read budget (generous; caps runaway loops).
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  // No AI gate, and no `insights` module gate (that module is the AI
  // analysis opt-out). Every field is computed from the record (the provider
  // chain is only probed for presence, for `hasProvider`), and this is the
  // main read of the Insights overview: switching AI off, or never setting a
  // provider up, still gets the overview. The `ai` block beside the body says
  // whether the briefing and status notes that decorate the overview can be
  // shown, resolved per request and never cached with the body.

  // v1.4.35 — read-through the analytics cache keyed on
  // (userId, "comprehensive"). The /insights page mount routinely
  // fans out to this endpoint alongside the Coach drawer + the
  // recommendations grid; the 60s TTL converts every duplicate
  // mount within the window to a Map lookup. Invalidation is handled
  // by `invalidateUserMeasurements`, which marks every key under the
  // `${userId}|` prefix stale (see `lib/cache/invalidate.ts`).
  //
  // v1.16.7 — stale-while-revalidate. This is the single heaviest
  // SQL-side aggregation on the /insights mount; serving the prior
  // body instantly while ONE background recompute refreshes it keeps
  // the page interactive across the bucket's 10-minute stale window
  // (a measurement sync used to bust the entry into a blocking cold
  // rebuild on the very next mount, all day). The truly-cold first
  // read of the day still computes inline — there is no prior body to
  // serve — but it no longer recurs per visit.
  //
  // The `revalidating` flag marks a stale-served body honestly so the
  // client can poll (bounded) until the background rebuild lands —
  // mirroring the `/api/insights/generate` GET contract. It rides on
  // the response, never inside the cached body, so a warmed entry
  // doesn't freeze the flag.
  const { value: body, outcome } = await cachedSwrWithMeta(
    caches.analytics as ServerCache<
      Awaited<ReturnType<typeof buildComprehensiveResponse>>
    >,
    `${user.id}|comprehensive`,
    () => buildComprehensiveResponse(user),
    annotate,
  );

  const [briefing, statusText] = await Promise.all([
    aiCapabilityToServe(user.id, "briefing"),
    aiCapabilityToServe(user.id, "statusText"),
  ]);

  return apiSuccess({
    ...body,
    revalidating: outcome === "stale",
    ai: { briefing, statusText },
  });
});

type AuthedUser = AuthContext["user"];

/**
 * v1.4.35 — comprehensive insights response body, lifted out of the
 * route handler so `cached()` can wrap it. Replaces the previous
 * 100k-row-in-JS aggregation with SQL-side aggregates served by
 * `buildComprehensiveAggregate`. The medication-compliance block keeps
 * its bounded Prisma reads (medications + intake events) — the directive
 * called those out as already on the safe path. The byte-shape of the
 * returned envelope is unchanged from the legacy route.
 */
export async function buildComprehensiveResponse(user: AuthedUser) {
  const userId = user.id;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  // v1.30.3 (QA F8) — the one shared per-user tz for every day-bucketing
  // pass in this route (resting-pulse proxy, medication-continuity, BP
  // pairing). Was previously re-derived ad hoc (or hardcoded UTC) at each
  // call site.
  const userTz = user.timezone || "Europe/Berlin";

  // Fetch user profile (height + DOB drive BMI + BP targets).
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
    },
  });

  // ── Aggregate-first reads ─────────────────────────────────
  // SQL-side rollup replaces the 100k-row findMany on the legacy
  // route. Returns per-type DataSummary identical to the JS
  // `summarize()` semantics over the 90-day window, plus the bounded
  // raw rows the BP target adherence pairing needs, plus daily-mean
  // buckets for the correlation pairings.
  const aggregate = await buildComprehensiveAggregate(userId);

  // v1.4.40 — swap the 90-day unbounded `prisma.moodEntry.findMany`
  // for the persistent mood-rollup DAY tier (audit Critical Finding
  // #2). The two consumers downstream — `dailyMoodEntries` for the
  // mood × metric correlations and `moodSummary` for the dashboard
  // mood block — read at a per-day resolution, which is precisely the
  // shape the rollup writer emits.
  //
  // Coverage-fallback: when the user has mood entries but zero rollup
  // rows yet (legacy account before the boot-time backfill has caught
  // up), fall back to a bounded 90-day raw walk once and fire the
  // warm-up so the next request lands on the rollup tier. Same posture
  // as `/api/mood/analytics`.
  //
  // Since v1.32.12 the mood rollup writer mints `bucketStart` from the
  // canonical local `MoodEntry.date` label at UTC midnight, so
  // `.toISOString().slice(0, 10)` recovers the user's LOCAL calendar day —
  // byte-identical to the live fallback's `entry.date`. Both mood paths
  // therefore emit local-day keys. The mood × metric pairing partners
  // below (sys BP, weight, resting pulse) are consequently derived in the
  // user's tz (v1.32.17) so both join sides share ONE local-day key space.
  // The measurement-rollup tier itself still buckets UTC (`dailyByType`)
  // and migrates to local in a documented follow-up release; the two
  // internally-consistent UTC joins (weight × BP, BP-med continuity) are
  // left on it deliberately (see their call sites below).
  void ensureUserMoodRollupsFresh(userId);
  const moodRollupDayRows = await readMoodDayRollups(userId, ninetyDaysAgo);
  let dailyMoodEntries: Array<{ day: string; value: number }>;
  let moodDataPoints: DataPoint[];
  let moodEntryCount: number;
  if (moodRollupDayRows.length > 0) {
    dailyMoodEntries = moodRollupDayRows.map((r) => ({
      day: r.bucketStart.toISOString().slice(0, 10),
      value: Math.round(r.mean * 100) / 100,
    }));
    moodDataPoints = moodRollupDayRows.map((r) => ({
      date: r.bucketStart,
      value: r.mean,
    }));
    moodEntryCount = moodRollupDayRows.reduce((s, r) => s + r.count, 0);
  } else {
    // Coverage-fallback: legacy account with mood entries but no
    // rollup coverage yet. Bounded by the 90-day window so the walk is
    // capped even when the rollup miss happens.
    const moodEntries = await prisma.moodEntry.findMany({
      // v1.7.0 sync — exclude tombstoned rows.
      where: { userId, deletedAt: null, moodLoggedAt: { gte: ninetyDaysAgo } },
      orderBy: { moodLoggedAt: "asc" },
      select: { date: true, score: true, moodLoggedAt: true },
    });
    const moodByDay = new Map<string, { sum: number; count: number }>();
    for (const entry of moodEntries) {
      const current = moodByDay.get(entry.date) ?? { sum: 0, count: 0 };
      current.sum += entry.score;
      current.count += 1;
      moodByDay.set(entry.date, current);
    }
    dailyMoodEntries = Array.from(moodByDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, stats]) => ({
        day,
        value: Math.round((stats.sum / stats.count) * 100) / 100,
      }));
    // Feed per-day means into `summarize()` so the live-fallback path
    // shares the rollup-tier semantic (one DataPoint per day, the
    // daily mean) — mirrors the v1.4.39 mood/analytics QA UX-H1 fix.
    moodDataPoints = dailyMoodEntries.map((e) => ({
      date: new Date(`${e.day}T12:00:00.000Z`),
      value: e.value,
    }));
    moodEntryCount = moodEntries.length;
  }

  const moodSummary =
    moodDataPoints.length > 0 ? summarize(moodDataPoints) : null;

  const summaries: Record<string, DataSummary> = aggregate.summaries;

  // ── BMI ──────────────────────────────────────────────────
  let bmi: number | null = null;
  let bmiClassification = null;
  if (dbUser?.heightCm && summaries.WEIGHT?.latest) {
    const heightM = dbUser.heightCm / 100;
    bmi = Math.round((summaries.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
    bmiClassification = classifyBMI(bmi);
  }

  // ── BP classification (30-day average) ────────────────────
  let bpClassification = null;
  const bpTargets = getBpTargets(dbUser?.dateOfBirth ?? null);
  if (
    summaries.BLOOD_PRESSURE_SYS?.avg30 &&
    summaries.BLOOD_PRESSURE_DIA?.avg30
  ) {
    bpClassification = classifyBP(
      summaries.BLOOD_PRESSURE_SYS.avg30,
      summaries.BLOOD_PRESSURE_DIA.avg30,
    );
  }

  // ── BP target adherence (trailing 90 days) ───────────────
  // Route through the canonical `computeBpInTargetPct` so this figure
  // shares ONE definition with the dashboard tile, the insight cards, the
  // AI snapshot and the targets endpoint (per the bp-in-target.ts
  // contract — the inline copy that used to live here drifted: it paired
  // sys+dia on the 5-minute window ONLY, dropping readings whose sys/dia
  // timestamps drift past 5 min on Withings / Apple-Health imports, which
  // skewed the share iOS renders on the Home Health Score). The helper
  // adds the same-local-day pairing fallback (v1.30.3 QA F7 — keyed on
  // the user's OWN tz, not a hardcoded Berlin day) so those readings
  // pair, and keeps the ESH-2023 band + 90/50 hypotension floor (both sys
  // AND dia at or below the age-band ceiling). Window is the aggregator's
  // 90-day raw pull — a "recent control" figure, not the all-time headline.
  let bpPctInTarget: number | null = null;
  if (bpTargets) {
    bpPctInTarget =
      computeBpInTargetPct(
        aggregate.bpRawRows.sys,
        aggregate.bpRawRows.dia,
        bpTargets,
        userTz,
      )?.pct ?? null;
  }

  // ── Correlations: weight × Sys BP ─────────────────────────
  // Daily-key pairing (the legacy `pairByTimestamp` ran with a
  // 24-hour default tolerance — daily-mean buckets are the
  // SQL-side equivalent and the directive explicitly accepts the
  // small semantic shift to bound the raw-row footprint).
  //
  // v1.32.17 — this pair stays on the UTC `dailyByType` series: BOTH
  // sides come from `dailyByType` (weight × sys), so they share one UTC
  // day-key space and are internally consistent. Re-keying it to local
  // is R12's read-swap (it migrates with the rollup tier), NOT this
  // hotfix — doing it here would mean per-request raw re-aggregation
  // without the local-bucketed rollup behind it.
  const weightDaily = aggregate.dailyByType.WEIGHT ?? [];
  const sysDaily = aggregate.dailyByType.BLOOD_PRESSURE_SYS ?? [];
  const weightBpPairs: PairedPoint[] = joinDailyByDay(weightDaily, sysDaily);
  const weightBpCorrelation = pearsonCorrelation(weightBpPairs);
  const scatterData = weightBpPairs.map((p) => ({
    weight: p.a,
    sysBP: p.b,
  }));

  // ── Correlations: mood × {sys BP, weight, pulse} ─────────
  // v1.32.17 — the mood series is LOCAL-day-keyed (since v1.32.12, see the
  // rollup note above). `pairMoodWithDaily` joins on an EXACT YYYY-MM-DD
  // key, so the metric partners MUST also be local-day-keyed or every
  // evening logger west of UTC gets a lag-1 pairing sold as same-day.
  // Derive the sys / weight partners as exact local-day means from the raw
  // rows already on the request path (canonical-source deduped in the
  // aggregator), NOT from the UTC `dailyByType` — a UTC-day MEAN cannot be
  // relabeled into a local-day mean. `round2` mirrors the aggregator's
  // `ROUND(AVG, 2)` so correlation thresholds don't drift.
  const sysDailyLocal = deriveDailyLocalMeans(aggregate.bpRawRows.sys, userTz);
  const weightDailyLocal = deriveDailyLocalMeans(
    aggregate.weightRawRows,
    userTz,
  );

  const moodBpPairs = pairMoodWithDaily(dailyMoodEntries, sysDailyLocal);
  const moodBpCorrelation = pearsonCorrelation(moodBpPairs);
  const moodBpScatterData = moodBpPairs.map((p) => ({ mood: p.a, sysBP: p.b }));

  const moodWeightPairs = pairMoodWithDaily(dailyMoodEntries, weightDailyLocal);
  const moodWeightCorrelation = pearsonCorrelation(moodWeightPairs);
  const moodWeightScatterData = moodWeightPairs.map((p) => ({
    mood: p.a,
    weight: p.b,
  }));

  // v1.2.5 (M-CS2) — this correlation is labelled "Resting pulse (bpm)";
  // score it against the RESTING series, not the raw PULSE day-mean. The
  // aggregator's `dailyByType.PULSE` is a per-day AVG that folds in workout
  // HR for Apple-Health users and inflates the "resting" figure. Prefer the
  // clean RESTING_HEART_RATE rows; only pull RAW PULSE (for the
  // low-percentile daily proxy) when the user has no resting rows — the
  // proxy needs the per-day distribution, which the day-mean discards.
  //
  // v1.32.17 — key this resting series on `userDayKey(d, userTz)`. Its ONLY
  // pairing partner is `dailyMoodEntries`, which is LOCAL-day-keyed since
  // v1.32.12 (the mood rollup writer now mints `bucketStart` from the
  // canonical local `MoodEntry.date` label, not a UTC truncation). Keeping
  // UTC here would offset every evening logger west of UTC by one day and
  // sell a lag-1 correlation as same-day. This is exactly the flip the
  // v1.30.3 F8 note said becomes correct once the mood side goes local —
  // it now has. (Unlike the mood side, this series builds from raw rows in
  // this route, so it re-keys directly with no rollup-tier change.)
  const restingPulseRows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "RESTING_HEART_RATE",
      deletedAt: null,
      measuredAt: { gte: ninetyDaysAgo },
    },
    select: { measuredAt: true, value: true },
  });
  const rawPulseRowsForResting =
    restingPulseRows.length === 0
      ? await prisma.measurement.findMany({
          where: {
            userId,
            type: "PULSE",
            deletedAt: null,
            measuredAt: { gte: ninetyDaysAgo },
          },
          select: { measuredAt: true, value: true },
        })
      : [];
  const localDayKey = (d: Date) => userDayKey(d, userTz);
  const { series: restingPulseSeries } = resolveRestingPulseSeries({
    restingSamples: restingPulseRows,
    pulseSamples: rawPulseRowsForResting,
    dayKeyOf: localDayKey,
  });
  const restingByDay = new Map<string, { sum: number; count: number }>();
  for (const s of restingPulseSeries) {
    const key = localDayKey(s.measuredAt);
    const cur = restingByDay.get(key) ?? { sum: 0, count: 0 };
    cur.sum += s.value;
    cur.count += 1;
    restingByDay.set(key, cur);
  }
  const restingPulseDaily = Array.from(restingByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({ day, value: stats.sum / stats.count }));
  const moodPulsePairs = pairMoodWithDaily(dailyMoodEntries, restingPulseDaily);
  const moodPulseCorrelation = pearsonCorrelation(moodPulsePairs);
  const moodPulseScatterData = moodPulsePairs.map((p) => ({
    mood: p.a,
    pulse: p.b,
  }));

  // ── Medication compliance ────────────────────────────────
  // Bounded reads — left untouched per the directive.
  const medicationRows = await prisma.medication.findMany({
    // v1.16.11 — as-needed (PRN) medications never surface a compliance
    // rate (no expected doses).
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    // v1.15.20 — schedules through the shared compliance select so the
    // configured per-dose windows reach this surface like every other.
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // v1.16.3 — archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
  });
  // A medication with no schedule expects no dose, and `calculateCompliance`
  // answers 100 % for that case. The `asNeeded: false` filter above catches
  // only the PRN arm; the empty schedule is reachable on a scheduled
  // medication and would otherwise report perfect adherence.
  const medications = medicationRows.filter(expectsDoses);

  const categoryMap = await getMedicationCategories(
    medications.map((m) => m.id),
  );

  const medCompliance = [];
  const bpMedicationEvents: Array<{
    scheduledFor: Date;
    takenAt: Date | null;
    skipped: boolean;
  }> = [];
  const bpMedications = medications.filter(
    (med) => (categoryMap[med.id] ?? "OTHER") === "BLOOD_PRESSURE",
  );
  // Single round-trip for all medications instead of N+1: one query keyed
  // on `medicationId IN (...)`, then group in memory.
  const allEvents = medications.length
    ? await prisma.medicationIntakeEvent.findMany({
        where: {
          medicationId: { in: medications.map((m) => m.id) },
          userId,
          // v1.7.0 sync — exclude tombstoned rows.
          deletedAt: null,
          scheduledFor: { gte: ninetyDaysAgo },
        },
        orderBy: { scheduledFor: "desc" },
      })
    : [];

  const eventsByMed = new Map<string, typeof allEvents>();
  for (const ev of allEvents) {
    const list = eventsByMed.get(ev.medicationId);
    if (list) list.push(ev);
    else eventsByMed.set(ev.medicationId, [ev]);
  }

  for (const med of medications) {
    const events = eventsByMed.get(med.id) ?? [];
    const mapped = events.map((e) => ({
      takenAt: e.takenAt,
      skipped: e.skipped,
      scheduledFor: e.scheduledFor,
    }));
    // v1.7.0 SB-SCHED-2 — engine-routed denominator.
    const medicationContext = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(mapped),
      user.timezone || "Europe/Berlin",
    );
    const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt, {
      medicationContext,
    });
    const c30 = calculateCompliance(mapped, med.schedules, 30, med.createdAt, {
      medicationContext,
    });

    medCompliance.push({
      id: med.id,
      name: med.name,
      dose: med.dose,
      category: categoryMap[med.id] ?? "OTHER",
      compliance7: c7.rate,
      compliance30: c30.rate,
      streak: c7.streak,
      taken7: c7.taken,
      skipped7: c7.skipped,
      missed7: c7.missed,
    });

    if ((categoryMap[med.id] ?? "OTHER") === "BLOOD_PRESSURE") {
      bpMedicationEvents.push(
        ...events.map((e) => ({
          scheduledFor: e.scheduledFor,
          takenAt: e.takenAt,
          skipped: e.skipped,
        })),
      );
    }
  }

  // ── Correlation: BP medication continuity × systolic BP ──
  // Uses the same daily BP_SYS series the aggregator pre-computed —
  // no second round-trip. The intake-side aggregation matches the
  // legacy code: continuity = min(1, taken / expectedPerDay), pairing
  // every day that had a sys reading.
  let bpMedicationCorrelation: {
    r: number;
    strength: string;
    n: number;
    medicationCount: number;
  } | null = null;
  const bpMedicationScatterData: Array<{
    continuityPct: number;
    sysBP: number;
  }> = [];

  const expectedBpIntakesPerDay = bpMedications.reduce(
    (sum, med) => sum + med.schedules.length,
    0,
  );

  if (expectedBpIntakesPerDay > 0) {
    // Daily systolic means (already keyed YYYY-MM-DD) from the SQL pass.
    // v1.32.17 — `sysDaily` (UTC `date_trunc` from the aggregator's
    // `dailyByType`) and `takenByDay` below (intake `scheduledFor`
    // truncated to UTC) both live in the SAME UTC day-key space and are
    // internally consistent with each other — this join is NOT broken and
    // stays as is. Only the mood pairings above moved to a separately
    // derived local-day series (their partner, the mood series, is
    // local-day-keyed). This correlation migrates to local when the
    // measurement-rollup tier buckets per-user tz (R12), not in this hotfix
    // — re-keying it here without the local-bucketed rollup would mean
    // per-request raw re-aggregation.
    const sysByDay = new Map<string, number>();
    for (const row of sysDaily) {
      sysByDay.set(row.day, row.value);
    }

    const takenByDay = new Map<string, number>();
    // Days that carry an intake record of ANY kind. A logged skip is a real
    // zero and belongs in the series; a day the person never touched is not a
    // zero, it is nothing, and pairing it against that day's systolic reading
    // invented a data point they never produced. Absence is not zero, here as
    // everywhere else in this project, so the unlogged day drops out of both
    // the scatter and the coefficient rather than dragging continuity down.
    const loggedDays = new Set<string>();
    for (const event of bpMedicationEvents) {
      const dayKey = event.scheduledFor.toISOString().slice(0, 10);
      loggedDays.add(dayKey);
      if (event.skipped || !event.takenAt) continue;
      takenByDay.set(dayKey, (takenByDay.get(dayKey) ?? 0) + 1);
    }

    const pairs: Array<{ a: number; b: number; date: Date }> = [];
    for (const [dayKey, avgSys] of sysByDay.entries()) {
      if (!loggedDays.has(dayKey)) continue;
      const taken = takenByDay.get(dayKey) ?? 0;
      const continuity = Math.min(1, taken / expectedBpIntakesPerDay);
      pairs.push({
        a: continuity,
        b: avgSys,
        date: new Date(`${dayKey}T00:00:00.000Z`),
      });
      bpMedicationScatterData.push({
        continuityPct: Math.round(continuity * 100),
        sysBP: Math.round(avgSys * 10) / 10,
      });
    }

    const corr = pearsonCorrelation(pairs);
    if (corr) {
      bpMedicationCorrelation = {
        ...corr,
        medicationCount: bpMedications.length,
      };
    }
  }

  // Generate alerts
  const alerts = generateAlerts({
    bmi,
    bpAvgSys: summaries.BLOOD_PRESSURE_SYS?.avg30 ?? null,
    bpAvgDia: summaries.BLOOD_PRESSURE_DIA?.avg30 ?? null,
    bpPctInTarget,
    weightSlope30: summaries.WEIGHT?.slope30?.slope ?? null,
    pulseAvg30: summaries.PULSE?.avg30 ?? null,
    pulseAnomalyCount: summaries.PULSE?.anomalyCount ?? 0,
    medications: medCompliance.map((m) => ({
      name: m.name,
      compliance7: m.compliance7,
      compliance30: m.compliance30,
    })),
  });

  // Data span — derived from the earliest 90-day measurement.
  const dataSpanDays = aggregate.firstMeasurementAt
    ? Math.ceil(
        (Date.now() - aggregate.firstMeasurementAt.getTime()) /
          (24 * 60 * 60 * 1000),
      )
    : 0;

  annotate({
    action: { name: "insights.comprehensive" },
    meta: {
      totalMeasurements: aggregate.totalMeasurements,
      moodEntries: moodEntryCount,
      medications: medications.length,
    },
  });

  return {
    summaries,
    bmi,
    bmiClassification,
    bpClassification,
    bpPctInTarget,
    bpTargets,
    weightBpCorrelation,
    scatterData,
    bpMedicationCorrelation,
    bpMedicationScatterData,
    moodSummary,
    moodBpCorrelation,
    moodBpScatterData,
    moodWeightCorrelation,
    moodWeightScatterData,
    moodPulseCorrelation,
    moodPulseScatterData,
    medications: medCompliance,
    alerts,
    // Presence only: no client is built and no token is refreshed on a read.
    hasProvider: await probeProviderPresence(userId),
    dataSpanDays,
    totalMeasurements: aggregate.totalMeasurements,
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * v1.32.17 — derive exact local-day mean series from raw measurement rows,
 * keyed by the user's timezone via `userDayKey`. The mood series is
 * local-day-keyed (since v1.32.12), and `pairMoodWithDaily` joins on an
 * exact YYYY-MM-DD key, so its metric partners must be local-day-keyed too.
 * A UTC-day mean (from `dailyByType`) cannot be relabeled into a local-day
 * mean, so the mean is recomputed here from raw rows already on the request
 * path. `userDayKey` formats via a memoised `Intl.DateTimeFormat` — no
 * offset arithmetic — so DST-transition days (23 h / 25 h) bucket correctly
 * and the result is host-TZ-independent (CI runs UTC). `round2` mirrors the
 * aggregator's `ROUND(AVG, 2)` so correlation thresholds don't drift.
 * Returns `{ day, value }[]` sorted ASC by day, the shape
 * `pairMoodWithDaily` expects.
 */
function deriveDailyLocalMeans(
  rows: Array<{ measuredAt: Date; value: number }>,
  tz: string,
): Array<{ day: string; value: number }> {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    const key = userDayKey(r.measuredAt, tz);
    const cur = byDay.get(key) ?? { sum: 0, count: 0 };
    cur.sum += r.value;
    cur.count += 1;
    byDay.set(key, cur);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({
      day,
      value: Math.round((stats.sum / stats.count) * 100) / 100,
    }));
}

/**
 * Daily-key inner join between two daily-aggregated series. Returns
 * `PairedPoint` shapes compatible with `pearsonCorrelation`.
 *
 * Inputs are sorted ASC by `day` (the aggregator's ORDER BY
 * guarantees that). The walk is O(n + m) merge-join style instead of
 * Map.lookup-per-element so it scales with the worst-case 90 buckets
 * x 90 buckets case without surprises.
 */
function joinDailyByDay(
  a: Array<{ day: string; value: number }>,
  b: Array<{ day: string; value: number }>,
): PairedPoint[] {
  const pairs: PairedPoint[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i];
    const bj = b[j];
    if (ai.day === bj.day) {
      pairs.push({
        a: ai.value,
        b: bj.value,
        date: new Date(`${ai.day}T12:00:00.000Z`),
      });
      i += 1;
      j += 1;
    } else if (ai.day < bj.day) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Pair the daily mood series (left side) with a daily-aggregated
 * metric (right side). Matches the legacy `buildMoodMetricPairs`
 * helper byte-for-byte: same daily YYYY-MM-DD key, same
 * `T12:00:00.000Z` anchor for the `date` field.
 */
function pairMoodWithDaily(
  dailyMood: Array<{ day: string; value: number }>,
  dailyMetric: Array<{ day: string; value: number }>,
): PairedPoint[] {
  if (dailyMood.length === 0 || dailyMetric.length === 0) return [];
  const metricByDay = new Map<string, number>();
  for (const m of dailyMetric) {
    metricByDay.set(m.day, m.value);
  }
  const pairs: PairedPoint[] = [];
  for (const mood of dailyMood) {
    const metric = metricByDay.get(mood.day);
    if (metric !== undefined) {
      pairs.push({
        a: mood.value,
        b: metric,
        date: new Date(`${mood.day}T12:00:00.000Z`),
      });
    }
  }
  return pairs;
}
