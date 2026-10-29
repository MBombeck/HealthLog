# Codex Backend Protocol Spec — `chatgpt.com/backend-api/codex/responses`

This is a TypeScript-implementer's reference for the Codex CLI's "Responses-over-HTTP" call to the ChatGPT-backed Codex endpoint. Every claim cites a specific Rust source file in `openai/codex` (path is relative to the repo root).

The endpoint is reverse-engineered from the official client, so this document is the authoritative shape — there is no public OpenAPI for this URL.

---

## 0. Endpoint

- **Method**: `POST`
- **URL**: `https://chatgpt.com/backend-api/codex/responses`
- **Content-Type**: `application/json`
- **Accept**: `text/event-stream` (the client always sets this)
- **Stream**: SSE; non-streaming is not supported on this URL (server returns 400 `"Stream must be set to true"`).

The base URL `https://chatgpt.com/backend-api/codex` is the constant `CHATGPT_CODEX_BASE_URL` in `codex-rs/model-provider-info/src/lib.rs:37`. The path `/responses` is joined onto it by `ResponsesClient::path()` in `codex-rs/codex-api/src/endpoint/responses.rs:102-104` (returns `"responses"`) and the provider's `url_for_path` joins them with a `/`.

The ACCEPT header is forced to `text/event-stream` in `codex-rs/codex-api/src/endpoint/responses.rs:137-140`.

---

## 1. Request body — `ResponsesApiRequest`

Source: `codex-rs/codex-api/src/common.rs:169-190`.

```ts
interface ResponsesApiRequest {
  // Required
  model: string; // e.g. "gpt-5-codex"
  input: ResponseItem[]; // MUST be a list, not a string
  tools: unknown[]; // [] is valid
  tool_choice: string; // "auto" is what core uses
  parallel_tool_calls: boolean; // bool, no default — must serialize
  reasoning: Reasoning | null; // null is allowed; field is required
  store: boolean; // false on chatgpt backend (only true on Azure)
  stream: true; // MUST be true on this URL
  include: string[]; // ["reasoning.encrypted_content"] when reasoning is on, else []

  // Optional (skipped when empty/None)
  instructions?: string; // skipped if "" (serde "skip_serializing_if = String::is_empty")
  service_tier?: string; // omit unless model supports it
  prompt_cache_key?: string; // core sets this to thread_id
  text?: TextControls; // verbosity + JSON-schema output
  client_metadata?: Record<string, string>; // free-form, see below
}
```

Serde rules from `codex-rs/codex-api/src/common.rs:169-190`:

| Field              | Skip-rule                                                         |
| ------------------ | ----------------------------------------------------------------- |
| `instructions`     | skipped when empty string                                         |
| `reasoning`        | always emitted (Option, but no skip attribute → `null` when None) |
| `service_tier`     | skipped when `None`                                               |
| `prompt_cache_key` | skipped when `None`                                               |
| `text`             | skipped when `None`                                               |
| `client_metadata`  | skipped when `None`                                               |

All other fields are always emitted.

There are NO serde renames — wire keys equal Rust field names verbatim.

### 1a. The `Reasoning` block

Source: `codex-rs/codex-api/src/common.rs:113-119`.

```ts
interface Reasoning {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "concise" | "detailed" | "none";
}
```

- `effort` enum: `codex-rs/protocol/src/openai_models.rs:42-52` (lowercase serde). `Medium` is the default if you ask for one.
- `summary` enum: `codex-rs/protocol/src/config_types.rs:24-36` (lowercase serde). The Codex CLI sets `summary` to `Some(...)` only when the user asked for summaries; `ReasoningSummary::None` is mapped to `None` (omitted) in `codex-rs/core/src/client.rs:697-701`.
- When the model does not support reasoning summaries, the entire `reasoning` field is set to `None` (i.e. emitted as `null`): `codex-rs/core/src/client.rs:689-705`.
- When `reasoning` is non-null, the client also sets `include: ["reasoning.encrypted_content"]`. When null, `include: []`. See `codex-rs/core/src/client.rs:721-725`.

### 1b. `TextControls`

Source: `codex-rs/codex-api/src/common.rs:142-148`.

```ts
interface TextControls {
  verbosity?: "low" | "medium" | "high"; // codex-rs/codex-api/src/common.rs:150-157
  format?: TextFormat;
}

interface TextFormat {
  type: "json_schema"; // only variant; codex-rs/codex-api/src/common.rs:121-126
  strict: boolean;
  schema: unknown; // raw JSON-Schema
  name: string; // "codex_output_schema" in CLI; arbitrary
}
```

`text` is omitted entirely when no verbosity AND no output schema is requested (`codex-rs/codex-api/src/common.rs:279-297`).

### 1c. Minimal valid body

For a plain text turn with no tools and no reasoning, the smallest body the Codex client itself ever sends is:

```json
{
  "model": "gpt-5-codex",
  "instructions": "You are a helpful coding agent.",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "Hello" }]
    }
  ],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "reasoning": null,
  "store": false,
  "stream": true,
  "include": []
}
```

`tools: []` is acceptable — the field is required but may be the empty array. `tool_choice: "auto"` is the literal string the CLI always sends (`codex-rs/core/src/client.rs:750`).

### 1d. `client_metadata`

Free-form `Record<string,string>`. The CLI uses it to forward an installation id and (over WebSocket) trace-context headers — none of these are mandatory for the HTTP path. Safe to omit (`None` → field skipped).

---

## 2. `ResponseItem` (the `input` array)

Source: `codex-rs/protocol/src/models.rs:741-891`.

```rust
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseItem { Message {...}, Reasoning {...}, ... }
```

