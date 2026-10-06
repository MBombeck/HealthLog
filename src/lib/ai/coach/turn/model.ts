/**
 * Run the model for one Coach turn: the tool-retrieval loop when every
 * provider in the chain supports tools, otherwise the streaming no-tools
 * completion over the full snapshot. A provider failure is classified into
 * the structured `coach.*` code the stream answers with.
 */
import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { localeLanguageNames as LANGUAGE_NAMES } from "@/lib/i18n/config";
import {
  AllProvidersFailedError,
  runStreamingRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { singleUserTurn, type CompletionResult } from "@/lib/ai/types";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { appendMessage } from "@/lib/ai/coach/persistence";
import {
  buildCoachToolRequest,
  renderPriorResultRefs,
} from "@/lib/ai/coach/chat-request-builder";
import {
  COACH_TOOL_DEFS,
  buildCoachDataInventory,
  renderDataInventory,
  renderFocusHint,
  buildToolModeAddendum,
  parseCoachToolArgs,
  runCoachToolLoop,
  type CoachToolTrace,
} from "@/lib/ai/coach/tools";
import { admittedPriorResults } from "@/lib/ai/coach/tools/executor";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";
import {
  COMPARE_SERIES_TOOL_DEF,
  COMPARE_SERIES_TOOL_NAME,
  compareSeriesArgsSchema,
} from "@/lib/ai/coach/tools/compare-series";
import { DIALOG_TOOL_DEFS } from "@/lib/ai/coach/tools/dialog-tools";
import {
  createTurnBudget,
  estimateInputTokens,
  type TurnPayer,
} from "@/lib/ai/coach/tools/turn-budget";
import type {
  CoachClarification,
  CoachMemoryNote,
  CoachPlanProposal,
  CoachResultTable,
  CoachStep,
  CoachStop,
} from "@/lib/ai/coach/types";
import type { AiToolCall } from "@/lib/ai/types";
import type { ActivityRecorder } from "@/lib/ai/coach/activity/contract";
import {
  createActivityRecorder,
  type TurnActivityRecorder,
} from "@/lib/ai/coach/activity/recorder";
import {
  digestActivityLabel,
  digestDoneActivityLabel,
  fetchActivityLabel,
  memoryActivityLabel,
  simpleActivityLabel,
} from "@/lib/ai/coach/activity/catalog";
import { buildMemoryContextBlock } from "@/lib/ai/coach/memory/contract";
import {
  projectResults,
  type SettledToolCall,
} from "@/lib/ai/coach/results/project";
import { deriveChartSpec } from "@/lib/ai/coach/results/chart-spec";
import {
  correlationPartners,
  type CorrelationPair,
} from "@/lib/ai/coach/follow-ups/derive";
import {
  createResultRefAllocator,
  type PriorResultTurn,
} from "@/lib/ai/coach/results/refs";

import { buildDialogAddenda } from "./addenda";
import type { TurnLedger } from "./budget";
import type { TurnReasoning } from "./reasoning";
import type { TurnChain } from "./chain";
import type { TurnContext } from "./context";
import { classifyBubblingProviderError } from "./errors";
import { snapshotStep, toStep } from "./steps";
import type { TurnEmitter } from "./types";

export type ModelOutcome =
  | {
      ok: true;
      result: CompletionResult;
      /**
       * v1.38.19 — typed as the chain's provider union, not a bare string:
       * the budget reconcile attributes the turn's tokens to the cost owner of
       * the hop named here.
       */
      workingProviderType: ProviderChainType;
      toolTrace: CoachToolTrace[];
      /**
       * v1.21.0 (P6) — the present tool-result payloads this turn, for the
       * post-hoc prose number-verifier. Empty on the no-tools path.
       */
      toolResultPayloads: unknown[];
      /**
       * v1.21.2 (A8) — no-tools/local-provider parity for the prose
       * number-verifier. The tool path grades prose against the figures the
       * tools returned; the no-tools path has no tools, so the authoritative
       * set is the SNAPSHOT the model was actually shown this turn —
       * `snapshot.sections`, the structured record `snapshotJson` is
       * serialised from, which already carries the correlations-snapshot
       * block. Populated only when the full figures were delivered this turn
       * (`includeFullSnapshot`); on a cheap follow-up the block was not
       * re-sent, so there is no fresh authoritative set to grade against.
       */
      noToolsSnapshotPayloads: unknown[];
      /**
       * The DATA INVENTORY manifest (per-domain sample counts) that rode this
       * turn's tool-mode prompt. The all-missed activation needs it as a
       * WIDENER: the counts were in front of the model, so a plain count
       * restatement ("you've logged 42 BP readings") must stay grounded even
       * on a turn whose every tool missed. Never an ACTIVATOR on its own —
       * see the v1.32.1 note below.
       */
      inventoryPayloads: unknown[];
      totalTokens: number;
      /**
       * v1.21.0 (F3) — cached-input tokens to subtract at reconcile
       * (prompt-cached input the user did not re-pay for must not be billed
       * to the daily meter).
       */
      cachedTokens: number;
      /**
       * v1.39.4 — the steps this turn read, in first-seen order: the tool
       * calls on the tool path, one snapshot step on the no-tools path.
       * Already streamed as `step` frames; persisted on the provenance.
       */
      steps: CoachStep[];
      /**
       * v1.39.4 — the tables this turn's tool results project to, with their
       * charts. Not streamed here: they go out after the reply guards, and
       * not at all on a blocked turn.
       */
      results: CoachResultTable[];
      /** v1.39.4 — the loop forced the answer at its round cap. */
      forcedFinal: boolean;
      /** v1.39.4 — the DATA INVENTORY entries; null on the no-tools path. */
      inventory: InventoryEntry[] | null;
      /**
       * v1.39.4 — the metric pairs a `get_correlations` call returned this
       * turn, for the related-metric chip. Empty on the no-tools path.
       */
      correlations: CorrelationPair[];
      /** v1.41 — the turn's live trail. */
      activity: TurnActivityRecorder;
      /** v1.41 — why the answer was forced, when it was. */
      stop?: CoachStop;
      /** v1.41 — the question the turn ended on, asked through the tool. */
      toolClarification: {
        question: string;
        clarification: CoachClarification;
      } | null;
      /** v1.41 — questions the brake turned into assumptions. */
      declinedClarifications: CoachClarification[];
      /** v1.41 — the fact the turn saved or proposes. */
      memoryNote: CoachMemoryNote | null;
      /** v1.41 — the plan the turn proposes. */
      planProposal: CoachPlanProposal | null;
      /** v1.41 — tables already went out as interim `result` frames. */
      interimSent: boolean;
    }
  | { ok: false; code: string };

/**
 * v1.39.4 — the turn's steps, upserted by id and streamed as they change.
 * A frame is never written to a stream the client already closed.
 */
function stepRecorder(emitter: TurnEmitter): {
  record(step: CoachStep | null): void;
  list(): CoachStep[];
} {
  const byId = new Map<string, CoachStep>();
  return {
    record(step) {
      if (!step) return;
      byId.set(step.id, step);
      if (!emitter.aborted()) emitter.emit({ type: "step", step });
    },
    list: () => [...byId.values()],
  };
}

/**
 * v1.39.4 — a projected table with the chart the server chose for it. A
 * table shown again already carries the chart its `show_result` view asked
 * for, and keeps it.
 */
function withChart(table: CoachResultTable): CoachResultTable {
  if (table.reusedFrom) return table;
  const chart = deriveChartSpec(table);
  return { ...table, chart, chartKind: chart?.kind ?? null };
}

/**
 * The tables a settled turn shows. Built outside the provider's failure
 * path: the model has already answered and its tokens are billed, so a
 * projection defect must not refund them or drop the reply. It costs the
 * turn its tables, which the annotation records, and nothing else.
 */
export function buildTurnResults(
  calls: Parameters<typeof projectResults>[0]["calls"],
  locale: Locale,
): CoachResultTable[] {
  try {
    return projectResults({ calls, locale }).map(withChart);
  } catch (err) {
    annotate({
      action: { name: "coach.results.project_failed" },
      meta: {
        error: err instanceof Error ? err.name : "unknown",
        calls: calls.length,
      },
    });
    return [];
  }
}

/** v1.39.4 — server-authored lines appended to the system prompt. */
function appendBlocks(base: string, blocks: string[]): string {
  const extra = blocks.filter((block) => block.length > 0);
  return extra.length > 0 ? [base, ...extra].join("\n\n") : base;
}

/** The tools a tool-mode turn offers: the catalogue, comparisons, the dialog. */
export const COACH_TURN_TOOL_DEFS = [
  ...COACH_TOOL_DEFS,
  COMPARE_SERIES_TOOL_DEF,
  ...DIALOG_TOOL_DEFS,
];

/** A call's validated arguments, `compare_series` included. */
function validatedArgs(call: AiToolCall): Record<string, unknown> | undefined {
  if (call.name !== COMPARE_SERIES_TOOL_NAME) {
    return parseCoachToolArgs(call.name, call.arguments);
  }
  try {
    const parsed = compareSeriesArgsSchema.safeParse(
      call.arguments.trim() === "" ? {} : JSON.parse(call.arguments),
    );
    return parsed.success
      ? (parsed.data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function runTurnModel(args: {
  userId: string;
  locale: Locale;
  signal: AbortSignal;
  conversationId: string;
  ctx: TurnContext;
  chain: TurnChain;
  toolMode: boolean;
  /** v1.41 — the day's ledger, booked round by round. */
  ledger: TurnLedger;
  /** The turn's frame channel; the live `step` and `activity` frames go out on it. */
  emitter: TurnEmitter;
  /**
   * v1.39.4 — server-authored context lines for this turn (a resolved
   * follow-up chip, an answered clarification). Empty on a plain turn,
   * which then sends its prompt unchanged.
   */
  turnHints: string[];
  /**
   * v1.39.4 — the tables earlier replies of this conversation hold, named
   * for the context and for `show_result`. Empty on a new conversation.
   */
  priorResults?: PriorResultTurn[];
  /** v1.41 — the person's message, the only source of a remembered fact. */
  message: string;
  /** v1.41 — that message's stored id. */
  userMessageId?: string;
  /** v1.41 — the reasoning the turn asks for, already resolved. */
  reasoning?: TurnReasoning;
  /** v1.41 — who pays: fixes the turn's budget. */
  payer: TurnPayer;
  /** v1.41 — a window was set for this conversation by the client. */
  conversationWindowSet: boolean;
}): Promise<ModelOutcome> {
  const { userId, locale, signal, conversationId, ctx, chain, toolMode } = args;
  const { effectiveScope, workoutEvidence, turnContext, snapshot } = ctx;
  const steps = stepRecorder(args.emitter);
  // v1.41 — the figures read so far, which screen the trail's model text.
  const figures: unknown[] = [];
  const recorder = createActivityRecorder({
    emit: (activity) => {
      if (!args.emitter.aborted()) {
        args.emitter.emit({ type: "activity", activity });
      }
    },
    screen: {
      locale,
      figures: () => figures,
      userMessage: args.message,
      scheduleDoses: ctx.scheduleDoses,
    },
  });
  // A round's digest runs until the next entry opens: the next round's
  // thinking, or the stop before it.
  let digest: { id: string; count: number; areas: number } | null = null;
  const closeDigest = () => {
    if (!digest) return;
    const { id, count, areas } = digest;
    digest = null;
    recorder.finish(id, "done", {
      ...digestDoneActivityLabel(locale, count, areas),
      count,
    });
  };
  const activity: ActivityRecorder = {
    ...recorder,
    start: (entry) => {
      closeDigest();
      return recorder.start(entry);
    },
  };
  try {
    // v1.41 — what the Coach knows about the person, built only now: the
    // capability was re-checked at the egress site before the model step.
    const memory = await buildMemoryContextBlock({
      userId,
      conversationId,
      locale,
      // The block re-runs the wire egress check for exactly these.
      providerTypes: chain.map((entry) => entry.providerType),
    }).catch(() => null);
    if (memory) {
      recorder.setRecalled(memory.recalled);
    }
    if (memory && memory.factIds.length + memory.planIds.length > 0) {
      const count = memory.factIds.length + memory.planIds.length;
      const id = activity.start({
        phase: "memory",
        round: 1,
        ...memoryActivityLabel(locale, count),
        count,
      });
      activity.finish(id, "done");
    }

    if (toolMode) {
      // v1.20.0 (F1) — base context: the full system prompt + a tool-mode
      // grounding addendum, with the tiny DATA INVENTORY manifest and the
      // transcript on the user turn. The figures are NOT in the prompt — the
      // model pulls only what it needs via the retrieval tools.
      const inventory = await buildCoachDataInventory(
        userId,
        effectiveScope,
        ctx.reach,
      );
      // Earlier tables whose metric the person has since excluded, or whose
      // range lies beyond the lookback limit, are neither named for the
      // model nor reachable through show_result.
      const priorResults = await admittedPriorResults({
        userId,
        prefs: ctx.coachPrefs,
        scope: inventory.probeScope,
        reach: ctx.reach,
        prior: args.priorResults ?? [],
      });
      const requestWith = (tableRules: boolean) =>
        buildCoachToolRequest({
          systemPrompt: ctx.systemPrompt,
          toolModeAddendum: appendBlocks(buildToolModeAddendum(locale), [
            buildDialogAddenda(locale, { tableRules }),
            ...args.turnHints,
          ]),
          focusHint: renderFocusHint(effectiveScope?.sources),
          workoutEvidence,
          dataInventory: renderDataInventory(inventory),
          priorResults: renderPriorResultRefs(priorResults),
          guidedBlock: turnContext.guidedBlock,
          transcript: turnContext.transcript,
          languageName: LANGUAGE_NAMES[locale],
          ...(memory ? { memoryBlock: memory.text } : {}),
        });
      // The recheck and follow-up rules are about tables: they ride the
      // prompt once the conversation holds one, or from the round after this
      // turn produced its first.
      const withTables = requestWith(true);
      const toolRequest =
        priorResults.length > 0 ? withTables : requestWith(false);
      // v1.39.4 — every call this turn settled, by its turn-wide index, for
      // the result tables. Only this turn's own calls ever reach them.
      const settled: SettledToolCall[] = [];
      // v1.41 — the trail entry of each call, and what each round read.
      const fetches = new Map<number, { id: string; round: number }>();
      const roundReads = new Map<
        number,
        Array<{ count: number; domain: string | undefined; done: boolean }>
      >();
      let interimSent = false;
      const budget = createTurnBudget({
        payer: args.payer,
        effort: args.reasoning?.effort,
        initialInputTokens: estimateInputTokens(
          toolRequest.system.length +
            toolRequest.messages
              .map((m) => (typeof m.content === "string" ? m.content : ""))
              .join("").length,
        ),
      });
      const loop = await runCoachToolLoop({
        userId,
        providers: chain,
        system: toolRequest.system,
        systemOnceTableShown: withTables.system,
        messages: toolRequest.messages,
        tools: COACH_TURN_TOOL_DEFS,
        temperature: AI_BUDGETS.coach.temperature,
        maxTokens: AI_BUDGETS.coach.maxTokens,
        fallbackWindow: effectiveScope?.window,
        // v1.21.0 (D5-1) — share the inventory's full-source snapshot across
        // every tool so the turn builds ONE snapshot, not one per tool.
        sharedScope: inventory.probeScope,
        // The lookback limit: every tool call is clamped to it.
        reach: ctx.reach,
        // v1.20.1 — a mid-generation disconnect tears the round calls down.
        signal,
        // v1.22 (#89) — per-user response timeout for each round's call.
        timeoutMs: ctx.aiResponseTimeoutMs,
        // v1.39.4 — result tables: each call may produce one, named `r1`..
        // in the order they settle.
        turn: {
          conversationId,
          locale,
          priorResults,
          refs: createResultRefAllocator(),
        },
        budget,
        spend: args.ledger,
        ...(args.reasoning ? { reasoning: args.reasoning } : {}),
        activity,
        locale,
        ...(memory?.pendingProposal
          ? { initialMemoryNote: memory.pendingProposal }
          : {}),
        dialog: {
          userId,
          conversationId,
          locale,
          userMessage: args.message,
          ...(args.userMessageId ? { userMessageId: args.userMessageId } : {}),
          inventory: inventory.entries,
          conversationWindowSet: args.conversationWindowSet,
        },
        checkpointScreen: { userMessage: args.message },
        // v1.39.4 — live steps: a `running` step as each call starts, its
        // final status as it settles. v1.41 — and a `fetch` trail entry.
        onCallStart: (call, index, round) => {
          const step = toStep({
            call,
            index,
            parsedArgs: validatedArgs(call),
            locale,
            fallbackWindow: effectiveScope?.window,
          });
          steps.record(step);
          const id = activity.start({
            phase: "fetch",
            round,
            ...fetchActivityLabel(locale, {
              domain: step?.domain ?? "snapshot",
              window: step?.window,
              ...(step && !step.window
                ? { fallback: { labelKey: step.labelKey, label: step.label } }
                : {}),
            }),
            ...(step ? { stepRef: step.id } : {}),
          });
          fetches.set(index, { id, round });
        },
        onCallSettled: (call, result, index, round) => {
          const parsedArgs = validatedArgs(call);
          const settledCall: SettledToolCall = {
            name: call.name,
            ...(parsedArgs ? { args: parsedArgs } : {}),
            result,
          };
          settled[index] = settledCall;
          if (result.present || result.available !== undefined) {
            figures.push(result.data ?? result.available);
          }
          const step = toStep({
            call,
            index,
            parsedArgs,
            result,
            locale,
            fallbackWindow: effectiveScope?.window,
          });
          steps.record(step);
          const entry = fetches.get(index);
          const status = step?.status ?? (result.present ? "done" : "empty");
          if (entry) {
            activity.finish(entry.id, status === "running" ? "done" : status, {
              ...(step?.count !== undefined ? { count: step.count } : {}),
            });
          }
          const reads = roundReads.get(round) ?? [];
          reads.push({
            count: step?.count ?? 0,
            domain: step?.domain,
            done: status === "done",
          });
          roundReads.set(round, reads);
          // v1.41 — a table goes out the moment it is read, as an interim
          // result the answer later shows or files under "Data used".
          if (result.table && !args.emitter.aborted()) {
            const [table] = buildTurnResults([settledCall], locale);
            if (table) {
              args.emitter.emit({
                type: "result",
                result: table,
                interim: true,
              });
              interimSent = true;
            }
          }
        },
        onRoundSettled: (round) => {
          const reads = roundReads.get(round) ?? [];
          if (reads.length === 0) return;
          const count = reads.reduce((sum, read) => sum + read.count, 0);
          const areas = new Set(
            reads.filter((read) => read.done).map((read) => read.domain),
          ).size;
          const id = activity.start({
            phase: "digest",
            round,
            ...digestActivityLabel(locale, count),
            count,
          });
          digest = { id, count, areas };
        },
      });
      closeDigest();
      // v1.32.1 — the numeric verifier ACTIVATES only when this turn actually
      // delivered figures the model was told to ground against: a pinned
      // workout-evidence block or a present tool result. The DATA INVENTORY
      // manifest is NOT an activator; when the turn IS active, the inventory
      // counts WIDEN the authoritative set so a plain count restatement stays
      // grounded.
      const presentToolPayloads = [
        ...(workoutEvidence === null ? [] : [workoutEvidence]),
        // A miss carries no `data` but may carry `available` — the bounded
        // out-of-window aggregate rule 3 lets the model cite. Ground it.
        ...(loop.toolResults ?? []).map((r) => r.data ?? r.available),
      ];
      return {
        ok: true,
        result: loop.result,
        // The loop reports the hop it landed on as a bare string; it is
        // assigned from `workingProvider.providerType` one frame up.
        workingProviderType: loop.workingProviderType as ProviderChainType,
        toolTrace: loop.toolTrace,
        toolResultPayloads:
          presentToolPayloads.length > 0
            ? [...presentToolPayloads, inventory.entries]
            : [],
        noToolsSnapshotPayloads: [],
        inventoryPayloads: [inventory.entries],
        totalTokens: loop.totalTokens,
        cachedTokens: loop.cachedTokens,
        steps: steps.list(),
        results: buildTurnResults(
          settled.filter((call) => call !== undefined),
          locale,
        ),
        forcedFinal: loop.forcedFinal === true,
        inventory: inventory.entries,
        correlations: correlationPartners(
          settled.filter((call) => call !== undefined),
        ),
        activity: recorder,
        ...(loop.stop ? { stop: loop.stop } : {}),
        toolClarification: loop.clarification ?? null,
        declinedClarifications: loop.declinedClarifications ?? [],
        memoryNote: loop.memoryNote ?? null,
        planProposal: loop.planProposal ?? null,
        interimSent,
      };
    }
    // v1.22 (#89) — the no-tools path (local / Ollama / exo, and any chain
    // that includes a non-tool provider) runs through the STREAMING runner so
    // the local client emits real tokens as they arrive and the per-idle-gap
    // timeout governs. The assembled reply is returned in full so every guard
    // still runs on the complete text.
    let streamedDeltas = 0;
    // v1.39.4 — the no-tools path reads the whole snapshot: one step.
    const snapshotRead = snapshotStep({
      metricCount: snapshot.provenance.metrics.length,
      locale,
    });
    steps.record(snapshotRead);
    if (snapshotRead) {
      const id = activity.start({
        phase: "fetch",
        round: 1,
        labelKey: snapshotRead.labelKey,
        label: snapshotRead.label,
        stepRef: snapshotRead.id,
        ...(snapshotRead.count !== undefined
          ? { count: snapshotRead.count }
          : {}),
      });
      activity.finish(id, snapshotRead.status === "done" ? "done" : "empty");
    }
    const thinking = activity.start({
      phase: "thinking",
      round: 1,
      ...simpleActivityLabel(locale, "thinking"),
    });
    const summaries: string[] = [];
    // v1.41 — the memory block rides the user turn here too, ahead of the
    // snapshot, fenced like the rest of the person's own context.
    const user = memory
      ? `${memory.text}\n\n${ctx.userPrompt}`
      : ctx.userPrompt;
    const fallback = await runStreamingRawCompletionWithFallback({
      surface: "coach",
      userId,
      providers: chain,
      onDelta: () => {
        streamedDeltas += 1;
      },
      params: {
        ...singleUserTurn({
          system: appendBlocks(ctx.systemPrompt, args.turnHints),
          user,
          temperature: AI_BUDGETS.coach.temperature,
          maxTokens: AI_BUDGETS.coach.maxTokens,
          // v1.20.1 — tear the upstream call down on a client disconnect.
          signal,
          // v1.22 (#89) — per-idle-gap timeout for the streaming local call.
          timeoutMs: ctx.aiResponseTimeoutMs,
        }),
        ...(args.reasoning
          ? {
              reasoning: args.reasoning,
              onReasoning: (event) => {
                if (event.kind === "title") {
                  activity.update(thinking, { title: event.text });
                } else if (event.kind === "text" && event.text.trim()) {
                  summaries.push(event.text);
                }
              },
            }
          : {}),
      },
    });
    annotate({
      action: { name: "coach.stream.deltas" },
      meta: { deltas: streamedDeltas },
    });
    const result = fallback.result;
    await args.ledger.settleRound({
      tokens: result.tokensUsed ?? 0,
      cachedTokens: result.cachedInputTokens ?? 0,
      servedBy: fallback.workingProvider.providerType,
      final: false,
    });
    const summaryText = (
      summaries.length > 0 ? summaries : (result.reasoning?.summary ?? [])
    ).join("\n\n");
    activity.finish(thinking, "done", summaryText ? { text: summaryText } : {});
    return {
      ok: true,
      result,
      workingProviderType: fallback.workingProvider.providerType,
      toolTrace: [],
      toolResultPayloads: [],
      // v1.21.2 (A8) — the no-tools path grades only when it delivered the
      // full SNAPSHOT.
      noToolsSnapshotPayloads: turnContext.includeFullSnapshot
        ? [
            snapshot.sections,
            ...(workoutEvidence === null ? [] : [workoutEvidence]),
          ]
        : [],
      inventoryPayloads: [],
      totalTokens: result.tokensUsed ?? 0,
      cachedTokens: result.cachedInputTokens ?? 0,
      steps: steps.list(),
      results: [],
      forcedFinal: false,
      inventory: null,
      correlations: [],
      activity: recorder,
      toolClarification: null,
      declinedClarifications: [],
      memoryNote: memory?.pendingProposal ?? null,
      planProposal: null,
      interimSent: false,
    };
  } catch (err) {
    // The provider chain failed: every round that returned is already
    // settled; give back what is still reserved before the error frame.
    await args.ledger.close();
    // #781 — the client walked away mid-generation. The request's abort
    // signal is threaded into every provider call, so the teardown surfaces
    // here as an abort-shaped failure with `request.signal` already flipped.
    // Close the turn honestly instead of letting the user message dangle
    // unanswered: persist an EMPTY assistant marker tagged
    // `providerType: "cancelled"` (the same channel "refusal" and "nudge"
    // already use for non-provider rows) so the thread shows the turn as
    // interrupted and offers a retry on reload. The content is empty by
    // construction — nothing guarded was produced, and anything the client
    // ever SAW was persisted before the first token frame left, so no
    // unguarded partial text is ever written. The reservation was refunded
    // above; a retry pays exactly what a fresh turn pays.
    if (signal.aborted) {
      await appendMessage({
        conversationId,
        role: "assistant",
        content: "",
        providerType: "cancelled",
        promptVersion: PROMPT_VERSION,
      }).catch(() => {
        // Marker persistence is best-effort — a failure leaves the
        // dangling user turn, which is exactly the pre-#781 state.
      });
      annotate({
        action: { name: "insights.coach.cancelled" },
        meta: { conversationId },
      });
      return { ok: false, code: "coach.cancelled" };
    }
    if (err instanceof AllProvidersFailedError) {
      annotate({
        action: { name: "insights.coach.providerFailed" },
        meta: {
          attempts: err.attempts.length,
          firstStatus: err.attempts[0]?.httpStatus ?? null,
          credentialExpired: err.primaryCredentialExpired,
        },
      });
      // v1.11.0 W1 — when the user's PRIMARY provider failed with an
      // auth-class status (401/403), the credential is dead, not the
      // service. Surface a distinct `credential_expired` frame so the
      // drawer can deep-link the user to reconnect rather than telling
      // them to "try again later" — the gap that let an expired codex
      // token silently kill all generation.
      if (err.primaryCredentialExpired) {
        return { ok: false, code: "coach.provider.credential_expired" };
      }
      // v1.4.25 W5 — distinguish provider rate-limit (every attempt
      // landed on 429) from generic unavailability. The drawer's
      // error-decoder surfaces the rate-limit copy with a warning
      // toast instead of the generic provider-down message, so the
      // user understands the limit is transient.
      const allRateLimited =
        err.attempts.length > 0 &&
        err.attempts.every((a) => a.httpStatus === 429);
      return {
        ok: false,
        code: allRateLimited
          ? "coach.provider.rate_limited"
          : "coach.provider.unavailable",
      };
    }
    // v1.21.3 — defence in depth. The chain runner wraps every hard provider
    // failure in `AllProvidersFailedError`, but a provider client can still
    // throw a tagged wire error that reaches here un-wrapped (e.g. a Codex 400
    // raised mid tool-loop on a path the chain runner did not catch). Such an
    // error is a PROVIDER failure, not a server bug — surface the same graceful
    // `coach.provider.*` frame the chain path uses rather than rethrowing into
    // an HTTP 500 (the bug that took the live Coach down for codex users). Only
    // a genuinely unexpected error (no upstream tag, no httpStatus) keeps the
    // 500 + GlitchTip path so real defects stay visible.
    const providerError = classifyBubblingProviderError(err);
    if (providerError) {
      annotate({
        action: { name: "insights.coach.providerFailed" },
        meta: {
          attempts: 1,
          firstStatus: providerError.httpStatus,
          credentialExpired: providerError.code === "credential_expired",
          unwrapped: true,
        },
      });
      return { ok: false, code: `coach.provider.${providerError.code}` };
    }
    throw err;
  }
}
