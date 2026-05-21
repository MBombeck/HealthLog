import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import {
  getGeneralStatusSystemPrompt,
  getGeneralStatusUserPrompt,
} from "@/lib/ai/prompts/general-status";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import { getNoKeyGeneralStatusText } from "@/lib/insights/no-key-fallbacks";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import {
  withTimeout,
  STATUS_PROVIDER_TIMEOUT_MS,
} from "@/lib/insights/with-timeout";
import { persistTimeoutStubAndReturn } from "@/lib/insights/persist-timeout-stub";
import { annotate } from "@/lib/logging/context";
import { toBerlinDayKey } from "@/lib/tz/resolver";

type SupportedLocale = "de" | "en";

// Derived from canonical enum so a new measurement type is auto-included
// in the AI general-status fetch (V3 audit: enum drift cousins).
const MEASUREMENT_TYPES = measurementTypeEnum.options;

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeSummaryText(value: string): string {
  return stripChartTokens(value).replace(/\s+/g, " ").trim();
}

function summarizeSeries(series: Array<{ value: number }>) {
  if (series.length === 0) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  // v1.4.33 — fold sum/min/max into a single walk. The previous
  // `Math.min(...series.map(...))` / `Math.max(...series.map(...))`
  // spread tripped V8's ~125 000-arg ceiling on the bound /api/analytics
  // path; see `.planning/round-v1433-analytics-500-report.md` §"Carry-
  // over". These helpers are fed bounded windows today so the crash
  // never reached them, but the spread allocates a transient args array
  // on every call — the fold is both stack-safe and cheaper.
  let sum = 0;
  let minVal = series[0].value;
  let maxVal = series[0].value;
  for (const entry of series) {
    sum += entry.value;
    if (entry.value < minVal) minVal = entry.value;
    if (entry.value > maxVal) maxVal = entry.value;
  }
  return {
    points: series.length,
    start: round(first, 2),
    end: round(last, 2),
    delta: round(last - first, 2),
    mean: round(sum / series.length, 2),
    min: round(minVal, 2),
    max: round(maxVal, 2),
  };
}

function normalizeLocale(value: string | null | undefined): SupportedLocale {
  return value === "en" ? "en" : "de";
}

