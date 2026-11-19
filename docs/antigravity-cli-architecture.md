# Antigravity CLI Architecture

**Status**: Draft — Stage 0 audit
**Date**: 2026-11-13
**Version**: `agy` 1.5.8

---

## Executive Summary

This document captures the architecture audit for integrating Antigravity CLI (`agy`) as an AI provider in HealthLog. The audit focuses on:

1. Understanding the existing AI provider contract and implementation patterns
2. Identifying what can be reused vs what requires new implementation
3. Defining the security and privacy model for Antigravity integration
4. Documenting decisions that must NOT be copied from Codex implementation

---

## 1. Existing AI Provider Architecture

### 1.1 Provider Types

HealthLog has two distinct type hierarchies:

**`ProviderType`** (runtime, `src/lib/ai/types.ts:115-116`):

```typescript
type ProviderType =
  "codex" | "admin-key" | "openai-compatible" | "anthropic" | "local" | "none";
```

**`ProviderChainType`** (fallback chain, `src/lib/ai/provider-chain.ts:57-65`):

```typescript
type ProviderChainType =
  | "codex"
  | "openai"
  | "anthropic"
  | "local"
  | "openai-compatible"
  | "admin-openai"
  | "admin-codex";
```

**Key difference**: `ProviderChainType` includes admin variants (`admin-openai`, `admin-codex`) for fallback chain resolution, while `ProviderType` uses `admin-key` for direct key-based access.

**Decision for Antigravity**: Add `"antigravity"` to BOTH types. Do NOT create `admin-antigravity` variant in Stage 1.

### 1.2 AIProvider Contract

**Location**: `src/lib/ai/types.ts:118-163`

```typescript
interface AIProvider {
  type: ProviderType;
  supportsTools?: boolean;
  responseTimeoutSeconds?: number | null;
  reasoningEffort?: ReasoningEffort | null;

  generateCompletion(params: CompletionParams): Promise<CompletionResult>;
  generateCompletionStream?(
    params: CompletionParams,
    onDelta: (delta: string) => void,
  ): Promise<CompletionResult>;
}
```

**Critical: `supportsTools` behavior** — Located at `src/lib/ai/coach/turn/chain.ts:47`:

```typescript
const allSupportTools = chainEntries.every(
  (entry) => resolveProvider(entry).supportsTools !== false,
);
```

**Implication**: Adding a provider with `supportsTools = false` will switch Coach to no-tools/snapshot mode for chains containing that provider. This MUST be intentional.

**Recommendation for Antigravity**: Set `supportsTools = false` because ACP tools are NOT HealthLog function calling. Document this as a known limitation.

### 1.3 Provider Registration Pattern

| Layer    | File                       | Responsibility                                                        |
| -------- | -------------------------- | --------------------------------------------------------------------- |
| Types    | `types.ts`                 | `ProviderType` union, `AIProvider` interface                          |
| Chain    | `provider-chain.ts`        | `ProviderChainType`, `PROVIDER_CHAIN_TYPES`, `PROVIDER_CHAIN_DEFAULT` |
| Resolver | `provider.ts`              | `resolveProvider()`, provider construction, credential stores         |
| Runner   | `provider-runner.ts`       | Fallback execution, health ledger, budget checks                      |
| Wire     | `*-wire.ts`, `*-client.ts` | Protocol-specific message mapping                                     |

### 1.4 Fallback Chain

**Default chain** (`provider-chain.ts:92-98`):

