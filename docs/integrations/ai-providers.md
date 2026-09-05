# AI providers

HealthLog's Coach, daily briefing, weekly report, and per-metric
insights all run through a multi-provider AI client. Pick whichever
provider you prefer — there is no lock-in. The provider is resolved
per-user via the fallback chain in `src/lib/ai/provider.ts` and
`src/lib/ai/provider-chain.ts`, so a user with a Claude key and an
Ollama endpoint can fall back from one to the other automatically.

## Provider matrix

| Provider            | Key acquisition                               | Default model       | Endpoint                                  | Privacy stance                          |
| ------------------- | --------------------------------------------- | ------------------- | ----------------------------------------- | --------------------------------------- |
| `OPENAI`            | <https://platform.openai.com/api-keys>        | `gpt-4o`            | `https://api.openai.com/v1`               | Measurement context sent to OpenAI      |
| `ANTHROPIC`         | <https://console.anthropic.com/settings/keys> | `claude-sonnet-4-6` | Anthropic SDK default                     | Measurement context sent to Anthropic   |
| `LOCAL`             | None (your endpoint)                          | `local-model`       | OpenAI-compatible URL you control         | Stays on your network                   |
| `OPENAI_COMPATIBLE` | Your gateway's key, or none                   | none (you name it)  | OpenAI-compatible URL you configure       | Reaches whatever your gateway routes to |
| `CHATGPT_OAUTH`     | Sign in with your ChatGPT account             | Codex-routed        | `chatgpt.com/backend-api/codex/responses` | Routed via your ChatGPT subscription    |

