/**
 * v1.41 — how an active plan is going, in one server-computed sentence.
 *
 * The memory block puts this sentence beside every active plan, and the
 * daily briefing gets at most two of them, so the model can check in on a
 * plan with real numbers instead of inventing them: the latest week's mean,
 * the two weeks before the plan began, and the trend since. The figures come
 * from the person's own day series in their own units; nothing here calls a
 * model.
 *
 * The sentence is model-facing context and English, like the rest of the
 * tool-mode prompt. It carries the plan's target in quotes (the person's own
 * words, at most 160 characters); every caller places it inside a data fence.
 *
 * Server-only.
 */
import { aiCapabilityForRecord } from "@/lib/ai/capabilities/gate";
import { prisma } from "@/lib/db";
import { planDayValue, resolvePlanMetric } from "@/lib/jobs/coach-plan-review";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getReadingTransform,
  resolveUnitPreferences,
  type DisplayTransform,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import { isModuleEnabled } from "@/lib/modules/gate";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";

import { decryptFromBytes } from "../bytes-codec";
import { scrubFenceMarkers } from "../data-fence";

/** Days read before the plan began, for the "before" mean. */
const BEFORE_DAYS = 14;
/** The latest window the "now" mean covers. */
const RECENT_DAYS = 7;
/** Day values needed since the start before a figure is stated. */
const MIN_DAYS_SINCE_START = 3;
/** A trend is stated once the series since the start spans this many days. */
const MIN_TREND_SPAN_DAYS = 7;
/** Progress lines the briefing gets. */
export const BRIEFING_PLAN_LINES = 2;

const MS_PER_DAY = 86_400_000;

export interface PlanProgressInput {
  metric: string;
  /** The plan's start: its creation, which is when it was proposed. */
  startedAt: Date;
  /** The person's own target words, when the plan has one. */
  target: string | null;
}