So every entry in `input` is an object with a `type` discriminator (snake_case) plus variant-specific fields.

The variants you'll need for outbound traffic are `Message`, `Reasoning`, `FunctionCall`, `FunctionCallOutput`. The server-only variants (`LocalShellCall`, `WebSearchCall`, `ImageGenerationCall`, `ToolSearchCall`, `ToolSearchOutput`, `CustomToolCall*`, `Compaction`, `ContextCompaction`) appear in stream output and only need to round-trip for multi-turn continuations.

### 2a. `Message`

`codex-rs/protocol/src/models.rs:744-756`.

```ts
interface MessageItem {
  type: "message";
  role: "user" | "assistant" | "system" | "developer"; // free string
  content: ContentItem[];
  // The `id` field exists in Rust but is `skip_serializing` — never emit it for inbound input
  // The `phase` field is for SERVER output; do not send it.
}
```

Note: `id` has `#[serde(skip_serializing)]` (line 745-747) — set client-side but never put into the request.

### 2b. `ContentItem`

`codex-rs/protocol/src/models.rs:697-712`.

```ts
type ContentItem =
  | { type: "input_text"; text: string }
  | {
      type: "input_image";
      image_url: string;
      detail?: "auto" | "low" | "high" | "original";
    }
  | { type: "output_text"; text: string };
```

- Use `input_text` and `input_image` for user turns.
- Use `output_text` for assistant-message replays in multi-turn continuations.
- `image_url` accepts `data:image/png;base64,...` (see `codex-rs/protocol/src/models.rs:2369`) or an HTTPS URL.
- `detail` enum: `codex-rs/protocol/src/models.rs:715-723` (default `High` when serializing for the CLI).

### 2c. `Reasoning`

`codex-rs/protocol/src/models.rs:757-767`.

```ts
interface ReasoningItem {
  type: "reasoning";
  // `id` is skip_serializing — do not send
  summary: ReasoningSummary[]; // Vec<ReasoningItemReasoningSummary>
  content?: ReasoningContent[]; // omitted unless server gave you one
  encrypted_content: string | null;
}

type ReasoningSummary = { type: "summary_text"; text: string };
type ReasoningContent = { type: "reasoning_text" | "text"; text: string };
```

Sources: `codex-rs/protocol/src/models.rs:1192-1203`.

For the simplest "fresh chat" use, you don't construct `Reasoning` items yourself — they only re-appear in `input` when continuing a turn that the server previously emitted them on. When you do replay them, keep `encrypted_content` verbatim.

### 2d. `FunctionCall` (outbound continuation)

`codex-rs/protocol/src/models.rs:778-791`.

```ts
interface FunctionCallItem {
  type: "function_call";
  // `id` skip_serializing
  name: string;
  namespace?: string | null; // omitted when None
  arguments: string; // JSON-as-string, NOT a parsed object
  call_id: string; // required
}
```

Important: `arguments` is a string containing JSON, not an object — the Responses API mandates this on the wire. See the comment at lines 786-789.

### 2e. `FunctionCallOutput`

`codex-rs/protocol/src/models.rs:809-814`.

```ts
interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string | { content?: string; content_items?: ContentItem[] };
}
```

The output payload uses `FunctionCallOutputPayload`, which is a string OR a structured `{ content | content_items }` object — see lines 804-808 for the wire-format note.

### 2f. Other variants you might see in stream output

| `type`                                                           | Notes                                  |
| ---------------------------------------------------------------- | -------------------------------------- |
| `local_shell_call`                                               | local-shell tool action (server emits) |
| `web_search_call`                                                | server emits when web_search ran       |
| `image_generation_call`                                          | server emits                           |
| `tool_search_call` / `tool_search_output`                        | dynamic-tool registry                  |
| `custom_tool_call` / `custom_tool_call_output`                   | user-defined tools                     |
| `compaction` (alias `compaction_summary`) / `context_compaction` | turn compaction artifacts              |

If you don't intend to round-trip these, keep them out of `input`. The unknown-variant catch-all (`Other`) is `#[serde(other)]` so unrecognized types are deserialized but lossy — don't echo them.

---

## 3. HTTP headers

The Codex CLI sends these on every Responses POST. Required ones are starred.

### 3a. From `BearerAuthProvider::add_auth_headers` — `codex-rs/model-provider/src/bearer_auth_provider.rs:31-46`

