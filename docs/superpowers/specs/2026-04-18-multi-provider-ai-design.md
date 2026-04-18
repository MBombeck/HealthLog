# Multi-provider AI Insights — Design Spec

**Date:** 2026-04-18
**Status:** Draft
**Scope:** Add Anthropic Claude and self-hosted (OpenAI-compatible) LLM endpoints alongside the existing OpenAI / ChatGPT Codex providers. Per-user provider choice, admin-level fallback, encrypted credential storage.

## 1. Problem

Today HealthLog can only talk to OpenAI — either the user's ChatGPT subscription via Codex OAuth, or an admin-managed OpenAI API key. That ties insight generation to a single vendor and to the public internet.

> "I'd like to pick my provider per user. OpenAI for some accounts, Claude for me, and on my home server I want to point HealthLog at a local Ollama instance — none of my BP readings should leave the LAN."
> — User intent

Consequences of the single-vendor model:
- No way to use Anthropic Claude despite better medical-reasoning answers.
- Privacy-sensitive users (BP, mood, medication) have no on-prem option.
- Vendor outages or quota exhaustion bring all insights down (already observed with OpenAI quota).

## 2. Current state

`src/lib/ai/provider.ts` exposes `resolveProvider(userId)` returning an `AIProvider`. The contract in `src/lib/ai/types.ts` is small and provider-agnostic:

```ts
export type ProviderType = "codex" | "admin-key" | "none";
export interface AIProvider {
  type: ProviderType;
  generateCompletion(params: CompletionParams): Promise<CompletionResult>;
}
export interface CompletionParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}
export interface CompletionResult {
  content: string;
  tokensUsed: number | null;
  model: string;
  providerType: ProviderType;
}
```

Implementations: `OpenAIClient` (Chat Completions, `response_format: json_object`, captures upstream body excerpt for diagnostics), `CodexClient` (chatgpt.com Responses API with refresh-on-401). Selection is hard-coded: Codex if connected, else admin OpenAI key, else `NoProvider`.

What needs to change:
- Widen `ProviderType` to include `anthropic` and `local`.
- Add per-user provider choice (currently only Codex is per-user).
- Add per-user model + base-URL + API key fields, mirrored on `AppSettings`.
- Two new clients (`AnthropicClient`, `LocalOpenAICompatibleClient`).
- New selection function that honors user preference before admin defaults.

## 3. Target abstraction

The `AIProvider` interface stays exactly as-is. New concrete clients implement it without touching call-sites in `src/app/api/insights/*`.

```
ProviderType = "codex" | "openai" | "anthropic" | "local" | "admin-key" | "none"
```
(`"admin-key"` retained for back-compat with already-cached `InsightResult.providerType` strings.)

Selection order in `resolveProvider(userId)`:
1. **User explicit choice** (`User.aiProvider`) with valid credentials.
2. **Codex OAuth** if user picked `CHATGPT_OAUTH` and tokens are present (existing path).
3. **Admin default** (`AppSettings.adminAiProvider` + admin key) for users with no personal config.
4. **`NoProvider`** — surface a clear error to the route handler.

The function is the single boundary: every call that needs an LLM goes through it. No client is constructed elsewhere.

## 4. Data model

`User` model additions (all nullable; user keeps current behaviour until they opt in):

```prisma
aiProvider                String?  @map("ai_provider")               // OPENAI | ANTHROPIC | LOCAL | CHATGPT_OAUTH
aiModel                   String?  @map("ai_model")                  // e.g. claude-sonnet-4-6
aiBaseUrl                 String?  @map("ai_base_url")               // local endpoint
aiOpenAiKeyEncrypted      String?  @map("ai_openai_key_encrypted")
aiAnthropicKeyEncrypted   String?  @map("ai_anthropic_key_encrypted")
aiLocalKeyEncrypted       String?  @map("ai_local_key_encrypted")    // optional bearer for local
```

`AppSettings` mirrors:

```prisma
adminAiProvider             String   @default("OPENAI") @map("admin_ai_provider")
adminAiAnthropicKeyEncrypted String? @map("admin_ai_anthropic_key_encrypted")
adminAiAnthropicModel        String? @default("claude-sonnet-4-6") @map("admin_ai_anthropic_model")
adminAiLocalBaseUrl          String? @map("admin_ai_local_base_url")
adminAiLocalKeyEncrypted     String? @map("admin_ai_local_key_encrypted")
adminAiLocalModel            String? @map("admin_ai_local_model")
```

