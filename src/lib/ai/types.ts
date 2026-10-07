import type { ReasoningEffort } from "./reasoning-effort";
import type { ReasoningLevel } from "./reasoning/levels";
import { z } from "zod/v4";

// ─── Insight Result Schema ─────────────────────────────────

export const insightFindingSchema = z.object({
  label: z.string(),
  value: z.string(),
  assessment: z.enum(["positive", "neutral", "attention", "warning"]),
  guideline: z.string().optional(),
});

export const insightCorrelationSchema = z.object({
  factor: z.string(),
  effect: z.string(),
  confidence: z.enum(["hoch", "mittel", "gering"]),
});

export const insightDataQualitySchema = z.object({
  coverage: z.string(),
  gaps: z.array(z.string()),
  confidence: z.enum(["hoch", "mittel", "gering"]),
});

/**
 * v1.4.16 phase B5c — rationale shape mirrors the strict
 * `aiRecommendationRationaleSchema`. dataWindow values match
 * `mini-window.ts` so the rec card's mini-chart can pin to the right
 * window without an extra mapping table.
 */
export const insightRecommendationRationaleSchema = z.object({
  dataWindow: z.enum(["last7days", "last30days", "last90days", "allTime"]),
  comparedTo: z.string(),
  deviation: z.string(),
});

/**
 * v1.4.16 — recommendations can be either the legacy plain-string
 * shape OR a structured object carrying an optional medical-reference
 * citation. The card renders a footnote with a labelled link when
 * `referenceId` is set and resolves to a known entry in
 * `MEDICAL_REFERENCES`.
 *
 * v1.4.16 phase B5c — adds `rationale` (Oura-style "Contributors")
 * and `metricSource` so the rec card can render the expand-out
 * explainability panel + a mini-chart pinned to the rec's window.
 * Both fields are optional on the UI type because legacy cached
 * payloads predate them; the server-side `aiRecommendationSchema`
 * enforces presence on fresh generations.
 */
export const insightRecommendationSchema = z.union([
  z.string(),
  z.object({
    text: z.string(),
    referenceId: z.string().optional(),
    rationale: insightRecommendationRationaleSchema.optional(),
    metricSource: z
      .object({
        type: z.string(),
        timeRange: z.string(),
        summary: z.string(),
        n: z.number().optional(),
      })
      .optional(),
    severity: z.enum(["info", "suggestion", "important", "urgent"]).optional(),
    id: z.string().optional(),
    /**
     * v1.4.16 phase B5d — deterministic confidence score (0-100).
     * Optional on the UI type because legacy cached payloads predate
     * the field; `<ConfidenceMeter>` renders a "draft" pill in that
     * case. Server-side `aiRecommendationSchema` mirrors this shape.
     */
    confidence: z.number().int().min(0).max(100).optional(),
  }),
]);

export const insightResultSchema = z.object({
  insightType: z.string().optional(),
  summary: z.string(),
  classification: z.enum([
    "optimal",
    "gut",
    "grenzwertig",
    "erhoht",
    "kritisch",
  ]),
  classificationLabel: z.string().optional(),
  findings: z.array(insightFindingSchema),
  correlations: z.array(insightCorrelationSchema),
  primaryRecommendation: z.string().optional(),
  recommendations: z.array(insightRecommendationSchema),
  dataQuality: insightDataQualitySchema,
  disclaimer: z.string(),
});

export type InsightResult = z.infer<typeof insightResultSchema>;

// ─── Provider Types ────────────────────────────────────────

// v1.33.1 (#470) — `openai-compatible` is the user-configured gateway
// (LiteLLM / OpenRouter / vLLM). It runs the OpenAI client against a base URL
// the user owns, so it is a distinct runtime tag from `admin-key`: logs,
// analytics and the budget classifier must be able to tell "the operator's
// OpenAI key" from "an endpoint someone pointed us at".
export type ProviderType =
  "codex" | "admin-key" | "openai-compatible" | "anthropic" | "local" | "none";