| Header               | Required              | Value                                                                                                                                 |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`      | \*                    | `Bearer <access_token>` (the OAuth access token, see §6)                                                                              |
| `ChatGPT-Account-ID` | \* (for ChatGPT auth) | the `chatgpt_account_id` claim from the id_token; obtained via `auth.get_account_id()` (`codex-rs/login/src/auth/manager.rs:339-344`) |
| `X-OpenAI-Fedramp`   | optional              | `"true"` only for FedRAMP accounts                                                                                                    |

Without `ChatGPT-Account-ID`, `chatgpt_get_request` errors out with "ChatGPT account ID not available, please re-run `codex login`" (`codex-rs/chatgpt/src/chatgpt_client.rs:33-36`).

### 3b. From the default reqwest client — `codex-rs/login/src/auth/default_client.rs:232-248`

| Header                              | Required | Value                                                                                                                                                                                                                         |
| ----------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `originator`                        | \*       | default `"codex_cli_rs"` (constant `DEFAULT_ORIGINATOR` at line 36); identifies the client family                                                                                                                             |
| `User-Agent`                        | \*       | format: `"<originator>/<version> (<os_type> <os_version>; <arch>) <terminal_user_agent>"` — see `get_codex_user_agent()` lines 133-157. Anything sane works (e.g. `"healthlog/1.0 (Node)"` is fine for a third-party client). |
| `x-openai-internal-codex-residency` | optional | `"us"` only when residency requirement is set                                                                                                                                                                                 |

### 3c. From `build_session_headers` — `codex-rs/codex-api/src/requests/headers.rs:5-16`

Sent on every Responses request when the CLI has a session/thread:

| Header                        | Value                                        |
| ----------------------------- | -------------------------------------------- |
| `session_id` and `session-id` | UUID-shaped session id (both spellings sent) |
| `thread_id` and `thread-id`   | UUID-shaped thread id (both spellings sent)  |

Optional but cheap; the server tolerates them as routing hints. Generate one UUID and use it for both names — duplicates are intentional, see lines 7-13.

### 3d. From `endpoint/responses.rs:91-97`

| Header                | Required | Value                                                                                                       |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `x-client-request-id` | optional | mirror the `thread_id` so it appears as the request-id in OpenAI logs                                       |
| `x-openai-subagent`   | optional | only set for sub-agent flows (review/compact/memory_consolidation/collab_spawn). Omit for first-party chat. |

### 3e. From `core/src/client.rs:135-148, 1648-1670`

These are Codex-specific extras the CLI adds; the server tolerates them all.

| Header                                           | Value                                                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenAI-Beta`                                    | only set on the **WebSocket** transport: `"responses_websockets=2026-02-06"` (line 145). NOT sent on HTTP — see line 911 (only the WS handshake adds it). |
| `x-codex-beta-features`                          | optional, comma-separated feature flags                                                                                                                   |
| `x-codex-installation-id`                        | UUID-ish, identifies the install — also embedded in `client_metadata` (line 759-762)                                                                      |
| `x-codex-turn-state`                             | sticky-routing token captured from a prior response's `x-codex-turn-state` response header — replay it on subsequent requests in the same "turn"          |
| `x-codex-turn-metadata`                          | optional, observability-only                                                                                                                              |
| `x-codex-window-id` / `x-codex-parent-thread-id` | sub-agent only                                                                                                                                            |
| `x-openai-memgen-request`                        | `"true"` for memory-consolidation sub-agent only                                                                                                          |
| `x-responsesapi-include-timing-metrics`          | `"true"` if the client wants timing info in the response                                                                                                  |

### 3f. Minimum third-party header set

For HealthLog's purposes (no sub-agent, no session continuity, no Azure, no sticky routing):

```
POST /backend-api/codex/responses HTTP/1.1
Host: chatgpt.com
Authorization: Bearer <oauth_access_token>
ChatGPT-Account-ID: <account_id>
Content-Type: application/json
Accept: text/event-stream
originator: <something_distinctive>
User-Agent: <descriptive_string>
session_id: <uuid>
thread_id: <uuid>
```

That's enough for the call to succeed.

### 3g. What the CLI does NOT send on HTTP

- `OpenAI-Beta` header on plain HTTP — only on WebSocket. Don't send it, it's not needed.
- `OpenAI-Organization` / `OpenAI-Project` — those are for `api.openai.com` only (`codex-rs/model-provider-info/src/lib.rs:333-343`), NOT for the ChatGPT backend.

---

## 4. SSE response

### 4a. Wire format

Standard SSE: `eventsource_stream::Eventsource` is used (`codex-rs/codex-api/src/sse/responses.rs:439`), so the format is:

```
event: <type>\n
data: <single-line JSON>\n
\n
```

Each event is one frame, separated by a blank line. The implementation tolerates `event:`-only lines without `data:` (used for keep-alives in tests, `codex-rs/codex-api/src/sse/responses.rs:638-642`). There is **no** `data: [DONE]` terminator — the stream ends with a `response.completed` event (or `response.failed`/`response.incomplete`); after that the connection is closed.

If the connection closes without a terminal event, the client surfaces `"stream closed before response.completed"` (line 458).

The data payload is a JSON object with at minimum `{ "type": "<type>", ...}`. The Rust deserializer is forgiving — unknown event kinds are logged at trace level and ignored (`codex-rs/codex-api/src/sse/responses.rs:425-427`).

### 4b. Event types — the complete list

Source: `codex-rs/codex-api/src/sse/responses.rs:300-428`.

The `data:` payload follows the `ResponsesStreamEvent` shape (lines 179-192):

```ts
interface ResponsesStreamEvent {
  type: string;
  headers?: unknown; // map; only present on metadata frames
  metadata?: unknown; // present on response.metadata
  response?: unknown; // present on created/completed/failed/incomplete
  item?: unknown; // present on output_item.* — a ResponseItem
  item_id?: string;
  call_id?: string;
  delta?: string; // text deltas
  summary_index?: number;
  content_index?: number;
  // ... other fields are tolerated and ignored
}
```

