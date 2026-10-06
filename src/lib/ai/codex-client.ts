import { randomUUID } from "node:crypto";
import { callTimeoutMs } from "./effective-timeout";
import { safeFetch } from "@/lib/safe-fetch";
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
  learnedReasoningDialect,
  rememberReasoningDialect,
} from "./reasoning/dialect-cache";
import type { ReasoningLevel } from "./reasoning/levels";
import { levelOfWireEffort, reasoningTitleOf } from "./reasoning/support";
import {
  getCachedCodexSlug,
  invalidateCachedCodexSlug,
  setCachedCodexSlug,
} from "./codex-slug-cache";

/**
 * Codex backend client — talks to `chatgpt.com/backend-api/codex/responses`
 * via the OpenAI Responses API (SSE streaming, ChatGPT-Account-ID
 * header, OAuth Bearer auth). Implemented against the spec at
 * `docs/codex-protocol-spec.md`, which mirrors the official `openai/codex`
 * CLI.
 *
 * Required headers:
 *   - `Authorization: Bearer <oauth-access-token>`
 *   - `ChatGPT-Account-ID: <chatgpt_account_id JWT claim>`
 *   - `Content-Type: application/json`
 *   - `Accept: text/event-stream`
 *   - `originator`, `User-Agent`, `session_id`, `thread_id`
 *
 * Response is always SSE (server rejects `stream: false` with 400).
 *
 * v1.4.15 (Phase C1) adds a slug-drift defence — see
 * `docs/codex-protocol-spec.md` §7b. The client walks an ordered
 * fallback chain on every fresh request series (short-circuiting on
 * a cached working slug) so a single upstream allow-list rotation no
 * longer bricks the integration.
 */

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/**
 * Default fallback chain — most-current-first as of 2026-06-02. Override
 * via `CODEX_MODEL_FALLBACK_CHAIN` (comma-separated) on apps01 if a
 * specific plan ladder needs different ordering. `CODEX_MODEL` is
 * folded into position 0 of the chain when set; duplicates are dropped.
 *
 * The ChatGPT Codex backend rotated its ChatGPT-auth slugs off the
 * `-codex` specialist line onto the plain `gpt-5.x` line on 2026-06-02;
 * the former `-codex` defaults are now rejected with a 503 "all
 * configured Codex slugs were rejected". The ladder below tracks the
 * current accepted set.
 */
const DEFAULT_SLUG_FALLBACK_CHAIN = [
  "gpt-5.5", // current default across paid tiers as of 2026-06-02
  "gpt-5.4", // documented fallback
  "gpt-5.4-mini", // documented lighter-weight fallback
  "gpt-5.3-codex", // late rung — still accepted intermittently
  "gpt-5.2", // legacy floor
] as const;

/**
 * The slug the codex vision gate reasons about *before* a request runs: the
 * cached working slug if one is live, else the first chain entry. Lets the
 * Lab-OCR capability resolver decide whether codex can read images without
 * standing up a client or making a network call. Best-effort — the actual
 * routed slug may differ once the chain walk runs, which the runtime probe +
 * graceful fallback (text/local OCR) covers.
 */
export function resolveCodexVisionSlug(): string | null {
  const cached = getCachedCodexSlug();
  if (cached) return cached;
  return loadFallbackChain()[0] ?? null;
}

function loadFallbackChain(): string[] {
  const envChain = process.env.CODEX_MODEL_FALLBACK_CHAIN?.trim();
  const fromEnv = envChain
    ? envChain
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_SLUG_FALLBACK_CHAIN];
  const pinned = process.env.CODEX_MODEL?.trim();
  const merged = pinned ? [pinned, ...fromEnv] : fromEnv;
  // Stable de-duplication.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of merged) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    result.push(slug);
  }
  return result;
}

/**
 * Triggers per spec §7b — body / status that mean "this slug is no
 * longer accepted, walk to the next one in the chain".
 */