1. `codex` — ChatGPT subscription (cheapest, covered by user's sub)
2. `openai` — User's OpenAI API key
3. `anthropic` — User's Anthropic API key
4. `local` — Self-hosted (Ollama, LM Studio)
5. `admin-openai` — Operator's shared key (fallback)

**Decision**: Do NOT add `antigravity` to `PROVIDER_CHAIN_DEFAULT` in first PR. Users must explicitly enable it.

---

## 2. What NOT to Copy from Codex

### 2.1 OAuth Token Management

**Codex approach** (`codex-oauth.ts`):

- Device-code OAuth flow with PKCE
- Access/refresh tokens stored encrypted in PostgreSQL
- Advisory lock coordination for refresh (`oauth-refresh.ts`)
- Token rotation with compare-and-set
- `codexAccessTokenEncrypted`, `codexRefreshTokenEncrypted`, `codexTokenExpiresAt`

**Antigravity — DO NOT COPY**:

- ACP has NO documented OAuth endpoint
- No refresh token mechanism
- Credentials live outside HealthLog DB
- No `antigravityAccessTokenEncrypted` column

**Decision**: Antigravity uses official CLI auth exclusively. HealthLog stores only:

- `antigravityProfileId` — random identifier for profile isolation
- `antigravityConnectionStatus` — last known state
- `antigravityCapabilitiesJson` — cached capabilities (model, thought levels)

### 2.2 Slug Fallback Chain

**Codex approach** (`codex-slug-chain.ts`, `codex-slug-cache.ts`):

- Model retirement detection (404 → fallback slug)
- `WORKING_SLUG_TTL_MS = 3600000` (1 hour cache)
- Predefined slug fallback order (GPT-5 → GPT-4.1 → GPT-4o)

**Antigravity — DO NOT COPY**:

- ACP provides `configOptions` with available models
- No static catalog to cache
- Model availability discovered at runtime

**Decision**: Query `configOptions` per-session or cache with short TTL. No hardcoded fallback chain.

### 2.3 Reasoning Summary Mapping

**Codex approach** (`codex-reasoning-wire.ts`):

- `response.reasoning_summary_text.delta` events
- Maps directly to `CompletionResult.reasoning.summary[]`
- `CODEX_ENDPOINT = "chatgpt.com/backend-api/codex/responses"`

**Antigravity — DO NOT COPY**:

- ACP `thought_level` is NOT the same as reasoning summaries
- No documented `reasoning_summary` in ACP spec
- Thought chunks may not be "verified summaries"

**Decision**: Set `reasoningSupportForChainEntry("antigravity")` to indicate:

- `effort`: only if confirmed by ACP capabilities
- `summaries: false`
- Do NOT map thought chunks to summaries without explicit capability

### 2.4 Central Provider Pattern

**Codex approach**:

- `admin-codex` type for operator's shared ChatGPT account
- `AppSettings.adminCodexAccessTokenEncrypted`
- `User.useCentralCodex` opt-in flag

**Antigravity — DO NOT COPY in Stage 1**:

- No `admin-antigravity` type
- No shared operator account
- Each user gets isolated profile

**Decision**: First PR is per-user profile only. Central provider requires separate security review.

---

## 3. Credentials and Isolation Model

### 3.1 Current Provider Credential Storage

| Provider  | Storage                | Columns                                                                          |
| --------- | ---------------------- | -------------------------------------------------------------------------------- |
| Codex     | PostgreSQL (encrypted) | `codexAccessTokenEncrypted`, `codexRefreshTokenEncrypted`, `codexTokenExpiresAt` |
| OpenAI    | PostgreSQL (encrypted) | `aiOpenaiKeyEncrypted`                                                           |
| Anthropic | PostgreSQL (encrypted) | `aiAnthropicKeyEncrypted`                                                        |
| Local     | PostgreSQL (optional)  | `aiLocalKeyEncrypted`, `aiLocalUrl`                                              |
| Gateway   | PostgreSQL (encrypted) | `aiCompatKeyEncrypted`, `aiCompatBaseUrl`, `aiCompatModel`                       |

### 3.2 Antigravity Profile Model

**Requirement**: Isolated profile per user, no credential storage in DB.

**Proposed fields on `User` model**:

| Field                         | Type      | Purpose                                                    |
| ----------------------------- | --------- | ---------------------------------------------------------- |
| `antigravityProfileId`        | String?   | Random identifier (NOT path, NOT token)                    |
| `antigravityModel`            | String?   | Last selected model                                        |
| `antigravityConnectionStatus` | String?   | `unknown` / `connected` / `auth_required` / `disconnected` |
| `antigravityConnectedAt`      | DateTime? | Last successful connection                                 |
| `antigravityCapabilitiesJson` | Json?     | Cached capabilities from last negotiation                  |

**NOT stored**:

- Access tokens
- Refresh tokens
- API keys
- Keyring contents
- ACP session IDs

### 3.3 Profile Isolation

**Mechanism**: Use `--app-data-dir` flag with isolated directory per profile:

```
/var/lib/healthlog/antigravity-profiles/<profile-id>/
```

**Requirements**:

- Directory created with `0700` permissions
- Owned by `nextjs` user
- Cleaned up when profile disconnected
- No sharing between users
- No inheritance from operator's profile

**Current state (Stage 2 code)**: the provider runs only when
`ANTIGRAVITY_PROFILE_ROOT` is an absolute path and `<root>/<userId>` already
exists. Otherwise the provider resolves to nothing, so no call reaches the
CLI under the server login. HealthLog does not create the profile directory or
run the login yet (Stages 4 and 5). Consent is required before the first call,
like the other external providers.

**Blockers to verify**:

1. Does `--app-data-dir` isolate ALL state (cache, keyring, sessions)?
   It also must accept an absolute path. The transport decision records an
   earlier "must not be absolute" error that is still open.
2. Can two profiles run concurrently?
3. What happens when profile directory is deleted?

---

## 4. Multimodal Capability Matrix

### 4.1 Current Vision Support

**Function**: `supportsVisionForConfig()` at `vision-capability.ts:104`

| Provider                     | Vision Support                     |
| ---------------------------- | ---------------------------------- |
| `anthropic`                  | Claude 3/3.5/3.7/4+                |
| `openai`, `admin-openai`     | GPT-4o/4-turbo/5+, o1/o3/o4        |
| `local`, `openai-compatible` | Trust-by-default                   |
| `codex`, `admin-codex`       | Depends on slug (multimodal check) |
| `none`                       | false                              |

### 4.2 Current PDF Support

**Function**: `supportsPdfForProvider()` at `vision-capability.ts:136`

| Provider    | Native PDF                |
| ----------- | ------------------------- |
| `anthropic` | ✅ Native document block  |
| All others  | ❌ Rasterization fallback |

**PDF Limits** (`rasterize-pdf.ts`):

- `RASTER_MAX_PAGES = 10` (default)
- `RASTER_HARD_MAX_PAGES = 20` (absolute max for lab scan)
- `RASTER_TARGET_LONG_EDGE = 1600` px
- Isolated child process with `PDF_CHILD_MEMORY_MB = 640` MB

### 4.3 Antigravity Multimodal — Unknowns

**Must verify in PoC**:

| Capability     | ACP Mechanism                          | Verification Needed                     |
| -------------- | -------------------------------------- | --------------------------------------- |
| Images         | `image` block with Base64              | Does model actually read image content? |
| PDF            | `resource.blob` with `application/pdf` | Does Antigravity analyze PDF bytes?     |
| Multi-page PDF | Unknown                                | Are all pages processed?                |
| Scanned PDF    | Unknown                                | OCR capability?                         |
| Audio          | `promptCapabilities.audio`             | Feature existence only                  |
| JSON Schema    | Not in ACP spec                        | Headless `--json-schema` only?          |

**Decision**: Do NOT claim multimodal support until PoC confirms actual processing.

---

## 5. Provider Health and Consent

### 5.1 Health Ledger

**Current**: `ProviderHealthLedger` at `provider-health-ledger.ts`

- PostgreSQL-backed negative cache
- `ProviderHealth` model in Prisma
- `getSkipHints()` returns providers marked as failed
- `recordSuccess()` / `recordFailure()` update ledger
- TTL-based auto-recovery

**For Antigravity**: Reuse existing `ProviderHealthLedger`. Add `"antigravity"` as valid `ProviderChainType`.

### 5.2 Consent Model

**Current**: `src/lib/ai/consent-guard.ts`

- `isExternalProvider()` returns true for all non-`local` providers
- `chainRequiresServerManagedConsent()` checks consent requirements
- `ConsentReceipt` stored in PostgreSQL
- Kinds: `ai_extraction`, `ai_insights_only`, `ai_full`

**For Antigravity**:

- `isExternalProvider("antigravity") === true` (data leaves instance)
- Require consent before first use
- Document that Antigravity is an external processor

### 5.3 Document Provider Rank

**Current**: `documentProviderRank` at `provider-rank.ts`

| Rank | Providers                                               | Rationale                       |
| ---- | ------------------------------------------------------- | ------------------------------- |
| 0    | `local`                                                 | No egress, data stays on device |
| 1    | `openai`, `anthropic`, `admin-key`, `openai-compatible` | BYOK no-train API keys          |
| 2    | `admin-openai`                                          | Operator's no-train key         |
| 3    | `codex`, `admin-codex`                                  | ChatGPT OAuth, train-by-default |

**For Antigravity**: Rank 3 (same as Codex). External account, potential training/interactions per Antigravity ToS.

---

## 6. Streaming Model

### 6.1 Current Streaming Implementation

**Providers with `generateCompletionStream()`**:

- `LocalOpenAICompatibleClient` only (`local-client.ts:573-605`)

**Codex behavior**: Always uses SSE internally (Responses API requires `stream: true`), but buffers complete response before returning. Does NOT implement `generateCompletionStream()`.

### 6.2 ACP Streaming

**Mechanism**: `agent_message_chunk` events in ACP v1

**Decision**: Implement `generateCompletionStream()` for Antigravity to support:

- Slow background jobs
- Better UX for long responses
- Cancellation during generation

**Constraint**: Stream ONLY `agent_message_chunk`, never tool output or thought chunks.

---

## 7. Error Handling

### 7.1 Current Error Classification

**Function**: `classifyFailureKind()` in `failure-kind.ts`

| Kind             | HTTP Status | Cascade?          |
| ---------------- | ----------- | ----------------- |
| `unauthorized`   | 401         | Yes               |
| `forbidden`      | 403         | Yes               |
| `rate_limited`   | 429         | Yes + cooldown    |
| `upstream_error` | 5xx         | Yes               |
| `cancelled`      | —           | No (log only)     |
| `content_filter` | 400         | No (return error) |

### 7.2 Antigravity Error Normalization

**Challenge**: ACP uses JSON-RPC error codes, not HTTP status.

**Decision**: Create normalization layer in `antigravity-errors.ts`:

- Map JSON-RPC codes to `FailureKind`
- Stable error classes: `cli_unavailable`, `cli_version_unsupported`, `auth_required`, `model_unavailable`, `permission_denied`
- Never log raw stderr (may contain prompts, paths, account data)

---

## 8. Decision Matrix: Reuse vs Extend vs New

| Area                   | Decision        | Files                         |
| ---------------------- | --------------- | ----------------------------- |
| `ProviderType`         | Extend          | `types.ts`                    |
| `ProviderChainType`    | Extend          | `provider-chain.ts`           |
| `AIProvider` interface | Reuse           | `types.ts`                    |
| Provider resolver      | Extend          | `provider.ts`                 |
| Provider runner        | Reuse           | `provider-runner.ts`          |
| Health ledger          | Reuse           | `provider-health-ledger.ts`   |
| Consent guard          | Reuse           | `consent-guard.ts`            |
| Document ranking       | Extend          | `provider-rank.ts`            |
| Vision capability      | Extend          | `vision-capability.ts`        |
| OAuth flow             | **DO NOT COPY** | N/A                           |
| Slug fallback          | **DO NOT COPY** | N/A                           |
| Token storage          | **DO NOT COPY** | N/A                           |
| Reasoning wire         | **DO NOT COPY** | N/A                           |
| ACP client             | **New**         | `antigravity-client.ts`       |
| ACP runner             | **New**         | `antigravity-runner.ts`       |
| Capabilities           | **New**         | `antigravity-capabilities.ts` |
| Error normalization    | **New**         | `antigravity-errors.ts`       |

---

## 9. Security Considerations

### 9.1 Non-Negotiable Requirements

1. **No credential storage**: Tokens, keys, account data stay outside HealthLog DB
2. **Profile isolation**: Each user's profile is sandboxed, no cross-contamination
3. **No permission grants**: All `session/request_permission` must be rejected
4. **Empty workspace**: Never point Antigravity at HealthLog codebase or data directories
5. **No MCP servers**: `mcpServers: []` in all sessions
6. **Telemetry clarification**: `--disable-telemetry` is NOT "disable data processing by Google"
7. **Consent required**: User must acknowledge external processing before first use

### 9.2 Blocked Actions

- `session/load`, `session/resume` for existing sessions
- `fs/*` client capabilities
- `terminal/*` client capabilities
- `--add-dir` flag
- `--dangerously-skip-permissions` flag
- Automatic login in Docker entrypoint
- Shared profiles between users
- Inheriting operator's profile

---

## 10. Open Questions for Stage 1

1. **Profile isolation verification**: Does `--app-data-dir` fully isolate credentials, cache, and sessions?

2. **Concurrent profiles**: Can multiple profiles run simultaneously without conflicts?

3. **Account binding**: Once a profile is authenticated, can it be bound to a different Antigravity account?

4. **PDF native vs raster**: Does ACP `resource.blob` actually process PDF, or just pass bytes?

5. **JSON Schema**: Is there any ACP-native schema enforcement, or only headless `--json-schema`?

6. **Audio capability**: Is audio functional in current Antigravity version?

7. **Session limits**: Any limits on concurrent sessions, message size, or attachment size?

---

## Appendix A: File Impact Register

### New Files (Stage 2+)

```
src/lib/ai/antigravity-client.ts
src/lib/ai/antigravity-runner.ts
src/lib/ai/antigravity-capabilities.ts
src/lib/ai/antigravity-errors.ts
src/app/api/antigravity/status/route.ts
src/app/api/antigravity/models/route.ts
src/app/api/antigravity/model/route.ts
src/app/api/antigravity/test/route.ts
src/app/api/antigravity/disconnect/route.ts
src/components/settings/ai/antigravity-provider-form.tsx
```

### Modified Files

```
prisma/schema.prisma (User model: antigravityProfileId, etc.)
src/lib/ai/types.ts (ProviderType += "antigravity")
src/lib/ai/provider-chain.ts (ProviderChainType += "antigravity")
src/lib/ai/provider.ts (resolver, presence, availability)
src/lib/ai/vision-capability.ts (supportsVisionForConfig, supportsPdfForProvider)
src/lib/ai/reasoning/resolve.ts (reasoningSupportForChainEntry)
src/lib/ai/provider-egress.ts (isExternalProvider)
src/lib/documents/provider-rank.ts (documentProviderRank)
src/lib/validations/ai-provider.ts (validation)
```

### Files Intentionally Unchanged

```
src/lib/ai/codex-oauth.ts (no OAuth for Antigravity)
src/lib/ai/codex-slug-chain.ts (no slug fallback)
src/lib/ai/codex-slug-cache.ts (no slug cache)
src/lib/integrations/oauth-refresh.ts (no token refresh)
scripts/rotate-encryption-key.ts (no new secrets in DB)
src/components/admin/central-codex-section.tsx (no central Antigravity in Stage 1)
```

---

## Appendix B: Prisma Schema Additions (Draft)

```prisma
model User {
  // ... existing fields ...

  // Antigravity CLI provider
  antigravityProfileId        String?
  antigravityModel            String?
  antigravityConnectionStatus String?   // unknown | connected | auth_required | disconnected
  antigravityConnectedAt      DateTime?
  antigravityCapabilitiesJson Json?
}
```

**Migration name**: `<timestamp>_antigravity_cli_provider`

---

## Appendix C: ACP Wire Compatibility

### CompletionParams → ACP Mapping

| HealthLog                | ACP                                   | Notes                               |
| ------------------------ | ------------------------------------- | ----------------------------------- |
| `system`                 | `session/systemPrompt` or transcript  | Verify native system prompt         |
| `messages`               | Transcript in single `session/prompt` | NOT multiple `session/prompt` calls |
| `temperature`            | `configOptions`                       | May not be supported                |
| `maxTokens`              | `configOptions`                       | Unknown parameter name              |
| `responseFormat: "json"` | Prompt instruction + validation       | No native schema enforcement        |
| `tools`, `toolChoice`    | **UNSUPPORTED**                       | `supportsTools = false`             |
| `reasoning.effort`       | `thought_level`                       | Verify capability                   |
| `reasoning.summaries`    | **UNSUPPORTED**                       | Set to false                        |
| `images`                 | `image` block with Base64             | Test actual processing              |
| `documents`              | `resource.blob` or fallback raster    | Test actual processing              |
| `signal`                 | `session/cancel`                      | Wire abort to cancel                |

### CompletionResult ← ACP Mapping

| HealthLog           | ACP                             | Notes                          |
| ------------------- | ------------------------------- | ------------------------------ |
| `content`           | `agent_message_chunk` aggregate | Stream or buffered             |
| `tokensUsed`        | `usage` block                   | May be null                    |
| `model`             | Response metadata or config     | Must be captured               |
| `providerType`      | Hardcoded `"antigravity"`       |                                |
| `toolCalls`         | **NEVER**                       | Not supported                  |
| `finishReason`      | `status` field                  | Map to `stop`/`length`/etc.    |
| `reasoning.summary` | **UNSUPPORTED**                 | Always empty                   |
| `providerState`     | `sessionId`?                    | Do NOT persist across requests |

---

**End of Document**
