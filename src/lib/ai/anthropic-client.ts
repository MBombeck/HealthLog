import { safeFetch } from "@/lib/safe-fetch";
import { callTimeoutMs } from "./effective-timeout";
import { extractJsonObject } from "./json-extract";
import type {
  AIProvider,
  AiContentPart,
  AiMessage,
  AiProviderState,
  AiToolCall,
  AiToolDef,
  CompletionParams,
  CompletionResult,
} from "./types";
import {
  annotateReasoningDowngrade,
  isReasoningParameterRejection,
  learnedReasoningDialect,
  rememberReasoningDialect,
} from "./reasoning/dialect-cache";
import {
  REASONING_LEVELS,
  REASONING_THINKING_BUDGET,
  type ReasoningLevel,
} from "./reasoning/levels";
import {
  anthropicRefusesSampling,
  anthropicThinkingDialect,
  anthropicThinksAlways,
  reasoningTitleOf,
  type AnthropicThinkingDialect,
} from "./reasoning/support";

/**
 * v1.18.9 — Anthropic Messages API content blocks. The text-only path sends a
 * bare string; the vision path (Lab-OCR) sends an array of typed blocks. The
 * uploaded image / PDF is framed strictly as DATA to transcribe by the system
 * prompt — never as instructions (prompt-injection backstop is the human
 * review screen downstream).
 *
 * v1.20.0 — adds the `tool_use` (assistant requests a tool) and `tool_result`
 * (a `role:"user"` turn answering one) blocks so a multi-round tool loop (F1)
 * round-trips natively.
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }
  // v1.41 — `thinking` / `redacted_thinking` blocks of an earlier round,
  // replayed byte-for-byte from `providerState` (signature included).
  | Record<string, unknown>;

interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/**
 * The thinking blocks a model returned, in the shape the next round must hand
 * back: "you must pass thinking blocks back to the API … the complete,
 * unmodified block", with `signature` (`thinking`) or `data`
 * (`redacted_thinking`). https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 */
function isThinkingBlock(block: unknown): block is Record<string, unknown> {
  const type = (block as { type?: unknown } | null)?.type;
  return type === "thinking" || type === "redacted_thinking";
}

/** `state` when this client made it for `model`, else `null`. */
function ownState(
  state: AiProviderState | undefined,
  model: string,
): AiProviderState | null {
  return state && state.providerType === "anthropic" && state.model === model
    ? state
    : null;
}

interface AnthropicClientConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Manual (budget) thinking keeps its thoughts between tool calls only with
 * this beta header; adaptive thinking interleaves on its own.
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking#interleaved-thinking
 */
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

/** What one request asks for. */
type ThinkingPlan =
  | { kind: "none" }
  | { kind: "manual"; budget: number; level: Exclude<ReasoningLevel, "off"> }
  | { kind: "adaptive"; effort: Exclude<ReasoningLevel, "off"> };

/** What a model behind an endpoint was learned to refuse. */
interface AnthropicDialect {
  /** The thinking form that worked after the name-derived one was refused. */
  thinking?: AnthropicThinkingDialect;
  /** The model refused `temperature`. */
  noSampling?: true;
}

// The only JSON steering on this wire. Current Anthropic models reject an
// assistant-turn prefill (the old `{` trick) with HTTP 400, so the contract
// rides on the instruction and on `extractJsonObject` on the way out.
const JSON_INSTRUCTION =
  "\n\nReply with a single JSON object matching the requested schema and nothing else: no prose, no markdown code fences, no explanation before or after the object.";

/**
 * Map an `AiContentPart[]` body into Anthropic content blocks. The media blocks
 * (image / document) are emitted FIRST and the text blocks LAST so the model
 * reads the report before the instruction — matching the pre-refactor
 * `buildVisionContent` ordering exactly.
 */
function mapParts(parts: AiContentPart[]): AnthropicContentBlock[] {
  const media: AnthropicContentBlock[] = [];
  const text: AnthropicContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      text.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      media.push({
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType,
          data: part.dataBase64,
        },
      });
    } else if (part.type === "document") {
      media.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: part.dataBase64,
        },
      });
    }
  }
  return [...media, ...text];
}