The existing `adminAiKeyEncrypted` / `adminAiModel` / `adminAiBaseUrl` fields stay and represent the OpenAI configuration. One Prisma migration adds the columns; existing users have `aiProvider = NULL` and route through admin default exactly like today.

## 5. New clients

### AnthropicClient
- `POST {baseUrl}/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`.
- `system` parameter for `params.systemPrompt`; `messages: [{ role: "user", content: params.userPrompt }]`.
- Structured JSON via **tool use**: declare a single `record_insight` tool whose `input_schema` mirrors `insightResultSchema`. Set `tool_choice: { type: "tool", name: "record_insight" }`. Read JSON from the `tool_use` block's `input` and serialize to a string for `CompletionResult.content`.
- Prompt caching: send the system prompt with `cache_control: { type: "ephemeral" }`. Insights re-run the same multi-paragraph medical preamble per metric — empirically ~90% cost reduction on cached reads.
- Tokens: sum `usage.input_tokens + usage.output_tokens` (incl. `cache_read_input_tokens`).
- Errors: capture body excerpt like `OpenAIClient` already does, scrub any `sk-ant-...` substrings before logging.

Default models (selectable in UI):
- `claude-sonnet-4-6` (default — quality / cost balance)
- `claude-opus-4-7` (highest quality)
- `claude-haiku-4-5` (cheap, fast)

### LocalOpenAICompatibleClient
- Same wire format as `OpenAIClient` (`/chat/completions`, optional `Authorization: Bearer ...` only if a key is set).
- `baseUrl` is required and user-configurable (e.g. `http://localhost:11434/v1` for Ollama, `http://lm-studio.lan:1234/v1`).
- Some local backends reject `response_format: { type: "json_object" }`. Strategy: feature-detect on first failure (HTTP 400 with body containing `response_format`), persist `User.aiLocalSupportsJsonMode = false`, and re-issue without the field. Append `"Return JSON only, no prose."` to the user prompt and run output through `jsonrepair` before `JSON.parse`.
- No-telemetry mode: never set `User-Agent` beyond `HealthLog/local`, never include user IDs in headers, do not send the request body to Wide Event annotation when provider is `local` (only `model`, `latencyMs`, `tokensUsed`).

## 6. UI — `/settings#ai`

Single dropdown `aiProvider` with options OpenAI / Anthropic Claude / Local LLM / ChatGPT (OAuth). Conditional fields:

| Provider     | Visible fields                                                  |
| ------------ | --------------------------------------------------------------- |
| OpenAI       | API key, model (default `gpt-4o-mini`)                          |
| Anthropic    | API key, model dropdown (sonnet/opus/haiku)                     |
| Local        | Base URL, model name, optional API key, "Disable JSON mode" hint |
| ChatGPT OAuth| Existing Codex connect button                                   |

Each provider section has a **Test connection** button that POSTs to `/api/insights/test` with a tiny prompt (`"Reply with {\"ok\":true}"`), surfacing the upstream status + body excerpt on failure.

Admin settings page gains the same dropdown for the global default plus an explanatory note: *"Used only for users who have not configured their own provider."*

## 7. Backward compatibility

- Migration is additive — no column drops, no data rewrites.
- `User.aiProvider IS NULL` ⇒ behave exactly as today (Codex if connected, else admin OpenAI).
- `CompletionResult.providerType = "admin-key"` continues to be emitted by `OpenAIClient` so cached insights and analytics dashboards keep working. New clients use new strings.
- Existing tests in `src/lib/ai/__tests__` keep passing; new tests are additive.

## 8. Error handling

Each client follows the `OpenAIClient` pattern: capture up to 500 chars of the upstream body, attach `{ httpStatus, upstream, model }` to the thrown `Error`, let `apiHandler` log it as a Wide Event. Per-provider mapping in `src/lib/ai/errors.ts`:

| Upstream                                | User-facing message (i18n key)            |
| --------------------------------------- | ----------------------------------------- |
| Anthropic 401 / `invalid_api_key`       | `insights.error.anthropicInvalidKey`      |
| Anthropic 429 / `rate_limit_error`      | `insights.error.anthropicRateLimited`     |
| Anthropic 529 / `overloaded_error`      | `insights.error.anthropicOverloaded`      |
| Local fetch ECONNREFUSED                | `insights.error.localUnreachable`         |
| Local 400 mentioning `response_format`  | auto-retry once, then `insights.error.localNoJsonMode` |
| OpenAI 429 `insufficient_quota`         | existing key                              |

## 9. Internationalisation

New keys (EN + DE) under `settings.ai.*` and `insights.error.*`:

