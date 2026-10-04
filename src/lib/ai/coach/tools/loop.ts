/**
 * v1.20.0 (F1) — bounded Coach retrieval loop.
 *
 * Runs the agentic call → tool-result → answer cycle on top of the existing
 * `runRawCompletionWithFallback` chain. Each round is a NON-streaming
 * completion (the chain returns a whole body); the route fake-tokenises the
 * FINAL prose for the visible stream exactly as before.
 *
 * Bounds (the loop can never run away):
 *   - MAX_ROUNDS = 3 (v1.21.0 D5): up to three tool-fetch rounds before the
 *     forced answer, so a sequential cross-metric "why" chain isn't starved.
 *   - HARD_CAP = MAX_ROUNDS + 1: an absolute ceiling; on the last allowed round
 *     the loop re-calls with `toolChoice:"none"` so the model is FORCED to
 *     produce prose even if it would otherwise keep asking for tools.
 *   - Tool calls within a round run in parallel (`Promise.all`).
 *
 * Token accounting: the caller reserves `maxTokens * MAX_ROUNDS` up front and
 * reconciles the SUMMED `tokensUsed` this function returns. The atomic
 * reserve/reconcile primitives are unchanged.
 *
 * Provider fallback: when the working provider does not support tools
 * (`supportsTools === false`) or returns no tool calls, the loop degrades to a
 * single completion — the caller falls back to the snapshot path BEFORE
 * entering this loop, so this is the safety floor, not the primary route.
 */
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { annotate } from "@/lib/logging/context";
import { runRawCompletionWithFallback } from "@/lib/ai/provider-runner";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import type {
  AiMessage,
  AiToolCall,
  AiToolDef,
  CompletionResult,
} from "@/lib/ai/types";
import type { ProviderHealthLedger } from "@/lib/ai/provider-health-ledger";
import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import { parseCoachToolArgs, type CoachToolName } from "./definitions";
import {
  executeCoachTool,
  type CoachToolResult,
  type CoachToolTrace,
  type CoachToolTurnContext,
} from "./executor";

/**
 * v1.21.0 (D5) — MAX_ROUNDS raised 2 → 3 so a sequential cross-metric "why"
 * chain (recovery low → which driver → pull that metric's series) is not
 * starved on the 2-round ceiling. The per-round token budget is unchanged; the
 * caller reserves `maxTokens * MAX_ROUNDS` and reconciles the summed actual
 * tokens, so the bound scales with this constant and stays explicit. HARD_CAP
 * tracks one above so the final allowed round still forces prose.
 */
export const MAX_ROUNDS = 3;
/**
 * Absolute ceiling; the final allowed round forces prose (toolChoice none).
 * Tracks one above MAX_ROUNDS so rounds 1..MAX_ROUNDS may fetch tools and the
 * final round is always a forced answer.
 */
export const HARD_CAP = MAX_ROUNDS + 1;

export interface CoachToolLoopResult {
  /** The final completion (prose). */
  result: CompletionResult;
  /** The working provider's type tag. */
  workingProviderType: string;
  /** Summed tokens across every round (for budget reconcile). */
  totalTokens: number;
  /**
   * v1.21.0 (F3) — summed cached-input tokens across every round. Subtracted
   * from the charged amount at reconcile so prompt-cached input the user did
   * not re-pay for is not billed to their daily meter.
   */
  cachedTokens: number;
  /** Number of model round-trips made. */
  rounds: number;
  /** Which tools ran + whether each found data (persisted onto provenance). */
  toolTrace: CoachToolTrace[];
  /**
   * v1.21.0 (P6) — the structured payloads of every tool result this turn that
   * DELIVERED figures, in call order. The post-hoc prose number-verifier
   * extracts the numeric leaves from these to cross-check the figures the model
   * cited. Empty on a no-tools answer.
   *
   * "Delivered figures" is present results plus the availability payload an
   * `outside_window` miss carries: that payload is server-computed (count, date
   * range, per-series aggregate) and rule 3 tells the model it MAY cite it, so it
   * has to ride the authoritative set — otherwise the verifier would elide the
   * one honest sentence the fix exists to make sayable.
   */
  toolResults: CoachToolResult[];
  /**
   * v1.39.4 — true when the loop reached `HARD_CAP`: the model asked for
   * tools in every round it was offered them, so the final answer was forced
   * with `toolChoice: "none"` rather than given freely.
   */
  forcedFinal: boolean;
}

/** v1.39.4 — a tool call to run before the first model round. */
interface CoachSeedCall {
  name: CoachToolName;
  args: Record<string, unknown>;
}

