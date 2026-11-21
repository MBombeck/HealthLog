/**
 * The pieces the comprehensive generator's steps share: the pre-provider
 * failure return, the scope-guarded cache commit, the reply parser, the
 * daily paragraph re-roll, the screen-repair correction, and the step types.
 */
import { withBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import { prisma } from "@/lib/db";
import type { AggregatedFeatures, SignalOfDay } from "@/lib/insights/features";
import { findUngroundedBriefingNumbers } from "@/lib/ai/briefing-grounding";
import type { OutboundReason } from "@/lib/ai/safety/outbound-screen";
import { getSelfContextTextForUser } from "@/lib/ai/coach/about-me";
import type { Prisma } from "@/generated/prisma/client";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import type { resolveProviderChain } from "@/lib/ai/provider";
import { runBriefingCompletion } from "@/lib/insights/briefing-provider";
import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";
import {
  stripJsonFences,
  type SupportedLocale,
} from "@/lib/insights/status-shared";
import { annotate } from "@/lib/logging/context";
import { resolveInsightsMaxTokens } from "@/lib/ai/ai-budgets";
import { recordBriefingFailure } from "@/lib/insights/briefing-failure-marker";
import type { GenerateOutcome } from "@/lib/insights/comprehensive-generate";

/** A step either stops the generation with an outcome or hands on its result. */
export type StepResult<T> = { stop: GenerateOutcome } | { next: T };

export type ProviderChain = Awaited<ReturnType<typeof resolveProviderChain>>;
export type BriefingReply = Awaited<
  ReturnType<typeof runBriefingCompletion>
>["result"];
export type ParsedInsight = NonNullable<
  ReturnType<typeof parseComprehensiveResult>
>;

/** The parsed reply and the provider that answered it. */
export interface ModelRun {
  insights: ParsedInsight;
  result: BriefingReply;
  workingProviderType: string;
}

/** A model run after the grounding gate. */
export interface GroundedRun extends ModelRun {
  briefingStrippedHard: boolean;
}

/**
 * Typed `failed` return for the pre-provider stages (feature
 * extraction / oversize payload). These paths used to return
 * `{ status: "failed" }` with NO annotation and NO failure marker: the
 * nightly cron counted them into its `failed` tally silently, and the
 * read path could not tell the user the last attempt failed. One helper
 * so every failure return is greppable under the same action name and
 * leaves a dated marker for the briefing card's honest empty state.
 */
export function failBeforeProvider(
  userId: string,
  locale: SupportedLocale,
  reason: "payload-too-large" | "features-error" | "aborted",
  err?: unknown,
): GenerateOutcome {
  const message =
    err instanceof Error
      ? err.message.slice(0, 240)
      : err != null
        ? String(err).slice(0, 240)
        : null;
  annotate({
    action: { name: "insights.generate.comprehensive_failed" },
    meta: { locale, reason, provider_status: null, provider_message: message },
  });
  void recordBriefingFailure({ userId, reason, locale });
  return { status: "failed", reason };
}

type InsightCommitResult =
  | "committed"
  | "scope-changed"
  | "profile-scope-changed"
  | "no-consent"
  | "unavailable";

/**
 * The exact User columns (besides `insightsPrivacyMode`, guarded
 * separately) that feed the generation prompt built above. Captured at the
 * same `dbUser` read that starts the generation and required to still
 * match at commit time.
 */
export type PromptScopeAtRead = {
  insightsExcludeMetrics: string[];
  gender: string | null;
  displayName: string | null;
};

/**
 * Recheck every user-controlled prompt scope immediately before a cache write.
 * The profile text identifies an authoritative profile-scope mismatch. The
 * guarded User columns below catch a privacy-mode / exclude-list / gender /
 * display-name change — the exact set of columns this generation's prompt
 * was built from — without keying on the broad `updatedAt` timestamp, which
 * a provider credential refresh (e.g. `resolveProviderChain()`'s token
 * maintenance) also advances and would otherwise false-positive here.
 *
 * The consent rule runs once more too, against the provider that answered
 * (`servedBy`, `null` for a timestamp-only stamp that writes no text), with a
 * fresh receipt read: a withdrawal that landed while the
 * call was in flight already purged the stored briefing, and this write would
 * bring it back.
 */
export async function commitInsightUnderScope(
  userId: string,
  modeAtRead: string,
  selfContextAtRead: string | null,
  promptScopeAtRead: PromptScopeAtRead,
  locale: SupportedLocale,
  servedBy: string | null,
  data: Prisma.UserUpdateInput,
): Promise<InsightCommitResult> {
  if (servedBy !== null) {
    const late = await aiEgressRefusal("briefing", userId, [servedBy]);
    if (late) {
      return late.reason === "consent_required" ? "no-consent" : "unavailable";
    }
  }
  const currentSelfContext = await getSelfContextTextForUser(userId, locale);
  if (currentSelfContext !== selfContextAtRead) {
    return "profile-scope-changed";
  }
  const res = await prisma.user.updateMany({
    where: {
      id: userId,
      insightsPrivacyMode: modeAtRead,
      insightsExcludeMetrics: {
        equals: promptScopeAtRead.insightsExcludeMetrics,
      },
      gender: promptScopeAtRead.gender,
      displayName: promptScopeAtRead.displayName,
    },
    data,
  });
  return res.count > 0 ? "committed" : "scope-changed";
}

export function scopeChangedSkip(
  result: InsightCommitResult,
  locale: SupportedLocale,
): GenerateOutcome | null {
  if (result === "committed") return null;
  annotate({
    action: { name: `insights.generate.${result.replaceAll("-", "_")}` },
    meta: { locale },
  });
  return { status: "skipped", reason: result };
}

/** Higher, seedless temperature for the daily-briefing phrasing re-roll. */
const BRIEFING_REROLL_TEMPERATURE = 0.6;

/** UTC YYYY-MM-DD calendar-day key gating the once-per-day briefing re-roll. */
export function buildRerollDateKey(at: Date = new Date()): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: internal once-per-day re-roll gate key, never shown
  return at.toISOString().slice(0, 10);
}