| Event `type`                            | Carries                                                            | Use it for                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `response.created`                      | `response: {}` (server may add `id`, `headers.OpenAI-Model`, etc.) | Signals the turn started. The CLI emits `ResponseEvent::Created`.                                                          |
| `response.metadata`                     | `metadata.openai_verification_recommendation: string[]`            | Optional; CLI uses to surface trust prompts. Ignore for chat.                                                              |
| `response.output_item.added`            | `item: ResponseItem`                                               | A new top-level item is starting (e.g. assistant message stub, function call).                                             |
| `response.output_item.done`             | `item: ResponseItem`                                               | The item is complete — this is where the **final** assistant `Message` arrives with its full `content[].text`.             |
| `response.output_text.delta`            | `delta: string`                                                    | Token-by-token text streaming for the assistant message currently in flight. Concatenate to assemble live text.            |
| `response.reasoning_summary_text.delta` | `delta: string`, `summary_index: number`                           | Reasoning summary stream (when `reasoning.summary` requested).                                                             |
| `response.reasoning_summary_part.added` | `summary_index: number`                                            | Marker that a new summary section started.                                                                                 |
| `response.reasoning_text.delta`         | `delta: string`, `content_index: number`                           | Reasoning text stream.                                                                                                     |
| `response.custom_tool_call_input.delta` | `item_id: string`, `call_id?: string`, `delta: string`             | Custom tool input streaming (also used for `response.function_call_arguments.delta` per line 806-813 of the test fixture). |
| `response.completed`                    | `response: { id, usage?, end_turn? }`                              | **Terminal event** — emit your final assembled text + usage.                                                               |
| `response.failed`                       | `response: { error: { code, message, ... } }`                      | **Terminal event** — error path; see §4c.                                                                                  |
| `response.incomplete`                   | `response: { incomplete_details: { reason: string } }`             | **Terminal event** — partial result, `reason` may be `max_output_tokens` etc.                                              |

Anything else (`response.in_progress`, `response.content_part.added`, etc.) is currently ignored by the official client (line 425-427); a TS implementation should follow suit and silently drop unknown `type` values.

### 4c. Error event — `response.failed`

Schema of `response.error` (`codex-rs/codex-api/src/sse/responses.rs:122-130`):

```ts
interface FailedError {
  type?: string;
  code?: string; // primary discriminator
  message?: string;
  plan_type?: string;
  resets_at?: number; // unix seconds
}
```

Code-to-meaning mapping (`codex-rs/codex-api/src/sse/responses.rs:547-570`):

| `error.code`                         | Meaning                          | Treat as                                                                                                      |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `context_length_exceeded`            | input too big                    | fatal, surface to user                                                                                        |
| `insufficient_quota`                 | account quota                    | fatal                                                                                                         |
| `usage_not_included`                 | feature not in plan              | fatal                                                                                                         |
| `invalid_prompt`                     | malformed/safety-rejected prompt | fatal, surface message                                                                                        |
| `cyber_policy`                       | flagged as security risk         | fatal, message + fallback "This request has been flagged for possible cybersecurity risk." (line 142-143)     |
| `server_is_overloaded` / `slow_down` | backpressure                     | retry with backoff                                                                                            |
| `rate_limit_exceeded`                | TPM/RPM limit                    | retry; parse delay from message via regex `(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s\|ms\|seconds?)` (line 586) |
| anything else                        | unknown server error             | retry                                                                                                         |

### 4d. Token usage — `response.completed`

Source: `codex-rs/codex-api/src/sse/responses.rs:132-167, 392-407`.

```ts
interface ResponseCompletedData {
  id: string;
  end_turn?: boolean; // some providers don't emit; treat None as "unknown"
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details?: { reasoning_tokens: number };
    total_tokens: number;
  };
}
```

Path: `event.data.response.usage.{input_tokens, output_tokens, total_tokens}`. Cached and reasoning-token sub-totals live one level deeper in `*_details`.

### 4e. Assembling the final text

Two valid strategies:

1. **Live streaming**: concatenate every `response.output_text.delta`'s `delta` field. Stop at `response.completed`. (Reasoning deltas come on a separate channel — `response.reasoning_*.delta` — and should NOT be concatenated into the visible answer.)
2. **End-of-turn snapshot**: ignore deltas, take the `response.output_item.done` whose `item.type == "message"` and `item.role == "assistant"`. Its `item.content[]` will contain `output_text` entries with the full text. This is more robust if you only care about the final answer.

The CLI uses both (deltas drive the live UI; `done` gives the canonical `ResponseItem` for the conversation log).

### 4f. Response headers worth reading

These are on the HTTP response (not in the SSE body). Source: `codex-rs/codex-api/src/sse/responses.rs:69-95`.

| Header                 | Use                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `x-request-id`         | Pass to the user when reporting errors                                                            |
| `OpenAI-Model`         | The actual model the server routed to (may differ from your request when safety routing kicks in) |
| `x-reasoning-included` | If present, server already accounted for prior reasoning tokens — don't re-estimate               |
| `x-codex-turn-state`   | Sticky-routing token — replay in next request's `x-codex-turn-state` header                       |
| `X-Models-Etag`        | Cache key for the `/models` endpoint                                                              |
| `cf-ray`               | Cloudflare ray, useful for support                                                                |

### 4g. Idle timeout

The CLI uses an idle timeout per stream (default in `codex-rs/model-provider-info/src/lib.rs` constants); if no SSE event arrives within the window, it emits `"idle timeout waiting for SSE"` and closes. A reasonable TS default is **120 seconds**.

---

## 5. HTTP error responses (non-SSE)

Source: `codex-rs/codex-api/src/api_bridge.rs:36-130`.

If the server fails before the SSE stream begins, it returns a JSON body with shape:

```json
{ "error": { "type": "...", "code": "...", "message": "..." } }
```

| Status                                                                                 | Special handling                                                                                         |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `400` with `error.code == "cyber_policy"`                                              | treat as `CyberPolicy` (message or fallback)                                                             |
| `400` body containing `"The image data you provided does not represent a valid image"` | invalid image                                                                                            |
| `400` other                                                                            | `InvalidRequest` — e.g. our two seen failures (`"Input must be a list"`, `"Stream must be set to true"`) |
| `429` with `error.type == "usage_limit_reached"`                                       | parse `plan_type`, `resets_at`, plus rate-limit headers (§5a)                                            |
| `429` with `error.type == "usage_not_included"`                                        | feature/plan rejection                                                                                   |
| `429` other                                                                            | retryable rate-limit                                                                                     |
| `500`                                                                                  | retry                                                                                                    |
| `503` with `error.code` in `{"server_is_overloaded","slow_down"}`                      | retry with backoff                                                                                       |
| anything else                                                                          | propagate verbatim                                                                                       |

