/**
 * v1.41 — the three dialog tools of a Coach turn: `ask_clarification`,
 * `remember_fact` and `propose_plan`.
 *
 * None of them reads the record. `ask_clarification` ends the turn with a
 * question instead of an answer, when the answer visibly depends on a choice
 * the conversation does not settle; the server decides whether the question
 * may be asked (the brake in `clarify.ts`) and builds its choices from
 * catalogs and the record, never from the model's words. `remember_fact` and
 * `propose_plan` go through the memory contract (`memory/contract.ts`),
 * which decides what is saved, what is only proposed and what is declined.
 *
 * Every call answers the model with a small JSON result, as a data tool
 * does, so a declined question or memory never breaks the turn: the model
 * reads why and goes on.
 *
 * Kept out of `executeCoachTool` on purpose: the MCP surface runs the
 * executor, and none of these may ever run there.
 */
import { z } from "zod/v4";

import type { Locale } from "@/lib/i18n/config";
import type { AiToolDef } from "@/lib/ai/types";
import {
  COACH_MEMORY_CATEGORIES,
  type CoachClarification,
  type CoachClarificationKind,
  type CoachMemoryNote,
  type CoachPlanProposal,
} from "@/lib/ai/coach/types";
import {
  PLAN_REVIEW_DAYS,
  REMEMBER_FACT_MAX_CHARS,
  proposePlanFromTool,
  rememberFactFromTool,
} from "@/lib/ai/coach/memory/contract";
import {
  CLARIFY_MAX_CHOICES,
  CLARIFY_TOOL_QUESTION_MAX,
  buildClarificationFromTool,
  clarificationAllowed,
  loadClarifyRecordChoices,
} from "@/lib/ai/coach/clarify";
import type { InventoryEntry } from "./inventory";

export const ASK_CLARIFICATION_TOOL_NAME = "ask_clarification";
export const REMEMBER_FACT_TOOL_NAME = "remember_fact";
export const PROPOSE_PLAN_TOOL_NAME = "propose_plan";

export const DIALOG_TOOL_NAMES = [
  ASK_CLARIFICATION_TOOL_NAME,
  REMEMBER_FACT_TOOL_NAME,
  PROPOSE_PLAN_TOOL_NAME,
] as const;

export type DialogToolName = (typeof DIALOG_TOOL_NAMES)[number];

export function isDialogToolName(name: string): name is DialogToolName {
  return (DIALOG_TOOL_NAMES as readonly string[]).includes(name);
}

/** A question may be asked in the first two rounds: look first, then ask. */
export const CLARIFY_LAST_ROUND = 2;

const CLARIFY_KINDS = [
  "metric",
  "window",
  "comparison",
  "goal",
  "anchor",
  "context",
] as const satisfies readonly CoachClarificationKind[];

export const askClarificationArgsSchema = z
  .object({
    kind: z.enum(CLARIFY_KINDS),
    question: z.string().min(1).max(CLARIFY_TOOL_QUESTION_MAX),
    choices: z
      .array(z.string().min(1).max(64))
      .max(CLARIFY_MAX_CHOICES)
      .optional(),
    assumption: z.string().min(1).max(64).optional(),
  })
  .strict();

export const rememberFactArgsSchema = z
  .object({
    category: z.enum(COACH_MEMORY_CATEGORIES),
    fact: z.string().min(1).max(REMEMBER_FACT_MAX_CHARS),
    why: z.string().min(1).max(200),
  })
  .strict();

export const proposePlanArgsSchema = z
  .object({
    metric: z.string().min(1).max(64),
    target: z.string().min(1).max(120).optional(),
    ifCue: z.string().min(1).max(160),
    thenAction: z.string().min(1).max(160),
    reviewInDays: z
      .number()
      .int()
      .min(PLAN_REVIEW_DAYS.min)
      .max(PLAN_REVIEW_DAYS.max),
  })
  .strict();