export interface AIProvider {
  type: ProviderType;
  /**
   * v1.20.0 — per-provider tool-calling capability flag. Defaults to true
   * (Anthropic / OpenAI / Codex / mock support tools natively). The local
   * OpenAI-compatible client sets it `false` because most local servers reject
   * an unknown `tools` field; F1's tool loop must treat a provider with
   * `supportsTools === false` (or an empty `toolCalls` result) as "no tools
   * available" and answer from base context.
   */
  supportsTools?: boolean;
  /**
   * The record owner's `aiResponseTimeoutSeconds`, stamped by the resolver
   * that handed this provider out (`bindResponseTimeout`). Each client reads
   * its upstream ceiling through `callTimeoutMs(params, this.responseTimeoutSeconds)`,
   * so the setting reaches every call without the call site passing it.
   * `null` / absent → the surface's `timeoutMs`, else the 60 s default.
   */
  responseTimeoutSeconds?: number | null;
  /**
   * #1126 — the `reasoning_effort` the record owner chose for this provider's
   * chain entry, stamped by the resolver (`bindReasoningEffort`). Only the
   * Local client and the OpenAI-compatible gateway read it, and only they are
   * ever stamped with a value. `null` / absent → Default: the key is not sent.
   */
  reasoningEffort?: ReasoningEffort | null;
  generateCompletion(params: CompletionParams): Promise<CompletionResult>;
  /**
   * v1.22 (#89) — optional true-streaming variant. A provider that can emit
   * tokens incrementally (the local OpenAI-compatible client over `stream:true`)
   * implements this so a slow self-hosted backend (e.g. an MLX/exo server that
   * takes >60 s to load the model before the first token) produces output as it
   * arrives rather than buffering the whole reply behind a single fetch — which
   * is what tripped the legacy total-request timeout and the reverse-proxy idle
   * cut. `onDelta` is called once per token/chunk as it arrives; the returned
   * `CompletionResult` carries the FULL assembled reply so every downstream
   * guard (grounding, refusal, sentinel-stripping) still runs on the complete
   * text. The timeout becomes a per-idle-gap ceiling (time-to-first-token +
   * inter-token gap), not a whole-call ceiling. Providers without a streaming
   * wire omit this; the runner falls back to {@link generateCompletion}.
   */
  generateCompletionStream?(
    params: CompletionParams,
    onDelta: (delta: string) => void,
  ): Promise<CompletionResult>;
}

/**
 * v1.18.9 — a single vision input folded into a message's content parts. Used
 * by the Lab-OCR extraction path: a photo of a paper report, or a PDF page.
 * `dataBase64` is the raw file bytes, base64-encoded (no `data:` prefix —
 * each client wraps it in the wire shape it needs). The blob is NEVER threaded
 * into an `annotate()` meta or any log field (it is health data).
 */
export interface CompletionImage {
  /** One of the sniffed image MIME types. */
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  /** Raw file bytes, base64-encoded (no data-URL prefix). */
  dataBase64: string;
}

/**
 * v1.18.9 — a PDF document folded into a message's content parts. Only
 * Anthropic accepts a native `document` block over the Messages API we use;
 * the other clients ignore it (the OCR route gates PDFs to Anthropic
 * providers).
 */
export interface CompletionDocument {
  mediaType: "application/pdf";
  /** Raw PDF bytes, base64-encoded (no data-URL prefix). */
  dataBase64: string;
}

// ─── Message-array request shape (v1.20.0) ─────────────────
//
// The provider contract takes a structured `{ system, messages[] }` request
// instead of a single `{ systemPrompt, userPrompt }` string pair. This unlocks
// three things in one refactor: provider prompt-caching (Anthropic
// `cache_control` on the stable system prefix, OpenAI/local automatic prefix
// cache), tool-calling (the typed surface F1 builds on), and clean multi-turn.
//
// The provider contract is still request → complete-string today: the Coach
// fake-tokenises a fully-assembled reply downstream and Codex buffers its SSE
// internally, so there is no real token-streaming dependency here.

/** A plain-text content part. */
export interface AiTextPart {
  type: "text";
  text: string;
}
/** An image content part (Lab-OCR vision). */
export interface AiImagePart {
  type: "image";
  mediaType: CompletionImage["mediaType"];
  /** Raw image bytes, base64-encoded (no data-URL prefix). */
  dataBase64: string;
}
/** A PDF document content part (Anthropic-only; other clients drop it). */
export interface AiDocPart {
  type: "document";
  mediaType: "application/pdf";
  /** Raw PDF bytes, base64-encoded (no data-URL prefix). */
  dataBase64: string;
}
export type AiContentPart = AiTextPart | AiImagePart | AiDocPart;

