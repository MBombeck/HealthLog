/**
 * The Coach retrieval loop: model round → tool calls → results → the next
 * round, until the model answers in prose or the turn's budget says the
 * next round must be the answer.
 *
 * v1.41 — a budget instead of a fixed three rounds. A turn runs under the
 * token, time and round limits of whoever pays for it (`turn-budget.ts`), a
 * no-progress brake (`progress.ts`) and, round by round, the day's ledger
 * (`spend`, reserved before each round and settled after it). Whichever of
 * them stops the loop, the next round is the final one: sent with
 * `toolChoice: "none"`, with one line telling the model why, and the room
 * for it was held back from the start, so a turn always ends with an answer.
 * The final round still carries the tool definitions: the history holds the
 * earlier calls and their results, and Anthropic refuses a request with
 * `tool_use` / `tool_result` blocks that defines no tools (400). `none` with
 * the tools present is valid on every wire, thinking included, and keeps the
 * cached tools prefix warm.
 *
 * Each round is a NON-streaming completion over the fallback chain; the
 * clients read the provider's stream internally where it has one and report
 * reasoning summaries as they arrive (`onReasoning`), which the trail shows
 * live. The reasoning state a provider needs back between rounds rides the
 * assistant message (`providerState`) and is never kept anywhere else.
 *
 * Tool calls within a round run in parallel. Beside the read-only catalogue
 * the loop runs `compare_series` and the three dialog tools; neither is part
 * of the executor, which the MCP surface shares. A call that repeats an
 * earlier one of the turn is not run again: the model gets `duplicateOf`.
 *
 * A clarifying question ends the turn without a prose round: the question
 * is the reply.
 */
import { coachPromptCacheKey } from "@/lib/ai/coach/prompt-cache-key";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { runRawCompletionWithFallback } from "@/lib/ai/provider-runner";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import type {
  AiMessage,
  AiToolCall,
  AiToolDef,
  CompletionResult,
} from "@/lib/ai/types";
import type { ReasoningLevel } from "@/lib/ai/reasoning/levels";
import type { ProviderHealthLedger } from "@/lib/ai/provider-health-ledger";
import type {
  CoachClarification,
  CoachMemoryNote,
  CoachPlanProposal,
  CoachScope,
  CoachScopeWindow,
  CoachStop,
  CoachStopReason,
} from "@/lib/ai/coach/types";
import {
  createNoopActivityRecorder,
  type ActivityRecorder,
} from "@/lib/ai/coach/activity/contract";
import {
  simpleActivityLabel,
  stopActivityLabel,
} from "@/lib/ai/coach/activity/catalog";
import { screenCheckpoint } from "@/lib/ai/coach/activity/screen";
import { parseCoachToolArgs, type CoachToolName } from "./definitions";
import {
  executeCoachTool,
  type CoachToolResult,
  type CoachToolTrace,
  type CoachToolTurnContext,
} from "./executor";
import {
  COMPARE_SERIES_TOOL_NAME,
  compareSeriesArgsSchema,
  runCompareSeries,
} from "./compare-series";
import {
  ASK_CLARIFICATION_TOOL_NAME,
  PROPOSE_PLAN_TOOL_NAME,
  isDialogToolName,
  runDialogTool,
  type DialogToolContext,
} from "./dialog-tools";
import { callScope, callSignature, createProgressTracker } from "./progress";
import {
  createTurnBudget,
  estimateInputTokens,
  type TurnBudget,
} from "./turn-budget";

/**
 * The day's ledger, round by round (`turn/budget.ts`). Kept as callbacks so
 * the loop stays free of the database.
 */
export interface RoundSpend {
  /** Reserve the next round; false when the day's ceiling refuses it. */
  reserveRound(estimate: number): Promise<boolean>;
  /** Settle a finished round against what it reserved. */
  settleRound(usage: {
    tokens: number;
    cachedTokens: number;
    servedBy: ProviderChainType;
    final: boolean;
  }): Promise<void>;
}