```
settings.ai.providerLabel               "AI Provider" / "KI-Anbieter"
settings.ai.providerOpenAI              "OpenAI"
settings.ai.providerAnthropic           "Anthropic Claude"
settings.ai.providerLocal               "Local LLM"
settings.ai.providerChatGptOAuth        "ChatGPT (OAuth)"
settings.ai.baseUrlLabel                "Endpoint URL" / "Endpunkt-URL"
settings.ai.baseUrlHint.local           "z.B. http://localhost:11434/v1"
settings.ai.modelLabel                  "Model" / "Modell"
settings.ai.testConnection              "Test connection" / "Verbindung testen"
settings.ai.testSuccess                 "Connection OK ({model}, {ms} ms)"
settings.ai.testFailure                 "Failed: {detail}"
settings.ai.localPrivacyNote            "Requests stay on your network. Bodies are not logged."
insights.error.anthropicInvalidKey      "Anthropic key rejected. Check Settings → AI."
insights.error.anthropicRateLimited     "Anthropic rate-limited. Try again shortly."
insights.error.anthropicOverloaded      "Anthropic is overloaded. Try again in a minute."
insights.error.localUnreachable         "Local LLM endpoint not reachable: {url}"
insights.error.localNoJsonMode          "Local model rejected JSON mode — falling back to text parsing."
```

## 10. Security

- All keys stored via existing AES-256-GCM helpers in `src/lib/crypto.ts`. Never persist plaintext.
- Anthropic keys begin with `sk-ant-`. The Wide Event redactor (`src/lib/logging/event-builder.ts`) gets a regex `/sk-ant-[A-Za-z0-9_\-]{20,}/g` → `"sk-ant-***"` applied to all `externalCalls[].errorBody`.
- Local provider runs with `next/server` `fetch` against arbitrary URLs — validate that `aiBaseUrl` parses as `http`/`https`, reject `file://`, `data://`, and (in production) bare IPs in private ranges *unless* `LOCAL_LLM_ALLOW_PRIVATE=true` (default true on self-hosted, false on `apps-01` build).
- Test-connection endpoint is `requireAuth` and rate-limited (5 req/min/user) to prevent SSRF probing.
- Admin keys remain admin-only via `requireAdmin()`.

## 11. Nyquist validation

- **Unit (Vitest)** — one `*.test.ts` per new client, mocking `fetch`:
  - `anthropic-client.test.ts`: success path returns parsed JSON from tool_use; 401 maps to error; cache_control header present.
  - `local-client.test.ts`: success path; auto-retry on `response_format` 400; ECONNREFUSED handled; bearer header omitted when no key.
- **Integration** — extend `provider.test.ts`:
  - User with `aiProvider = ANTHROPIC` and key → returns `AnthropicClient`.
  - User with no preference falls back to admin default of each kind.
  - Codex still wins when user picks `CHATGPT_OAUTH` and is connected.
- **End-to-end smoke** — manual: switch provider in `/settings#ai`, hit `/api/insights/general-status`, verify `providerType` in cached `InsightResult`.

## 12. Risks & mitigations

- **Admin changes default provider, breaks users.** Mitigated by precedence rule: any user with `aiProvider != NULL` is unaffected. Migration backfills nothing — admin only impacts opted-out users.
- **Local model returns malformed JSON.** Two-layer defence: tool-use where supported, `jsonrepair` fallback otherwise; on persistent failure surface `dataQuality.confidence = "gering"` and the raw text in a debug field.
- **Cached insight from old provider.** Cache key already includes `providerType`; switching provider invalidates naturally on next generate.
- **Anthropic prompt-caching cost regression** if system prompt is rebuilt per request without cache_control. Mitigation: emit a Wide Event metric `ai.cache_read_tokens` and add a Grafana panel.

## 13. Out of scope

- Vendor-specific features beyond JSON output (Anthropic citations, OpenAI function-calling tool registries, Google Gemini).
- Streaming responses to the UI (insights are batch-generated).
- Multi-region routing or load-balancing across providers.
- Per-metric provider override (one provider per user, applied to all metrics).
- Cost dashboards beyond the existing `tokensUsed` field.

## 14. Effort

**M–L.** ~2 days dev:
- 0.5d schema migration + `resolveProvider` rewrite + types.
- 0.5d `AnthropicClient` (tool-use, caching, errors).
- 0.5d `LocalOpenAICompatibleClient` + JSON-mode feature detection + jsonrepair.
- 0.25d settings UI + test-connection endpoint.
- 0.25d i18n + tests + docs.
