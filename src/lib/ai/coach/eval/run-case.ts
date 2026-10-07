/**
 * Coach evaluation case driver (B0, v1.21.3).
 *
 * The single seam both the deterministic graders and the opt-in live judge
 * consume: a case in, a {prose, toolPayloads} capture out. There are two ways
 * to produce that capture:
 *
 *   1. DETERMINISTIC (the per-PR / nightly free floor): the prose is the case's
 *      `idealResponse`, and the authoritative payload set is whatever the case
 *      delivered to the model this turn — its scripted tool results on the tool
 *      path, or the snapshot sections on the no-tools path. No model call, no
 *      network, no flakiness. This proves the GRADERS are correct and the ideal
 *      responses clear them.
 *
 *   2. LIVE (layer 2, gated on `COACH_EVAL_API_KEY`): the prose is the REAL
 *      generation. `runRealCase` drives the actual `runCoachToolLoop` with a
 *      resolved provider chain and captures `result.content` + the loop's
 *      `toolResults` payloads. Used only by `judge.ts`, only when the secret is
 *      present.
 *
 * The authoritative payload-set rule is identical on both paths, so the
 * grounding grader grades the same way whether the prose is scripted or real:
 *   - tool path  → the present tool-result `data` payloads,
 *   - no-tools   → the single `snapshotSections` record.
 * This mirrors the route exactly (`coach-prose-grounding-no-tools.test.ts`).
 */
import type { Locale } from "@/lib/i18n/config";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";
import { TURN_LIMITS } from "@/lib/ai/coach/tools/turn-budget";
import type {
  AiMessage,
  AiToolCall,
  CompletionParams,
  CompletionResult,
} from "@/lib/ai/types";
import type { CoachEvalCase } from "./golden-cases";
import type { CoachScenario, CoachScenarioObservation } from "./scenarios";
import type { ClarifyToolCall } from "@/lib/ai/coach/clarify";

/** The capture both grader layers consume. */
export interface CoachCaseCapture {
  /** The case id, for reporting. */
  id: string;
  /** The prose under grading (scripted ideal, or real generation). */
  prose: string;
  /**
   * The authoritative payload set the prose is graded against — the tool-result
   * `data` payloads on the tool path, or the single snapshot record on the
   * no-tools path. Matches the route's verifier-payload rule exactly.
   */
  toolPayloads: ReadonlyArray<unknown>;
  /**
   * The tool calls the generation made, with their validated arguments.
   * Empty or absent on the deterministic path.
   */
  toolCalls?: ReadonlyArray<{ name: string; args: Record<string, unknown> }>;
}

/**
 * Resolve the authoritative payload set for a case the same way the route does:
 * the present tool-result payloads when the case scripts tools, else the
 * snapshot sections as the single no-tools payload.
 */
export function authoritativePayloads(
  testCase: CoachEvalCase,
): ReadonlyArray<unknown> {
  if (testCase.scriptedToolResults && testCase.scriptedToolResults.length > 0) {
    return testCase.scriptedToolResults
      .filter((r) => r.present)
      .map((r) => r.data);
  }
  return [testCase.snapshotSections];
}

/**
 * DETERMINISTIC capture: grade the case's reference prose against the case's own
 * authoritative payload set. No model, no network.
 */
export function captureDeterministic(
  testCase: CoachEvalCase,
): CoachCaseCapture {
  return {
    id: testCase.id,
    prose: testCase.idealResponse,
    toolPayloads: authoritativePayloads(testCase),
    toolCalls: [],
  };
}

/**
 * LIVE capture: drive the real bounded retrieval loop with a resolved provider
 * chain and capture the generated prose + the loop's present tool payloads.
 *
 * Only `judge.ts` calls this, and only when `COACH_EVAL_API_KEY` is present. It
 * is the ONLY path in the harness that touches the network. Kept dependency-lazy
 * (dynamic import of the loop) so importing this module for the deterministic
 * path never drags the provider graph in.
 */
