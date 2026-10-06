/**
 * v1.41 — plans the Coach proposes in a turn, and the person's answer.
 *
 * When the person names a goal or agrees to a suggestion, the Coach calls
 * `propose_plan`: one if-then plan tied to one metric, with an optional
 * target and a review window of 7 to 56 days. The plan is written as
 * `proposed` (its text encrypted like every plan) and stays inert until the
 * person taps "Take on this plan": a plan is a commitment, so only the person
 * activates it. The answer arrives as `planDecision` on the chat request and
 * flips the plan to `active` (with its review date counted from the tap) or
 * `abandoned`.
 *
 * At most one proposal per answer and {@link MAX_OPEN_PLAN_PROPOSALS} open
 * proposals per person; an unanswered proposal lapses after
 * {@link PROPOSAL_EXPIRY_DAYS} days (`coach-reminder-sweep`).
 *
 * Plan text never reaches `annotate()`.
 *
 * Server-only.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

import { encryptToBytes, decryptFromBytes } from "../bytes-codec";
import { isNearDuplicate } from "../facts";
import { PLAN_FIELD_MAX_CHARS } from "../plans";
import type { CoachPlanProposal } from "../types";
import type {
  DecidePlanProposalArgs,
  DecidePlanProposalOutcome,
  ProposePlanArgs,
  ProposePlanOutcome,
} from "./contract";
import {
  MAX_OPEN_PLAN_PROPOSALS,
  PLAN_REVIEW_DAYS,
  PROPOSAL_EXPIRY_DAYS,
} from "./shared";

const MS_PER_DAY = 86_400_000;

/** A metric key as the plans store it: `WEIGHT`, `SLEEP`, `BLOOD_PRESSURE`. */
const METRIC_KEY = /^[A-Z][A-Z0-9_]{1,59}$/;

function clean(text: string | undefined): string | null {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length >= 2 && flat.length <= PLAN_FIELD_MAX_CHARS ? flat : null;
}

/** The review window, clamped into {@link PLAN_REVIEW_DAYS}. */
export function clampReviewDays(days: number): number {
  const whole = Number.isFinite(days) ? Math.round(days) : PLAN_REVIEW_DAYS.min;
  return Math.min(PLAN_REVIEW_DAYS.max, Math.max(PLAN_REVIEW_DAYS.min, whole));
}

function decryptOrNull(buf: Uint8Array | null): string | null {
  if (!buf) return null;
  try {
    return decryptFromBytes(buf);
  } catch {
    return null;
  }
}

/** Runs a `propose_plan` call: writes the plan as `proposed`. */
export async function proposePlanFromTool(
  args: ProposePlanArgs,
): Promise<ProposePlanOutcome> {
  const outcome = await runPropose(args);
  annotate({
    action: { name: "coach.plans.proposed" },
    meta:
      outcome.kind === "proposed"
        ? {
            outcome: "proposed",
            metric: outcome.proposal.metric,
            reviewInDays: outcome.proposal.reviewInDays,
          }
        : { outcome: "declined", reason: outcome.reason },
  });
  return outcome;
}

