/**
 * v1.4.16 — daily feedback aggregator.
 *
 * Runs once a day (04:00 Europe/Berlin via the pg-boss schedule
 * registered in `reminder-worker.ts`). Aggregates the last 30 days
 * of `RecommendationFeedback` rows into per-(severity, metricSourceType,
 * providerType, promptVersion) buckets and writes a summary JSON to
 * `AppSettings.adminAiInsightsFeedbackSummary` (singleton row).
 *
 * The summary feeds the `/admin/ai-quality` preview that surfaces
 * helpful-rate per severity x provider — a v1.4.17 ratchet will read
 * the same shape to drive prompt-tuning (low-helpful-rate buckets
 * get a stricter "OMIT" or "REPHRASE" rule appended next prompt
 * version, per research §5.2).
 *
 * Single-user-default-on policy (research §3): the aggregator runs
 * unconditionally for the user's own ratings. Cross-user training
 * stays admin-only and the summary lives on the singleton AppSettings
 * row that's already gated behind requireAdmin().
 *
 * No prompt mutation in v1.4.16 — the aggregator only writes the
 * summary blob; the prompt-tuning step is deferred to v1.4.17.
 */
// account-deletion(file): instance-wide counts of feedback rows; nothing is done for any account.
import type { PrismaClient } from "@/generated/prisma/client";

export const DEFAULT_FEEDBACK_AGGREGATION_WINDOW_DAYS = 30;

export interface FeedbackBucket {
  severity: string;
  metricSourceType: string;
  providerType: string;
  promptVersion: string;
  helpful: number;
  notHelpful: number;
  total: number;
  /** Fraction in [0..1], rounded to 2 decimals. Always 0 when total=0. */
  helpfulRate: number;
  /**
   * v1.4.23 — surface origin so the admin dashboard can group
   * recommendation rows separately from Coach assistant-message rows
   * (the existing buckets blended both before this field landed).
   */
  targetType: string;
}

/**
 * v1.4.23 — slim view onto the Coach-only rows so the admin
 * coach-feedback dashboard can render the first-week aggregate without
 * re-deriving the slice from the recommendation buckets.
 */
export interface CoachFeedbackBucket {
  promptVersion: string;
  /** Encoded as `tone=warm|neutral|concise` */
  tone: string;
  /** Encoded as `verbosity=brief|default|detailed` */
  verbosity: string;
  helpful: number;
  notHelpful: number;
  total: number;
  helpfulRate: number;
}

export interface FeedbackAggregationSummary {
  generatedAt: string;
  windowDays: number;
  buckets: FeedbackBucket[];
  /**
   * v1.4.23 — Coach assistant-message buckets sliced by
   * (promptVersion, tone, verbosity). Empty array when the
   * aggregation window has no Coach feedback rows.
   */
  coachBuckets: CoachFeedbackBucket[];
}

interface MinimalFeedbackRow {
  recommendationSeverity: string;
  metricSourceType: string;
  providerType: string;
  promptVersion: string;
  helpful: boolean;
  /**
   * v1.4.23 — present on every row from the new schema. Defaults to
   * "recommendation" for legacy rows so the bucketing still works
   * during the upgrade window when the migration has run but the route
   * hasn't started writing the field yet.
   */
  targetType?: string;
}

/**
 * Pure helper — group rows by the four-tuple key and compute helpful
 * counts per bucket. Exported so the unit test can pin the bucketing
 * shape without going through Prisma. Callers that already have rows
 * in memory (admin-only ad-hoc analysis tools) can reuse this without
 * the Prisma roundtrip.
 *
 * Sort order is deterministic: severity, then metricSourceType, then
 * providerType, then promptVersion. The admin UI rendering this list
 * relies on the order being stable across aggregator runs.
 */
export function buildFeedbackBuckets(
  rows: MinimalFeedbackRow[],
): FeedbackBucket[] {
  const map = new Map<string, FeedbackBucket>();
  for (const row of rows) {
    const targetType = row.targetType ?? "recommendation";
    const key = [
      targetType,
      row.recommendationSeverity,
      row.metricSourceType,
      row.providerType,
      row.promptVersion,
    ].join("\x01");
    const existing = map.get(key);
    if (existing) {
      if (row.helpful) existing.helpful += 1;
      else existing.notHelpful += 1;
      existing.total += 1;
    } else {
      map.set(key, {
        severity: row.recommendationSeverity,
        metricSourceType: row.metricSourceType,
        providerType: row.providerType,
        promptVersion: row.promptVersion,
        helpful: row.helpful ? 1 : 0,
        notHelpful: row.helpful ? 0 : 1,
        total: 1,
        helpfulRate: 0,
        targetType,
      });
    }
  }

  const buckets = [...map.values()];
  for (const b of buckets) {
    b.helpfulRate =
      b.total === 0 ? 0 : Math.round((b.helpful / b.total) * 100) / 100;
  }

  buckets.sort((a, b) => {
    return (
      a.targetType.localeCompare(b.targetType) ||
      a.severity.localeCompare(b.severity) ||
      a.metricSourceType.localeCompare(b.metricSourceType) ||
      a.providerType.localeCompare(b.providerType) ||
      a.promptVersion.localeCompare(b.promptVersion)
    );
  });

  return buckets;
}