### 5a. Rate-limit headers

Source: `codex-rs/codex-api/src/rate_limits.rs` (lines 22-345). The Codex backend uses bespoke headers (NOT standard `X-RateLimit-*`). The keys you'll see:

```
x-codex-active-limit
x-codex-primary-used-percent
x-codex-primary-window-minutes
x-codex-primary-reset-at
x-codex-secondary-primary-used-percent
x-codex-secondary-primary-window-minutes
x-codex-secondary-primary-reset-at
x-codex-bengalfox-primary-used-percent
x-codex-bengalfox-limit-name
x-codex-credits-has-credits
x-codex-credits-unlimited
x-codex-credits-balance
x-codex-promo-message
```

Surface them to the user when relevant. Never block on them — they're informational.

### 5b. Other error-relevant headers

| Header                              | Source line             | Use                                                                    |
| ----------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `x-request-id` / `x-oai-request-id` | `api_bridge.rs:136-137` | request id for support                                                 |
| `cf-ray`                            | `api_bridge.rs:138`     | Cloudflare ray                                                         |
| `x-openai-authorization-error`      | `api_bridge.rs:139`     | identity-error sub-code                                                |
| `x-error-json`                      | `api_bridge.rs:140`     | base64-JSON-encoded error envelope; decode with standard b64 then JSON |

---

## 6. Authentication

### 6a. What goes in `Authorization`

The OAuth **access token** issued by `auth.openai.com`. For ChatGPT-mode auth, `CodexAuth::get_token()` returns `tokens.access_token` directly — no swap, no extra exchange (`codex-rs/login/src/auth/manager.rs:325-336`). That's what `BearerAuthProvider` puts in `Bearer <token>`.

The token format is a JWT. The Rust client extracts the expiry from the JWT itself (`parse_jwt_expiration` in `manager.rs:1797`), so there is no `expires_in` to track separately.

### 6b. Where the token comes from (device-code flow)

Source: `codex-rs/login/src/server.rs:711-782` and `codex-rs/login/src/device_code_auth.rs`.

1. Issuer: `https://auth.openai.com` (constant `DEFAULT_ISSUER`, `server.rs:51`).
2. The device-code flow ends with a PKCE code exchange at `POST {issuer}/oauth/token` with body:
   ```
   grant_type=authorization_code
   code=<authorization_code>
   redirect_uri=<redirect>
   client_id=app_EMoamEEZ73f0CkXaXp7hrann
   code_verifier=<pkce_verifier>
   ```
   Content-Type: `application/x-www-form-urlencoded`.
3. The response is JSON `{ id_token, access_token, refresh_token }` (`server.rs:719-723`). All three are required.

The `client_id` value `app_EMoamEEZ73f0CkXaXp7hrann` is in `codex-rs/login/src/auth/manager.rs:921`.

The OAuth scope is `openid profile email offline_access api.connectors.read api.connectors.invoke` (`codex-rs/login/src/server.rs:493-495`). Plus the non-standard query params `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, and `originator=<originator>` on the authorize URL (lines 502-506). The token endpoint itself only needs the form fields above.

### 6c. ChatGPT-Account-ID

Read from the `id_token` JWT — specifically the `chatgpt_account_id` claim. The CLI reads it at parse time and exposes it via `CodexAuth::get_account_id()` (`manager.rs:339-344`). For a TS client: decode the JWT (no signature verification needed for our purposes; the server validates), then look at `payload.chatgpt_account_id` (typically nested under `https://api.openai.com/auth.chatgpt_account_id` — see `manager.rs:891` for the namespace).

If you can't find the account id in the id_token, the server returns 401 on the responses POST.

### 6d. Refresh procedure

Source: `codex-rs/login/src/auth/manager.rs:806-848, 906-926`.

```
POST https://auth.openai.com/oauth/token
Content-Type: application/json    ← note: refresh uses JSON, not form-encoded
{
  "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "<refresh_token>"
}
```

Override the URL with env `CODEX_REFRESH_TOKEN_URL_OVERRIDE` if you need a non-default issuer.

Response shape (`manager.rs:913-918`):

```json
{
  "id_token": "...", // optional
  "access_token": "...", // optional but expected
  "refresh_token": "..." // optional; rotated when present
}
```

Persist whichever fields the server returned. **The refresh token is rotated** — the next refresh must use the newly returned `refresh_token` if any; reusing the old one yields `refresh_token_reused` and 401 (lines 856-857).

Failure handling (HTTP 401 body, lines 851-878):

| `error.code` in body        | Treat as                                 |
| --------------------------- | ---------------------------------------- |
| `refresh_token_expired`     | permanent — user must re-login           |
| `refresh_token_reused`      | permanent — concurrent refresh; re-login |
| `refresh_token_invalidated` | permanent — token revoked; re-login      |
| anything else               | log and re-login                         |

### 6e. When to refresh

The CLI considers a token "stale" when (`manager.rs:1796-1805`):

1. The JWT's `exp` is `<= now`, OR
2. `last_refresh < now - 8 days` (constant `TOKEN_REFRESH_INTERVAL = 8` at line 85; `last_refresh` is the wall-clock time of the previous successful refresh).