The five spellings above are the canonical `User.aiProvider` enum
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
  than the default route. Since v1.28.14 the operator can also share
  a subscription-based account that users opt into — see
  [Admin-shared subscription access](#admin-shared-subscription-access).

Single-user instances usually pick one mode and stop there.
Multi-user instances tend to run BYOK with the admin-shared key as a
fallback for users who skip the setup.

## The fallback chain

`User.aiProviderChain` is a JSON array of providers tried in priority
order. The default is encoded as `PROVIDER_CHAIN_DEFAULT` in
`src/lib/ai/provider-chain.ts`:

1. `codex` — ChatGPT OAuth (covered by your ChatGPT Plus / Pro
   subscription; no per-token cost on top).
2. `openai` — user's own OpenAI API key.
3. `anthropic` — user's own Anthropic API key.
4. `local` — self-hosted Ollama / LM Studio / vLLM endpoint.
5. `admin-openai` — operator's shared key (last-ditch).

`openai-compatible` is a sixth chain entry you can add in the editor.
It is deliberately not in the default chain: it resolves only against a
base URL you saved, so a default entry would be dead weight for
everyone who never configures a gateway.

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

The default model is `gpt-4o` (see `src/lib/ai/provider.ts`) — a
full-size model that keeps the headline Insights assessments grounded
and well-reasoned out of the box. Override to a lighter model such as
`gpt-4o-mini` if you want to trade some reasoning headroom for a lower
per-token cost.

**Cost expectation.** A daily briefing for an active account runs at
roughly 4–8k input tokens + ~1k output. At gpt-4o's published rates
that is a fraction of a US cent per briefing; a heavy user generating
multiple Coach turns plus a weekly report typically spends a few
dollars per month. A lighter override drops this further.

## Anthropic setup

1. Sign in at <https://console.anthropic.com/settings/keys>.
2. **Create Key.** A workspace-scoped key is recommended over an
   organisation-scoped key.
3. Copy the `sk-ant-…` key.
4. In HealthLog, open `/settings/ai`. Set provider to **Anthropic**,
   paste the key, optionally override the model.

The default model is `claude-sonnet-4-6` (`src/lib/ai/provider.ts`).
The Anthropic client refuses to forward an Anthropic key to a stale
`aiBaseUrl` even if one is parked in the shared column — Anthropic
has no per-tenant base URL the UI exposes; the SDK default is the
only correct endpoint.

**Cost expectation.** A current Sonnet runs at a higher per-token
cost than a lightweight OpenAI model but produces noticeably stronger
reasoning on the more structured Coach prompts. Most BYOK users on
Claude spend in the low single digits per month.

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
private-IP-range targets by default. `ALLOW_LOCAL_AI_PRIVATE_HOSTS`
opens the escape hatch and accepts two forms: a comma-separated host
allowlist (e.g. `ALLOW_LOCAL_AI_PRIVATE_HOSTS=ollama.lan,10.0.0.5`),
which permits only those exact hostnames, or the legacy
`ALLOW_LOCAL_AI_PRIVATE_HOSTS=true`, which permits any private host —
including the cloud-metadata endpoint, so prefer the host list. Leave
it unset on public-facing instances unless you specifically run an
internal endpoint.

**Model sizing.** Roughly: 7-8B for 8 GB GPU / Apple Silicon base
(briefings fine, deeper Coach reasoning gets terse), 14-24B for
16-24 GB GPU / M-series Pro/Max (sweet spot for BYOK-style usage),
70B+ for 48 GB+ / multi-GPU (comparable to mid-tier hosted models).

## OpenAI-compatible gateways (LiteLLM, OpenRouter, vLLM, …)

Since v1.33.1 a gateway has its own provider: **OpenAI-compatible
gateway**. Any service that speaks the OpenAI `/v1/chat/completions`
wire plugs in there, whether it runs on your network or not.

1. In `/settings/ai`, set provider to **OpenAI-compatible gateway**.
2. Base URL is the gateway's OpenAI-compatible root and **ends with
   `/v1`** — e.g. `https://litellm.example.com/v1`,
   `https://openrouter.ai/api/v1`, or `http://vllm.lan:8000/v1`.
3. API key is **optional** — set it when the gateway requires a
   Bearer token (OpenRouter key, LiteLLM master key), leave it blank
   otherwise. It is encrypted at rest like every other credential,
   in its own column.
4. Model is whatever the gateway routes — e.g.
   `anthropic/claude-sonnet-4-6` on OpenRouter or a LiteLLM alias.
   Leave it blank and the model saved for your other providers is
   used; with neither set the provider is skipped.

Then add **OpenAI-compatible gateway** to the fallback chain (it is
not in the default one) and put it where you want it tried.

**Why it is a separate provider and not a base-URL field on OPENAI.**
The OPENAI provider pins `api.openai.com`, and the gateway provider
reads three columns of its own: its base URL, its own key, its own
model. Neither can see the other's. A key you issued to OpenAI can
therefore never be sent to a host you typed into a different form,
and that property is structural rather than a comment — the OPENAI
arm has no code path that reads the gateway's base URL.

**SSRF guard.** The gateway's base URL passes the same floor as the
Local provider's: a public host always, a private one only when the
operator allowlisted it via `ALLOW_LOCAL_AI_PRIVATE_HOSTS` (documented
under Local endpoints above). LAN gateways are the normal case for LiteLLM and vLLM, so
the escape hatch matters here as much as it does for Ollama.

JSON surfaces send the standard
`response_format: { type: "json_object" }`; an endpoint that rejects
the field is detected on the first refusal and retried without it,
so strict gateways and older local servers both work unmodified.

**When the gateway refuses.** OpenRouter answers a refused generation
with HTTP 200 and the reason inside the body, so every refusal used to
reach the provider health card as an empty reply with no status. It now
carries the gateway's own status and message — 402 out of credits, 403
blocked, 429 rate-limited, 502 model down. The two account settings
behind most refusals are an empty credit balance and a data-policy or
zero-retention restriction that leaves no eligible provider for the
model you picked; both are changed in the gateway account, not here.

**The Local provider still works for this** and nothing about it
changed — it speaks the same wire and honours the same base URL. Pick
the gateway provider when the endpoint is a gateway (it says so in
the UI, it keeps a separate key, and it can sit in the chain
alongside Local), and pick Local for a model running on your own
machine.

The **admin** server-key path has a separate guard: an admin-set
custom base URL must additionally be allowed via
`ADMIN_AI_BASE_URL_ALLOWLIST` in the container environment. Neither
the user-level Local provider nor the gateway provider reads that
variable — both are governed by the SSRF guard above.

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
   (`src/lib/ai/provider.ts`).

Disconnect cleanly from `/settings/ai` — `POST /api/auth/codex/disconnect`
clears the encrypted token columns. The wire-level protocol is
documented in `docs/codex-protocol-spec.md` for anyone who wants to
audit the request shape; users who just want the integration to
work do not need to read it.

## Admin-shared subscription access

Besides the shared API key, the operator can connect a single
subscription-based AI account for the whole instance — an
operator-shared subscription provider that users without any
personal AI setup can opt into.

- **Admin side.** Under **Admin → AI** the operator runs the same
  device-code OAuth flow as the per-user connection
  (`POST /api/admin/central-codex/device-start` +
  `device-poll`). The tokens land AES-256-GCM-encrypted in the
  `AppSettings` singleton and are never returned by any endpoint —
  status and disconnect go through `GET` / `DELETE
/api/admin/central-codex`, which sit behind the cookie-only
  `requireAdmin()` boundary.
- **User side.** Each user opts in individually in `/settings/ai`
  (`PATCH /api/auth/me/use-central-codex`, body
  `{ "useCentralCodex": boolean }`). The opt-in is off by default.
- **Chain semantics.** The shared connection is the internal
  `admin-codex` chain entry. It is never part of the persisted chain
  and never offered in the chain editor — it is appended **last** to
  the resolved chain, and only when the user opted in AND the
  operator has connected the account
  (`src/lib/ai/provider-chain.ts`). A hand-crafted persisted entry
  resolves to nothing.
- **Cost.** Generations through the shared connection run under the
  operator's account, so usage and rate limits land on the operator,
  not the user.

The settings UI states this plainly: the shared access is a single
signed-in AI account the operator connected for everyone on the
server — not the user's own key. Users who want their data to reach
only a provider under their own contract should configure a personal
provider instead; their own entries always resolve first.

## Privacy stance

- **OpenAI** and **Anthropic** see the prompt + structured snapshot
  HealthLog assembles per generation (recent metrics, target ranges,
  Coach conversation history). No raw row exports leave the app, but
  values themselves are visible to the provider for the request's
  duration. Provider retention policy applies.
- **LOCAL** keeps everything on your network. Snapshots reach only
  the endpoint you configured. With Ollama on the same host as
  HealthLog, nothing leaves the host at all.
- **OPENAI_COMPATIBLE** reaches exactly the endpoint you configured,
  and then wherever that endpoint routes. A gateway on your own
  network keeps the data there; a hosted gateway forwards it to
  whichever provider it fronts, under that provider's retention
  policy. HealthLog cannot see past the gateway, so the honest
  statement is the one above: this provider's privacy stance is your
  gateway's.
- **CHATGPT_OAUTH** routes via OpenAI's Codex endpoint. Same caveat
  as OpenAI; the difference is the billing axis (ChatGPT
  subscription instead of API tokens).

The Coach drawer surfaces a "Local" badge when generation resolves
to the local provider, so users who pinned a local endpoint can see
at a glance that their context stayed on the host.

The document vault is local-first by default: an uploaded document is
only read by an external AI provider when you tap a per-document AI
action, and every text-layer PDF is indexed for search locally with no
egress at all — **unless you opt into automatic AI reading in AI
settings** (next section).

## Automatic document reading (opt-in)

**Off by default.** With the switch off, nothing about the vault
changes: a stored document is read externally only when you explicitly
tap "Read with AI" on it, and that tap still needs an active AI-consent
receipt for any provider that leaves the machine. Text-layer PDFs stay
searchable through local extraction with no egress.

Turn **"Read documents automatically with AI"** on (AI settings) and
each document you upload is read, described, and indexed by your
configured AI provider with no per-document confirmation — the
"upload and it just gets read" flow. What that means, plainly:

- **The document's contents leave this machine** to your configured
  provider. The read happens on the server, right after upload.
- **A subscription connection** — a signed-in AI account rather than an
  API key — applies its own consumer data settings. **Subscription
  providers may use the content to improve their models, and no
  data-processing agreement covers it.** Turning the toggle on is the
  standing consent for that trade; it is recorded in the consent audit
  trail.
- **A self-hosted local model never egresses.** Documents read by a
  local provider stay on your server whether the toggle is on or off.
- **Scanned / image-only PDFs** are rendered to page images server-side
  so a provider that only accepts images (a subscription connection) can
  read them too; a native-PDF provider reads the PDF directly. Only the
  first pages of a long document are sent, to bound cost.

Regulated or privacy-sensitive deployments should either leave this off
and read documents per-document on demand, or configure a **BYOK
no-training API key** or a **local model** as the provider — both avoid
the subscription-training trade. The setting is per-user: in a
multi-user deployment each account opts in for its own documents.

## What the Coach is — and isn't

The Coach is an informational assistant that works from your own
logged data. It is not a doctor, what it says is not medical advice,
and it does not diagnose, prescribe, or change treatment — those
boundaries are written into its system prompt as safety contracts, not
left to chance. It describes patterns observationally ("your resting
heart rate has been rising over 14 days"), never as a verdict about a
named condition, and it defers diagnosis, dose, and drug-interaction
questions to a healthcare professional. This is HealthLog's
project-wide self-description standard: a personal health
record-keeping and wellness tool, not a medical device. The same
non-diagnostic framing governs the daily briefing, the insights, and
every surface that turns your data into words.

The Coach can also reach out proactively — a calm, once-a-day morning
check-in when there is something genuine to surface (a recovery trend
easing off, blood pressure running a touch high). The nudge is warm
and localized, references the focus by category rather than quoting
your own words back, and stays silent when there is nothing real to
say or when you have engaged the Coach recently. It is an invitation,
never a streak-guilt prompt, and it inherits the same non-diagnostic
boundaries as the chat.

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

`INSIGHTS_MAX_TOKENS` (default `2500`, clamped to 500–8000) sets the
output-token ceiling for the daily-briefing generation. Raise it if a
verbose model gets its briefing cut off mid-JSON — the API reports
that case as "AI response was cut off" rather than the generic
invalid-JSON error.

`DOCUMENT_AI_LIMIT_PER_HOUR` (default `6`, clamped to 1–1000) bounds
the document-AI actions per user per hour. Read/index, extract,
suggest and summarise share one bucket, and a slot is only consumed
when a request actually reaches the provider — a request that fails
during input preparation (unreadable file, exhausted daily budget,
malformed body) hands its slot back. Raise it when users batch-read
many documents against a generous provider budget; lower it on a
tight one. The 429 names the actual wait (the window is an hour) and
carries the reset instant in `X-RateLimit-Reset`.

All three variables must also be listed in the compose
`environment:` whitelist to reach the container; the shipped
`docker-compose.yml` lists them.

## Connection test

`POST /api/ai/test` runs a one-shot probe against the resolved
provider and returns the resolved provider type, the model, the token
usage, and a short response sample. The Settings UI surfaces a
**Test connection** button next to each provider section that fires
this endpoint. A failed probe carries a categorised `reasonCode` so
the UI renders the failure in the user's language rather than the raw
upstream error.

## Troubleshooting

- **"No AI provider configured."** Either set up at least one BYOK
  provider in `/settings/ai`, or configure an admin-shared OpenAI
  key in the admin panel.
- **Local endpoint rejected as "internal/private host".** Set
  `ALLOW_LOCAL_AI_PRIVATE_HOSTS` to the endpoint's exact hostname
  (e.g. `ollama.lan`; comma-separate several) in the container
  environment, or to `true` to allow any private host. Prefer the host
  list; leave it unset on internet-facing instances unless you
  specifically want to allow private-range targets.
- **Codex disconnects after a few weeks of inactivity.** ChatGPT
  refresh tokens lapse after extended idle periods. Reconnect via
  the **Connect ChatGPT** button — HealthLog re-runs the device-code
  flow and the new tokens land in the same encrypted columns.
- **Chain falls through every entry.** Run the per-provider connection
  test from `/settings/ai` to identify which step is failing. The
  most common cause is a stale or revoked BYOK key earlier in the
  chain; remove or disable that entry to skip ahead.
