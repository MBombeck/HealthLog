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
 * yields `briefingState: "preparing"` and the `insight-pregenerate`
 * cron refills it. The builder NEVER POSTs `/api/insights/generate`.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { computeSummariesSlice } from "@/lib/analytics/summaries-slice";
import {
  summarize,
  type DataPoint,
  type DataSummary,
} from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { computeBpInTargetFastPath } from "@/lib/analytics/bp-in-target-fast-path";
import {
  probeRollupCoverage,
  isFullyCovered,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";
import {
  resolveDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { dailyBriefingSchema, type DailyBriefing } from "@/lib/ai/schema";
import { getAssistantFlags } from "@/lib/feature-flags";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";

/** Briefing freshness window — mirrors the 24 h TTL on the advisor cache. */
const BRIEFING_TTL_MS = 24 * 60 * 60 * 1000;

/** Five-year mood window — mirrors `/api/mood/analytics`. */
const MOOD_ROLLUP_WINDOW_MS = 5 * 365 * 24 * 60 * 60 * 1000;

const GLUCOSE_CONTEXTS = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
] as const;

export type BriefingState = "ready" | "preparing" | "disabled";

export interface DashboardSnapshotUser {
  username: string;
  timezone: string;
  heightCm: number | null;
  dateOfBirth: string | null;
  gender: "MALE" | "FEMALE" | null;
  glucoseUnit: string | null;
  onboardingTourCompleted: boolean;
  /**
   * Server-computed wall-clock hour in the user's timezone so the
   * client greeting never has to run its own `Intl.DateTimeFormat`
   * before first paint.
   */
  greetingHour: number;
}

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
  glucoseByContext: Record<string, DataSummary>;
}

export interface DashboardSnapshot {
  user: DashboardSnapshotUser;
  layout: DashboardLayout;
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
  };
  /** Thick phase — null on a rollup-coverage miss. */
  extras: DashboardSnapshotExtras | null;
  briefing: DailyBriefing | null;
  briefingState: BriefingState;
  briefingUpdatedAt: string | null;
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
  dashboardWidgetsJson: unknown;
}

/** Format a UTC `Date` as a YYYY-MM-DD label (matches mood rollup tier). */
function utcDayLabel(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Wall-clock hour in `tz`, used for the server-side greeting. */
function hourInTimezone(now: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    });
    const parsed = parseInt(fmt.format(now), 10);
    // Intl emits "24" for midnight under hour12:false on some ICU builds.
    return Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

