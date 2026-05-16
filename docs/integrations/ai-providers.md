# AI providers

HealthLog's Coach, daily briefing, weekly report, and per-metric
insights all run through a multi-provider AI client. Pick whichever
provider you prefer — there is no lock-in. The provider is resolved
per-user via the fallback chain in `src/lib/ai/provider.ts` and
`src/lib/ai/provider-chain.ts`, so a user with a Claude key and an
Ollama endpoint can fall back from one to the other automatically.

## Provider matrix

| Provider | Key acquisition | Default model | Endpoint | Privacy stance |
| -------- | ---------------- | ------------- | -------- | -------------- |
| `OPENAI` | <https://platform.openai.com/api-keys> | `gpt-4o-mini` | `https://api.openai.com/v1` | Measurement context sent to OpenAI |
| `ANTHROPIC` | <https://console.anthropic.com/settings/keys> | `claude-3-5-sonnet-latest` | Anthropic SDK default | Measurement context sent to Anthropic |
| `LOCAL` | None (your endpoint) | `local-model` | OpenAI-compatible URL you control | Stays on your network |
| `CHATGPT_OAUTH` | Sign in with your ChatGPT account | Codex-routed | `chatgpt.com/backend-api/codex/responses` | Routed via your ChatGPT subscription |

The four spellings above are the canonical `User.aiProvider` enum
values. Anything else falls through to the admin-shared OpenAI key
(if configured) or the `NoProvider` stub that surfaces "No AI
provider configured" to the UI.

## BYOK vs admin-shared

HealthLog supports two key-provisioning modes that coexist:

- **BYOK (Bring Your Own Key)** — each user pastes their personal
  API key into `/settings/ai`. The key is AES-256-GCM-encrypted at
  rest and only decrypted in-process when the provider client
  initialises. Cost falls to the user; no shared budget.
- **Admin-shared** — the admin panel accepts a single OpenAI key in
  `AppSettings.adminAiKeyEncrypted`. Users who have not configured
  their own key fall back to the admin key. This is the last entry
  in the default provider chain so it acts as a safety net rather
  than the default route.

Single-user instances usually pick one mode and stop there.
Multi-user instances tend to run BYOK with the admin-shared key as a
fallback for users who skip the setup.

## The fallback chain

`User.aiProviderChain` is a JSON array of providers tried in priority
order. The default is encoded in
`src/lib/ai/provider-chain.ts:60-66`:

1. `codex` — ChatGPT OAuth (covered by your ChatGPT Plus / Pro
   subscription; no per-token cost on top).
2. `openai` — user's own OpenAI API key.
3. `anthropic` — user's own Anthropic API key.
4. `local` — self-hosted Ollama / LM Studio / vLLM endpoint.
5. `admin-openai` — operator's shared key (last-ditch).

Entries the user has no credential for are silently skipped. The
runner walks the surviving entries in order; the first to return a
non-error completion wins. A 422 fires only when every entry in the
resolved chain returned an error.

Edit the order in `/settings/ai`. Disable an entry without removing
it by toggling its switch — a malformed chain on disk falls back to
the default rather than 500-ing.

## OpenAI setup

1. Sign in at <https://platform.openai.com/api-keys>.
2. **Create new secret key.** Scope: "Restricted → Model capabilities
   → Write" is sufficient for HealthLog's use of the Responses /
   Chat Completions APIs.
3. Copy the `sk-…` key.
4. In HealthLog, open `/settings/ai`. Set provider to **OpenAI**,
   paste the key, optionally override the model.

The default model is `gpt-4o-mini` (`src/lib/ai/provider.ts:80`) —
cheap, fast, and grounded enough for the structured-output Coach
prompts. Override to `gpt-4o` or `gpt-4.1` if you want more reasoning
headroom and accept the per-token cost.

**Cost expectation.** A daily briefing for an active account runs at
roughly 4–8k input tokens + ~1k output. At gpt-4o-mini's published
rates that is well under a US cent per briefing; a heavy user
generating multiple Coach turns plus a weekly report typically spends
a few dollars per month.

## Anthropic setup

1. Sign in at <https://console.anthropic.com/settings/keys>.
2. **Create Key.** A workspace-scoped key is recommended over an
   organisation-scoped key.
3. Copy the `sk-ant-…` key.
4. In HealthLog, open `/settings/ai`. Set provider to **Anthropic**,
   paste the key, optionally override the model.

The default model is `claude-3-5-sonnet-latest` (`src/lib/ai/provider.ts:55`).
The Anthropic client refuses to forward an Anthropic key to a stale
`aiBaseUrl` even if one is parked in the shared column — Anthropic
has no per-tenant base URL the UI exposes; the SDK default is the
only correct endpoint.

**Cost expectation.** Claude 3.5 Sonnet runs roughly 5x the per-token
cost of `gpt-4o-mini` but produces noticeably stronger reasoning on
the more structured Coach prompts. Most BYOK users on Claude spend
in the low single digits per month.

## Local endpoints (Ollama, LM Studio, vLLM)

Any OpenAI-compatible local endpoint plugs in as the **Local**
provider. Data stays on your network end-to-end; nothing leaves the
host running the model.

**Ollama** — `ollama pull qwen2.5:14b-instruct && ollama serve`.
In `/settings/ai`: provider **Local**, base URL
`http://localhost:11434/v1` (Ollama exposes the OpenAI-compatible
shim there), model `qwen2.5:14b-instruct`, leave the API key blank.
If HealthLog runs in Docker and Ollama runs on the host, swap
`localhost` for `host.docker.internal` (Mac/Windows) or the host's
LAN IP (Linux).