function isSlugRejection(status: number, bodyExcerpt: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  const lower = bodyExcerpt.toLowerCase();
  if (lower.includes("not supported when using codex with a chatgpt account")) {
    return true;
  }
  if (lower.includes("model_not_found")) return true;
  if (lower.includes("does not exist") && lower.includes("model")) {
    return true;
  }
  return false;
}

const ORIGINATOR = "healthlog";
const USER_AGENT = "HealthLog/1.0 (+https://github.com/MBombeck/HealthLog)";

/** A Responses-API user/assistant content block. */
type CodexContentBlock =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "high" }
  | { type: "output_text"; text: string };

/** A Responses-API input item. */
type CodexInputItem =
  | {
      type: "message";
      role: "user" | "assistant";
      content: CodexContentBlock[];
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    }
  // v1.41 — a reasoning item from an earlier round of the same turn, handed
  // back exactly as the stream delivered it (encrypted content included).
  | Record<string, unknown>;

/**
 * Map an `AiContentPart[]` body into Responses input content blocks. Text parts
 * on an assistant turn use `output_text` (Responses API requires it for
 * assistant replays); user turns use `input_text`. Image parts are user-only.
 */
function mapCodexParts(
  parts: AiContentPart[],
  role: "user" | "assistant",
): CodexContentBlock[] {
  const textType: "input_text" | "output_text" =
    role === "assistant" ? "output_text" : "input_text";
  const out: CodexContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      out.push({ type: textType, text: part.text });
    } else if (part.type === "image") {
      out.push({
        type: "input_image",
        image_url: `data:${part.mediaType};base64,${part.dataBase64}`,
        detail: "high",
      });
    }
    // `document` (PDF) parts are not representable here (image-only wire).
  }
  return out;
}

/**
 * Build the Responses-API `input` array from the message turns. Tool-call /
 * tool-result turns map to the `function_call` / `function_call_output`
 * top-level items the Responses API expects; everything else is a `message`.
 * A text-only single user turn is byte-identical to the pre-refactor wire.
 */
function buildCodexInput(
  messages: AiMessage[],
  slug: string,
): CodexInputItem[] {
  const items: CodexInputItem[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: m.toolCallId ?? "",
        output: typeof m.content === "string" ? m.content : "",
      });
      continue;
    }
    // v1.21.3 — assistant message replays MUST use `output_text`, not
    // `input_text` (Responses API; docs/codex-protocol-spec.md §2b). The
    // single-user-turn case never hit this — only the multi-round tool loop
    // replays a prior assistant turn — so the spec violation surfaced as a 400
    // exactly on the Coach tool-call path that broke in production. User turns
    // keep `input_text` / `input_image`.
    const textType: "input_text" | "output_text" =
      m.role === "assistant" ? "output_text" : "input_text";
    const content: CodexContentBlock[] =
      typeof m.content === "string"
        ? [{ type: textType, text: m.content }]
        : mapCodexParts(m.content, m.role);
    // v1.41 — the reasoning items this round produced go back before its
    // message and function calls, unchanged: with `store: false` the server
    // keeps nothing, and a tool round that loses its reasoning items reasons
    // from scratch (https://developers.openai.com/cookbook/examples/responses_api/reasoning_items).
    // Only state this client produced for this slug is re-inserted; anything
    // else (another provider's state, a slug the chain walked away from) is
    // dropped, because an encrypted item is only readable where it was made.
    if (m.role === "assistant") {
      for (const item of codexStateItems(m.providerState, slug)) {
        items.push(item);
      }
    }
    items.push({ type: "message", role: m.role, content });
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        items.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
    }
  }
  return items;
}

/** The reasoning items of `state` when this client made it for `slug`. */
function codexStateItems(
  state: AiProviderState | undefined,
  slug: string,
): Record<string, unknown>[] {
  if (!state || state.providerType !== "codex" || state.model !== slug) {
    return [];
  }
  return state.items.filter(
    (item): item is Record<string, unknown> =>
      item !== null &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "reasoning",
  );
}

// ── v1.41 reasoning wire ────────────────────────────────────────────────────

/**
 * The Responses-API efforts in ascending order. The Codex backend names the
 * values a slug accepts in its 400 body ("Supported values are: 'none',
 * 'low', …"), which is how a slug's ladder is learned.
 */
