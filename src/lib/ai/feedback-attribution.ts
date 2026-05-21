/**
 * v1.4.16 phase B5e — server-side resolver for the provider/prompt
 * attribution that gets stamped on every `RecommendationFeedback` row.
 *
 * The client cannot supply these fields — that would let any user
 * poison the daily aggregator's slice (`(severity x provider x prompt)
 * helpful-rate`) by claiming a thumbs-down was attributed to a rival
 * provider. So the API endpoint reads the user's most recent
 * `insights.generate` audit row, pulls `chainProviderType` (or its
 * legacy fallback `providerType`) plus the current `PROMPT_VERSION`
 * constant, and stamps those on the row.
 *
 * If no audit row exists yet (the user is rating a per-status insight
 * that pre-dates the comprehensive generate flow), we fall back to
 * "unknown" + the current PROMPT_VERSION so the row is still
 * persistable and the aggregator can group "unknown" separately.
 */
import { prisma } from "@/lib/db";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";

export interface FeedbackAttribution {
  providerType: string;
  promptVersion: string;
}

/** Default attribution when no `insights.generate` row exists yet. */
export const FEEDBACK_ATTRIBUTION_FALLBACK: Readonly<FeedbackAttribution> = {
  providerType: "unknown",
  promptVersion: PROMPT_VERSION,
};

interface AuditDetailsShape {
  providerType?: unknown;
  chainProviderType?: unknown;
}

function parseAuditDetails(raw: string | null): AuditDetailsShape {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object")
      return parsed as AuditDetailsShape;
  } catch {
    // Treat unparseable details as absent — the fallback applies.
  }
  return {};
}

/**
 * Pick provider attribution from a parsed audit-row details blob.
 * Priority: chainProviderType > providerType > "unknown".
 */
export function pickProviderType(details: AuditDetailsShape): string {
  if (typeof details.chainProviderType === "string") {
    return details.chainProviderType;
  }
  if (typeof details.providerType === "string") return details.providerType;
  return FEEDBACK_ATTRIBUTION_FALLBACK.providerType;
}

/**
 * Resolve the (providerType, promptVersion) tuple to stamp on a
 * `RecommendationFeedback` row. Reads the latest `insights.generate`
 * audit row for the user. Falls back to the safe defaults when no
 * audit row exists.
 */
export async function resolveFeedbackAttribution(
  userId: string,
): Promise<FeedbackAttribution> {
  const latest = await prisma.auditLog.findFirst({
    where: { userId, action: "insights.generate" },
    orderBy: { createdAt: "desc" },
    select: { details: true },
  });

  if (!latest) return { ...FEEDBACK_ATTRIBUTION_FALLBACK };

  const details = parseAuditDetails(latest.details);
  return {
    providerType: pickProviderType(details),
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * v1.4.23 H7 — attribution shape for a Coach assistant-message
 * thumbs row. The polymorphic `RecommendationFeedback` table reuses
 * its existing slots for Coach rows:
 *   - `recommendationId` carries the Coach message id
 *   - `coachMessageId` (added in 0042) FKs the source message so the
 *     prose stays encrypted-at-rest in `coach_messages`. The senior-
 *     dev review (Sr-H3) flagged the original H7 design that
 *     snapshotted decrypted prose into `recommendationText` as a
 *     silent break of the Coach surface's encryption invariant.
 *   - `recommendationText` is always NULL for coach rows
 *   - `recommendationSeverity` is always "coach" so dashboards can
 *     filter / group on the literal
 *   - `metricSourceType` encodes the user's active prefs at the
 *     moment of the rating: `coach:tone=warm:verbosity=default`. The
 *     aggregator buckets on this field so a future audit can slice
 *     helpful-rate per (tone, verbosity) without a join.
 *   - `metricSourceTimeRange` is always "single_message"
 *   - `target_type` is "coach"
 */
export interface CoachFeedbackAttribution extends FeedbackAttribution {
  metricSourceType: string;
}

function buildCoachMetricSourceType(
  tone: string,
  verbosity: string,
): string {
  return `coach:tone=${tone}:verbosity=${verbosity}`;
}

/**
 * Resolve the (providerType, promptVersion, metricSourceType) tuple
 * for a Coach feedback row. Reads the user's latest persisted
 * Coach assistant message to recover the providerType + promptVersion
 * stamped on it, and queries the user's active `coachPrefsJson` for
 * the tone/verbosity slice. Falls back to safe defaults when either
 * lookup misses.
 */
export async function resolveCoachFeedbackAttribution(
  userId: string,
  messageId: string,
): Promise<CoachFeedbackAttribution> {
  const [message, userRow] = await Promise.all([
    prisma.coachMessage.findFirst({
      where: { id: messageId, conversation: { userId } },
      select: { providerType: true, promptVersion: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { coachPrefsJson: true },
    }),
  ]);

  // Lazy-import to avoid circular imports — coach-prefs validation
  // doesn't depend on attribution but the inverse would create a cycle.
  const { parseCoachPrefs } = await import("@/lib/validations/coach-prefs");
  const prefs = parseCoachPrefs(userRow?.coachPrefsJson);

  return {
    providerType:
      message?.providerType ?? FEEDBACK_ATTRIBUTION_FALLBACK.providerType,
    promptVersion: message?.promptVersion ?? PROMPT_VERSION,
    metricSourceType: buildCoachMetricSourceType(prefs.tone, prefs.verbosity),
  };
}