/** What the trail is told about a call as it starts and as it settles. */
export interface LoopCallEvents {
  /**
   * Fired as each call starts. `index` counts calls across the whole turn
   * from 0, so it is stable for a step id. A throwing callback is swallowed:
   * progress reporting never breaks the loop.
   */
  onCallStart?: (call: AiToolCall, index: number, round: number) => void;
  /**
   * Fired once for every call that started, when its result is in: found,
   * missed, invalid or failed alike.
   */
  onCallSettled?: (
    call: AiToolCall,
    result: CoachToolResult,
    index: number,
    round: number,
  ) => void;
  /** Fired when every call of a round has settled. */
  onRoundSettled?: (round: number) => void;
}

export interface CoachToolLoopResult {
  /** The final completion (prose, or the question on a clarification). */
  result: CompletionResult;
  /** The working provider's type tag. */
  workingProviderType: string;
  /** Summed tokens across every round (for budget reconcile). */
  totalTokens: number;
  /** Summed cached-input tokens across every round. */
  cachedTokens: number;
  /** Number of model round-trips made. */
  rounds: number;
  /** Which tools ran + whether each found data (persisted onto provenance). */
  toolTrace: CoachToolTrace[];
  /**
   * The structured payloads of every tool result this turn that DELIVERED
   * figures, in call order, for the prose number-verifier: a present
   * result's `data`, or the `available` block an out-of-window miss carries.
   */
  toolResults: CoachToolResult[];
  /**
   * True when the answer was forced by the budget, the clock or the round
   * cap: the "keep looking" chip continues it. A no-progress stop is
   * forced too, but continuing it would only circle again.
   */
  forcedFinal: boolean;
  /** v1.41 — why the answer was forced, when it was. */
  stop?: CoachStop;
  /** v1.41 — the question, when the turn ended on one. */
  clarification?: { question: string; clarification: CoachClarification };
  /**
   * v1.41 — questions the brake turned into assumptions, for the
   * provenance. Absent when there were none.
   */
  declinedClarifications?: CoachClarification[];
  /** v1.41 — the fact this answer saved or proposes. */
  memoryNote?: CoachMemoryNote;
  /** v1.41 — the plan this answer proposes. */
  planProposal?: CoachPlanProposal;
}

/** v1.39.4 — a tool call to run before the first model round. */
interface CoachSeedCall {
  name: CoachToolName;
  args: Record<string, unknown>;
}

/** The line the final round is sent with, by why it is final. */
const FINAL_ROUND_LINE: Readonly<Record<CoachStopReason, string>> = {
  budget:
    "FINAL ROUND: this turn's token budget is spent. Answer now from the results you already have; name what is still missing in one clause. No tool calls.",
  time: "FINAL ROUND: this turn's time is up. Answer now from the results you already have; name what is still missing in one clause. No tool calls.",
  cap: "FINAL ROUND: this turn has used its rounds. Answer now from the results you already have; name what is still missing in one clause. No tool calls.",
  no_progress:
    "FINAL ROUND: the last calls brought nothing new. Answer now from the results you already have; name what could not be found in one clause. No tool calls.",
};

/** Tokens of text, for the budget's estimate of what the next round adds. */
function textTokens(value: string): number {
  return estimateInputTokens(value.length);
}