const CODEX_EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** What one request sends: `null` is today's `reasoning: null`. */
type CodexReasoningWire = { effort: string; summary: boolean } | null;

/** What a slug was learned to refuse (see `reasoning/dialect-cache.ts`). */
interface CodexReasoningDialect {
  /** The slug refused `reasoning` altogether. */
  disabled?: true;
  /** The slug refused `reasoning.summary`. */
  noSummary?: true;
  /** The efforts the slug named as supported when it refused one. */
  efforts?: string[];
}

function dialectKey(slug: string) {
  return { provider: "codex", endpoint: CODEX_ENDPOINT, model: slug };
}

function readCodexDialect(slug: string): CodexReasoningDialect {
  const raw = learnedReasoningDialect(dialectKey(slug));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CodexReasoningDialect;
  } catch {
    return {};
  }
}

function wantedEffort(level: ReasoningLevel): string {
  // "Off" is a real off on the current slugs: a 2026-10-06 probe answered
  // `effort: "none"` on gpt-5.5 with a non-reasoning reply. A slug that
  // refuses it learns its lowest supported value instead.
  return level === "off" ? "none" : level;
}

/** The supported effort closest to `wanted` from below, else the lowest. */
function nearestEffort(wanted: string, supported: string[]): string | null {
  const rank = (e: string) =>
    (CODEX_EFFORT_ORDER as readonly string[]).indexOf(e);
  const known = supported
    .filter((e) => rank(e) >= 0)
    .sort((a, b) => rank(a) - rank(b));
  if (known.length === 0) return null;
  const below = known.filter((e) => rank(e) <= rank(wanted));
  return below.length > 0 ? below[below.length - 1] : known[0];
}

function planCodexReasoning(
  reasoning: CompletionParams["reasoning"],
  slug: string,
): CodexReasoningWire {
  if (!reasoning) return null;
  const dialect = readCodexDialect(slug);
  if (dialect.disabled) return null;
  let effort: string | null = wantedEffort(reasoning.effort);
  if (dialect.efforts && !dialect.efforts.includes(effort)) {
    effort = nearestEffort(effort, dialect.efforts);
  }
  if (!effort) return null;
  return {
    effort,
    summary: reasoning.summaries && effort !== "none" && !dialect.noSummary,
  };
}

/**
 * Read a 400 that refuses a reasoning parameter and learn what the slug
 * accepts instead. Returns the lesser wire to retry with, or `undefined`
 * when the body is not about reasoning (the caller's error path takes it).
 */
function learnFromReasoningRejection(
  slug: string,
  wire: Exclude<CodexReasoningWire, null>,
  status: number,
  body: string,
): CodexReasoningWire | undefined {
  // Only a body that names the reasoning parameter counts; a 400 about the
  // prompt or a tool must not teach the slug anything.
  if (status !== 400 || !/reasoning/i.test(body)) {
    return undefined;
  }
  const dialect = readCodexDialect(slug);
  let next: CodexReasoningWire;
  if (wire.summary && /reasoning\.summary|summary/i.test(body)) {
    dialect.noSummary = true;
    next = { effort: wire.effort, summary: false };
  } else {
    const listed = /supported values are:([^"\n]*)/i.exec(body);
    const efforts = listed
      ? Array.from(listed[1].matchAll(/'([a-z]+)'/g), (m) => m[1])
      : [];
    const nearest =
      efforts.length > 0 && !efforts.includes(wire.effort)
        ? nearestEffort(wire.effort, efforts)
        : null;
    if (nearest) {
      dialect.efforts = efforts;
      next = { effort: nearest, summary: wire.summary && nearest !== "none" };
    } else {
      dialect.disabled = true;
      next = null;
    }
  }
  rememberReasoningDialect(dialectKey(slug), JSON.stringify(dialect));
  annotateReasoningDowngrade(
    "codex",
    wire.effort,
    next ? next.effort : "default",
  );
  return next;
}

/**
 * Map tool defs into the Responses `function` tool shape.
 *
 * v1.21.3 — the Responses-API function tool requires an explicit `strict`
 * field; omitting it is one documented cause of a 400 on a client-supplied
 * `tools` array. We send `strict: false` because the Coach tool schemas are
 * not authored to the strict-mode contract (which additionally demands
 * `additionalProperties: false` and every property in `required`). This is
 * codex-only — the OpenAI Chat-Completions client nests tools differently and
 * is untouched.
 */
function buildCodexTools(tools: AiToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    strict: false,
    parameters: t.parameters,
  }));
}

