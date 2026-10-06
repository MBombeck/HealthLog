/**
 * Model-free turns.
 *
 * v1.41 — a tapped decision ("Yes, remember it" / "No", "Take on this plan"
 * / "Not now") is answered by the memory contract and one catalog line
 * (`runDecisionTurn`): no budget, no provider, an assistant message tagged
 * `decision`. The tap names only the message and the proposal; what is
 * saved or activated is read from what that message stored.
 *
 * A reuse chip ("as a chart", "as a table") is answered from
 * a table already stored on the conversation. No budget reservation and no
 * provider call; the capability and the rate limit still apply at the route.
 * Streams `step → token (caption) → provenance → result → followUps → done`
 * and persists an assistant message with `providerType: "reuse"`.
 *
 * The table is copied as it was stored: the same rows, the same columns,
 * marked with where it came from. Only the view changes: "as a chart" shows
 * the stored chart, "as a table" shows the table first and keeps the chart
 * for the toggle and the chip back to it.
 *
 * Answers null, before anything is written, when the stored table cannot be
 * served (withheld, unreadable, or no chart to show). The pipeline then runs
 * the turn through the model with the chip's context hint instead.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveModuleMap } from "@/lib/modules/gate";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import type {
  CoachProvenance,
  CoachResultTable,
  CoachStep,
} from "@/lib/ai/coach/types";
import { appendMessage, readMessageResults } from "@/lib/ai/coach/persistence";
import { isCoachDomainWithheld } from "@/lib/ai/coach/results/domain-module";
import {
  COACH_REUSE_CAPTION_KEY,
  COACH_STEP_LABEL_KEYS,
} from "@/lib/ai/coach/dialog-keys";
import { buildMethod } from "@/lib/ai/coach/method";
import { deriveFollowUps } from "@/lib/ai/coach/follow-ups/derive";
import type { ResolvedFollowUp } from "@/lib/ai/coach/follow-ups/resolve";
import { parseCoachPrefs } from "@/lib/validations/coach-prefs";
import { readCoachReach } from "@/lib/ai/coach/history-reach-read";
import { tableRangeWithinReach } from "@/lib/ai/coach/tools/executor";
import { createSseStream } from "@/lib/sse/create-stream";

import {
  COACH_MEMORY_KEYS,
  COACH_PLAN_KEYS,
} from "@/lib/ai/coach/memory/shared";
import {
  decideFactProposal,
  decidePlanProposal,
} from "@/lib/ai/coach/memory/contract";
import { readLatestMessages } from "@/lib/ai/coach/latest-messages";
import {
  coachMemoryNoteMetaSchema,
  coachPlanProposalMetaSchema,
} from "@/lib/ai/coach/stream-events";

import { persistUserTurn } from "./conversation";
import { toResultMeta } from "./provenance";
import { SSE_HEADERS, createTurnEmitter, emitReply } from "./sse";
import type { TurnConversation, TurnInput } from "./types";

/** The copy of a stored table this turn shows, or null when it cannot. */
async function copyStoredTable(args: {
  userId: string;
  conversationId: string;
  resolved: ResolvedFollowUp;
}): Promise<CoachResultTable | null> {
  const { userId, conversationId, resolved } = args;
  const { followUp, sourceMessageId } = resolved;
  const ref = followUp.anchor?.ref;
  if (!ref) return null;
  const modules = await resolveModuleMap(userId);
  const entries = await readMessageResults(
    userId,
    conversationId,
    sourceMessageId,
    (domain) => isCoachDomainWithheld(domain, modules),
  );
  const entry = entries?.find((candidate) => candidate.ref === ref);
  if (!entry || "withheld" in entry) return null;
  // A table reaching past the lookback limit set since it was made is not
  // shown again; the model turn that runs instead says why.
  const reach = await readCoachReach(userId);
  if (
    !tableRangeWithinReach(
      entry.source.window,
      entry.source.period ?? "current",
      reach,
    )
  ) {
    return null;
  }
  if (followUp.kind === "as_chart" && entry.chart === null) return null;
  // Only the view changes. "As a table" keeps the chart beside the table, so
  // the reply can offer the chart again.
  const { view: _view, ...stored } = entry;
  return {
    ...stored,
    ref: "r1",
    displayed: true,
    ...(followUp.kind === "as_table" && entry.chart !== null
      ? { view: "table" as const }
      : {}),
    reusedFrom: { messageId: sourceMessageId, ref },
  };
}

