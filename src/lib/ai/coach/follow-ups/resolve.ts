/**
 * Resolve a tapped follow-up chip (`followUp: { messageId, id }` on the
 * request) against what the server persisted: the chip must sit on the
 * conversation's latest assistant message. A reuse chip is answered from the
 * stored table without a model call; any other becomes a turn-context hint.
 * A chip that is no longer current degrades to a plain message.
 *
 * The request names only which chip was tapped. What the chip asks for (its
 * kind, domain, window, period, table) is read from the stored message, so
 * nothing the client sends can widen it.
 */
import type { z } from "zod/v4";

import {
  readLatestMessages,
  type LatestMessage,
  type LatestMessagesLoader,
} from "@/lib/ai/coach/latest-messages";
import { annotate } from "@/lib/logging/context";
import type { CoachFollowUp, CoachStep } from "@/lib/ai/coach/types";
import {
  coachFollowUpSchema,
  coachStepSchema,
} from "@/lib/ai/coach/stream-events";
import {
  formatPriorResultRef,
  type PriorResultTurn,
} from "@/lib/ai/coach/results/refs";

import { widerWindow } from "./catalog";

/** A chip that resolved: what it asks for, and how it is answered. */
export interface ResolvedFollowUp {
  sourceMessageId: string;
  followUp: CoachFollowUp;
  /**
   * A line for the turn context, on a chip answered by the model. A reuse
   * chip carries one too: it is the fallback when the stored table can no
   * longer be served and the turn goes to the model after all.
   */
  contextHint: string | null;
  /**
   * The readings the source reply counted for the chip's table, from its
   * stored step; absent when the step carried no count.
   */
  sourceCount?: number;
}

/** The chips and steps a stored reply carries, each parsed against its schema. */
function storedDialog(metricSourceJson: string | null): {
  followUps: CoachFollowUp[];
  steps: CoachStep[];
} {
  const none = { followUps: [], steps: [] };
  if (!metricSourceJson) return none;
  try {
    const raw = JSON.parse(metricSourceJson) as {
      followUps?: unknown;
      steps?: unknown;
    };
    const each = <T>(value: unknown, schema: z.ZodType<T>): T[] =>
      Array.isArray(value)
        ? value.flatMap((item) => {
            const parsed = schema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          })
        : [];
    return {
      followUps: each(raw.followUps, coachFollowUpSchema),
      steps: each(raw.steps, coachStepSchema),
    };
  } catch {
    return none;
  }
}

/** The `m<k>.r<n>` name the turn's context gives a stored table, if any. */
function priorName(
  sourceMessageId: string,
  ref: string | undefined,
  priorResults: readonly PriorResultTurn[],
): string | null {
  if (!ref) return null;
  const turn = priorResults.find((p) => p.messageId === sourceMessageId);
  if (!turn || !turn.results.some((meta) => meta.ref === ref)) return null;
  return formatPriorResultRef(turn.turnIndex, ref);
}

/**
 * The turn-context line for a chip answered by the model. Server-written
 * from the stored chip's enum fields only; null when the chip carries
 * nothing to act on.
 */
export function followUpContextHint(
  followUp: CoachFollowUp,
  tableName: string | null,
): string | null {
  const anchor = followUp.anchor;
  const from = tableName
    ? ` The table from your last answer is ${tableName}: use show_result for it, do not fetch it again.`
    : "";
  const lead = `FOLLOW-UP: the person tapped the ${followUp.kind} chip under your last answer.`;
  switch (followUp.kind) {
    case "as_chart":
    case "as_table": {
      if (!tableName) return null;
      const view = followUp.kind === "as_chart" ? "chart" : "table";
      return `${lead} Call show_result with ref ${tableName} and view ${view}; do not fetch it again.`;
    }
    case "previous_period":
    case "year_ago": {
      if (!anchor?.window) return null;
      const period = followUp.kind === "year_ago" ? "yearAgo" : "previous";
      const granularity = anchor.granularity
        ? ` granularity=${anchor.granularity}`
        : "";
      return `${lead} Fetch get_metric_table metric=${anchor.domain} window=${anchor.window} period=${period}${granularity} and compare it with the current period.${from}`;
    }
    case "widen_window": {
      const wider = anchor?.window ? widerWindow(anchor.window) : null;
      if (!anchor || !wider) return null;
      return `${lead} Fetch get_metric_table metric=${anchor.domain} window=${wider} and say what the longer view adds.${from}`;
    }
    case "related_metric": {
      if (!anchor) return null;
      const window = anchor.window ? ` window=${anchor.window}` : "";
      return `${lead} Fetch get_metric_table metric=${anchor.domain}${window} and describe it alongside what you already read. A pattern between two metrics is an association, never a cause.${from}`;
    }
    case "continue":
      // Answered with its own context lines (`continue.ts`).
      return null;
    case "change_assumption":
      // v1.41 — the contract is in place; no chip of this kind is offered yet.
      return null;
  }
}

export async function resolveFollowUp(args: {
  userId: string;
  conversationId: string | undefined;
  followUp: { messageId: string; id: string } | undefined;
  /** The tables earlier replies hold, named as the turn's context names them. */
  priorResults?: readonly PriorResultTurn[];
  /** The turn's shared read of the latest messages, when it has one. */
  latest?: LatestMessagesLoader;
}): Promise<ResolvedFollowUp | null> {
  const { userId, conversationId, followUp } = args;
  if (!followUp || !conversationId) return null;
  const stale = (reason: string) => {
    annotate({
      action: { name: "coach.followUp.stale" },
      meta: { reason },
    });
    return null;
  };
  let rows: LatestMessage[];
  try {
    rows = await (args.latest?.() ??
      readLatestMessages(userId, conversationId));
  } catch {
    return stale("unreadable");
  }
  // The chip must sit on the latest reply: an interrupted turn's empty
  // marker does not count as one.
  const latest = rows.find((m) => m.providerType !== "cancelled");
  if (
    !latest ||
    latest.role !== "assistant" ||
    latest.id !== followUp.messageId
  ) {
    return stale("not_latest");
  }
  const stored = storedDialog(latest.metricSourceJson);
  const chip = stored.followUps.find(
    (candidate) => candidate.id === followUp.id,
  );
  if (!chip) return stale("unknown_chip");
  const sourceCount = chip.anchor?.ref
    ? stored.steps.find((step) => step.resultRef === chip.anchor?.ref)?.count
    : undefined;

  const tableName = priorName(
    latest.id,
    chip.anchor?.ref,
    args.priorResults ?? [],
  );
  annotate({
    action: { name: "coach.followUp.resolved" },
    meta: { kind: chip.kind, reuse: chip.reuse, origin: chip.origin },
  });
  return {
    sourceMessageId: latest.id,
    followUp: chip,
    contextHint: followUpContextHint(chip, tableName),
    ...(sourceCount !== undefined ? { sourceCount } : {}),
  };
}