interface CodexClientConfig {
  accessToken: string;
  accountId: string;
  onTokenRefresh: () => Promise<{ accessToken: string; accountId: string }>;
  /**
   * Override the slug fallback chain (test-only). When unset, the
   * chain is loaded from env + DEFAULT_SLUG_FALLBACK_CHAIN.
   */
  slugChain?: string[];
}

/** Diagnostic shape returned to the route layer for Wide-Event logging. */
export interface CodexAttemptDiagnostics {
  attempted: string[];
  cacheState: "hit" | "miss" | "expired";
  workingSlug: string | null;
}

export class CodexClient implements AIProvider {
  readonly type = "codex" as const;
  /** See `AIProvider.responseTimeoutSeconds`; stamped by the resolver. */
  responseTimeoutSeconds: number | null = null;
  private accessToken: string;
  private accountId: string;
  private onTokenRefresh: () => Promise<{
    accessToken: string;
    accountId: string;
  }>;
  private readonly slugChain: string[];
  private lastDiagnostics: CodexAttemptDiagnostics | null = null;

  constructor(config: CodexClientConfig) {
    this.accessToken = config.accessToken;
    this.accountId = config.accountId;
    this.onTokenRefresh = config.onTokenRefresh;
    this.slugChain = config.slugChain ?? loadFallbackChain();
    if (this.slugChain.length === 0) {
      // Hardcoded floor — even with a misconfigured env var we always
      // try at least one slug.
      this.slugChain = [...DEFAULT_SLUG_FALLBACK_CHAIN];
    }
  }

  /**
   * Diagnostics for the most recent generateCompletion() call, used by
   * the route layer for Wide-Event annotations. Captures the order of
   * attempted slugs, whether the cache was hit, and which slug
   * eventually worked (or null on all-failed).
   */
  getLastDiagnostics(): CodexAttemptDiagnostics | null {
    return this.lastDiagnostics;
  }