function enrichLastSeen(
  raw: Record<string, { lastSeenAt: string } | null>,
  nowMs: number,
): Record<string, { lastSeenAt: string; daysAgo: number } | null> {
  const out: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  > = {};
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

/** Read-only mood block, lifting the rollup-tier read from `/api/mood/analytics`. */
async function buildMoodBlock(
  prisma: PrismaClient,
  userId: string,
): Promise<{
  summary: DataSummary | null;
  entries: DashboardSnapshotMoodEntry[];
}> {
  void ensureUserMoodRollupsFresh(userId);

  const since = new Date(Date.now() - MOOD_ROLLUP_WINDOW_MS);
  const rollups = await readMoodDayRollups(userId, since);

  if (rollups.length > 0) {
    const entries = rollups
      .map((r) => ({
        date: utcDayLabel(r.bucketStart),
        score: Math.round(r.mean * 100) / 100,
        samples: r.count,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const dataPoints: DataPoint[] = rollups.map((r) => ({
      date: r.bucketStart,
      value: r.mean,
    }));
    return { summary: summarize(dataPoints), entries };
  }

  // Coverage fallback — mirror the live walk in `/api/mood/analytics`.
  const moodEntries = await prisma.moodEntry.findMany({
    where: { userId },
    orderBy: { moodLoggedAt: "asc" },
    select: { date: true, score: true },
  });
  if (moodEntries.length === 0) {
    return { summary: summarize([]), entries: [] };
  }
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const e of moodEntries) {
    const cur = byDay.get(e.date) ?? { sum: 0, count: 0 };
    cur.sum += e.score;
    cur.count += 1;
    byDay.set(e.date, cur);
  }
  const entries = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({
      date: day,
      score: Math.round((stats.sum / stats.count) * 100) / 100,
      samples: stats.count,
    }));
  const dataPoints: DataPoint[] = entries.map((e) => ({
    date: new Date(`${e.date}T12:00:00.000Z`),
    value: e.score,
  }));
  return { summary: summarize(dataPoints), entries };
}

/**
 * Thick slice — BD-Zielbereich + per-context glucose. Only called by
 * the builder when the rollup tier is warm (`isFullyCovered`); the BP
 * fast-path then stays on the sub-second rollup branch and never drops
 * into the multi-second live fallback that would make the whole strip
 * wait. On a coverage miss the builder skips this entirely and emits
 * `extras: null` (per-tile shimmer until the boot backfill converges).
 */
async function buildExtras(
  prisma: PrismaClient,
  user: SnapshotUserInput,
  userTz: string,
  coverage: RollupCoverageMap,
): Promise<DashboardSnapshotExtras> {
  let bpInTargetPct: number | null = null;
  let bpInTargetPct7d: number | null = null;
  let bpInTargetPct30d: number | null = null;
  let bpInTargetPctAllTime: number | null = null;
  let bpInTargetPctPriorMonth: number | null = null;
  let bpInTargetPctPriorYear: number | null = null;

  const bpTargets = getBpTargets(user.dateOfBirth);
  if (bpTargets) {
    const now = new Date();
    const windows = await computeBpInTargetFastPath({
      userId: user.id,
      targets: bpTargets,
      now,
      coverage,
      userTz,
    });
    bpInTargetPct = windows.last30Days?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
    bpInTargetPctAllTime = windows.allTime?.pct ?? null;
    bpInTargetPctPriorMonth = windows.priorMonth?.pct ?? null;
    bpInTargetPctPriorYear = windows.priorYear?.pct ?? null;
  }

  const glucoseSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
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
  const glucoseByContext: Record<string, DataSummary> = {};
  if (glucoseRows.length > 0) {
    for (const ctx of GLUCOSE_CONTEXTS) {
      const ctxRows = glucoseRows.filter((r) => r.glucoseContext === ctx);
      if (ctxRows.length === 0) continue;
      glucoseByContext[ctx] = summarize(
        ctxRows.map(
          (r): DataPoint => ({ date: r.measuredAt, value: r.value }),
        ),
      );
    }
  }

  return {
    bpInTargetPct,
    bpInTargetPct7d,
    bpInTargetPct30d,
    bpInTargetPctAllTime,
    bpInTargetPctPriorMonth,
    bpInTargetPctPriorYear,
    glucoseByContext,
  };
}

/**
 * Read-only briefing lift. Parses `User.insightsCachedText`, validates
 * the `dailyBriefing` block, and reports a tri-state. NEVER calls the
 * provider chain.
 */
function liftBriefing(
  user: SnapshotUserInput,
  coachEnabled: boolean,
): {
  briefing: DailyBriefing | null;
  briefingState: BriefingState;
  briefingUpdatedAt: string | null;
} {
  if (!coachEnabled || user.disableCoach) {
    return {
      briefing: null,
      briefingState: "disabled",
      briefingUpdatedAt: null,
    };
  }

  const cachedAt = user.insightsCachedAt;
  const updatedAt = cachedAt?.toISOString() ?? null;
  const stale =
    !cachedAt || Date.now() - cachedAt.getTime() >= BRIEFING_TTL_MS;
  if (stale || !user.insightsCachedText) {
    return {
      briefing: null,
      briefingState: "preparing",
      briefingUpdatedAt: updatedAt,
    };
  }

  try {
    const parsed = JSON.parse(user.insightsCachedText) as Record<
      string,
      unknown
    >;
    const candidate = parsed?.dailyBriefing;
    if (candidate == null) {
      return {
        briefing: null,
        briefingState: "preparing",
        briefingUpdatedAt: updatedAt,
      };
    }
    const validated = dailyBriefingSchema.safeParse(candidate);
    if (!validated.success) {
      return {
        briefing: null,
        briefingState: "preparing",
        briefingUpdatedAt: updatedAt,
      };
    }
    return {
      briefing: validated.data,
      briefingState: "ready",
      briefingUpdatedAt: updatedAt,
    };
  } catch {
    return {
      briefing: null,
      briefingState: "preparing",
      briefingUpdatedAt: updatedAt,
    };
  }
}

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
  } = {},
): Promise<DashboardSnapshot> {
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;
  const now = new Date();
  const nowMs = now.getTime();
  const time =
    options.time ?? (<T>(_label: string, fn: () => Promise<T>) => fn());

  // Probe coverage once up front so the thick `extras` phase only runs
  // when the rollup tier is warm. A coverage miss returns `extras: null`
  // immediately rather than dropping into the live-SQL fallback that
  // would make the whole strip wait on the slowest read (R-firstpaint
  // §6 — paint-together vs slowest-wins).
  const coverage = await time("coverage", () => probeRollupCoverage(user.id));
  const warm = isFullyCovered(coverage);

  const [slim, mood, extras, flags] = await Promise.all([
    time("summaries", () => computeSummariesSlice(user.id)),
    time("mood", () => buildMoodBlock(prisma, user.id)),
    warm
      ? time("extras", () => buildExtras(prisma, user, userTz, coverage))
      : Promise.resolve(null),
    time("flags", () => getAssistantFlags()),
  ]);

  const layout = resolveDashboardLayout(user.dashboardWidgetsJson);
  const briefing = liftBriefing(user, flags.briefing);

  const gender =
    user.gender === "MALE" || user.gender === "FEMALE" ? user.gender : null;

  return {
    user: {
      username: user.displayName?.trim() || user.username,
      timezone: userTz,
      heightCm: user.heightCm ?? null,
      dateOfBirth: user.dateOfBirth?.toISOString() ?? null,
      gender,
      glucoseUnit: user.glucoseUnit ?? null,
      onboardingTourCompleted: user.onboardingTourCompleted,
      greetingHour: hourInTimezone(now, userTz),
    },
    layout,
    tiles: {
      summaries: slim.summaries,
      lastSeenByType: enrichLastSeen(slim.lastSeenByType, nowMs),
      mood: {
        summary: mood.entries.length > 0 ? mood.summary : null,
        entries: mood.entries,
      },
    },
    extras,
    briefing: briefing.briefing,
    briefingState: briefing.briefingState,
    briefingUpdatedAt: briefing.briefingUpdatedAt,
    generatedAt: now.toISOString(),
  };
}