export async function runCoachToolLoop(args: {
  userId: string;
  providers: ProviderChainResolved[];
  system: string;
  /**
   * v1.39.4 — the system prompt for the rounds after a call produced a
   * table, when it differs (the table rules ride it).
   */
  systemOnceTableShown?: string;
  /** The conversation messages (history + the new user turn). */
  messages: AiMessage[];
  tools: AiToolDef[];
  temperature?: number;
  maxTokens?: number;
  fallbackWindow?: CoachScopeWindow;
  /** The turn's shared full-source snapshot scope. */
  sharedScope?: CoachScope;
  /** The person's Coach lookback limit; every tool call is clamped to it. */
  reach: CoachHistoryReach;
  ledger?: ProviderHealthLedger;
  /** Aborts the per-round provider calls on client disconnect. */
  signal?: AbortSignal;
  /** Per-user upstream timeout (ms) for each round's provider call. */
  timeoutMs?: number;
  onCallStart?: LoopCallEvents["onCallStart"];
  onCallSettled?: LoopCallEvents["onCallSettled"];
  onRoundSettled?: LoopCallEvents["onRoundSettled"];
  /** v1.39.4 — accepted, not read yet. */
  seedCalls?: ReadonlyArray<CoachSeedCall>;
  /** v1.39.4 — the chat turn the loop runs in. */
  turn?: CoachToolTurnContext;
  /**
   * v1.41 — the turn's budget. Absent: the person's own limits, estimated
   * from the prompt.
   */
  budget?: TurnBudget;
  /** v1.41 — the day's ledger, round by round. Absent: nothing is booked. */
  spend?: RoundSpend;
  /** v1.41 — the reasoning each round asks for, already resolved. */
  reasoning?: { effort: ReasoningLevel; summaries: boolean };
  /** v1.41 — the live trail. Absent: the no-op recorder. */
  activity?: ActivityRecorder;
  /** v1.41 — the locale the trail is labelled in. */
  locale?: Locale;
  /** v1.41 — what the dialog tools need. Absent: they are declined. */
  dialog?: DialogToolContext;
  /**
   * v1.41 — a note the answer already carries before any round (a health
   * fact the background found, offered once). It is the answer's one note:
   * `remember_fact` is declined beside it.
   */
  initialMemoryNote?: CoachMemoryNote;
  /** v1.41 — the figures read so far, for screening a checkpoint. */
  checkpointScreen?: { userMessage: string };
}): Promise<CoachToolLoopResult> {
  const {
    userId,
    providers,
    tools,
    temperature,
    maxTokens,
    fallbackWindow,
    sharedScope,
    reach,
    ledger,
    signal,
    timeoutMs,
    onCallStart,
    onCallSettled,
    onRoundSettled,
    turn,
    spend,
    reasoning,
    dialog,
  } = args;
  const locale: Locale = args.locale ?? turn?.locale ?? "en";
  const activity = args.activity ?? createNoopActivityRecorder();
  const budget =
    args.budget ??
    createTurnBudget({
      payer: "user",
      effort: reasoning?.effort,
      initialInputTokens: textTokens(
        args.system +
          args.messages
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join(""),
      ),
    });
  const progress = createProgressTracker();
  // v1.41.2 — one key for every round, so round two finds round one's prefix
  // in the provider's prompt cache.
  const cacheKey = coachPromptCacheKey(turn?.conversationId);

  const messages: AiMessage[] = [...args.messages];
  let system = args.system;
  let totalTokens = 0;
  let cachedTokens = 0;
  let rounds = 0;
  let workingProviderType = "";
  const toolTrace: CoachToolTrace[] = [];
  const toolResults: CoachToolResult[] = [];
  const declinedClarifications: CoachClarification[] = [];
  let memoryNote: CoachMemoryNote | undefined = args.initialMemoryNote;
  let planProposal: CoachPlanProposal | undefined;
  let callCount = 0;
  let stopReason: CoachStopReason | null = null;
  let progressStalled = false;

  for (let round = 1; ; round += 1) {
    // ── Whether this round may still fetch ──────────────────────────
    if (round > 1 && stopReason === null) {
      stopReason = budget.check() ?? (progressStalled ? "no_progress" : null);
      if (stopReason === null && spend) {
        const admitted = await spend.reserveRound(budget.nextRoundEstimate());
        if (!admitted) stopReason = "budget";
      }
    }
    const isFinal = stopReason !== null;
    if (stopReason) {
      const label = stopActivityLabel(locale, stopReason);
      const id = activity.start({
        phase: "stop",
        round,
        ...label,
        stop: stopReason,
      });
      activity.finish(id, "done");
    }

    rounds = round;
    const thinking = activity.start({
      phase: "thinking",
      round,
      ...simpleActivityLabel(locale, "thinking"),
    });
    const summaries: string[] = [];
    const started = Date.now();
    const fallback = await runRawCompletionWithFallback({
      userId,
      providers,
      // The tool loop IS the Coach chat: a person is waiting on every round.
      surface: "coach",
      ledger,
      params: {
        system: stopReason
          ? `${system}\n\n${FINAL_ROUND_LINE[stopReason]}`
          : system,
        messages,
        temperature,
        maxTokens,
        signal,
        timeoutMs,
        ...(reasoning
          ? {
              reasoning,
              onReasoning: (event) => {
                if (event.kind === "title") {
                  activity.update(thinking, { title: event.text });
                } else if (event.kind === "text" && event.text.trim()) {
                  summaries.push(event.text);
                }
              },
            }
          : {}),
        tools,
        toolChoice: isFinal ? ("none" as const) : ("auto" as const),
        cacheKey,
      },
    });
    const result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
    totalTokens += result.tokensUsed ?? 0;
    cachedTokens += result.cachedInputTokens ?? 0;
    budget.endRound({
      tokens: result.tokensUsed,
      cachedTokens: result.cachedInputTokens,
      durationMs: Date.now() - started,
    });
    if (spend) {
      await spend.settleRound({
        tokens: result.tokensUsed ?? 0,
        cachedTokens: result.cachedInputTokens ?? 0,
        servedBy: fallback.workingProvider.providerType as ProviderChainType,
        final: isFinal,
      });
    }
    // A client that reports summaries only on the result, not live.
    const summaryText = (
      summaries.length > 0 ? summaries : (result.reasoning?.summary ?? [])
    ).join("\n\n");
    activity.finish(thinking, "done", summaryText ? { text: summaryText } : {});

    const calls = result.toolCalls ?? [];
    const wantsTools =
      !isFinal && result.finishReason === "tool_calls" && calls.length > 0;

    if (!wantsTools) {
      return finish({ result });
    }

    // Assistant text beside the calls: the model's own checkpoint.
    const checkpoint = screenCheckpoint(result.content, {
      locale,
      figures: () => toolResults.map((r) => r.data ?? r.available),
      userMessage: args.checkpointScreen?.userMessage,
    });
    if (checkpoint) {
      const id = activity.start({
        phase: "checkpoint",
        round,
        ...simpleActivityLabel(locale, "thinking"),
      });
      activity.finish(id, "done", { title: checkpoint });
    }

    messages.push({
      role: "assistant",
      content: result.content ?? "",
      toolCalls: calls,
      ...(result.providerState ? { providerState: result.providerState } : {}),
    });

    let asked: CoachToolLoopResult["clarification"];
    const settled = await Promise.all(
      calls.map(async (call) => {
        const index = callCount;
        callCount += 1;
        const signature = callSignature(call.name, call.arguments);
        const earlier = progress.duplicateOf(call.id, signature);
        if (earlier !== null) {
          progress.record({ duplicate: true, scope: null, result: null });
          annotate({
            action: { name: "coach.tool.duplicate" },
            meta: { tool: call.name.slice(0, 48), round },
          });
          return {
            call,
            content: {
              present: false,
              reason: "duplicate",
              duplicateOf: earlier,
            },
          };
        }

        if (isDialogToolName(call.name)) {
          const phase =
            call.name === ASK_CLARIFICATION_TOOL_NAME
              ? "asking"
              : call.name === PROPOSE_PLAN_TOOL_NAME
                ? "plan"
                : "remember";
          const id = activity.start({
            phase,
            round,
            ...simpleActivityLabel(locale, phase),
          });
          const outcome = dialog
            ? await runDialogTool({
                name: call.name,
                rawArguments: call.arguments,
                round,
                ctx: dialog,
                noted: memoryNote !== undefined,
                proposed: planProposal !== undefined,
              })
            : { kind: "none" as const, result: { declined: "unavailable" } };
          if (outcome.kind === "ask") {
            asked = {
              question: outcome.question,
              clarification: outcome.clarification,
            };
          } else if (outcome.kind === "memory") {
            memoryNote = outcome.note;
          } else if (outcome.kind === "plan") {
            planProposal = outcome.proposal;
          } else if (outcome.kind === "declined") {
            declinedClarifications.push(outcome.clarification);
          }
          activity.finish(
            id,
            outcome.kind === "none" || outcome.kind === "declined"
              ? "empty"
              : "done",
          );
          progress.record({ duplicate: false, scope: null, result: null });
          return { call, content: outcome.result };
        }

        notify(() => onCallStart?.(call, index, round));
        const toolResult =
          call.name === COMPARE_SERIES_TOOL_NAME
            ? await runCompareSeries({
                userId,
                rawArguments: call.arguments,
                fallbackWindow,
                sharedScope,
                reach,
                ...(turn ? { turn } : {}),
              })
            : await executeCoachTool({
                userId,
                name: call.name,
                rawArguments: call.arguments,
                fallbackWindow,
                sharedScope,
                reach,
                ...(turn ? { turn } : {}),
              });
        // The settled callback gets the table; the model never does. It
        // reads the compact summary in `data`, and the verifier grades the
        // prose against that same summary.
        notify(() => onCallSettled?.(call, toolResult, index, round));
        const { table, ...forModel } = toolResult;
        if (table && args.systemOnceTableShown) {
          system = args.systemOnceTableShown;
        }
        const validArgs =
          call.name === COMPARE_SERIES_TOOL_NAME
            ? compareArgs(call.arguments)
            : parseCoachToolArgs(call.name, call.arguments);
        toolTrace.push({
          name: call.name,
          present: forModel.present,
          ...(validArgs ? { args: validArgs } : {}),
        });
        if (forModel.present || forModel.available !== undefined) {
          toolResults.push(forModel);
        }
        progress.record({
          duplicate: false,
          scope: validArgs ? callScope(call.name, validArgs) : null,
          result: forModel,
        });
        return { call, content: forModel };
      }),
    );

    for (const { call, content } of settled) {
      const serialised = JSON.stringify(content);
      budget.addInput(textTokens(serialised));
      messages.push({ role: "tool", toolCallId: call.id, content: serialised });
    }
    budget.addInput(textTokens(result.content ?? ""));
    notify(() => onRoundSettled?.(round));

    // A question ends the turn: it is the reply, with no prose round.
    if (asked) {
      return finish({
        result: {
          ...result,
          content: asked.question,
          toolCalls: undefined,
          // The provider state belongs to the next round, which a question
          // ends; it never leaves the loop.
          providerState: undefined,
        },
        clarification: asked,
      });
    }
    progressStalled = progress.endRound();
  }

  function finish(end: {
    result: CompletionResult;
    clarification?: CoachToolLoopResult["clarification"];
  }): CoachToolLoopResult {
    const stop: CoachStop | undefined = stopReason
      ? { reason: stopReason, rounds }
      : undefined;
    annotate({
      action: { name: "coach.tool.rounds" },
      meta: {
        rounds,
        tools: toolTrace.length,
        forcedFinal: stopReason !== null,
        stop: stopReason ?? "answered",
        clarification: end.clarification !== undefined,
        spent: budget.spent(),
        elapsedMs: budget.elapsedMs(),
        payer: budget.payer,
      },
    });
    return {
      result: end.result,
      workingProviderType,
      totalTokens,
      cachedTokens,
      rounds,
      toolTrace,
      toolResults,
      forcedFinal: stopReason !== null && stopReason !== "no_progress",
      ...(stop ? { stop } : {}),
      ...(end.clarification ? { clarification: end.clarification } : {}),
      ...(declinedClarifications.length > 0 ? { declinedClarifications } : {}),
      ...(memoryNote ? { memoryNote } : {}),
      ...(planProposal ? { planProposal } : {}),
    };
  }
}

/** A `compare_series` call's arguments as their schema validates them. */
function compareArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = compareSeriesArgsSchema.safeParse(
      raw.trim() === "" ? {} : JSON.parse(raw),
    );
    return parsed.success
      ? (parsed.data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Run a progress callback; a throw from it never reaches the loop. */
function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    // Progress is best-effort; the answer is not.
  }
}