/**
 * v1.20.0 — a tool definition handed to the model. `parameters` is a JSON
 * Schema object; each client maps it into the provider's tool shape. F4 plumbs
 * the param + per-provider wire mapping; F1 supplies real definitions and the
 * call→result→answer loop.
 */
export interface AiToolDef {
  name: string;
  description: string;
  /** JSON-schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
}

/**
 * v1.20.0 — a tool the model asked to call. `arguments` is the raw JSON string
 * the model produced (parsed by F1's loop, never trusted blindly).
 */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * v1.20.0 — one conversation turn. The common case is a plain-string
 * `content`; vision turns and tool-result turns use `parts[]`. `toolCalls` are
 * set on assistant turns that requested tools (F1); `toolCallId` ties a
 * `role:"tool"` turn back to the call it answers (F1).
 */
export interface AiMessage {
  role: "user" | "assistant" | "tool";
  content: string | AiContentPart[];
  /** Set on assistant turns that called tools (F1 fills these). */
  toolCalls?: AiToolCall[];
  /** Set on `role:"tool"` turns — the id of the call this answers. */
  toolCallId?: string;
  /**
   * Anthropic prompt-cache hint — marks a stable message-prefix boundary.
   * A no-op on every other provider (their prefix caching is automatic).
   */
  cacheBreakpoint?: boolean;
  /**
   * v1.41 — opaque provider state carried from one tool round to the next on
   * an assistant turn: the reasoning items a provider requires back verbatim
   * (encrypted reasoning items, thinking blocks with their signatures,
   * reasoning details). Only the client whose `providerType` and `model` match
   * re-inserts it; every other client drops it. Lives in memory for one turn:
   * never persisted, never logged, never passed to `annotate()`.
   */
  providerState?: AiProviderState;
}

/**
 * v1.41 — provider state threaded between the rounds of one turn. `items` is
 * whatever the producing client needs back, unchanged; nothing outside that
 * client reads it.
 */
export interface AiProviderState {
  providerType: ProviderType;
  model: string;
  items: unknown[];
}

/**
 * v1.41 — one live reasoning event a client reports while a call runs.
 * `title` is the first bold line of a summary once it has closed, `text` a
 * finished summary, `done` the end of the reasoning for this call. Model
 * text: the receiver screens it before anything reaches a person.
 */
export interface AiReasoningEvent {
  kind: "title" | "text" | "done";
  text: string;
}

export interface CompletionParams {
  /**
   * Stable system prompt. Carries the brand-free reference grounding, persona
   * and instructions. Eligible for the provider cache prefix on every client;
   * keep per-request volatile data (timestamps, interpolated dates) OUT of it
   * so the cached prefix stays byte-identical across calls.
   */
  system: string;
  /** The conversation turns. The 80% case is one user turn (see {@link singleUserTurn}). */
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Optional deterministic seed. Threaded onto the OpenAI and local
   * (Ollama / OpenAI-compatible) request bodies for reproducible output on
   * the reference surfaces (status cards + period narrative). Anthropic's
   * Messages API has no seed knob, so the Anthropic client ignores it.
   */
  seed?: number;
  /**
   * v1.18.7 — opt the structured (JSON) surfaces into the provider's
   * strongest JSON-reliability mode. When `"json"` (and no `tools`):
   *   - local (Ollama / OpenAI-compatible): adds `format: "json"`.
   *   - Anthropic: prefills the assistant turn with `{` so the first token
   *     is forced into a JSON object.
   *   - OpenAI / Codex: sends `response_format: { type: "json_object" }`.
   * The Coach (prose, NOT JSON) leaves this unset, so no provider coerces
   * its reply into a JSON object — including the OpenAI client, which now
   * gates `response_format` on this flag rather than pinning it always.
   *
   * Mutually exclusive with `tools` on Anthropic: the `{`-prefill injects an
   * assistant turn that collides with a `tool_use` response, so the Anthropic
   * client drops the prefill whenever `tools` are present.
   */
  responseFormat?: "json";
  /**
   * v1.20.0 — tool definitions offered to the model. F4 plumbs the param +
   * per-provider wire mapping; no F4 call site sets it. Local providers may
   * ignore tools entirely — F1's loop must tolerate an empty `toolCalls`.
   */
  tools?: AiToolDef[];
  /**
   * v1.20.0 — `"auto"` lets the model decide; `"none"` forbids tool calls.
   * Mapped per provider; omitted from the wire when unset.
   */
  toolChoice?: "auto" | "none";
  /**
   * v1.20.1 — optional caller-owned cancellation signal. Threaded onto the
   * client's `safeFetch` so a mid-generation client disconnect (the Coach SSE
   * route wires `request.signal` here) tears the upstream provider request
   * down instead of running it to completion and paying the full token cost
   * into a closed connection. Composed with the per-client timeout inside
   * `safeFetch`. Omitted → behaviour is unchanged (timeout-only).
   */
  signal?: AbortSignal;
  /**
   * v1.22 (#89) — per-request upstream timeout, in milliseconds. Each client
   * passes this straight to its `safeFetch` call, falling back to the shared
   * 60 s default when unset — so every existing caller (Coach, status cards)
   * is byte-identical. The comprehensive briefing surface is the one caller
   * that overrides it: its reasoning-heavy single-turn generation over the
   * full feature snapshot ran past the 60 s default on large accounts and was
   * aborted mid-stream ("operation aborted due to timeout"), which left the
   * briefing — and the insights trend narrative that reads the same cached
   * block — permanently blank. Sized in `AI_BUDGETS.comprehensive.timeoutMs`.
   *
   * This is the SURFACE default. The record owner's response-timeout setting,
   * bound to the provider instance at resolution, overrides it (see
   * `callTimeoutMs` in `effective-timeout.ts`) unless `timeoutPolicy` says the
   * value is a hard ceiling.
   */
  timeoutMs?: number;
  /**
   * `"surface-ceiling"` makes `timeoutMs` a hard ceiling the person's
   * response-timeout setting does not lift. Reserved for unattended surfaces
   * that are latency-bounded by design and fall back to deterministic copy
   * (the Coach nudge tick, the reaction line). The set of callers is frozen by
   * `ai-call-timeout-guard.test.ts`.
   */
  timeoutPolicy?: "surface-ceiling";
  /**
   * v1.41 — the reasoning this call asks for, already resolved against the
   * person's level, the operator's cap and what the provider supports
   * (`src/lib/ai/reasoning/resolve.ts`). `summaries` asks for reasoning
   * summaries where the provider offers them. Absent → today's behaviour: the
   * client sends exactly what it sent before the field existed.
   */
  reasoning?: { effort: ReasoningLevel; summaries: boolean };
  /**
   * v1.41.2 — a stable key for calls that resend the same prompt prefix (the
   * rounds of one Coach turn, the turns of one conversation). Providers that
   * route a request to a prompt cache by key read it: Codex as
   * `prompt_cache_key` and its session headers, `api.openai.com` as
   * `prompt_cache_key`. Without it a Codex call is routed afresh every time
   * and a later round pays for its whole prefix again. An opaque value: the
   * caller hashes whatever it derives the key from. Absent → nothing is sent.
   */
  cacheKey?: string;
  /**
   * v1.41 — live reasoning events, called as they arrive on clients that read
   * the provider's stream, or once after the reply on clients that do not.
   * Never called when `reasoning` is absent.
   */
  onReasoning?: (event: AiReasoningEvent) => void;
}

export interface CompletionResult {
  content: string;
  tokensUsed: number | null;
  /**
   * v1.20.0 — prompt-cache observability. The count of input tokens served
   * from the provider's cache, where the provider reports it (Anthropic
   * `cache_read_input_tokens`, OpenAI/Codex `cached_tokens`). Null / absent
   * when the provider does not report it or the prefix did not hit.
   *
   * v1.41.2 — always a share of `tokensUsed`, never beside it: the turn
   * budget and the daily ledger charge `tokensUsed - cachedInputTokens` at
   * full weight and the cached share at a tenth. A client whose provider
   * reports cached input outside its input count (Anthropic) adds it to
   * `tokensUsed`.
   */
  cachedInputTokens?: number | null;
  model: string;
  providerType: ProviderType;
  /**
   * v1.20.0 — populated when the model asked to call tools (F1 consumes).
   * Absent on a plain completion.
   */
  toolCalls?: AiToolCall[];
  /**
   * v1.20.0 — why the model stopped. Lets F1's loop branch only on
   * `"tool_calls"`. Absent when the provider does not surface it.
   */
  finishReason?: "stop" | "tool_calls" | "length";
  /**
   * v1.41 — what the call reasoned, when it reasoned. `summary` holds the
   * finished summaries (model text, unscreened), `tokens` the reasoning tokens
   * the provider billed where it reports them, `downgradedTo` the level the
   * client fell back to after the provider refused the requested one.
   */
  reasoning?: {
    summary: string[];
    tokens: number | null;
    downgradedTo?: ReasoningLevel;
  };
  /**
   * v1.41 — the state the next round of the same turn hands back on its
   * assistant message (see {@link AiMessage.providerState}).
   */
  providerState?: AiProviderState;
}

/**
 * Ergonomic builder for the common single-user-turn completion. Folds an
 * optional vision payload (`images` / `documents`) into the user message's
 * content parts so the Lab-OCR path keeps a one-call shape.
 */
export function singleUserTurn(p: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  seed?: number;
  responseFormat?: "json";
  images?: CompletionImage[];
  documents?: CompletionDocument[];
  tools?: AiToolDef[];
  toolChoice?: "auto" | "none";
  /** v1.20.1 — caller-owned cancel signal threaded to the client fetch. */
  signal?: AbortSignal;
  /** v1.22 (#89) — per-request upstream timeout override (ms); see CompletionParams. */
  timeoutMs?: number;
  /** See `CompletionParams.timeoutPolicy`. */
  timeoutPolicy?: "surface-ceiling";
}): CompletionParams {
  const images = p.images ?? [];
  const documents = p.documents ?? [];
  // Parts order is text-first, then media — the OpenAI / local / Codex wires
  // emit it in this order. The Anthropic client re-orders to media-first when
  // it maps the parts (it reads the report before the instruction), preserving
  // each provider's pre-refactor vision wire byte-for-byte.
  const content: string | AiContentPart[] =
    images.length === 0 && documents.length === 0
      ? p.user
      : [
          { type: "text", text: p.user },
          ...images.map((img): AiImagePart => ({
            type: "image",
            mediaType: img.mediaType,
            dataBase64: img.dataBase64,
          })),
          ...documents.map((doc): AiDocPart => ({
            type: "document",
            mediaType: doc.mediaType,
            dataBase64: doc.dataBase64,
          })),
        ];
  return {
    system: p.system,
    messages: [{ role: "user", content }],
    temperature: p.temperature,
    maxTokens: p.maxTokens,
    seed: p.seed,
    responseFormat: p.responseFormat,
    tools: p.tools,
    toolChoice: p.toolChoice,
    signal: p.signal,
    timeoutMs: p.timeoutMs,
    ...(p.timeoutPolicy ? { timeoutPolicy: p.timeoutPolicy } : {}),
  };
}

/**
 * Return a copy of `params` whose LAST user message has `suffix` appended to
 * its text. Preserves the wire shape of the corrective-retry paths (insight
 * schema retry, OCR retry, briefing grounding correction): they used to append
 * to the single `userPrompt` string, and this keeps the model seeing one user
 * turn with the appended text rather than an extra back-to-back user turn.
 *
 * Throws if there is no user message to append to — every retry path always
 * has one, so a throw is a programming error, not a runtime case.
 */
export function appendToLastUserMessage(
  params: CompletionParams,
  suffix: string,
): CompletionParams {
  const messages = [...params.messages];
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    throw new Error("appendToLastUserMessage: no user message to append to");
  }
  const target = messages[idx];
  if (typeof target.content === "string") {
    messages[idx] = { ...target, content: `${target.content}${suffix}` };
  } else {
    // Vision / parts content — append the suffix as a trailing text part.
    messages[idx] = {
      ...target,
      content: [...target.content, { type: "text", text: suffix }],
    };
  }
  return { ...params, messages };
}