export async function runCoachToolLoop(args: {
  userId: string;
  providers: ProviderChainResolved[];
  system: string;
  /**
   * v1.39.4 — the system prompt for the rounds after a call produced a
   * table, when it differs (the table rules ride it). Absent: `system`
   * throughout.
   */
  systemOnceTableShown?: string;
  /** The conversation messages (history + the new user turn). */
  messages: AiMessage[];
  tools: AiToolDef[];
  temperature?: number;
  maxTokens?: number;
  fallbackWindow?: CoachScopeWindow;
  /**
   * v1.21.0 (D5-1) — the turn's shared full-source snapshot scope (the same one
   * the DATA INVENTORY was built against). Threaded to every tool so they read
   * under one cache key — one snapshot build per turn instead of N.
   */
  sharedScope?: CoachScope;
  /**
   * The person's Coach lookback limit. Required: every tool call of a chat
   * turn is clamped to it, and a caller that forgot it would read past it.
   */
  reach: CoachHistoryReach;
  ledger?: ProviderHealthLedger;
  /** Aborts the per-round provider calls on client disconnect. */
  signal?: AbortSignal;
  /**
   * v1.22 (#89) — per-user upstream timeout (ms) for each tool-round provider
   * call. Forwarded to `CompletionParams.timeoutMs`; unset → the client's
   * shared default holds.
   */
  timeoutMs?: number;
  /**
   * v1.39.4 — fired as each tool call starts. `index` counts calls across
   * the whole turn from 0, so it is stable for a step id. A throwing callback
   * is swallowed: progress reporting never breaks the loop.
   */
  onCallStart?: (call: AiToolCall, index: number) => void;
  /**
   * v1.39.4 — fired once for every call that started, when its result is in:
   * found, missed, invalid or failed alike (`executeCoachTool` never throws).
   */
  onCallSettled?: (
    call: AiToolCall,
    result: CoachToolResult,
    index: number,
  ) => void;
  /**
   * v1.39.4 — calls to run before round one, reusing the loop's own
   * assistant-call and tool-result serialisation. Accepted, not read yet.
   */
  seedCalls?: ReadonlyArray<CoachSeedCall>;
  /**
   * v1.39.4 — the chat turn the loop runs in: lets a call produce a named
   * result table and `show_result` find an earlier one of the conversation.
   */
  turn?: CoachToolTurnContext;
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
    turn,
  } = args;

  const messages: AiMessage[] = [...args.messages];
  let system = args.system;
  let totalTokens = 0;
  let cachedTokens = 0;
  let rounds = 0;
  let workingProviderType = "";
  const toolTrace: CoachToolTrace[] = [];
  const toolResults: CoachToolResult[] = [];
  let callCount = 0;

  // Round budget: rounds 1..HARD_CAP. On the last allowed round we forbid tool
  // calls so the model must answer.
  for (let round = 1; round <= HARD_CAP; round += 1) {
    rounds = round;
    const isForcedFinal = round >= HARD_CAP;
    const offerTools = round <= MAX_ROUNDS && !isForcedFinal;

    const fallback = await runRawCompletionWithFallback({
      userId,
      providers,
      // The tool loop IS the Coach chat: a person is waiting on every round.
      surface: "coach",
      ledger,
      params: {
        system,
        messages,
        temperature,
        maxTokens,
        signal,
        timeoutMs,
        ...(offerTools
          ? { tools, toolChoice: "auto" as const }
          : { toolChoice: "none" as const }),
      },
    });
    const result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
    totalTokens += result.tokensUsed ?? 0;
    cachedTokens += result.cachedInputTokens ?? 0;

    const calls = result.toolCalls ?? [];
    const wantsTools =
      offerTools && result.finishReason === "tool_calls" && calls.length > 0;

    if (!wantsTools) {
      // The model produced prose (or a no-tools provider returned empty
      // toolCalls) — we are done.
      annotate({
        action: { name: "coach.tool.rounds" },
        meta: {
          rounds,
          tools: toolTrace.length,
          forcedFinal: isForcedFinal,
        },
      });
      return {
        result,
        workingProviderType,
        totalTokens,
        cachedTokens,
        rounds,
        toolTrace,
        toolResults,
        forcedFinal: isForcedFinal,
      };
    }

    // Append the assistant turn that requested the tools, then execute them in
    // parallel and append one tool-result turn per call.
    messages.push({
      role: "assistant",
      content: result.content ?? "",
      toolCalls: calls,
    });

    const results = await Promise.all(
      calls.map(async (call) => {
        const index = callCount;
        callCount += 1;
        notify(() => onCallStart?.(call, index));
        const settled = await executeCoachTool({
          userId,
          name: call.name,
          rawArguments: call.arguments,
          fallbackWindow,
          sharedScope,
          reach,
          ...(turn ? { turn } : {}),
        });
        // v1.39.4 — the settled callback gets the table; the model never
        // does. It reads the compact summary in `data`, and the verifier
        // grades the prose against that same summary.
        notify(() => onCallSettled?.(call, settled, index));
        const { table, ...toolResult } = settled;
        if (table && args.systemOnceTableShown) {
          system = args.systemOnceTableShown;
        }
        const validArgs = parseCoachToolArgs(call.name, call.arguments);
        toolTrace.push({
          name: call.name,
          present: toolResult.present,
          ...(validArgs ? { args: validArgs } : {}),
        });
        // v1.21.0 (P6) — retain the payloads that carried figures for the
        // post-hoc prose number-verifier (the union of numeric leaves grounds
        // the figures the model may cite): a present result's `data`, or the
        // `available` block an out-of-window miss reports.
        if (toolResult.present || toolResult.available !== undefined) {
          toolResults.push(toolResult);
        }
        return { call, toolResult };
      }),
    );

    for (const { call, toolResult } of results) {
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  // Unreachable: the forced-final round (round === HARD_CAP) always returns
  // above because `offerTools` is false, so `wantsTools` is false. Kept as a
  // defensive guard.
  throw new Error("coach tool loop exceeded hard cap without a final answer");
}

/** Run a progress callback; a throw from it never reaches the loop. */
function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    // Progress is best-effort; the answer is not.
  }
}