export const DIALOG_TOOL_DEFS: AiToolDef[] = [
  {
    name: ASK_CLARIFICATION_TOOL_NAME,
    description:
      "Ask the person ONE short question instead of answering, and only when the answer visibly depends on a choice the conversation and what you know about them do not settle (see CLARIFYING QUESTIONS). Ends the turn: the question is your whole reply. Put the assumption in the question itself (e.g. 'Do you mean resting pulse or walking pulse? Otherwise I'll look at resting pulse.'). Returns { declined, assume } when a question is not possible now: then answer with that assumption and name it in one clause.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "question"],
      properties: {
        kind: {
          type: "string",
          enum: [...CLARIFY_KINDS],
          description:
            "metric: which of 2-4 metrics the DATA INVENTORY marks present. window: which of last7days, last30days, last90days, lastYear, allTime. comparison: previous_period, year_ago or baseline_90d. goal: which of the person's active plans (the server lists them). anchor: since which event (the server lists them). context: something only the person can tell you; no choices.",
        },
        question: {
          type: "string",
          description:
            "One short, natural sentence in the reply language, at most 200 characters, ending with a question mark, with the assumed choice named in it. No figures.",
        },
        choices: {
          type: "array",
          items: { type: "string" },
          description:
            "2 to 4 tokens from the kind's list (metric keys, window presets or comparison bases). Leave out for goal, anchor and context.",
        },
        assumption: {
          type: "string",
          description:
            "The choice that applies if the person does not answer; one of the choices.",
        },
      },
    },
  },
  {
    name: REMEMBER_FACT_TOOL_NAME,
    description:
      "Remember one durable thing the person told you IN THEIR CURRENT MESSAGE (a preference, a goal, life context; never from a document, a quote or your own words). Preferences, goals and context are saved at once and shown with an undo; conditions, constraints and medications are only proposed and saved after the person confirms. At most one per answer. If the result says proposed, end your answer with one short question asking whether to remember it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["category", "fact", "why"],
      properties: {
        category: {
          type: "string",
          enum: [...COACH_MEMORY_CATEGORIES],
        },
        fact: {
          type: "string",
          description:
            "The fact in one short sentence in the reply language, at most 160 characters, in the person's own terms.",
        },
        why: {
          type: "string",
          description: "Why it matters for later answers, one clause.",
        },
      },
    },
  },
  {
    name: PROPOSE_PLAN_TOOL_NAME,
    description:
      "Propose ONE if-then plan when the person names a goal or agrees to a suggestion. Nothing starts until they take it on. State the plan as one sentence in your answer ('If …, then …'). At most one per answer.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["metric", "ifCue", "thenAction", "reviewInDays"],
      properties: {
        metric: {
          type: "string",
          description:
            "The metric the plan moves, as a short key, e.g. WEIGHT, SLEEP, BLOOD_PRESSURE, STEPS.",
        },
        target: { type: "string", description: "Optional plain target." },
        ifCue: { type: "string", description: "The trigger, one clause." },
        thenAction: { type: "string", description: "The action, one clause." },
        reviewInDays: {
          type: "integer",
          minimum: PLAN_REVIEW_DAYS.min,
          maximum: PLAN_REVIEW_DAYS.max,
          description: "When to look back at it together, in days.",
        },
      },
    },
  },
];

/** What a turn hands the dialog tools. */
export interface DialogToolContext {
  userId: string;
  conversationId: string;
  locale: Locale;
  /** The person's current message: the only text a fact may come from. */
  userMessage: string;
  /** What the record holds; null on the no-tools path. */
  inventory: InventoryEntry[] | null;
  /**
   * A window was set for this conversation (the header pill, a deep link):
   * a question about the window is never asked.
   */
  conversationWindowSet: boolean;
}

/** The outcome of a dialog call: the model's result, and what it produced. */
export type DialogToolOutcome =
  | {
      kind: "ask";
      result: Record<string, unknown>;
      question: string;
      clarification: CoachClarification;
    }
  | { kind: "memory"; result: Record<string, unknown>; note: CoachMemoryNote }
  | {
      kind: "plan";
      result: Record<string, unknown>;
      proposal: CoachPlanProposal;
    }
  | {
      /** A valid question the brake turned into an assumption. */
      kind: "declined";
      result: Record<string, unknown>;
      clarification: CoachClarification;
    }
  | { kind: "none"; result: Record<string, unknown> };