export async function runRealCase(args: {
  testCase: CoachEvalCase;
  /** A resolved provider chain (the judge builds this from the eval key). */
  providers: import("@/lib/ai/provider-runner").ProviderChainResolved[];
  system: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<CoachCaseCapture> {
  const { runCoachToolLoop } = await import("@/lib/ai/coach/tools/loop");
  const { testCase, providers, system, temperature, maxTokens } = args;

  const out = await runCoachToolLoop({
    userId: `eval:${testCase.id}`,
    providers,
    system,
    messages: [{ role: "user", content: testCase.userMessage }],
    // The eval drives generation; tools are offered but the case's snapshot is
    // folded into the system prompt by the judge so a no-tools provider still
    // has the context. The loop tolerates an empty toolCalls (no-tools path).
    tools: [],
    // An eval case is a fixed transcript, not a person with a setting.
    reach: UNBOUNDED_REACH,
    temperature,
    maxTokens,
  });

  const toolPayloads =
    out.toolResults.length > 0
      ? out.toolResults.filter((r) => r.present).map((r) => r.data)
      : [testCase.snapshotSections];

  return {
    id: testCase.id,
    prose: out.result.content ?? "",
    toolPayloads,
    toolCalls: out.toolTrace.map((t) => ({ name: t.name, args: t.args ?? {} })),
  };
}

// ── Dialog scenarios, live ─────────────────────────────────────────────────

/** The one provider method a live scenario run needs. */
export interface ScenarioProvider {
  generateCompletion(params: CompletionParams): Promise<CompletionResult>;
}

/**
 * How many rounds a live scenario may take: the round cap of the person's
 * own plan (v1.41), the forced answer included.
 */
const SCENARIO_MAX_ROUNDS = TURN_LIMITS.user.maxRounds;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A stand-in tool result: presence follows the scenario's inventory and
 * `show_result` resolves only the scenario's own earlier tables. Figures
 * are left out on purpose: the scenarios grade which call is made, not
 * what the reply says about numbers it was never given.
 */
async function stubToolResult(
  scenario: CoachScenario,
  call: AiToolCall,
  args: Record<string, unknown>,
  ref: string,
): Promise<Record<string, unknown>> {
  const { resolvePriorResultRef } = await import("@/lib/ai/coach/results/refs");
  if (call.name === "compare_series") {
    const metrics = [args.metric, args.metricB].filter(
      (m): m is string => typeof m === "string",
    );
    const held = metrics.every(
      (metric) =>
        scenario.inventory.find((entry) => entry.metric === metric)?.present,
    );
    return held
      ? {
          present: true,
          resultRef: ref,
          data: {
            note: "figures withheld in this evaluation",
            mode: args.mode,
          },
        }
      : { present: false, reason: "no_data" };
  }
  if (call.name === "show_result") {
    const target = resolvePriorResultRef(
      String(args.ref ?? ""),
      priorResultTurns(scenario),
    );
    return target
      ? {
          present: true,
          resultRef: ref,
          data: { shownAgain: args.ref, periods: target.meta.rowCount },
        }
      : { present: false, reason: "unknown_result" };
  }
  const row = scenario.inventory.find((entry) =>
    typeof args.metric === "string"
      ? entry.metric === args.metric
      : entry.tool === call.name,
  );
  if (!row?.present) return { present: false, reason: "no_data" };
  return {
    present: true,
    resultRef: ref,
    data: { note: "figures withheld in this evaluation", readings: row.count },
  };
}

/** The scenario's earlier tables, as the chat turn names them. */
function priorResultTurns(scenario: CoachScenario) {
  if (!scenario.priorResults || scenario.priorResults.length === 0) return [];
  const turnIndex = (scenario.priorTurns ?? []).filter(
    (turn) => turn.role === "assistant",
  ).length;
  return [
    {
      messageId: "prior",
      turnIndex: Math.max(1, turnIndex),
      results: scenario.priorResults,
    },
  ];
}

/**
 * LIVE scenario run: the scenario's question, record and earlier tables in
 * the chat turn's own context (system prompt, tool-mode and dialog
 * addenda, DATA INVENTORY, EARLIER TABLES, transcript), put to a real
 * model over the real tool catalogue, comparisons and the dialog tools
 * for as many rounds as a turn on the person's own plan (v1.41), a question ending the run. Every call is
 * captured with its arguments and answered with a stand-in result; the
 * reply goes through the clarification and chip parsers the turn uses.
 *
 * Only `judge.ts` calls this with a real provider, and only when
 * `COACH_EVAL_API_KEY` is present. Everything is imported lazily so the
 * deterministic path never loads the prompt graph.
 */
export async function runScenarioLive(args: {
  scenario: CoachScenario;
  provider: ScenarioProvider;
}): Promise<CoachScenarioObservation> {
  const { scenario, provider } = args;
  const locale: Locale = scenario.locale;
  const [
    { detectRefusal },
    { getCoachSystemPrompt },
    { buildCoachToolRequest, buildCoachTurnContext, renderPriorResultRefs },
    tools,
    { buildDialogAddenda },
    { localeLanguageNames },
    { parseClarifySentinel, buildClarificationFromTool },
    { parseFollowUpsSentinel },
    { stripResultRefs },
    { COMPARE_SERIES_TOOL_DEF },
    { DIALOG_TOOL_DEFS },
  ] = await Promise.all([
    import("@/lib/ai/coach/refusal"),
    import("@/lib/ai/coach/system-prompt"),
    import("@/lib/ai/coach/chat-request-builder"),
    import("@/lib/ai/coach/tools"),
    import("@/lib/ai/coach/turn/addenda"),
    import("@/lib/i18n/config"),
    import("@/lib/ai/coach/clarify"),
    import("@/lib/ai/coach/follow-ups/parse-sentinel"),
    import("@/lib/ai/coach/results/refs"),
    import("@/lib/ai/coach/tools/compare-series"),
    import("@/lib/ai/coach/tools/dialog-tools"),
  ]);

  const empty: CoachScenarioObservation = {
    toolCalls: [],
    providerCalls: 0,
    context: "",
    prose: "",
    clarification: null,
    followUps: [],
    method: null,
    readDomains: [],
  };
  // The route screens the message before any model sees it.
  const refusal = detectRefusal({ message: scenario.prompt, locale });
  if (refusal.refuse) return { ...empty, prose: refusal.message ?? "" };

  const turnContext = buildCoachTurnContext({
    priorTurns: scenario.priorTurns ?? [],
    priorSummary: null,
    message: scenario.prompt,
    guidedQuestion: undefined,
  });
  const request = buildCoachToolRequest({
    systemPrompt: getCoachSystemPrompt(locale),
    toolModeAddendum: [
      tools.buildToolModeAddendum(locale),
      buildDialogAddenda(locale),
    ].join("\n\n"),
    focusHint: "",
    workoutEvidence: null,
    dataInventory: tools.renderDataInventory({
      entries: scenario.inventory,
      restMode: false,
      cycleEnabled: false,
      window: "last30days",
      probeScope: { window: "last30days" },
    }),
    priorResults: renderPriorResultRefs(priorResultTurns(scenario)),
    guidedBlock: turnContext.guidedBlock,
    transcript: turnContext.transcript,
    languageName: localeLanguageNames[locale],
  });

  const messages: AiMessage[] = [...request.messages];
  const context = [
    request.system,
    ...messages.map((m) => (typeof m.content === "string" ? m.content : "")),
  ].join("\n");
  const toolCalls: CoachScenarioObservation["toolCalls"] = [];
  let providerCalls = 0;
  let refs = 0;
  let prose = "";
  // v1.41 — the turn offers comparisons and the dialog tools too; a
  // clarifying question ends the run with the question as the reply.
  const offered = [
    ...tools.COACH_TOOL_DEFS,
    COMPARE_SERIES_TOOL_DEF,
    ...DIALOG_TOOL_DEFS,
  ];
  let asked: CoachScenarioObservation["clarification"] = null;
  let rounds = 0;
  const seen = new Set<string>();
  let repeats = 0;
  for (let round = 1; round <= SCENARIO_MAX_ROUNDS; round += 1) {
    const offer = round < SCENARIO_MAX_ROUNDS;
    rounds = round;
    providerCalls += 1;
    const result = await provider.generateCompletion({
      system: request.system,
      messages,
      temperature: 0.2,
      maxTokens: 600,
      ...(offer
        ? { tools: offered, toolChoice: "auto" as const }
        : { toolChoice: "none" as const }),
    });
    const calls = offer ? (result.toolCalls ?? []) : [];
    if (calls.length === 0) {
      prose = result.content ?? "";
      break;
    }
    messages.push({
      role: "assistant",
      content: result.content ?? "",
      toolCalls: calls,
    });
    for (const call of calls) {
      const callArgs =
        tools.parseCoachToolArgs(call.name, call.arguments) ??
        parseArgs(call.arguments);
      toolCalls.push({ name: call.name, args: callArgs });
      const signature = `${call.name}:${JSON.stringify(callArgs)}`;
      if (seen.has(signature)) repeats += 1;
      seen.add(signature);
      if (call.name === "ask_clarification") {
        const built = buildClarificationFromTool({
          call: callArgs as unknown as ClarifyToolCall,
          inventory: scenario.inventory,
          locale,
        });
        if (built.ok && round <= 2) {
          asked = built.clarification;
          prose = built.question;
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(
            built.ok && round <= 2
              ? { asked: true }
              : { declined: "invalid", assume: callArgs.assumption ?? null },
          ),
        });
        continue;
      }
      if (call.name === "remember_fact" || call.name === "propose_plan") {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({ declined: "unavailable" }),
        });
        continue;
      }
      refs += 1;
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(
          await stubToolResult(scenario, call, callArgs, `r${refs}`),
        ),
      });
    }
    if (asked) break;
  }

  const clarified = asked
    ? { prose, clarification: asked }
    : parseClarifySentinel({
        prose,
        inventory: scenario.inventory,
        locale,
      });
  const visible = stripResultRefs(
    parseFollowUpsSentinel(clarified.prose).prose,
  ).prose;
  return {
    toolCalls,
    providerCalls,
    context,
    prose: visible,
    clarification: clarified.clarification,
    // Chips and the method line are the server's; nothing to grade here.
    followUps: [],
    method: null,
    readDomains: toolCalls.flatMap((c) =>
      typeof c.args.metric === "string" ? [c.args.metric] : [],
    ),
    toolRounds: rounds - (asked ? 0 : 1),
    repeatedCalls: repeats,
  };
}
