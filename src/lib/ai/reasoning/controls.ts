/**
 * v1.41 — the reads behind a reasoning decision: the operator's two controls,
 * and the resolved Coach state the account payload publishes.
 *
 * Server-only. The decision itself is the pure `resolveReasoning` in
 * `./resolve.ts`; this file only gathers its inputs.
 */
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { memoizePerRequest } from "@/lib/request-cache";
import { isAnthropicBaseUrl, probeProviderChain } from "@/lib/ai/provider";
import { isOperatorFundedProvider } from "@/lib/ai/coach/budget";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import type { ProviderWorkAuthority } from "@/lib/sharing/provider-work-authority";
import type { CompletionParams } from "@/lib/ai/types";
import {
  coachReasoningLevel,
  type CoachPrefs,
} from "@/lib/validations/coach-prefs";

import type { BackgroundReasoningJob } from "./levels";
import {
  coachReasoningCeiling,
  completionReasoning,
  parseReasoningMaxEffort,
  reasoningSupportForChainEntry,
  resolveReasoning,
  type CoachReasoningState,
  type ReasoningAdminControls,
  type ReasoningCostOwner,
} from "./resolve";

/**
 * Fails closed: an unreadable settings row reads as "reasoning off", so a
 * storage blip can never hand out reasoning the operator switched off. The
 * calls it affects still run, without reasoning.
 */
const UNREADABLE: ReasoningAdminControls = Object.freeze({
  enabled: false,
  maxEffort: "low",
});

/**
 * The operator's reasoning switch and cap. Memoised per request; read afresh
 * inside a background run, so switching reasoning off at 02:05 stops the
 * nightly pass that began at 02:00 for every account after the switch.
 */
export function loadReasoningControls(): Promise<ReasoningAdminControls> {
  return memoizePerRequest(
    "ai-reasoning-controls",
    async () => {
      try {
        const row = await prisma.appSettings.findUnique({
          where: { id: "singleton" },
          select: { aiReasoningEnabled: true, aiReasoningMaxEffort: true },
        });
        return {
          enabled: row?.aiReasoningEnabled ?? true,
          maxEffort: parseReasoningMaxEffort(row?.aiReasoningMaxEffort),
        };
      } catch {
        getEvent()?.addWarning(
          "Failed to load the reasoning controls; reasoning is off for this request",
        );
        return UNREADABLE;
      }
    },
    { freshInBackground: true },
  );
}

/** Who pays for a chain whose primary is `providerType` (`null`: none). */
function costOwnerOf(providerType: string | undefined): ReasoningCostOwner {
  return providerType === undefined ||
    isOperatorFundedProvider(providerType as ProviderChainType)
    ? "operator"
    : "user";
}

/**
 * Resolve the Coach reasoning state for the account payload. The preference is
 * the caller's own (Coach preferences belong to the person); the provider is
 * the record's, read through the memoised presence probe the `ai` block
 * already ran, plus one point read of the model columns.
 */
export async function loadCoachReasoningState(args: {
  prefs: CoachPrefs;
  recordId: string;
  authority: ProviderWorkAuthority | null;
}): Promise<CoachReasoningState> {
  const [admin, presence] = await Promise.all([
    loadReasoningControls(),
    probeProviderChain(args.recordId, args.authority),
  ]);
  const primary = presence.entries[0]?.providerType as
    ProviderChainType | undefined;
  const costOwner = costOwnerOf(primary);

  let support = null;
  if (primary !== undefined) {
    const [row, settings] = await Promise.all([
      prisma.user.findUnique({
        where: { id: args.recordId },
        select: { aiModel: true, aiCompatModel: true, aiCompatBaseUrl: true },
      }),
      primary === "admin-openai"
        ? prisma.appSettings.findUnique({
            where: { id: "singleton" },
            select: { adminAiModel: true, adminAiBaseUrl: true },
          })
        : Promise.resolve(null),
    ]);
    support = reasoningSupportForChainEntry(primary, {
      model: row?.aiModel,
      compatModel: row?.aiCompatModel,
      compatBaseUrl: row?.aiCompatBaseUrl,
      adminModel: settings?.adminAiModel,
      adminIsAnthropic: settings?.adminAiBaseUrl
        ? isAnthropicBaseUrl(settings.adminAiBaseUrl)
        : false,
    });
  }

  const preference = coachReasoningLevel(args.prefs);
  const resolved = resolveReasoning({
    surface: "coach",
    userPref: preference,
    admin,
    costOwner,
    support,
  });
  return {
    level: resolved.effort,
    preference,
    maxLevel: coachReasoningCeiling(admin, costOwner),
    available: admin.enabled && support !== null && support.effort,
    offIsReal: support?.offIsReal ?? true,
    source: resolved.source,
  };
}

/**
 * The reasoning one background call carries, or `undefined` for none.
 *
 * Only the jobs in `BACKGROUND_REASONING_JOBS` can ask; the operator's switch
 * and cap apply like everywhere else, the payer comes from the chain's
 * primary, and the provider's ability is left to the client (the model is not
 * known here, and every client sends nothing it cannot honour and learns a
 * refusal per endpoint). The decision is stamped on the wide event as meta,
 * never as an action: the job owns the action name.
 */
export async function resolveJobReasoning(
  job: BackgroundReasoningJob,
  chain: ReadonlyArray<{ providerType: ProviderChainType }>,
): Promise<CompletionParams["reasoning"]> {
  // Reasoning is an improvement to a job, never a precondition for it: any
  // failure here sends the call exactly as it went before reasoning existed.
  let resolved;
  try {
    resolved = resolveReasoning({
      surface: job,
      admin: await loadReasoningControls(),
      costOwner: costOwnerOf(chain[0]?.providerType),
    });
  } catch {
    return undefined;
  }
  annotate({
    meta: {
      ai_reasoning_job: job,
      ai_reasoning_effort: resolved.effort,
      ai_reasoning_source: resolved.source,
    },
  });
  return completionReasoning(resolved, job);
}