**LM Studio** — start the built-in server from the **Local Server**
tab (usually `http://localhost:1234/v1`) and paste the URL into
HealthLog the same way.

**vLLM** — production-grade shared inference:

```bash
vllm serve Qwen/Qwen2.5-14B-Instruct \
  --host 0.0.0.0 --port 8000 --api-key your-shared-secret
```

Base URL `http://<vllm-host>:8000/v1`, API key `your-shared-secret`,
model `Qwen/Qwen2.5-14B-Instruct`. The local-client encrypts the
API key at rest like every other provider credential.

**SSRF guard.** Local endpoints route through the same validation
as every other outbound URL HealthLog hits. The guard rejects
private-IP-range targets by default — set
`ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` in the container environment to
allow `localhost`, RFC1918, and link-local destinations
(`src/lib/ai/provider.ts:456-462`). Leave it unset on public-facing
instances unless you specifically run an internal endpoint.

**Model sizing.** Roughly: 7-8B for 8 GB GPU / Apple Silicon base
(briefings fine, deeper Coach reasoning gets terse), 14-24B for
16-24 GB GPU / M-series Pro/Max (sweet spot for BYOK-style usage),
70B+ for 48 GB+ / multi-GPU (comparable to mid-tier hosted models).

## ChatGPT OAuth (Codex)

The `CHATGPT_OAUTH` provider routes generations via the
`chatgpt.com/backend-api/codex/responses` endpoint that the official
Codex CLI uses. Users authenticate with their existing ChatGPT Plus
or Pro subscription via device-code OAuth — no API key, no
per-token billing on top of the subscription.

UI setup:

1. In `/settings/ai`, set provider to **ChatGPT OAuth**.
2. Click **Connect ChatGPT.** HealthLog calls
   `POST /api/auth/codex/device-start` to receive a user code and a
   verification URL.
3. The UI displays the verification URL and the short user code.
   Open the URL in any browser signed in to your ChatGPT account
   and enter the user code.
4. HealthLog polls `POST /api/auth/codex/device-poll` until ChatGPT
   confirms the grant. Access and refresh tokens land in
   `User.codexAccessTokenEncrypted` / `codexRefreshTokenEncrypted`,
   AES-256-GCM-encrypted at rest. The connection status flips to
   `connected`.
5. Token refresh runs automatically; the client triggers a refresh
   on 401 and persists the new tokens transparently
   (`src/lib/ai/provider.ts:122-217`).

Disconnect cleanly from `/settings/ai` — `POST /api/auth/codex/disconnect`
clears the encrypted token columns. The wire-level protocol is
documented in `docs/codex-protocol-spec.md` for anyone who wants to
audit the request shape; users who just want the integration to
work do not need to read it.

## Privacy stance

- **OpenAI** and **Anthropic** see the prompt + structured snapshot
  HealthLog assembles per generation (recent metrics, target ranges,
  Coach conversation history). No raw row exports leave the app, but
  values themselves are visible to the provider for the request's
  duration. Provider retention policy applies.
- **LOCAL** keeps everything on your network. Snapshots reach only
  the endpoint you configured. With Ollama on the same host as
  HealthLog, nothing leaves the host at all.
- **CHATGPT_OAUTH** routes via OpenAI's Codex endpoint. Same caveat
  as OpenAI; the difference is the billing axis (ChatGPT
  subscription instead of API tokens).

The Coach drawer surfaces a "Local" badge when generation resolves
to the local provider, so users who pinned a local endpoint can see
at a glance that their context stayed on the host.

## Caching contract

Two caches sit in front of every provider call so generation budgets
stay predictable:

1. **24-hour insight cache.** A successful generation is keyed by
   the upstream measurement snapshot's hash and the prompt version.
   The next read within 24 hours of the same snapshot returns the
   cached envelope instead of re-billing the provider. Force-regen
   on the UI bypasses the cache.
2. **Snapshot LRU.** The Coach snapshot builder caches per
   `(userId, scope)` for 60 seconds so a rapid-fire conversation
   reuses the same upstream context without re-querying Postgres.
   See `src/lib/ai/coach/snapshot.ts`.

`INSIGHTS_RATE_LIMIT_PER_HOUR` (default `10`) bounds the number of
`POST /api/insights/generate` calls a single user can fire per hour.
Lower it when running on a tight budget — the 24h cache already
short-circuits read traffic; only force-regens and cache-misses cost
tokens.

## Connection test

`POST /api/ai/test` runs a one-shot probe against the resolved
provider and returns the latency in milliseconds plus the model the
provider routed to. The Settings UI surfaces a **Test connection**
button next to each provider section that fires this endpoint. A
failed probe surfaces a localisable `errorCode` so the UI renders
the failure in the user's language rather than the raw upstream
error.

## Troubleshooting

- **"No AI provider configured."** Either set up at least one BYOK
  provider in `/settings/ai`, or configure an admin-shared OpenAI
  key in the admin panel.
- **Local endpoint rejected as "internal/private host".** Set
  `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` in the container environment.
  Leave it unset on internet-facing instances unless you specifically
  want to allow private-range targets.
- **Codex disconnects after a few weeks of inactivity.** ChatGPT
  refresh tokens lapse after extended idle periods. Reconnect via
  the **Connect ChatGPT** button — HealthLog re-runs the device-code
  flow and the new tokens land in the same encrypted columns.
- **Chain falls through every entry.** Run the per-provider connection
  test from `/settings/ai` to identify which step is failing. The
  most common cause is a stale or revoked BYOK key earlier in the
  chain; remove or disable that entry to skip ahead.