/**
 * Map one `AiMessage` to its Anthropic wire turn. A `role:"tool"` turn becomes
 * a `role:"user"` turn carrying a `tool_result` block (Anthropic's convention).
 * An assistant turn with `toolCalls` emits `tool_use` blocks alongside any text.
 */
function mapMessage(m: AiMessage, model: string): AnthropicWireMessage {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: typeof m.content === "string" ? m.content : "",
        },
      ],
    };
  }
  const hasToolCalls =
    m.role === "assistant" && !!m.toolCalls && m.toolCalls.length > 0;

  // v1.41 — an assistant round that thought. When the stored reply's tool
  // calls are exactly the ones this turn carries, the reply goes back as it
  // came (interleaved thinking keeps its order); otherwise its thinking
  // blocks lead and the text and tool_use blocks are rebuilt behind them.
  const state =
    m.role === "assistant" ? ownState(m.providerState, model) : null;
  if (state) {
    const stored = state.items.filter(
      (b): b is Record<string, unknown> => b !== null && typeof b === "object",
    );
    const storedIds = stored
      .filter((b) => b.type === "tool_use")
      .map((b) => String(b.id))
      .sort();
    const turnIds = (m.toolCalls ?? []).map((tc) => tc.id).sort();
    if (
      storedIds.length > 0 &&
      storedIds.length === turnIds.length &&
      storedIds.every((id, i) => id === turnIds[i])
    ) {
      return { role: "assistant", content: stored };
    }
    const thinking = stored.filter(isThinkingBlock);
    if (thinking.length > 0) {
      const rebuilt = mapMessage({ ...m, providerState: undefined }, model);
      const rest =
        typeof rebuilt.content === "string"
          ? rebuilt.content.length > 0
            ? [{ type: "text" as const, text: rebuilt.content }]
            : []
          : rebuilt.content;
      return { role: "assistant", content: [...thinking, ...rest] };
    }
  }

  // Plain-string content with no tool calls stays a bare string on the wire —
  // byte-identical to the pre-refactor text-only path. Only build a block array
  // when there are content parts or tool_use blocks to carry.
  if (typeof m.content === "string" && !hasToolCalls) {
    return { role: m.role, content: m.content };
  }

  const blocks: AnthropicContentBlock[] =
    typeof m.content === "string"
      ? m.content.length > 0
        ? [{ type: "text", text: m.content }]
        : []
      : mapParts(m.content);
  if (hasToolCalls) {
    for (const tc of m.toolCalls!) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }
  }
  return { role: m.role, content: blocks };
}