export interface PlanProgressContext {
  userId: string;
  timeZone: string;
  units: UnitPreferences;
  now: Date;
  db?: Parameters<typeof readDayAggregates>[0]["db"];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Least-squares slope of value over day index, per day. */
function slopePerDay(points: ReadonlyArray<{ x: number; y: number }>): number {
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function formatAbsolute(raw: number, transform: DisplayTransform): string {
  // The transform rounds a converted value; an unconverted one keeps the
  // canonical figure, rounded here to the unit's own grain.
  const value = round(
    applyDisplayTransform(raw, transform),
    transform.decimals,
  );
  return transform.displayUnit
    ? `${value} ${transform.displayUnit}`
    : `${value}`;
}

function formatDelta(raw: number, transform: DisplayTransform): string {
  const value = round(
    applyDisplayTransformDelta(raw, transform),
    transform.decimals,
  );
  const signed = value > 0 ? `+${value}` : `${value}`;
  return transform.displayUnit ? `${signed} ${transform.displayUnit}` : signed;
}

/**
 * The progress sentence for one plan, or null when the metric has no series
 * HealthLog reads. Pure apart from the one day-series read.
 */
export async function computePlanProgress(
  plan: PlanProgressInput,
  ctx: PlanProgressContext,
): Promise<string | null> {
  const resolved = resolvePlanMetric(plan.metric);
  if (!resolved) return null;
  const transform = getReadingTransform(resolved.type, ctx.units);
  const startKey = userDayKey(plan.startedAt, ctx.timeZone);
  const todayKey = userDayKey(ctx.now, ctx.timeZone);
  const recentFromKey = shiftDateKey(todayKey, -(RECENT_DAYS - 1));
  const rows = await readDayAggregates({
    userId: ctx.userId,
    type: resolved.type,
    since: new Date(plan.startedAt.getTime() - (BEFORE_DAYS + 1) * MS_PER_DAY),
    until: ctx.now,
    timeZone: ctx.timeZone,
    ...(ctx.db ? { db: ctx.db } : {}),
  });
  const beforeFromKey = shiftDateKey(startKey, -BEFORE_DAYS);
  const before: number[] = [];
  const since: Array<{ key: string; value: number }> = [];
  for (const row of rows) {
    const value = planDayValue(resolved.type, row);
    if (!Number.isFinite(value)) continue;
    if (row.day < startKey) {
      if (row.day >= beforeFromKey) before.push(value);
    } else {
      since.push({ key: row.day, value });
    }
  }
  since.sort((a, b) => a.key.localeCompare(b.key));

  const target = plan.target
    ? `; target "${scrubFenceMarkers(plan.target).replace(/\s+/g, " ").trim()}"`
    : "";
  const head = `${resolved.label} plan since ${startKey}${target}`;
  if (since.length < MIN_DAYS_SINCE_START) {
    return `${head}: ${since.length} day(s) with readings since the start, too few to call progress yet.`;
  }

  const parts: string[] = [];
  const recent = since.filter((d) => d.key >= recentFromKey);
  if (recent.length > 0) {
    parts.push(
      `latest ${RECENT_DAYS}-day mean ${formatAbsolute(
        mean(recent.map((d) => d.value)),
        transform,
      )}`,
    );
  } else {
    parts.push(`no readings in the last ${RECENT_DAYS} days`);
  }
  if (before.length >= MIN_DAYS_SINCE_START) {
    const beforeMean = mean(before);
    const sinceMean = mean(since.map((d) => d.value));
    parts.push(
      `mean since the start ${formatAbsolute(sinceMean, transform)} against ${formatAbsolute(
        beforeMean,
        transform,
      )} in the ${BEFORE_DAYS} days before (${formatDelta(
        sinceMean - beforeMean,
        transform,
      )})`,
    );
  }
  // Whole calendar days between day keys: the keys are already the person's
  // local days, so the distance is calendar arithmetic, not an instant.
  const firstMs = dayKeyAsUtcMidnight(since[0].key).getTime();
  const points = since.map((d) => ({
    x: (dayKeyAsUtcMidnight(d.key).getTime() - firstMs) / MS_PER_DAY,
    y: d.value,
  }));
  const span = points[points.length - 1].x;
  if (span >= MIN_TREND_SPAN_DAYS) {
    parts.push(
      `trend ${formatDelta(slopePerDay(points) * 7, transform)} per week over ${since.length} days with readings`,
    );
  }
  return `${head}: ${parts.join("; ")}.`;
}

/** The person's day zone and units, read once per block. */
export async function loadProgressContext(
  userId: string,
  now: Date,
): Promise<PlanProgressContext> {
  const [timeZone, row] = await Promise.all([
    resolveUserTimezone(userId),
    prisma.user.findUnique({
      where: { id: userId },
      select: { unitPreference: true, glucoseUnit: true },
    }),
  ]);
  return {
    userId,
    timeZone,
    units: resolveUnitPreferences({
      unitPreference: row?.unitPreference,
      glucoseUnit: row?.glucoseUnit,
    }),
    now,
  };
}

function decryptOrNull(buf: Uint8Array | null): string | null {
  if (!buf) return null;
  try {
    return decryptFromBytes(buf);
  } catch {
    return null;
  }
}

/**
 * One server-computed progress sentence per active plan, at most two, for
 * the daily briefing prompt. The model may quote one; it may not invent one.
 *
 * Built only while the briefing may reach a model for this record and the
 * Coach module is on (plans are the Coach's): otherwise nothing is read and
 * the briefing carries no plan line.
 */
export async function buildPlanProgressLines(
  userId: string,
  opts: { now?: Date } = {},
): Promise<string[]> {
  const capability = await aiCapabilityForRecord(userId, "briefing");
  if (!capability.available) return [];
  if (!(await isModuleEnabled(userId, "coach"))) return [];

  const plans = await prisma.coachPlan.findMany({
    where: { userId, deletedAt: null, status: "active" },
    orderBy: [{ updatedAt: "desc" }],
    select: { metric: true, targetEncrypted: true, createdAt: true },
  });
  if (plans.length === 0) return [];

  const ctx = await loadProgressContext(userId, opts.now ?? new Date());
  const lines: string[] = [];
  for (const plan of plans) {
    if (lines.length >= BRIEFING_PLAN_LINES) break;
    try {
      const line = await computePlanProgress(
        {
          metric: plan.metric,
          startedAt: plan.createdAt,
          target: decryptOrNull(plan.targetEncrypted),
        },
        ctx,
      );
      if (line) lines.push(line);
    } catch {
      // One unreadable series drops its line, never the briefing.
    }
  }
  return lines;
}