For a TS client, refresh proactively when the access token's `exp` claim is within ~5 minutes of expiry, and force-refresh on any `401` response from the responses endpoint.

### 6f. Revocation (optional)

`POST https://auth.openai.com/oauth/revoke` revokes a refresh token. Constant: `REVOKE_TOKEN_URL` at `manager.rs:95`. Override env: `CODEX_REVOKE_TOKEN_URL_OVERRIDE` (`manager.rs:97`).

---

## 7. Model strings

The CLI sends the model slug verbatim in the `model` field. There is no enum on the wire — anything the backend recognises works. Slugs the official client knows about (sample, not exhaustive):

| Slug               | Source                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `gpt-5-codex`      | `codex-rs/tui/src/model_migration.rs`; `codex-rs/tui/src/bottom_pane/status_line_setup.rs`                                    |
| `gpt-5-codex-mini` | `codex-rs/tui/src/model_migration.rs`                                                                                         |
| `gpt-5.3-codex`    | used as a "cyber-restricted" placeholder in tests (`codex-rs/codex-api/src/sse/responses.rs:1374`) — confirms the slug exists |
| `gpt-5.1`          | shows up in rate-limit error messages in tests (`codex-rs/codex-api/src/sse/responses.rs:875`)                                |

The ChatGPT backend ignores `model` strings the user's account doesn't have entitlements for — the server may safety-route to a different model and report the actual model used in the `OpenAI-Model` response header (§4f). Trust that header, not the request value, when logging.

### 7a. ChatGPT-account-auth allow-list (verified 2026-05-09)

When authenticating via the ChatGPT-OAuth path (Bearer token + `ChatGPT-Account-ID` header, §3a), the backend rejects model slugs that are NOT in the active `codex-rs/models-manager/models.json` bundle. The rejection is HTTP 400 with body:

```json
{
  "detail": "The '<slug>' model is not supported when using Codex with a ChatGPT account."
}
```

Confirmed-rejected slugs (despite the source-tree references in the table above):

- `gpt-5` — rejected
- `gpt-5-codex` — rejected (the API-key-auth Codex slug; not the ChatGPT-auth one)

Confirmed-accepted slugs on a ChatGPT Plus subscription (per `available_in_plans` in `models.json`):

- `gpt-5.6-terra` — HealthLog's default (first chain entry) as of 2026-10-24; the backend rejected `gpt-5.5` and everything below it that day. `gpt-5.6-luna` and `gpt-5.6-sol` are its siblings on the same line
- `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra` — the gpt-6 line, listed in `models.json` since 2026-09-22 (`gpt-6.1-sol` the catalog default since 2026-09-29). The catalog names `gpt-6-sol` as the upgrade of `gpt-5.6-terra` and `gpt-5.6-sol`, and `gpt-6-luna` as that of `gpt-5.6-luna`. Every gpt-6 slug lists `input_modalities: ["text", "image"]` and the same reasoning presets as the gpt-5.6 line (`low` to `max`, sol and astra also `ultra`). The presets omit `none`, as they do for `gpt-5.5`, which a live probe on 2026-10-06 showed accepts it; HealthLog sends `none` for "off" on the gpt-6 line too and learns a refusal per slug. A live check on 2026-10-24 found the account's own list (`GET /backend-api/codex/models?client_version=…`) offering `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` and the `gpt-5.6` line, all with `input_modalities: ["text", "image"]`. From a HealthLog container with its stored sign-in, `gpt-6.1-sol`, `gpt-6-sol` and `gpt-6-luna` each answered text and read a lab-report image correctly. `gpt-6.1-sol` refuses `reasoning.effort: "none"` and names `low` as its lowest effort, which the client learns and steps up to on the same slug; the other two accept `none`
- `gpt-5.5` — the default from 2026-06 until 2026-10-24, kept as the last chain rung while plans differ