/** Map tool defs into the Anthropic `tools` array. */
function buildAnthropicTools(tools: AiToolDef[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export class AnthropicClient implements AIProvider {
  readonly type = "anthropic" as const;
  /** See `AIProvider.responseTimeoutSeconds`; stamped by the resolver. */
  responseTimeoutSeconds: number | null = null;
  private config: AnthropicClientConfig;

  constructor(config: AnthropicClientConfig) {
    this.config = config;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const baseUrl = (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    const url = `${baseUrl}/messages`;

    const hasTools = !!params.tools && params.tools.length > 0;
    // Tools imply the tool flow, which returns tool_use blocks rather than a
    // JSON body; the object extraction below stays off that path.
    const wantsJson = params.responseFormat === "json" && !hasTools;

    const wireMessages: AnthropicWireMessage[] = params.messages.map((m) =>
      mapMessage(m, this.config.model),
    );

    // JSON-reliability instruction, only for callers that asked for JSON.
    // v1.41 — it used to ride on every request without tools, so the Coach's
    // prose rounds, the judge's final-line verdict and the array-shaped memory
    // extractors were all told to "reply with a single JSON object". Every
    // object-shaped caller sets `responseFormat: "json"` (the status provider
    // does by default), so gating on it changes nothing for them.
    if (wantsJson) {
      for (let i = wireMessages.length - 1; i >= 0; i -= 1) {
        if (wireMessages[i].role !== "user") continue;
        const turn = wireMessages[i];
        if (typeof turn.content === "string") {
          turn.content = `${turn.content}${JSON_INSTRUCTION}`;
        } else {
          // Merge into the trailing text block when there is one (vision turns
          // end with the instruction text) so the wire stays a single text
          // block — byte-identical to the pre-refactor `wrapForJson` output.
          const last = turn.content[turn.content.length - 1];
          if (last && last.type === "text" && typeof last.text === "string") {
            last.text = `${last.text}${JSON_INSTRUCTION}`;
          } else {
            turn.content = [
              ...turn.content,
              { type: "text", text: JSON_INSTRUCTION },
            ];
          }
        }
        break;
      }
    }

    // v1.20.0 — prompt-cache the stable system prefix. Anthropic needs an
    // explicit `cache_control` marker; the system block carries the large
    // brand-free reference grounding + persona, so marking it lets repeated
    // calls (status batch, briefing) read it from cache. Surface
    // `cache_read_input_tokens` for observability.
    const system = [
      {
        type: "text" as const,
        text: params.system,
        cache_control: { type: "ephemeral" as const },
      },
    ];

    const tools = hasTools
      ? buildAnthropicTools(params.tools as AiToolDef[])
      : undefined;
    // Thinking allows only `auto` and `none`, which is all this maps to.
    const toolChoice =
      hasTools && params.toolChoice
        ? params.toolChoice === "none"
          ? { type: "none" as const }
          : { type: "auto" as const }
        : undefined;

    const dialect = this.readDialect();
    let plan = this.planThinking(params, dialect);
    let sendTemperature = this.sendsTemperature(plan, dialect);

    let res = await this.send(url, params, {
      plan,
      sendTemperature,
      system,
      wireMessages,
      tools,
      toolChoice,
      hasTools,
    });

    // v1.41 — a model that refuses the thinking form or the sampling field it
    // was sent is asked again without it, and the endpoint remembers. Each
    // step drops something, so the loop ends; the answer is never lost to a
    // reasoning parameter.
    let rawBody = "";
    for (let step = 0; !res.ok && step < 3; step += 1) {
      rawBody = await res.text().catch(() => "");
      if (res.status !== 400) break;
      const learned = this.learnFromRejection(
        plan,
        sendTemperature,
        rawBody,
        dialect,
      );
      if (!learned) break;
      plan = this.planThinking(params, dialect);
      sendTemperature = this.sendsTemperature(plan, dialect);
      rawBody = "";
      res = await this.send(url, params, {
        plan,
        sendTemperature,
        system,
        wireMessages,
        tools,
        toolChoice,
        hasTools,
      });
    }

    if (!res.ok) {
      // Mirror the openai-client body-capture so 4xx/5xx upstream incidents
      // (model-not-found, overloaded, rate limit) are diagnosable from logs
      // instead of surfacing as an opaque "Anthropic request failed (5xx)".
      // Strip anything that looks like an Anthropic API key from the excerpt
      // before logging.
      if (!rawBody) rawBody = await res.text().catch(() => "");
      const bodyExcerpt = redactAnthropicBody(rawBody);
      const err = new Error(`Anthropic request failed (${res.status})`);
      Object.assign(err, {
        httpStatus: res.status,
        upstream: "anthropic",
        model: this.config.model,
        bodyExcerpt,
      });
      throw err;
    }

    const json = (await res.json()) as {
      content?: Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens_details?: { thinking_tokens?: number };
      };
    };

    const blocks = json.content ?? [];

    // v1.41 — every text block, not just the first: with thinking on, a reply
    // can carry text before and after its thinking or tool_use blocks. Text
    // blocks that follow each other directly are one passage split by the
    // API; a non-text block between them is a paragraph break.
    let rawText: string | undefined;
    let brokenSinceText = false;
    for (const block of blocks) {
      if (block.type !== "text") {
        brokenSinceText = true;
        continue;
      }
      const text = block.text ?? "";
      rawText =
        rawText === undefined
          ? text
          : `${rawText}${brokenSinceText && text ? "\n\n" : ""}${text}`;
      brokenSinceText = false;
    }
    if (rawText !== undefined && rawText.trim() === "") rawText = undefined;

    // v1.20.0 — surface tool_use blocks for F1's loop.
    const toolUseBlocks = blocks.filter((c) => c.type === "tool_use");
    const toolCalls: AiToolCall[] | undefined =
      toolUseBlocks.length > 0
        ? toolUseBlocks.map((b) => ({
            id: b.id ?? "",
            name: b.name ?? "",
            arguments: JSON.stringify(b.input ?? {}),
          }))
        : undefined;

    // A tool_use-only reply carries no text — that is valid (F1). Only an empty
    // reply with neither text NOR a tool call is an error.
    if (!rawText && !toolCalls) {
      // v1.20.1 — sentinel httpStatus + kind so the chain classifier can tell
      // an empty 200-OK reply apart from a transport failure. Cascade unchanged
      // (`status <= 0` is already a hard failure).
      const err = new Error("Anthropic returned empty content");
      Object.assign(err, {
        httpStatus: 0,
        kind: "empty_response",
        upstream: "anthropic",
      });
      throw err;
    }

    // v1.41 — thinking. The blocks travel to the next round untouched (the
    // whole reply, so interleaved order survives); readable summaries go to
    // the receiver after the reply, since this client does not stream.
    const thinkingBlocks = blocks.filter(isThinkingBlock);
    const summary = thinkingBlocks
      .map((b) => (typeof b.thinking === "string" ? b.thinking.trim() : ""))
      .filter((t) => t.length > 0);
    const emit = params.reasoning ? params.onReasoning : undefined;
    if (emit) {
      for (const text of summary) {
        const title = reasoningTitleOf(text);
        if (title) emit({ kind: "title", text: title });
        emit({ kind: "text", text });
      }
      emit({ kind: "done", text: "" });
    }

    // Without a prefill the model returns the whole object, sometimes inside
    // a ```json fence or behind a short lead-in sentence; narrow to the
    // object so the caller parses it as-is.
    const content =
      wantsJson && rawText ? extractJsonObject(rawText) : (rawText ?? "");

    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    const tokensUsed = inputTokens + outputTokens || null;
    const cachedInputTokens = json.usage?.cache_read_input_tokens ?? null;

    // The presence of tool_use blocks is authoritative for the tool-loop gate:
    // F1's loop continues only when `finishReason === "tool_calls"`. Anthropic
    // normally pairs tool_use blocks with `stop_reason: "tool_use"`, but if it
    // ever returns the blocks under a different (or absent) stop_reason, deriving
    // the reason from `stop_reason` alone would drop the tool request and the
    // loop would surface the empty tool_use-only reply as the final answer.
    const finishReason: CompletionResult["finishReason"] =
      toolCalls && toolCalls.length > 0
        ? "tool_calls"
        : json.stop_reason === "tool_use"
          ? "tool_calls"
          : json.stop_reason === "max_tokens"
            ? "length"
            : json.stop_reason === "end_turn"
              ? "stop"
              : undefined;

    const sentLevel = levelOfPlan(plan);
    const reasoning: CompletionResult["reasoning"] = params.reasoning
      ? {
          summary,
          // Thinking is billed as output and already inside `output_tokens`.
          tokens: json.usage?.output_tokens_details?.thinking_tokens ?? null,
          // Only a refusal the endpoint taught counts as a downgrade; a turn
          // that started elsewhere and so runs without thinking does not.
          ...(dialect.thinking !== undefined &&
          REASONING_LEVELS.indexOf(sentLevel) <
            REASONING_LEVELS.indexOf(params.reasoning.effort)
            ? { downgradedTo: sentLevel }
            : {}),
        }
      : undefined;

    return {
      content,
      tokensUsed,
      cachedInputTokens,
      model: this.config.model,
      providerType: "anthropic",
      ...(toolCalls ? { toolCalls } : {}),
      finishReason,
      ...(reasoning ? { reasoning } : {}),
      // State goes back whenever the reply thought, and on every tool round
      // of a call that asked for reasoning: an adaptive round may choose not
      // to think, and the next round must still recognise it as its own.
      ...(thinkingBlocks.length > 0 || (params.reasoning && toolCalls)
        ? {
            providerState: {
              providerType: "anthropic" as const,
              model: this.config.model,
              items: blocks,
            },
          }
        : {}),
    };
  }

  // ── v1.41 reasoning ───────────────────────────────────────────────────────

  private dialectKey() {
    return {
      provider: "anthropic",
      endpoint: this.config.baseUrl ?? DEFAULT_BASE_URL,
      model: this.config.model,
    };
  }

  private readDialect(): AnthropicDialect {
    const raw = learnedReasoningDialect(this.dialectKey());
    if (!raw) return {};
    try {
      return JSON.parse(raw) as AnthropicDialect;
    } catch {
      return {};
    }
  }

  /**
   * The thinking this request asks for. Absent `params.reasoning` → none,
   * today's wire. The dialect comes from the model name (manual budget up to
   * 4.5, adaptive effort from 4.6) unless the endpoint taught otherwise.
   *
   * A turn that began on another provider (or another model) carries
   * assistant tool rounds without our thinking blocks; with thinking on, the
   * API expects the current tool round to start with one, so thinking stays
   * off for the rest of that turn.
   */
  private planThinking(
    params: CompletionParams,
    dialect: AnthropicDialect,
  ): ThinkingPlan {
    const reasoning = params.reasoning;
    if (!reasoning) return { kind: "none" };
    const form =
      dialect.thinking ?? anthropicThinkingDialect(this.config.model);
    if (form === "none") return { kind: "none" };
    if (this.toolRoundStartedElsewhere(params.messages, form)) {
      return { kind: "none" };
    }
    const level = reasoning.effort;
    if (form === "manual") {
      return level === "off"
        ? { kind: "none" }
        : { kind: "manual", budget: REASONING_THINKING_BUDGET[level], level };
    }
    if (level === "off") {
      // From the 5 generation thinking cannot be switched off; the lowest
      // effort is the honest "off" (`offIsReal: false` in support.ts).
      return anthropicThinksAlways(this.config.model)
        ? { kind: "adaptive", effort: "low" }
        : { kind: "none" };
    }
    return { kind: "adaptive", effort: level };
  }

  /**
   * True when the current tool round (the turns after the last user message)
   * has an assistant turn this client did not make for this model: another
   * provider, or another model, started it. In manual mode a turn of ours
   * that ran without thinking counts too, because a budget-mode continuation
   * must open with a thinking block. In adaptive mode the model may have
   * chosen not to think in that round, which the API accepts.
   */
  private toolRoundStartedElsewhere(
    messages: AiMessage[],
    form: AnthropicThinkingDialect,
  ): boolean {
    let lastUser = -1;
    messages.forEach((m, i) => {
      if (m.role === "user") lastUser = i;
    });
    return messages.slice(lastUser + 1).some((m) => {
      if (m.role !== "assistant" || (m.toolCalls?.length ?? 0) === 0) {
        return false;
      }
      const own = ownState(m.providerState, this.config.model);
      if (!own) return true;
      return form === "manual" && !own.items.some(isThinkingBlock);
    });
  }

  /**
   * `temperature` goes out only where the model takes it: never from 4.7 on
   * (the 5 generation refuses even the default), never with thinking on, and
   * never once the endpoint refused it.
   */
  private sendsTemperature(
    plan: ThinkingPlan,
    dialect: AnthropicDialect,
  ): boolean {
    return (
      plan.kind === "none" &&
      !dialect.noSampling &&
      !anthropicRefusesSampling(this.config.model)
    );
  }

  /**
   * Learn from a 400 that refuses a parameter we sent. Returns false when the
   * body is about something else, including a replay error about the
   * thinking blocks handed back ("must start with a thinking block"), which
   * says nothing about the thinking form the model accepts; the caller then
   * raises it as before.
   */
  private learnFromRejection(
    plan: ThinkingPlan,
    sentTemperature: boolean,
    body: string,
    dialect: AnthropicDialect,
  ): boolean {
    const model = this.config.model;
    let changed: string | null = null;
    if (
      sentTemperature &&
      isReasoningParameterRejection(
        400,
        body,
        /temperature|top_p|sampling/i,
        model,
      )
    ) {
      dialect.noSampling = true;
      changed = "sampling";
    } else if (
      plan.kind !== "none" &&
      isReasoningParameterRejection(
        400,
        body,
        /thinking|budget_tokens|adaptive|output_config|effort/i,
        model,
      )
    ) {
      dialect.thinking = plan.kind === "adaptive" ? "manual" : "none";
      changed = plan.kind;
    }
    if (!changed) return false;
    rememberReasoningDialect(this.dialectKey(), JSON.stringify(dialect));
    annotateReasoningDowngrade(
      "anthropic",
      changed,
      changed === "sampling" ? "no-sampling" : (dialect.thinking ?? "none"),
    );
    return true;
  }

  private send(
    url: string,
    params: CompletionParams,
    req: {
      plan: ThinkingPlan;
      sendTemperature: boolean;
      system: unknown;
      wireMessages: AnthropicWireMessage[];
      tools: unknown;
      toolChoice: unknown;
      hasTools: boolean;
    },
  ): Promise<Response> {
    const { plan } = req;
    const answerBudget = params.maxTokens ?? 1000;
    // `max_tokens` bounds thinking and answer together, so the thinking
    // budget rides on top of the answer budget; manual mode additionally
    // requires `budget_tokens < max_tokens`. It is a ceiling, not a charge.
    const maxTokens =
      plan.kind === "manual"
        ? answerBudget + plan.budget
        : plan.kind === "adaptive"
          ? answerBudget + REASONING_THINKING_BUDGET[plan.effort]
          : answerBudget;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (plan.kind === "manual" && req.hasTools) {
      headers["anthropic-beta"] = INTERLEAVED_THINKING_BETA;
    }
    return safeFetch(
      url,
      {
        method: "POST",
        headers,
        // NOTE: Anthropic's Messages API has no `seed` parameter, so
        // `params.seed` is intentionally not forwarded here — output on this
        // provider is non-deterministic regardless of the pinned seed.
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: maxTokens,
          ...(req.sendTemperature
            ? { temperature: params.temperature ?? 0.3 }
            : {}),
          // Manual: a fixed budget. Adaptive: the model decides how much,
          // `effort` steers it, and `display: "summarized"` asks for readable
          // thinking where the default would leave it empty (5 generation).
          // https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
          ...(plan.kind === "manual"
            ? { thinking: { type: "enabled", budget_tokens: plan.budget } }
            : plan.kind === "adaptive"
              ? {
                  thinking: { type: "adaptive", display: "summarized" },
                  output_config: { effort: plan.effort },
                }
              : {}),
          system: req.system,
          messages: req.wireMessages,
          ...(req.tools ? { tools: req.tools } : {}),
          ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
        }),
      },
      // 60 s ceiling — see openai-client.ts for the rationale.
      // v1.11.2 — base URL is user/admin-overridable; pin the connect-time DNS
      // check so a private/metadata address is rejected (SSRF/rebinding).
      // v1.20.1 — compose the caller's cancel signal (Coach SSE disconnect) so
      // a mid-generation abort tears the upstream call down early.
      // The record owner's response-timeout setting, else the surface value, else 60 s.
      {
        timeoutMs: callTimeoutMs(params, this.responseTimeoutSeconds),
        requirePublicHost: true,
        signal: params.signal,
      },
    );
  }
}

/** The level a plan delivers, for `downgradedTo`. */
function levelOfPlan(plan: ThinkingPlan): ReasoningLevel {
  return plan.kind === "manual"
    ? plan.level
    : plan.kind === "adaptive"
      ? plan.effort
      : "off";
}

function redactAnthropicBody(rawBody: string): string {
  return rawBody
    .slice(0, 500)
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***redacted***")
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
}
