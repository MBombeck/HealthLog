/**
 * v1.11.1 — worker pipeline for the combined Coach memory-refresh queue.
 *
 * Runs the background generators for one conversation, sequentially so they
 * share the wake-up: the rolling conversation summary first, then durable fact
 * extraction, then plan proposals. Each step is fault-isolated — a failure or
 * no-provider in one never sinks the others or the job. Kept out of the route
 * bundle (the route imports only `enqueueCoachMemoryRefresh` from
 * `coach-memory-shared`).
 *
 * v1.41 — the job runs once the conversation has been quiet for
 * `COACH_MEMORY_QUIET_MS`. Woken while the conversation is still going (a
 * turn landed after the job was queued), it puts itself back for the rest of
 * the quiet time and does no model work.
 *
 * Both steps reserve and reconcile against the caller's daily token ledger
 * inside `runStatusCompletion`, so this off-request work is metered on the same
 * `coach_usage` row as the chat turn that triggered it, against the ceiling
 * that matches the chain's cost owner. This comment previously asserted the
 * same guarantee while no such accounting existed anywhere on the path — the
 * chokepoint did no budget work at all, so every generator behind it, not just
 * these two, spent unmetered.
 */
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

import {
  COACH_MEMORY_QUIET_MS,
  enqueueCoachMemoryRefresh,
  type CoachMemoryRefreshPayload,
} from "./coach-memory-shared";
import { extractAndStoreFacts } from "./facts";
import { extractAndStorePlanProposals } from "./plans";
import { refreshConversationSummary } from "./conversation-summary";

/**
 * How long ago the conversation's newest message was written, or null when the
 * conversation is gone (deleted, or not this person's).
 */
async function quietForMs(
  conversationId: string,
  userId: string,
  now: Date,
): Promise<number | null> {
  const newest = await prisma.coachMessage.findFirst({
    where: { conversationId, conversation: { userId } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return newest ? now.getTime() - newest.createdAt.getTime() : null;
}

export async function runCoachMemoryRefresh(
  payload: CoachMemoryRefreshPayload,
  now: Date = new Date(),
): Promise<void> {
  const { conversationId, userId } = payload;
  // A payload without a locale (an older queued job) composes ENGLISH memory,
  // not German — the memory prose is model-facing context and English is the
  // fallback body for every locale that has no reviewed one.
  const locale = payload.locale ?? "en";

  const quiet = await quietForMs(conversationId, userId, now);
  if (quiet === null) {
    annotate({
      action: { name: "coach.memory.refresh.skipped" },
      meta: { reason: "no_conversation" },
    });
    return;
  }
  if (quiet < COACH_MEMORY_QUIET_MS) {
    await enqueueCoachMemoryRefresh(
      { conversationId, userId, locale },
      COACH_MEMORY_QUIET_MS - quiet,
    );
    annotate({
      action: { name: "coach.memory.refresh.deferred" },
      meta: { quietSeconds: Math.round(quiet / 1000) },
    });
    return;
  }

  // The `coach` capability before any transcript is read. The chat route that
  // enqueued this admitted the Coach, but the operator, the person's Coach
  // switch or a consent can change while the job waits. Stored memory stays
  // as it is; only new model work stops. The chokepoint re-checks per step.
  const capability = await aiCapabilityForJob(userId, "coach");
  if (!capability.available) {
    annotate({
      action: { name: "coach.memory.refresh.skipped" },
      meta: { reason: capability.reason },
    });
    return;
  }

  let summaryStatus = "error";
  try {
    const result = await refreshConversationSummary(conversationId, userId, {
      locale,
    });
    summaryStatus = result.status;
  } catch (err) {
    annotate({
      action: { name: "coach.memory.refresh.summary_failed" },
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  let factsStatus = "error";
  let factsCount = 0;
  try {
    const result = await extractAndStoreFacts(conversationId, userId, {
      locale,
    });
    factsStatus = result.status;
    factsCount = result.count;
  } catch (err) {
    annotate({
      action: { name: "coach.memory.refresh.facts_failed" },
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // v1.21.3 (B1) — durable goal / if-then plan proposals. Same worker pass
  // (no separate pg-boss queue), fault-isolated like the facts step: a failure
  // or no-provider here never sinks the summary / facts work or the job. Plans
  // are written as `proposed`; the user confirms them through the PATCH route.
  let plansStatus = "error";
  let plansCount = 0;
  try {
    const result = await extractAndStorePlanProposals(conversationId, userId, {
      locale,
    });
    plansStatus = result.status;
    plansCount = result.count;
  } catch (err) {
    annotate({
      action: { name: "coach.memory.refresh.plans_failed" },
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  annotate({
    action: { name: "coach.memory.refresh.done" },
    meta: { summaryStatus, factsStatus, factsCount, plansStatus, plansCount },
  });
}