Retired for ChatGPT sign-in (OpenAI's Codex models page): `gpt-5.2` and `gpt-5.3-codex` on 2026-05-26, `gpt-5.4` and `gpt-5.4-mini` on 2026-08-31, `gpt-5.5` on 2026-10-14 at 19:00 UTC. The backend answers each of them with 400 `model_not_found`, "The '<slug>' model is not supported when using Codex with a ChatGPT account.", which the client reads as a reason to try the next slug.

The `codex-rs/tui/src/model_migration.rs` references to `gpt-5-codex` etc. are _migration prompts_ shown to existing users — they are NOT the slugs sent on the wire after migration. The wire slugs come from `models.json`. Always cross-check `models.json` (`gh api repos/openai/codex/contents/codex-rs/models-manager/models.json`) before picking a default.

### 7b. Slug-drift defence — fallback chain (HealthLog v1.4.15+)

The ChatGPT-Codex allow-list is rotated by OpenAI without prior notice (`gpt-5-codex` → `gpt-5.3-codex` happened over 48 h in May 2026 and bricked HealthLog twice while the v1.4.7..v1.4.13 saga unrolled). The cause: a single hard-coded slug in `CODEX_MODEL` flips invalid the moment the upstream rotates it. Operator brief, verbatim 2026-05-09: "Die Integration des Slug Drift Risiko darf halt immer überhaupt nicht sein."

To eliminate that risk class, HealthLog's `CodexClient` tries its sign-in's working slug first and otherwise walks an ordered chain built from the models the account is offered.

**The account's model list.** Before it walks, the client reads the list the Codex CLI reads, on the same sign-in as the responses call:

```http
GET /backend-api/codex/models?client_version=0.165.0 HTTP/1.1
Host: chatgpt.com
Authorization: Bearer <oauth-access-token>
ChatGPT-Account-ID: <chatgpt_account_id>
originator: healthlog
```

The answer is `ModelsResponse` from `codex-rs/protocol/src/openai_models.rs`: `{ "models": [ModelInfo, ...] }`, where the client reads `slug`, `visibility` (`list` / `hide` / `none`), `priority` (lower first), `input_modalities` (`text`, `image`, `audio`) and `model_specialty`. `codex-rs/codex-api/src/endpoint/models.rs` appends `client_version`; the backend leaves out models whose `minimal_client_version` is above it, so the version sent tracks a current Codex CLI release (`CODEX_MODELS_CLIENT_VERSION` in `src/lib/ai/codex-model-catalog.ts`). The read is bounded like the CLI's (5 s, `codex-rs/model-provider/src/models_endpoint.rs`) and to 4 MiB, cached per sign-in for an hour, and a failed read waits ten minutes before the next attempt. The list is a hint, never a gate: a read that fails, times out, does not parse or comes back empty leaves the static chain below, and one `ai.codex.models_unreadable` warning per sign-in reports the stretch.

**Order.** `CODEX_MODEL` first when set. `CODEX_MODEL_FALLBACK_CHAIN`, when set, replaces everything after it and the list is not read. Otherwise: the default chain below kept to what the account is offered; then every other offered model in the list's `priority` order, leaving out what the list hides (`visibility` other than `list`), the specialist lines (`model_specialty`) and the `-astra` frontier tier; then the rest of the default chain, so the walk never holds fewer models than before the list existed. `supported_in_api` is not a filter: it describes API-key access, and the CLI ignores it for a ChatGPT sign-in (`ModelPreset::filter_by_auth`). A slug this sign-in was refused in the last six hours goes to the very end, even while its list still offers it. With the list's `input_modalities` for the slug in hand, the Codex vision gate reads them; without, it falls back to the model family.

**Default chain** (top = first try). `gpt-5.6-terra` leads because it is the slug verified against the backend. The gpt-6 rungs follow before terra's own siblings: the catalog names `gpt-6-sol` as terra's upgrade, and the 2026-10-24 rotation retired a whole line at once, so a rotation that takes terra most likely takes `gpt-5.6-luna` and `gpt-5.6-sol` with it. `gpt-6.1-sol` (the catalog default, also on plans `gpt-6-sol` is not offered on) and `gpt-6-luna` (the lighter one) come next. `gpt-6-astra`, the frontier tier, stays out of the default:

```ts
const DEFAULT_SLUG_FALLBACK_CHAIN = [
  "gpt-5.6-terra", // verified against the backend 2026-10-24
  "gpt-6-sol", // terra's upgrade in the upstream catalog
  "gpt-6.1-sol", // the catalog default, on every plan
  "gpt-6-luna", // lighter gpt-6 sibling
  "gpt-5.6-luna", // lighter sibling on terra's line
  "gpt-5.6-sol", // heavier sibling on terra's line
  "gpt-5.5", // previous default, kept as the last rung while plans differ
];
```

Every default rung must be a model family the reasoning, sampling and vision gates recognise (`src/lib/ai/openai-model-family.ts`); `codex-slug-fallback.test.ts` holds the chain to that.

The shipped constant in `src/lib/ai/codex-slug-chain.ts` is authoritative; when the upstream rotates again, that file moves first and this listing follows.

A fixed chain goes stale. From 2026-10-14, when GPT-5.5 retired, every model on the chain HealthLog shipped then was retired, and every Codex request answered 503 "all configured Codex slugs were rejected" until the chain was updated or `CODEX_MODEL` was set by hand. That is why the account's live list now comes first and the default chain only orders and backs it up.

The chain is overridable via the env var `CODEX_MODEL_FALLBACK_CHAIN` (comma-separated), which replaces it outright; if `CODEX_MODEL` is also set, it is folded into position 0 and de-duplicated.

**Trigger condition** (when to walk to the next slug):

| Status                                                                        | Action                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------ |
| `400` body matches `/not supported when using Codex with a ChatGPT account/i` | walk                                             |
| `400` body contains `model_not_found`                                         | walk                                             |
| `400` body contains `does not exist` AND mentions a model name                | walk                                             |
| `404` (any body)                                                              | walk                                             |
| `401` first time                                                              | refresh and re-try same slug; do NOT walk        |
| `401` after refresh, `403`, `429`, `5xx`                                      | propagate (don't walk)                           |
| `200` with SSE `response.failed.error.code === "invalid_prompt"`              | propagate (request shape is wrong, slug is fine) |

**Positive cache** — when a slug is observed working (HTTP 200 with at least one `response.completed` event), record `(slug, timestamp)` for that sign-in. On its next request, jump straight to the cached slug; the model list is read only when there is none or it stops working. TTL: 1 hour. Scope: per stored credential (`user:<id>` for a person's connection, `central` for the operator-shared one), process-local, no DB write, at most 1000 sign-ins held. Each entry carries a digest of the ChatGPT account id it was learned under, and a credential reconnected to another account starts empty. Two sign-ins on different plans no longer overwrite each other's working slug.

**Cache invalidation**: on a 400/404 walk the refused slug leaves the working slot and goes to the back of that sign-in's line for six hours. The next-best slug is promoted into the cache only after it succeeds.

**All-failed case**: if every slug in the chain rejects with the walk-trigger, the client throws a structured error with `httpStatus: 503` and message `"AI provider unreachable — all configured Codex slugs were rejected"`. The route layer surfaces this to the user with "AI provider unreachable — check Settings".

**Observability**: a request that builds the chain annotates `codex.models.chain` (`operator` / `live` / `static`), `codex.models.read` (`live` / `cache` / `skipped`), `codex.models.failure` (`timeout`, `network`, `auth`, `http_error`, `too_large`, `unparsable`, `empty`, or null) and `codex.models.offered` (a count). `CodexClient.getLastDiagnostics()` holds the attempted slugs, the cache state and the working slug.

The walk lives in `src/lib/ai/codex-client.ts`, the order in `src/lib/ai/codex-slug-chain.ts`, the list read in `src/lib/ai/codex-model-catalog.ts`, the per-sign-in memory in `src/lib/ai/codex-slug-cache.ts`; the contract is unit-tested in `src/lib/ai/__tests__/codex-live-models.test.ts`, `codex-slug-chain.test.ts`, `codex-model-catalog.test.ts` and `codex-slug-fallback.test.ts`.

---

## 8. Worked example — minimal end-to-end

Outbound:

```http
POST /backend-api/codex/responses HTTP/1.1
Host: chatgpt.com
Authorization: Bearer eyJhbGciOi...<oauth-access-token>
ChatGPT-Account-ID: a1b2c3d4-...
Content-Type: application/json
Accept: text/event-stream
originator: healthlog
User-Agent: healthlog/1.0
session_id: 11111111-1111-1111-1111-111111111111
thread_id: 22222222-2222-2222-2222-222222222222
```

```json
{
  "model": "gpt-5-codex",
  "instructions": "",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "Say hi in one word." }]
    }
  ],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "reasoning": null,
  "store": false,
  "stream": true,
  "include": []
}
```

Inbound (illustrative — based on `codex-rs/codex-api/src/sse/responses.rs:666-730` test fixtures):

```
event: response.created
data: {"type":"response.created","response":{"id":"resp_abc"}}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hi"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"!"}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi!"}]}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_abc","usage":{"input_tokens":12,"output_tokens":2,"total_tokens":14}}}
```

A TS client should:

1. Stream-parse SSE.
2. Concatenate `delta` from each `response.output_text.delta` for live UI.
3. On `response.output_item.done` with `item.type=="message"` and `item.role=="assistant"`, take `item.content` as the canonical reply.
4. On `response.completed`, store `response.id` (for follow-up turns) and `response.usage` (for token accounting).
5. On `response.failed` / `response.incomplete`, surface error per §4c.

---

## 9. Quick reference — the original errors we hit

- **"Input must be a list"** → `input` was a string. Wrap as `[{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }]`.
- **"Stream must be set to true"** → must set `stream: true`. The chatgpt.com endpoint has no non-streaming mode.

Both come back as HTTP 400 with `error.code == "invalid_prompt"` (no `cyber_policy` flag) → mapped to `ApiError::InvalidRequest` per `api_bridge.rs:75-77`.

---

## 10. Source-file index (for re-verification)

All paths relative to `openai/codex` repo:

- `codex-rs/codex-api/src/common.rs` — `ResponsesApiRequest`, `Reasoning`, `TextControls`, `TextFormat`
- `codex-rs/codex-api/src/endpoint/responses.rs` — request construction, headers, ACCEPT
- `codex-rs/codex-api/src/requests/headers.rs` — session/thread/sub-agent headers
- `codex-rs/codex-api/src/sse/responses.rs` — SSE parsing, all event types, error mapping
- `codex-rs/codex-api/src/api_bridge.rs` — HTTP error mapping
- `codex-rs/codex-api/src/rate_limits.rs` — rate-limit headers
- `codex-rs/codex-api/src/auth.rs` — `AuthProvider` trait
- `codex-rs/protocol/src/models.rs` — `ResponseItem`, `ContentItem`, `MessagePhase`, `ImageDetail`, etc.
- `codex-rs/protocol/src/openai_models.rs` — `ReasoningEffort` enum; `ModelsResponse`, `ModelInfo`, `ModelVisibility`, `InputModality`, `ModelPreset::filter_by_auth` (the `/models` wire)
- `codex-rs/codex-api/src/endpoint/models.rs` — `ModelsClient`: `GET models?client_version=…`
- `codex-rs/model-provider/src/models_endpoint.rs` — the 5 s model-list bound; `models_identity.rs` — the per-account cache identity
- `codex-rs/models-manager/src/manager.rs` — priority sort, picker visibility, cache TTL
- `codex-rs/protocol/src/config_types.rs` — `ReasoningSummary`, `Verbosity` enums
- `codex-rs/model-provider/src/bearer_auth_provider.rs` — `Authorization` + `ChatGPT-Account-ID` headers
- `codex-rs/model-provider/src/auth.rs` — auth-provider selection
- `codex-rs/model-provider-info/src/lib.rs` — `CHATGPT_CODEX_BASE_URL`, OpenAI provider creation
- `codex-rs/login/src/auth/manager.rs` — token storage, refresh, expiry, `CLIENT_ID`
- `codex-rs/login/src/server.rs` — code exchange (`exchange_code_for_tokens`), authorize URL (scope)
- `codex-rs/login/src/device_code_auth.rs` — device-code flow
- `codex-rs/login/src/auth/default_client.rs` — `originator`, `User-Agent`, residency
- `codex-rs/chatgpt/src/chatgpt_client.rs` — confirms `chatgpt_base_url + path` pattern and `ChatGPT-Account-ID` requirement
- `codex-rs/core/src/client.rs` — how the CLI builds requests (`build_responses_request`, `build_responses_headers`); the source of `tool_choice="auto"`, `store=false` for chatgpt, `stream=true`, `include=["reasoning.encrypted_content"]` when reasoning is on, `prompt_cache_key=thread_id`