export async function generateGeneralStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const cacheAction = `insights.general-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const provider = await resolveProvider(userId);
  if (provider.type === "none") {
    return {
      hasProvider: false,
      text: getNoKeyGeneralStatusText(locale),
      cached: true,
      updatedAt: null,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dateOfBirth: true,
    },
  });

  const latestCache = await prisma.auditLog.findFirst({
    where: { userId, action: cacheAction },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });

  if (!force && latestCache?.details) {
    try {
      const parsed = JSON.parse(latestCache.details) as {
        dateKey?: string;
        text?: string;
      };
      if (
        parsed.dateKey === todayKey &&
        typeof parsed.text === "string" &&
        parsed.text.trim().length > 0
      ) {
        return {
          hasProvider: true,
          text: parsed.text,
          cached: true,
          updatedAt: latestCache.createdAt.toISOString(),
        };
      }
    } catch {
      // ignore invalid cache payload
    }
  }

  // v1.4.28 FB-D2 — cap the snapshot input. General-status pulls
  // every supported measurement type; without a cap the read scales
  // linearly with account density.
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: {
          in: [...MEASUREMENT_TYPES],
        },
      },
      orderBy: { measuredAt: "desc" },
      take: 5000,
      select: {
        type: true,
        value: true,
        measuredAt: true,
      },
    })
    .then((rows) => rows.reverse());

  const now = new Date();

  const measurementSeries = Object.fromEntries(
    MEASUREMENT_TYPES.map((type) => {
      const records = measurements
        .filter((measurement) => measurement.type === type)
        .map((measurement) => ({
          measuredAt: measurement.measuredAt,
          value: measurement.value,
        }));

      const series = applyPayloadBudget(records, { now });

      return [
        type,
        {
          summary: summarizeSeries(
            series.daily.map((bucket) => ({ value: bucket.value })),
          ),
          series,
        },
      ];
    }),
  );

  const intakeEvents = await prisma.medicationIntakeEvent.findMany({
    where: { userId },
    orderBy: { scheduledFor: "asc" },
    select: {
      scheduledFor: true,
      takenAt: true,
      skipped: true,
    },
  });

  const adherenceByDay = new Map<
    string,
    { total: number; taken: number; skipped: number }
  >();
  for (const event of intakeEvents) {
    const dayKey = toBerlinDayKey(event.scheduledFor);
    const bucket = adherenceByDay.get(dayKey) ?? {
      total: 0,
      taken: 0,
      skipped: 0,
    };
    bucket.total += 1;
    if (!event.skipped && event.takenAt) {
      bucket.taken += 1;
    } else if (event.skipped) {
      bucket.skipped += 1;
    }
    adherenceByDay.set(dayKey, bucket);
  }

  // Adherence series — bucket the per-day rate so the model gets the
  // canonical 360+24 view. We collapse one rate per day first, then feed
  // it into applyPayloadBudget over a synthesised `{measuredAt, value}`
  // record list.
  const adherenceRecords = Array.from(adherenceByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({
      measuredAt: new Date(`${day}T00:00:00.000Z`),
      value: value.total > 0 ? round((value.taken / value.total) * 100, 1) : 0,
    }));
  const adherenceSeries = applyPayloadBudget(adherenceRecords, { now });

  // Fetch mood context (optional — for enrichment only). v1.4.28
  // FB-D2 — cap at 90 entries.
  const moodEntries = await prisma.moodEntry
    .findMany({
      where: { userId },
      orderBy: { moodLoggedAt: "desc" },
      take: 90,
      select: { date: true, score: true, moodLoggedAt: true },
    })
    .then((rows) => rows.reverse());

  const moodRecords = moodEntries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  const moodSeries = applyPayloadBudget(moodRecords, { now });
  const moodSummary = summarizeSeries(
    moodSeries.daily.map((bucket) => ({ value: bucket.value })),
  );
  const moodMean = moodSummary?.mean ?? null;

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);
  let bpInTargetLast30Days: number | null = null;
  if (bpTargets) {
    const sysDaily = measurementSeries.BLOOD_PRESSURE_SYS?.series.daily ?? [];
    const diaMap = new Map(
      (measurementSeries.BLOOD_PRESSURE_DIA?.series.daily ?? []).map(
        (bucket) => [bucket.dayOffset, bucket.value] as const,
      ),
    );
    const paired = sysDaily
      .map((bucket) => {
        const dia = diaMap.get(bucket.dayOffset);
        if (dia == null) return null;
        return { dayOffset: bucket.dayOffset, sys: bucket.value, dia };
      })
      .filter(
        (entry): entry is { dayOffset: number; sys: number; dia: number } =>
          !!entry,
      )
      // Keep the legacy "last 30 daily points" semantics — newest 30
      // paired daily buckets (dayOffset 0..29).
      .filter((point) => point.dayOffset < 30);

    if (paired.length > 0) {
      const inTargetCount = paired.filter((point) =>
        // v1.4.16 A2 — one-sided ceiling semantics with hypotension
        // floor. See lib/analytics/bp-in-target.ts.
        isBpReadingInTarget(point.sys, point.dia, bpTargets),
      ).length;
      bpInTargetLast30Days = round((inTargetCount / paired.length) * 100, 1);
    }
  }

  // Compute overall data coverage info
  const oldestDay = measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestDay =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const totalSpanDays =
    oldestDay && newestDay
      ? Math.round(
          (newestDay.getTime() - oldestDay.getTime()) / (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestDaysAgo = newestDay
    ? Math.round((Date.now() - newestDay.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    interpretationHint:
      "Use trend direction and deltas. Prioritize the newest data if trends conflict. Consider dataCoverage for reliability assessment.",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo: newestDaysAgo,
      avgDaysBetweenMeasurements:
        measurements.length > 1
          ? Math.round((totalSpanDays / (measurements.length - 1)) * 10) / 10
          : null,
    },
    measurementSeries,
    medicationAdherence: {
      summary: summarizeSeries(
        adherenceSeries.daily.map((bucket) => ({ value: bucket.value })),
      ),
      series: adherenceSeries,
    },
    bloodPressureTargets: bpTargets
      ? {
          systolic: { min: bpTargets.sysLow, max: bpTargets.sysHigh },
          diastolic: { min: bpTargets.diaLow, max: bpTargets.diaHigh },
          inTargetPctLast30DailyPoints: bpInTargetLast30Days,
        }
      : null,
    moodContext:
      moodSeries.daily.length >= 3
        ? {
            points: moodSeries.daily.length,
            mean: moodMean,
            latest: moodSeries.daily[0]?.value ?? null,
            series: moodSeries,
          }
        : null,
  };

  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: { payload_size_bytes: snapshotJson.length },
  });

  // v1.4: pull the previous cached general-status into the prompt so
  // the model can compare to the user's last analysis. Falls back
  // gracefully when there's no history (first-run users).
  const previousContext = await getPreviousInsightContext(
    userId,
    "general-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // v1.4.28 FB-D2 — 20 s timeout race; fall back to the no-key text
  // on stall so the InsightStatusCard renders deterministically.
  const raced = await withTimeout(
    () =>
      provider.generateCompletion({
        systemPrompt: getGeneralStatusSystemPrompt(locale),
        userPrompt: getGeneralStatusUserPrompt(
          snapshotJson,
          todayKey,
          locale,
          previousContextBlock,
        ),
        temperature: 0.3,
        maxTokens: 1000,
      }),
    STATUS_PROVIDER_TIMEOUT_MS,
    null,
  );

  if (raced.timedOut || raced.value === null) {
    // v1.4.37 — persist a sentinel row keyed to today so the next
    // mount short-circuits at the cache lookup above instead of
    // re-racing the same 20 s provider call on every cold visit.
    // See `persistTimeoutStubAndReturn` for the full rationale.
    return persistTimeoutStubAndReturn({
      userId,
      cacheAction,
      todayKey,
      locale,
      providerType: provider.type,
      stubText: getNoKeyGeneralStatusText(locale),
    });
  }

  const result = raced.value;
  const content = result.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("AI returned empty content for general-status");
  }

  let summary = "";
  try {
    const parsed = JSON.parse(content) as { summary?: string };
    if (typeof parsed.summary === "string") {
      summary = parsed.summary;
    } else {
      summary = content;
    }
  } catch {
    summary = content;
  }

  summary = normalizeSummaryText(summary);
  if (!summary) {
    throw new Error("General-status summary was empty after normalization");
  }

  const created = await prisma.auditLog.create({
    data: {
      userId,
      action: cacheAction,
      details: JSON.stringify({
        dateKey: todayKey,
        locale,
        text: summary,
        providerType: provider.type,
        model: result.model ?? "unknown",
        tokensUsed: result.tokensUsed ?? null,
      }),
    },
    select: { createdAt: true },
  });

  return {
    hasProvider: true,
    text: summary,
    cached: false,
    updatedAt: created.createdAt.toISOString(),
  };
}