/**
 * Re-roll ONLY the daily-briefing paragraph on a hash-unchanged hit.
 *
 * Runs the same comprehensive prompt at a higher, seedless temperature, then
 * keeps the cached payload verbatim and swaps in just the freshly-generated
 * `dailyBriefing.paragraph`. So the structured findings stay byte-stable
 * (reference assessments, monotony is fine) while the prose the user reads at
 * the top of /insights varies day-over-day. Returns null on any miss (no
 * provider success, invalid JSON, no cached/new paragraph) so the caller
 * falls back to the plain timestamp refresh.
 */
export async function rerollBriefingParagraph(args: {
  userId: string;
  chain: Awaited<ReturnType<typeof resolveProviderChain>>;
  systemPrompt: string;
  userPrompt: string;
  cachedText: string;
  locale: SupportedLocale;
  /**
   * The pre-computed signals the briefing must match.
   * The reroll runs at a higher, seedless temperature for phrasing variety,
   * which is exactly the path most prone to drifting a restated number; the
   * fresh paragraph is rejected (caller keeps the cached one) when a number in
   * it does not trace to one of these figures.
   */
  signals: readonly SignalOfDay[] | null;
  /**
   * The full feature snapshot so the grounding gate also
   * admits numbers from the W8 aggregate blocks (glucose / labs / preventive-
   * care / workouts) the reroll may now cite.
   */
  features?: AggregatedFeatures | null;
  /**
   * The comparison snapshot the SAME `userPrompt` carries as its own section.
   * The gate walks it for authoritative figures too, so a rerolled paragraph
   * may narrate the comparison the prompt asked it to narrate.
   */
  comparison?: unknown;
  /**
   * The upstream provider timeout for this re-roll, resolved from the user's
   * response-timeout setting (falling back to the comprehensive budget). The
   * caller resolves it once and threads it in so the re-roll honours the same
   * slow-backend allowance the main generation does.
   */
  effectiveTimeoutMs: number;
  /** The caller's bound: a re-roll it gave up on sends nothing more. */
  signal?: AbortSignal;
}): Promise<{ text: string; providerType: string } | null> {
  let cached: Record<string, unknown>;
  try {
    cached = JSON.parse(args.cachedText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const cachedBriefing = cached.dailyBriefing;
  // Nothing to re-roll when the cached payload carries no briefing paragraph.
  if (
    cachedBriefing === null ||
    typeof cachedBriefing !== "object" ||
    typeof (cachedBriefing as { paragraph?: unknown }).paragraph !== "string"
  ) {
    return null;
  }

  let result;
  let providerType: string;
  try {
    const fallback = await runBriefingCompletion({
      userId: args.userId,
      chain: args.chain,
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      // Seedless on purpose: the seed would pin the same phrasing, which is
      // exactly what we are varying. Higher temperature for prose variety.
      temperature: BRIEFING_REROLL_TEMPERATURE,
      maxTokens: resolveInsightsMaxTokens(),
      // Wider upstream budget so the reasoning-heavy briefing
      // generation is not clipped at the client's 60 s default mid-stream.
      // Honours the per-user response-timeout setting (see caller).
      timeoutMs: args.effectiveTimeoutMs,
      signal: args.signal,
      stage: "reroll",
      // The re-roll is a fresh pass at the paragraph, so it may think
      // like the generation it replaces; the operator's switch still wins.
      reasoningJob: "daily_briefing",
    });
    result = fallback.result;
    providerType = fallback.workingProvider.providerType;
  } catch {
    // Includes `BriefingBudgetExceededError`: a user at the day's ceiling
    // simply does not get the phrasing re-roll. The caller falls through to
    // the plain timestamp refresh and keeps the cached paragraph.
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonFences(result.content)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const freshBriefing = parsed.dailyBriefing;
  const freshParagraph =
    freshBriefing && typeof freshBriefing === "object"
      ? (freshBriefing as { paragraph?: unknown }).paragraph
      : undefined;
  if (
    typeof freshParagraph !== "string" ||
    freshParagraph.trim().length === 0
  ) {
    return null;
  }

  // Grounding gate on the rerolled paragraph. The higher
  // seedless temperature can drift a restated figure ("+1.2 kg" → "+1.3 kg");
  // reject the reroll on any ungrounded number so the caller keeps the cached
  // (already-grounded) paragraph rather than swapping in a fabricated one.
  const rerollUngrounded = findUngroundedBriefingNumbers(
    { paragraph: freshParagraph },
    args.signals,
    args.features,
    args.comparison,
  );
  if (rerollUngrounded.length > 0) {
    return null;
  }

  // Keep the cached payload verbatim; swap in only the fresh paragraph.
  const mergedBriefing = {
    ...(cachedBriefing as Record<string, unknown>),
    paragraph: freshParagraph,
  };
  // A re-rolled paragraph is new text, so it carries a new generation
  // moment; the plain stamp refresh that a miss falls back to does not.
  const merged = withBriefingGeneratedAt(
    { ...cached, dailyBriefing: mergedBriefing },
    new Date(),
  );
  return { text: JSON.stringify(merged), providerType };
}

/**
 * Parse + (best-effort) validate a comprehensive provider reply. Returns the
 * parsed payload (validated when it matches `insightResultSchema`, which
 * keeps the richer optional blocks, else the raw object), or null when the reply
 * is not valid JSON even after fence-stripping. Null signals the caller to
 * run its one corrective retry.
 */
export function parseComprehensiveResult(
  content: string,
): InsightResult | Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(content));
  } catch {
    return null;
  }
  const validated = insightResultSchema.safeParse(parsed);
  return validated.success
    ? validated.data
    : (parsed as Record<string, unknown>);
}

/**
 * The correction the one screen repair is sent with. Names the contract the
 * first reply broke, never the sentence that broke it: the model gets the
 * rule, not its own words back.
 */
export function buildOutboundScreenCorrection(reason: OutboundReason): string {
  const rule =
    reason === "causal_claim"
      ? 'It stated that one measurement or habit CAUSES another. Describe co-occurrence and timing only ("was higher on days when", "tends to move together"); never say that something causes, drives, leads to or results in something else.'
      : reason === "dose_prescription"
        ? "It told the reader to take, change, stop or dose a medication. Never give a dose or a medication instruction; at most suggest discussing medication with their clinician."
        : "It gave a risk score, a probability of disease or a diagnosis. Never estimate risk or name a diagnosis; describe the readings and their trend only.";
  return `
Your previous reply was withheld by the safety screen. ${rule}

Re-write the whole JSON object with the same structure and the same numbers, changing only the wording that broke this rule. Return the full JSON object again.
`;
}