  /**
   * Build the slug-attempt order: cached slug first (if any and not
   * expired), then the rest of the fallback chain in order, deduped
   * against the cached slug.
   */
  private buildAttemptOrder(): { order: string[]; cacheState: "hit" | "miss" } {
    const cached = getCachedCodexSlug();
    if (cached === null) {
      return { order: [...this.slugChain], cacheState: "miss" };
    }
    const order = [cached, ...this.slugChain.filter((s) => s !== cached)];
    return { order, cacheState: "hit" };
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const { order, cacheState } = this.buildAttemptOrder();
    const attempted: string[] = [];
    let lastSlugRejectionError: Error | null = null;

    for (const slug of order) {
      attempted.push(slug);

      let wire = planCodexReasoning(params.reasoning, slug);
      const firstAttempt = await this.doRequest(params, slug, wire);

      if (firstAttempt.status === 401) {
        // Token-refresh path — don't walk the chain, this is auth-state
        // not slug-state. Refresh once and re-try the SAME slug.
        const fresh = await this.onTokenRefresh();
        this.accessToken = fresh.accessToken;
        this.accountId = fresh.accountId;
        const retryAfterRefresh = await this.doRequest(params, slug, wire);
        if (retryAfterRefresh.ok) {
          this.lastDiagnostics = {
            attempted,
            cacheState,
            workingSlug: slug,
          };
          setCachedCodexSlug(slug);
          return this.parseResponse(retryAfterRefresh, slug, params, wire);
        }
        // Even after refresh — surface the auth failure verbatim, do
        // NOT walk the chain (auth issues don't get fixed by changing
        // the slug).
        throw await this.buildUpstreamError(
          retryAfterRefresh,
          "Codex request failed after token refresh",
          slug,
        );
      }

      let attempt = firstAttempt;
      let rawBody = "";
      // v1.41 — a slug that refuses a reasoning parameter is asked again with
      // the lesser request it names (no summary, a lower effort, no reasoning
      // at all), and the slug remembers it. The answer is never lost to a
      // reasoning refusal. Bounded: each step strictly reduces the request.
      for (let step = 0; !attempt.ok && step < 3; step += 1) {
        rawBody = await attempt.text().catch(() => "");
        if (!wire) break;
        const next = learnFromReasoningRejection(
          slug,
          wire,
          attempt.status,
          redactBody(rawBody),
        );
        if (next === undefined) break;
        wire = next;
        rawBody = "";
        attempt = await this.doRequest(params, slug, wire);
      }

      if (attempt.ok) {
        this.lastDiagnostics = {
          attempted,
          cacheState,
          workingSlug: slug,
        };
        setCachedCodexSlug(slug);
        return this.parseResponse(attempt, slug, params, wire);
      }

      // Capture the body for the slug-rejection check.
      if (!rawBody) rawBody = await attempt.text().catch(() => "");
      const bodyExcerpt = redactBody(rawBody);

      if (isSlugRejection(attempt.status, bodyExcerpt)) {
        // Slug rejected — drop the cache (in case it pointed here),
        // record the failure for diagnostics, and walk to the next
        // chain slot.
        invalidateCachedCodexSlug();
        const slugErr = new Error(
          `Codex slug "${slug}" rejected (${attempt.status})`,
        );
        Object.assign(slugErr, {
          httpStatus: attempt.status,
          upstream: "codex",
          model: slug,
          bodyExcerpt,
        });
        lastSlugRejectionError = slugErr;
        continue;
      }

      // Non-slug error (5xx, 429, invalid_prompt, etc.) — propagate
      // immediately. Walking the chain wouldn't help.
      //
      // v1.21.3 — fold the redacted upstream body into the message itself, not
      // just a side property. Codex's 400 body names the exact field/param it
      // rejected; without it in the message the chain runner's `summariseError`
      // (which reads `err.message`) logged a bare "Codex request failed (400)"
      // with no actionable reason — which is what made the live tool-call 400
      // un-diagnosable. The body is already redacted of bearer/sk- secrets.
      const err = new Error(
        bodyExcerpt
          ? `Codex request failed (${attempt.status}): ${bodyExcerpt}`
          : `Codex request failed (${attempt.status})`,
      );
      Object.assign(err, {
        httpStatus: attempt.status,
        upstream: "codex",
        model: slug,
        bodyExcerpt,
      });
      this.lastDiagnostics = {
        attempted,
        cacheState,
        workingSlug: null,
      };
      throw err;
    }

    // All slugs exhausted — every one rejected as not-supported.
    this.lastDiagnostics = {
      attempted,
      cacheState,
      workingSlug: null,
    };
    const message =
      "AI provider unreachable — all configured Codex slugs were rejected";
    const err = new Error(message);
    Object.assign(err, {
      httpStatus: 503,
      upstream: "codex",
      model: attempted[attempted.length - 1] ?? null,
      bodyExcerpt: lastSlugRejectionError
        ? (lastSlugRejectionError as Error & { bodyExcerpt?: string })
            .bodyExcerpt
        : null,
      attempted,
    });
    throw err;
  }

  private async buildUpstreamError(
    res: Response,
    message: string,
    slug: string,
  ): Promise<Error> {
    const rawBody = await res.text().catch(() => "");
    const bodyExcerpt = redactBody(rawBody);
    // v1.21.3 — fold the redacted body into the message (see the non-slug error
    // path); the chain runner's `summariseError` reads `err.message`.
    const err = new Error(
      bodyExcerpt
        ? `${message} (${res.status}): ${bodyExcerpt}`
        : `${message} (${res.status})`,
    );
    Object.assign(err, {
      httpStatus: res.status,
      upstream: "codex",
      model: slug,
      bodyExcerpt,
    });
    return err;
  }

