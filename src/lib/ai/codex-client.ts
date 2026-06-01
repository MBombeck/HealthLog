import { randomUUID } from "node:crypto";
import { safeFetch } from "@/lib/safe-fetch";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";
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
 * Default fallback chain — most-current-first as of 2026-05-09. Override
 * via `CODEX_MODEL_FALLBACK_CHAIN` (comma-separated) on apps01 if a
 * specific plan ladder needs different ordering. `CODEX_MODEL` is
 * folded into position 0 of the chain when set; duplicates are dropped.
 */
const DEFAULT_SLUG_FALLBACK_CHAIN = [
  "gpt-5.3-codex", // verified accepted on Plus/Pro 2026-05-09
  "gpt-5-codex", // historical default — kept as second-chance retry; backend may flip back
  "gpt-5", // bare slug — rejected on ChatGPT-auth as of 2026-05; safe to keep as ladder-rung
  "gpt-4o", // last-ditch capability fallback
] as const;

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
const USER_AGENT = "HealthLog/1.0 (+https://healthlog.bombeck.io)";

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

      const firstAttempt = await this.doRequest(params, slug);

      if (firstAttempt.status === 401) {
        // Token-refresh path — don't walk the chain, this is auth-state
        // not slug-state. Refresh once and re-try the SAME slug.
        const fresh = await this.onTokenRefresh();
        this.accessToken = fresh.accessToken;
        this.accountId = fresh.accountId;
        const retryAfterRefresh = await this.doRequest(params, slug);
        if (retryAfterRefresh.ok) {
          this.lastDiagnostics = {
            attempted,
            cacheState,
            workingSlug: slug,
          };
          setCachedCodexSlug(slug);
          return this.parseResponse(retryAfterRefresh, slug);
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

      if (firstAttempt.ok) {
        this.lastDiagnostics = {
          attempted,
          cacheState,
          workingSlug: slug,
        };
        setCachedCodexSlug(slug);
        return this.parseResponse(firstAttempt, slug);
      }

      // Capture the body for the slug-rejection check.
      const rawBody = await firstAttempt.text().catch(() => "");
      const bodyExcerpt = redactBody(rawBody);

      if (isSlugRejection(firstAttempt.status, bodyExcerpt)) {
        // Slug rejected — drop the cache (in case it pointed here),
        // record the failure for diagnostics, and walk to the next
        // chain slot.
        invalidateCachedCodexSlug();
        const slugErr = new Error(
          `Codex slug "${slug}" rejected (${firstAttempt.status})`,
        );
        Object.assign(slugErr, {
          httpStatus: firstAttempt.status,
          upstream: "codex",
          model: slug,
          bodyExcerpt,
        });
        lastSlugRejectionError = slugErr;
        continue;
      }

      // Non-slug error (5xx, 429, invalid_prompt, etc.) — propagate
      // immediately. Walking the chain wouldn't help.
      const err = new Error(`Codex request failed (${firstAttempt.status})`);
      Object.assign(err, {
        httpStatus: firstAttempt.status,
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
    const err = new Error(`${message} (${res.status})`);
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
  ): Promise<Response> {
    const sessionId = randomUUID();
    const threadId = randomUUID();
    return safeFetch(CODEX_ENDPOINT, {
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
        instructions: params.systemPrompt,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: params.userPrompt }],
          },
        ],
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        // Reasoning is required-but-nullable on the wire. We don't ask
        // for reasoning summaries — emit `null` so the JSON has the
        // field present and the server stops complaining about a
        // missing key (it returned 400 in earlier iterations).
        reasoning: null,
        store: false,
        stream: true,
        // Required field; empty array when not asking for reasoning.
        include: [],
      }),
      // SSE streaming completion — match the 60 s budget the other AI
      // clients use so a long generation is not clipped by the 15 s
      // default while still bounding a tar-pit upstream.
    }, { timeoutMs: 60_000 });
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
  ): Promise<CompletionResult> {
    if (!res.body) {
      throw new Error("Codex returned no response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assembledText = "";
    let deltaText = "";
    let tokensUsed: number | null = null;
    let serverModel: string | null = null;

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
            item?: {
              type?: string;
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
            };
            response?: {
              usage?: { total_tokens?: number };
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
            case "response.output_item.done": {
              const item = parsed.item;
              if (item?.type === "message" && item.role === "assistant") {
                const text = item.content
                  ?.filter((c) => c.type === "output_text" && c.text)
                  .map((c) => c.text!)
                  .join("");
                if (text) assembledText += text;
              }
              break;
            }
            case "response.completed": {
              tokensUsed = parsed.response?.usage?.total_tokens ?? null;
              break;
            }
            case "response.failed": {
              const err = parsed.response?.error;
              const message =
                err?.message ?? "Codex stream returned response.failed";
              const e = new Error(message);
              Object.assign(e, {
                upstream: "codex",
                errorCode: err?.code ?? null,
                model: serverModel ?? requestedSlug,
              });
              throw e;
            }
            case "response.incomplete": {
              const reason =
                parsed.response?.incomplete_details?.reason ??
                "incomplete response";
              throw new Error(`Codex stream incomplete: ${reason}`);
            }
            case "error":
            case "response.error": {
              const message =
                parsed.error?.message ?? "Codex stream returned an error event";
              throw new Error(message);
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
    if (!content) {
      throw new Error("Codex returned empty content");
    }

    return {
      content,
      tokensUsed,
      model: serverModel ?? requestedSlug,
      providerType: "codex",
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