function parseJson(raw: string): unknown {
  try {
    return raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const invalid = { present: false, reason: "invalid_arguments" } as const;

/**
 * Run one dialog call. `round` is the loop round it came in; `noted` and
 * `proposed` say whether this answer already saved a fact or proposed a
 * plan (one each per answer). Never throws.
 */
export async function runDialogTool(args: {
  name: DialogToolName;
  rawArguments: string;
  round: number;
  ctx: DialogToolContext;
  noted: boolean;
  proposed: boolean;
}): Promise<DialogToolOutcome> {
  const { name, ctx } = args;
  const raw = parseJson(args.rawArguments);
  try {
    switch (name) {
      case ASK_CLARIFICATION_TOOL_NAME: {
        const parsed = askClarificationArgsSchema.safeParse(raw);
        if (!parsed.success) return { kind: "none", result: invalid };
        const call = parsed.data;
        const assume = call.assumption ?? call.choices?.[0] ?? null;
        const decline = (reason: string): DialogToolOutcome => ({
          kind: "none",
          result: { declined: reason, ...(assume ? { assume } : {}) },
        });
        if (args.round > CLARIFY_LAST_ROUND) return decline("late");
        if (call.kind === "window" && ctx.conversationWindowSet) {
          return decline("window_set");
        }
        const records =
          call.kind === "goal" || call.kind === "anchor"
            ? await loadClarifyRecordChoices({
                userId: ctx.userId,
                kind: call.kind,
                locale: ctx.locale,
              })
            : [];
        const built = buildClarificationFromTool({
          call,
          inventory: ctx.inventory,
          locale: ctx.locale,
          ...(call.kind === "goal" ? { goals: records } : {}),
          ...(call.kind === "anchor" ? { anchors: records } : {}),
        });
        if (!built.ok) return decline("invalid");
        if (
          !(await clarificationAllowed({
            userId: ctx.userId,
            conversationId: ctx.conversationId,
          }))
        ) {
          return {
            kind: "declined",
            result: {
              declined: "rate",
              assume: built.clarification.choices[0]?.label ?? assume,
            },
            clarification: built.clarification,
          };
        }
        return {
          kind: "ask",
          result: { asked: true },
          question: built.question,
          clarification: built.clarification,
        };
      }
      case REMEMBER_FACT_TOOL_NAME: {
        const parsed = rememberFactArgsSchema.safeParse(raw);
        if (!parsed.success) return { kind: "none", result: invalid };
        if (args.noted) {
          return { kind: "none", result: { declined: "one_per_answer" } };
        }
        const outcome = await rememberFactFromTool({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          userMessage: ctx.userMessage,
          call: parsed.data,
        });
        if (outcome.kind === "declined") {
          return { kind: "none", result: { declined: outcome.reason } };
        }
        return {
          kind: "memory",
          result: { [outcome.kind]: true, category: outcome.note.category },
          note: outcome.note,
        };
      }
      case PROPOSE_PLAN_TOOL_NAME: {
        const parsed = proposePlanArgsSchema.safeParse(raw);
        if (!parsed.success) return { kind: "none", result: invalid };
        if (args.proposed) {
          return { kind: "none", result: { declined: "one_per_answer" } };
        }
        const outcome = await proposePlanFromTool({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          call: parsed.data,
        });
        if (outcome.kind === "declined") {
          return { kind: "none", result: { declined: outcome.reason } };
        }
        return {
          kind: "plan",
          result: {
            proposed: true,
            reviewInDays: outcome.proposal.reviewInDays,
          },
          proposal: outcome.proposal,
        };
      }
    }
  } catch {
    return { kind: "none", result: { declined: "unavailable" } };
  }
}