/**
 * v1.4.23 — derive the Coach-only bucket view from the unified
 * recommendation feedback rows. The Coach route writes the user's
 * active prefs into `metricSourceType` as
 * `coach:tone=<x>:verbosity=<y>`; this helper parses that back out so
 * the admin dashboard can group on the typed dimensions without
 * re-running a regex per row.
 *
 * Rows whose `targetType !== "coach"` are ignored. Rows whose
 * `metricSourceType` does not match the encoded shape land under
 * `tone=unknown:verbosity=unknown` so an early-write pre-migration row
 * still contributes to a bucket rather than silently dropping.
 */
export function buildCoachFeedbackBuckets(
  rows: MinimalFeedbackRow[],
): CoachFeedbackBucket[] {
  const map = new Map<string, CoachFeedbackBucket>();
  for (const row of rows) {
    if ((row.targetType ?? "recommendation") !== "coach") continue;
    const { tone, verbosity } = parseCoachMetricSource(row.metricSourceType);
    const key = `${row.promptVersion}|${tone}|${verbosity}`;
    const existing = map.get(key);
    if (existing) {
      if (row.helpful) existing.helpful += 1;
      else existing.notHelpful += 1;
      existing.total += 1;
    } else {
      map.set(key, {
        promptVersion: row.promptVersion,
        tone,
        verbosity,
        helpful: row.helpful ? 1 : 0,
        notHelpful: row.helpful ? 0 : 1,
        total: 1,
        helpfulRate: 0,
      });
    }
  }
  const buckets = [...map.values()];
  for (const b of buckets) {
    b.helpfulRate =
      b.total === 0 ? 0 : Math.round((b.helpful / b.total) * 100) / 100;
  }
  buckets.sort(
    (a, b) =>
      a.promptVersion.localeCompare(b.promptVersion) ||
      a.tone.localeCompare(b.tone) ||
      a.verbosity.localeCompare(b.verbosity),
  );
  return buckets;
}

const COACH_METRIC_SOURCE_RE = /^coach:tone=([^:]+):verbosity=([^:]+)$/;

function parseCoachMetricSource(metricSourceType: string): {
  tone: string;
  verbosity: string;
} {
  const match = metricSourceType.match(COACH_METRIC_SOURCE_RE);
  if (!match) return { tone: "unknown", verbosity: "unknown" };
  return { tone: match[1], verbosity: match[2] };
}

export interface AggregateOptions {
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /** Override the rolling window. Defaults to 30 days. */
  windowDays?: number;
}

/**
 * Read the rolling-window feedback rows, bucket them, and persist the
 * summary to the singleton AppSettings row. Returns the summary so
 * callers (the worker handler, ad-hoc admin tools) can log a digest.
 */
export async function aggregateRecommendationFeedback(
  prisma: PrismaClient,
  options: AggregateOptions = {},
): Promise<FeedbackAggregationSummary> {
  const now = options.now ?? new Date();
  const windowDays =
    options.windowDays ?? DEFAULT_FEEDBACK_AGGREGATION_WINDOW_DAYS;
  const since = new Date(now.getTime() - windowDays * 86_400_000);

  const rows = await prisma.recommendationFeedback.findMany({
    where: { createdAt: { gte: since } },
    select: {
      recommendationSeverity: true,
      metricSourceType: true,
      providerType: true,
      promptVersion: true,
      helpful: true,
      targetType: true,
    },
  });

  const summary: FeedbackAggregationSummary = {
    generatedAt: now.toISOString(),
    windowDays,
    buckets: buildFeedbackBuckets(rows),
    coachBuckets: buildCoachFeedbackBuckets(rows),
  };

  // The singleton AppSettings row is auto-created on first install
  // (`/admin/general` already touches it). Use upsert so the
  // aggregator works on a fresh DB during testcontainer integration
  // runs without depending on init ordering.
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {
      adminAiInsightsFeedbackSummary: summary as unknown as object,
    },
    create: {
      id: "singleton",
      adminAiInsightsFeedbackSummary: summary as unknown as object,
    },
  });

  return summary;
}