export async function runReuseTurn(args: {
  input: TurnInput;
  conversation: TurnConversation;
  resolved: ResolvedFollowUp;
}): Promise<Response | null> {
  const { input, conversation, resolved } = args;
  const { userId, locale } = input;
  const conversationId = conversation.conversationId;
  if (!resolved.followUp.reuse) return null;

  const table = await copyStoredTable({ userId, conversationId, resolved });
  if (!table) {
    annotate({
      action: { name: "coach.followUp.reuse_unavailable" },
      meta: { kind: resolved.followUp.kind },
    });
    return null;
  }

  await persistUserTurn(conversationId, input.message);

  const { t } = getServerTranslator(locale);
  const caption = t(COACH_REUSE_CAPTION_KEY);
  const { source } = table;
  const step: CoachStep = {
    id: "s1",
    tool: "show_result",
    labelKey: COACH_STEP_LABEL_KEYS.reuse,
    label: t(COACH_STEP_LABEL_KEYS.reuse),
    domain: source.domain,
    window: source.window,
    period: source.period,
    ...(source.granularity ? { granularity: source.granularity } : {}),
    status: "done",
    ...(resolved.sourceCount !== undefined
      ? { count: resolved.sourceCount }
      : {}),
    resultRef: table.ref,
  };
  const meta = toResultMeta(table);
  const prefsRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { coachPrefsJson: true },
  });
  const prefs = parseCoachPrefs(prefsRow?.coachPrefsJson);
  // The other view of the same table, if it has one. Nothing that would need
  // a read: a reuse turn reads nothing.
  const followUps = deriveFollowUps({
    results: [meta],
    steps: [step],
    inventory: null,
    proposals: [],
    forcedFinal: false,
    prefs,
    locale,
  });
  const method = buildMethod({ steps: [step], results: [meta], locale });
  const provenance: CoachProvenance = {
    windows: [],
    metrics: [],
    steps: [step],
    ...(method ? { method } : {}),
    results: [meta],
    ...(followUps.length > 0 ? { followUps } : {}),
  };
  const message = await appendMessage({
    conversationId,
    role: "assistant",
    content: caption,
    metricSource: provenance,
    providerType: "reuse",
    promptVersion: PROMPT_VERSION,
    results: [table],
  });
  annotate({
    action: { name: "coach.followUp.reused" },
    meta: { kind: resolved.followUp.kind, rows: table.rows.length },
  });

  const stream = createSseStream(async (controller) => {
    const emitter = createTurnEmitter(controller);
    if (!emitter.aborted()) emitter.emit({ type: "step", step });
    await emitReply(
      emitter,
      {
        ok: true,
        replyText: caption,
        provenance,
        suggestion: null,
        action: null,
        results: [table],
        followUps,
        clarification: null,
        messageId: message.id,
        totalTokens: 0,
        model: null,
      },
      conversationId,
    );
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * The reply a declined proposal gets. Pending keys: integration copies them
 * into the bundles with the rest of this release's strings.
 */
export const COACH_DECISION_DECLINED_KEYS = {
  memory: "insights.coach.memory.declined",
  plan: "insights.coach.plan.declined",
} as const;

/** The stored note and plan of a message, each held to its wire schema. */
function storedProposals(metricSourceJson: string | null): {
  proposalId: string | null;
  planId: string | null;
} {
  const none = { proposalId: null, planId: null };
  if (!metricSourceJson) return none;
  try {
    const raw = JSON.parse(metricSourceJson) as Record<string, unknown>;
    const note = coachMemoryNoteMetaSchema.safeParse(raw.memoryNote);
    const plan = coachPlanProposalMetaSchema.safeParse(raw.planProposal);
    return {
      proposalId:
        note.success && note.data.proposal
          ? (note.data.proposalId ?? null)
          : null,
      planId: plan.success ? plan.data.planId : null,
    };
  } catch {
    return none;
  }
}

/**
 * Answer a tapped decision without a model, or null when it is not one this
 * conversation can take: the message is not the latest reply, it carried no
 * such proposal, or the contract reports it stale. The pipeline then runs
 * the tap's label as an ordinary message.
 */
export async function runDecisionTurn(args: {
  input: TurnInput;
  conversation: TurnConversation;
}): Promise<Response | null> {
  const { input, conversation } = args;
  const { userId, locale } = input;
  const conversationId = conversation.conversationId;
  const memory = input.memoryDecision;
  const plan = memory ? undefined : input.planDecision;
  const decision = memory ?? plan;
  if (!decision || !input.conversationId) return null;

  let latest:
    Awaited<ReturnType<typeof readLatestMessages>>[number] | undefined;
  try {
    const rows = await (conversation.latestMessages?.() ??
      readLatestMessages(userId, conversationId));
    latest = rows.find((m) => m.providerType !== "cancelled");
  } catch {
    latest = undefined;
  }
  const stored =
    latest?.role === "assistant" && latest.id === decision.messageId
      ? storedProposals(latest.metricSourceJson)
      : null;
  const matches = memory
    ? stored?.proposalId === memory.proposalId
    : stored?.planId === plan?.planId;
  if (!stored || !matches) {
    annotate({
      action: { name: "coach.decision.stale" },
      meta: { kind: memory ? "memory" : "plan", reason: "not_latest" },
    });
    return null;
  }

  const { t } = getServerTranslator(locale);
  let reply: string;
  if (memory) {
    const outcome = await decideFactProposal({
      userId,
      conversationId,
      messageId: memory.messageId,
      proposalId: memory.proposalId,
      accept: memory.accept,
    }).catch(() => ({ kind: "stale" as const }));
    if (outcome.kind === "stale") return null;
    reply =
      outcome.kind === "saved"
        ? t(COACH_MEMORY_KEYS.confirmed)
        : t(COACH_DECISION_DECLINED_KEYS.memory);
  } else if (plan) {
    const outcome = await decidePlanProposal({
      userId,
      conversationId,
      messageId: plan.messageId,
      planId: plan.planId,
      accept: plan.accept,
    }).catch(() => ({ kind: "stale" as const }));
    if (outcome.kind === "stale") return null;
    reply =
      outcome.kind === "activated"
        ? t(COACH_PLAN_KEYS.confirmed, { days: outcome.reviewInDays })
        : t(COACH_DECISION_DECLINED_KEYS.plan);
  } else {
    return null;
  }

  await persistUserTurn(conversationId, input.message);
  const provenance: CoachProvenance = { windows: [], metrics: [] };
  const message = await appendMessage({
    conversationId,
    role: "assistant",
    content: reply,
    metricSource: provenance,
    providerType: "decision",
    promptVersion: PROMPT_VERSION,
  });
  annotate({
    action: { name: "coach.decision.answered" },
    meta: { kind: memory ? "memory" : "plan", accept: decision.accept },
  });

  const stream = createSseStream(async (controller) => {
    const emitter = createTurnEmitter(controller);
    await emitReply(
      emitter,
      {
        ok: true,
        replyText: reply,
        provenance,
        suggestion: null,
        action: null,
        results: [],
        followUps: [],
        clarification: null,
        messageId: message.id,
        totalTokens: 0,
        model: null,
      },
      conversationId,
    );
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