  private async doRequest(
    params: CompletionParams,
    slug: string,
    wire: CodexReasoningWire,
  ): Promise<Response> {
    const sessionId = randomUUID();
    const threadId = randomUUID();

    // v1.18.11 — fold vision inputs (Lab-OCR) into the user turn when present.
    // The Codex/ChatGPT-OAuth backend accepts the `input_image` content block
    // on this same `codex/responses` endpoint (docs/codex-protocol-spec.md
    // §2b: `image_url` accepts a `data:<mime>;base64,...` URL, `detail`
    // defaults to "high"). Image INPUT consumes the ChatGPT plan allocation —
    // no API key is required (an API key only matters for image GENERATION).
    // When no images are present the content is byte-identical to the prior
    // text-only wire, so every text caller (Coach, insights, status cards) is
    // untouched. The image is UNTRUSTED data to transcribe, framed as such by
    // the system prompt. Documents (PDF) are NOT folded in — `input_image` is
    // image-only; the OCR route gates PDFs to Anthropic.
    //
    // v1.20.0 — `input` is now built from the full message array (multi-turn +
    // tool-result turns), with `tools` mapped to the Responses `function` shape
    // (the wire already declared `tools`/`tool_choice` — now they carry defs).
    const input = buildCodexInput(params.messages, slug);
    const tools =
      params.tools && params.tools.length > 0
        ? buildCodexTools(params.tools)
        : [];
    const toolChoice = params.toolChoice ?? "auto";

    return safeFetch(
      CODEX_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.accessToken}`,
          "ChatGPT-Account-ID": this.accountId,
          originator: ORIGINATOR,
          "User-Agent": USER_AGENT,
          session_id: sessionId,
          "session-id": sessionId,
          thread_id: threadId,
          "thread-id": threadId,
        },
        body: JSON.stringify({
          model: slug,
          instructions: params.system,
          input,
          tools,
          tool_choice: toolChoice,
          parallel_tool_calls: false,
          // Reasoning is required-but-nullable on the wire. Without a
          // requested level (every caller before v1.41, and every caller
          // that does not opt in) it stays `null`, the field present so the
          // server stops complaining about a missing key (it returned 400 in
          // earlier iterations). With one, the official client's shape:
          // `{ effort, summary }`, `summary` only when summaries are wanted.
          // https://developers.openai.com/api/docs/guides/reasoning
          reasoning: wire
            ? {
                effort: wire.effort,
                ...(wire.summary ? { summary: "auto" } : {}),
              }
            : null,
          store: false,
          stream: true,
          // Required field; empty array when not asking for reasoning. With
          // reasoning on, the encrypted items come back so the next tool
          // round can hand them over statelessly (`store` must stay false).
          include:
            wire && wire.effort !== "none"
              ? ["reasoning.encrypted_content"]
              : [],
        }),
        // SSE streaming completion — match the 60 s budget the other AI
        // clients use so a long generation is not clipped by the 15 s
        // default while still bounding a tar-pit upstream.
      },
      // v1.20.1 — compose the caller's cancel signal (Coach SSE disconnect) so
      // a mid-generation abort tears the upstream call down early.
      // The record owner's response-timeout setting, else the surface value
      // (the comprehensive briefing needs >60 s), else 60 s.
      {
        timeoutMs: callTimeoutMs(params, this.responseTimeoutSeconds),
        signal: params.signal,
      },
    );
  }

  /**
   * Consume the Codex SSE stream and assemble the final assistant
   * message. Event types per the spec:
   *
   *   - `response.output_item.done` — final assembled item; an
   *     assistant `Message` carries the canonical reply in
   *     `item.content[].text`.
   *   - `response.output_text.delta` — incremental chunks; fallback
   *     when no done event arrives.
   *   - `response.completed` — terminal; carries `usage.total_tokens`.
   *   - `response.failed` / `response.incomplete` — terminal errors.
   *
   * Reasoning deltas (`response.reasoning_*.delta`) are deliberately
   * NOT folded into the visible text — they belong to a separate
   * channel.
   */
  private async parseResponse(
    res: Response,
    requestedSlug: string,
    params: CompletionParams,
    wire: CodexReasoningWire,
  ): Promise<CompletionResult> {
    if (!res.body) {
      // v1.20.1 — sentinel httpStatus + kind so the chain classifier can tell
      // a stream-level failure apart from a connect-time transport error.
      const err = new Error("Codex returned no response body");
      Object.assign(err, {
        httpStatus: 0,
        kind: "stream_failed",
        upstream: "codex",
      });
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assembledText = "";
    let deltaText = "";
    let tokensUsed: number | null = null;
    let cachedInputTokens: number | null = null;
    let serverModel: string | null = null;
    const toolCalls: AiToolCall[] = [];

    // v1.41 — reasoning. Events only reach `onReasoning` when the caller asked
    // for reasoning (the contract in `types.ts`); summaries are model text and
    // the receiver screens them.
    const emit = params.reasoning ? params.onReasoning : undefined;
    const reasoningItems: Record<string, unknown>[] = [];
    const summaries: string[] = [];
    let reasoningTokens: number | null = null;
    const summaryBuffers = new Map<string, string>();
    const titled = new Set<string>();
    const texted = new Set<string>();
    const emitTitle = (key: string, text: string) => {
      if (!emit || titled.has(key)) return;
      const title = reasoningTitleOf(text);
      if (title) {
        titled.add(key);
        emit({ kind: "title", text: title });
      }
    };
    const emitText = (key: string, text: string) => {
      if (!emit || texted.has(key) || !text.trim()) return;
      emitTitle(key, text);
      texted.add(key);
      emit({ kind: "text", text });
    };

    // The server reports the actual routed model in the OpenAI-Model
    // response header — useful when safety-routing kicks in.
    const headerModel = res.headers.get("OpenAI-Model");
    if (headerModel) serverModel = headerModel;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);

          const dataLine = rawEvent
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;

          let parsed: {
            type?: string;
            delta?: string;
            text?: string;
            item_id?: string;
            summary_index?: number;
            item?: {
              type?: string;
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
              summary?: Array<{ type?: string; text?: string }>;
              id?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
            };
            response?: {
              usage?: {
                total_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
                output_tokens_details?: { reasoning_tokens?: number };
              };
              error?: { code?: string; message?: string };
              incomplete_details?: { reason?: string };
            };
            error?: { code?: string; message?: string };
          };
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (parsed.type) {
            case "response.output_text.delta": {
              if (parsed.delta) deltaText += parsed.delta;
              break;
            }
            // v1.41 — live reasoning summaries. A summary's first bold line
            // is its title; it goes out as soon as it has closed, the full
            // text when the part is done.
            case "response.reasoning_summary_text.delta": {
              const key = `${parsed.item_id ?? ""}:${parsed.summary_index ?? 0}`;
              const buffered =
                (summaryBuffers.get(key) ?? "") + (parsed.delta ?? "");
              summaryBuffers.set(key, buffered);
              emitTitle(key, buffered);
              break;
            }
            case "response.reasoning_summary_text.done": {
              const key = `${parsed.item_id ?? ""}:${parsed.summary_index ?? 0}`;
              emitText(key, parsed.text ?? summaryBuffers.get(key) ?? "");
              break;
            }
            case "response.output_item.done": {
              const item = parsed.item;
              if (item?.type === "message" && item.role === "assistant") {
                const text = item.content
                  ?.filter((c) => c.type === "output_text" && c.text)
                  .map((c) => c.text!)
                  .join("");
                if (text) assembledText += text;
              } else if (item?.type === "reasoning" && params.reasoning) {
                // The whole item, untouched: the next round hands it back.
                reasoningItems.push(item as Record<string, unknown>);
                (item.summary ?? []).forEach((part, index) => {
                  if (typeof part.text !== "string" || !part.text) return;
                  summaries.push(part.text);
                  // A part whose `.done` never arrived still reaches the
                  // receiver, once.
                  emitText(`${item.id ?? ""}:${index}`, part.text);
                });
              } else if (item?.type === "function_call") {
                // v1.20.0 — the model asked to call a tool. Surface it for
                // F1's loop; the id is the call_id the function_call_output
                // turn must echo back.
                toolCalls.push({
                  id: item.call_id ?? item.id ?? "",
                  name: item.name ?? "",
                  arguments: item.arguments ?? "",
                });
              }
              break;
            }
            case "response.completed": {
              tokensUsed = parsed.response?.usage?.total_tokens ?? null;
              cachedInputTokens =
                parsed.response?.usage?.input_tokens_details?.cached_tokens ??
                null;
              // Reasoning tokens are billed as output and already inside
              // `total_tokens`; reported separately for the trail and budget.
              reasoningTokens =
                parsed.response?.usage?.output_tokens_details
                  ?.reasoning_tokens ?? null;
              break;
            }
            case "response.failed": {
              const err = parsed.response?.error;
              const message =
                err?.message ?? "Codex stream returned response.failed";
              const e = new Error(message);
              Object.assign(e, {
                upstream: "codex",
                // v1.20.1 — sentinel httpStatus + kind so the chain classifier
                // distinguishes a stream-level failure from a transport error.
                httpStatus: 0,
                kind: "stream_failed",
                errorCode: err?.code ?? null,
                model: serverModel ?? requestedSlug,
              });
              throw e;
            }
            case "response.incomplete": {
              const reason =
                parsed.response?.incomplete_details?.reason ??
                "incomplete response";
              const e = new Error(`Codex stream incomplete: ${reason}`);
              Object.assign(e, {
                httpStatus: 0,
                kind: "stream_failed",
                upstream: "codex",
              });
              throw e;
            }
            case "error":
            case "response.error": {
              const message =
                parsed.error?.message ?? "Codex stream returned an error event";
              const e = new Error(message);
              Object.assign(e, {
                httpStatus: 0,
                kind: "stream_failed",
                upstream: "codex",
              });
              throw e;
            }
            default:
              // Unknown event types are tolerated and ignored, same
              // as the official client.
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const content = assembledText || deltaText;
    // A function-call-only reply carries no text — valid (F1). Only an empty
    // reply with neither text NOR a tool call is an error.
    if (!content && toolCalls.length === 0) {
      // v1.20.1 — sentinel httpStatus + kind so the chain classifier can tell
      // an empty reply apart from a transport failure. Cascade unchanged
      // (`status <= 0` is already a hard failure).
      const err = new Error("Codex returned empty content");
      Object.assign(err, {
        httpStatus: 0,
        kind: "empty_response",
        upstream: "codex",
      });
      throw err;
    }

    if (emit) emit({ kind: "done", text: "" });

    const sentLevel = wire ? levelOfWireEffort(wire.effort) : null;
    const reasoning: CompletionResult["reasoning"] = params.reasoning
      ? {
          summary: summaries,
          tokens: reasoningTokens,
          ...(sentLevel !== params.reasoning.effort
            ? { downgradedTo: sentLevel ?? "off" }
            : {}),
        }
      : undefined;

    return {
      content,
      tokensUsed,
      cachedInputTokens,
      model: serverModel ?? requestedSlug,
      providerType: "codex",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      ...(reasoning ? { reasoning } : {}),
      // Keyed on the slug that was asked, not the routed model header: the
      // next round re-inserts the items only when it asks the same slug.
      ...(reasoningItems.length > 0
        ? {
            providerState: {
              providerType: "codex" as const,
              model: requestedSlug,
              items: reasoningItems,
            },
          }
        : {}),
    };
  }
}

function redactBody(rawBody: string): string {
  return rawBody
    .slice(0, 500)
    .replace(/sk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, "sk-***redacted***")
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
}

// Test-only re-exports — keeps the spec-driven defaults visible to unit
// tests without exporting a settable mutable.
export const __test = {
  DEFAULT_SLUG_FALLBACK_CHAIN,
  isSlugRejection,
  loadFallbackChain,
};