async function runPropose(args: ProposePlanArgs): Promise<ProposePlanOutcome> {
  const { userId, conversationId, call } = args;
  const metric =
    typeof call.metric === "string"
      ? call.metric
          .trim()
          .toUpperCase()
          .replace(/[\s-]+/g, "_")
      : "";
  const ifCue = clean(call.ifCue);
  const thenAction = clean(call.thenAction);
  const target = call.target === undefined ? null : clean(call.target);
  if (
    !METRIC_KEY.test(metric) ||
    ifCue === null ||
    thenAction === null ||
    (call.target !== undefined && target === null)
  ) {
    return { kind: "declined", reason: "invalid" };
  }
  const reviewInDays = clampReviewDays(call.reviewInDays);
  const now = new Date();

  const turnStart = await prisma.coachMessage.findFirst({
    where: { conversationId, role: "user", conversation: { userId } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!turnStart) return { kind: "declined", reason: "unavailable" };

  const open = await prisma.coachPlan.findMany({
    where: {
      userId,
      deletedAt: null,
      status: { in: ["proposed", "active"] },
    },
    select: {
      id: true,
      status: true,
      ifCueEncrypted: true,
      thenActionEncrypted: true,
      sourceConversationId: true,
      createdAt: true,
    },
  });

  // One proposal per answer: a plan this conversation proposed since the
  // person's message the turn answers.
  if (
    open.some(
      (plan) =>
        plan.status === "proposed" &&
        plan.sourceConversationId === conversationId &&
        plan.createdAt >= turnStart.createdAt,
    )
  ) {
    return { kind: "declined", reason: "one_per_answer" };
  }

  const signature = `${ifCue} ${thenAction}`;
  const known = open.some((plan) => {
    const cue = decryptOrNull(plan.ifCueEncrypted);
    const action = decryptOrNull(plan.thenActionEncrypted);
    return (
      cue !== null &&
      action !== null &&
      isNearDuplicate(signature, [`${cue} ${action}`])
    );
  });
  if (known) return { kind: "declined", reason: "invalid" };

  const lapse = new Date(now.getTime() - PROPOSAL_EXPIRY_DAYS * MS_PER_DAY);
  const openProposals = open.filter(
    (plan) => plan.status === "proposed" && plan.createdAt >= lapse,
  ).length;
  if (openProposals >= MAX_OPEN_PLAN_PROPOSALS) {
    return { kind: "declined", reason: "too_many_open" };
  }

  // Field-by-field (no mass assignment). `reviewDate` holds the proposed
  // window until the person decides; the sweep only reviews active plans.
  const row = await prisma.coachPlan.create({
    data: {
      userId,
      metric,
      ifCueEncrypted: encryptToBytes(ifCue),
      thenActionEncrypted: encryptToBytes(thenAction),
      targetEncrypted: target ? encryptToBytes(target) : null,
      status: "proposed",
      reviewDate: new Date(now.getTime() + reviewInDays * MS_PER_DAY),
      sourceConversationId: conversationId,
    },
    select: { id: true },
  });
  const proposal: CoachPlanProposal = {
    planId: row.id,
    metric,
    reviewInDays,
    ifCue,
    thenAction,
    ...(target ? { target } : {}),
  };
  return { kind: "proposed", proposal };
}

/** The `planProposal` an assistant message carries in its stored metadata. */
function proposedPlanId(metricSourceJson: string | null): string | null {
  if (!metricSourceJson) return null;
  try {
    const parsed = JSON.parse(metricSourceJson) as {
      planProposal?: { planId?: unknown };
    };
    const id = parsed?.planProposal?.planId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Answers a plan proposal: `active` on accept, `abandoned` on decline. Only a
 * plan the assistant message proposed, and only the person's own.
 */
export async function decidePlanProposal(
  args: DecidePlanProposalArgs,
): Promise<DecidePlanProposalOutcome> {
  const outcome = await runDecide(args).catch(
    (): DecidePlanProposalOutcome => ({ kind: "stale" }),
  );
  annotate({
    action: { name: "coach.plans.decided" },
    meta: { accept: args.accept, outcome: outcome.kind },
  });
  return outcome;
}

async function runDecide(
  args: DecidePlanProposalArgs,
): Promise<DecidePlanProposalOutcome> {
  const { userId, conversationId, messageId, planId, accept } = args;
  const message = await prisma.coachMessage.findFirst({
    where: {
      id: messageId,
      conversationId,
      role: "assistant",
      conversation: { userId },
    },
    select: { metricSourceJson: true },
  });
  if (!message || proposedPlanId(message.metricSourceJson) !== planId) {
    return { kind: "stale" };
  }
  const plan = await prisma.coachPlan.findFirst({
    where: { id: planId, userId, deletedAt: null, status: "proposed" },
    select: { createdAt: true, reviewDate: true },
  });
  if (!plan) return { kind: "stale" };

  const now = new Date();
  if (!accept) {
    const { count } = await prisma.coachPlan.updateMany({
      where: { id: planId, userId, deletedAt: null, status: "proposed" },
      data: { status: "abandoned", reviewDate: null },
    });
    return count > 0 ? { kind: "abandoned" } : { kind: "stale" };
  }

  // The window the Coach proposed, counted from the tap.
  const reviewInDays = clampReviewDays(
    plan.reviewDate
      ? (plan.reviewDate.getTime() - plan.createdAt.getTime()) / MS_PER_DAY
      : PLAN_REVIEW_DAYS.min,
  );
  const { count } = await prisma.coachPlan.updateMany({
    where: { id: planId, userId, deletedAt: null, status: "proposed" },
    data: {
      status: "active",
      reviewDate: new Date(now.getTime() + reviewInDays * MS_PER_DAY),
    },
  });
  return count > 0 ? { kind: "activated", reviewInDays } : { kind: "stale" };
}
