# Changelog

## [1.3.3] — 2026-05-08

### Added

- **Pulse oximetry as a first-class measurement type (`OXYGEN_SATURATION`).**
  Closes the SpO2 part of #109. Migration `0024_oxygen_saturation` extends
  the `MeasurementType` enum. Plausibility range 50–100% (below 50% is
  incompatible with sustained life and almost certainly a faulty sensor;
  upper bound 100% is physical). Default severity bands follow BTS Guideline
  2017 + ATS clinical practice: green 95–100%, orange 92–94%, red <92% —
  lower-only concern (the upper orange wing collapses onto greenMax since
  saturation cannot physically exceed 100%). COPD / chronic-respiratory
  users with a doctor-set baseline of 88–92% can personalize via the
  threshold-override UI. Wired through Withings (ScanWatch type 54),
  measurement form, list, charts, doctor PDF, OpenAPI spec, and i18n (DE +
  EN). iOS DTO already declared `OXYGEN_SATURATION` from a prior commit;
  the server enum addition closes the long-standing drift.
- **Body composition surfaces (TOTAL_BODY_WATER, BONE_MASS, BLOOD_GLUCOSE)
  in the measurements list filter, badge, mobile icon, edit dialog, and
  server-rendered doctor-report PDF** — closes the UI side of #109. Root
  cause was three local maps in `measurement-list.tsx` that drifted from
  the v1.3 server enum; extracted to `measurement-list-meta.ts` with
  fail-fast coverage tests so future enum additions are caught at build
  time. Server-side PDF used a separately-drifted type map vs. the
  browser-side renderer; both are now in sync.
- **Effective-range thresholds for `TOTAL_BODY_WATER` and `BONE_MASS`** —
  severity logic was returning `nominal` for any value because no defaults
  existed.

### Changed

- **OpenAPI `MeasurementType` enum extended + spec version bumped 1.3.0 →
  1.3.3** to match the actual app. Spec was lagging by two minor releases.
- **Withings webhook secret now reads from `X-Withings-Webhook-Secret`
  header** in preference to the legacy `?secret=…` URL query parameter.
  Closes the URL-leak-via-access-logs vector flagged in audit C-3. Legacy
  query-param path is retained for backwards compatibility and emits a
  Wide Event warning so operators can spot still-using-the-old-flow
  integrators. Plan: remove the query fallback in 1.4.x once warnings drain.
- **Idempotency `defaultUserIdResolver` now supports Bearer tokens.**
  Cookie sessions tried first, then Bearer-token via `hashToken` lookup.
  Without the Bearer fallback, every iOS / external-ingest retry was
  hitting the handler again and creating duplicate measurements (audit
  C-4 — the exact use case `withIdempotency` was built for).
- **GlitchTip URL stripping** — `reportToGlitchtip` now strips the URL
  query string before forwarding so Withings legacy `?secret=…` and OAuth
  `?code=…` callbacks cannot leak via the error tracker (audit H-B7).

### Fixed

- **Migration `0022_body_composition_metrics` unit comment lied** —
  claimed `TOTAL_BODY_WATER: percent of body weight (%)` while every other
  surface (validators, Withings client, doctor PDF) treated it as `kg`.
  Comment corrected to match reality.

### Security

- **Bearer-scope wildcard handling (CRITICAL — V3-1).** `requireAuth()`
  previously accepted any non-admin token regardless of declared
  permission scope, so a token with `permissions:["medication:ingest"]`
  could DELETE the user account. Spec now requires `permissions:["*"]`
  or the explicit required permission.
- **Account-deletion completeness (CRITICAL — V3-2 / GDPR Art. 17).**
  Cascades through `Feedback` + `AuditLog` rows so user-erasure is
  actually total. Daily retention job sweeps orphaned audit rows after
  90 days as a defence-in-depth.
- **Withings webhook secret header migration (audit C-3)**, idempotency
  Bearer-resolver (audit C-4), GlitchTip URL strip (audit H-B7).
- **Truthfulness pass on medical citations** — SpO2 normal-range source
  is now consumer-pulse-oximeter consensus + NICE NG115 + FDA labelling
  (BTS-2017 was for clinical hypoxaemia thresholds, not consumer
  monitoring); body-composition metrics are explicitly labelled
  "bioimpedance-estimated, not DEXA-comparable" in the doctor PDF;
  TBW citation now references the Watson formula / ICRP Reference Man
  (was misattributed to ESPEN 2017); steps target now references
  Saint-Maurice JAMA 2020 (WHO publishes minutes/week, not steps).
- **SpO2 user-override clamp** — overrides could emit physical
  impossibilities (e.g. `orangeMax = 100.75`); clamped to METRIC_BOUNDS
  for SpO2 + BODY_FAT.
- **moodLog webhook secret encrypted at rest with AES-256-GCM** (V3
  STILL-V2-C-2). Read path tolerates legacy plaintext rows during the
  transition window; one-shot startup migration in the worker rotates
  any leftover plaintext rows.
- **CSP tightening** — `chatgpt.com` + `api.openai.com` `connect-src`
  now gated to `/settings/ai/**` (was a global blanket on every page,
  including `/auth/login` → DOM-XSS exfil channel).
- **Web-Push subscription endpoint SSRF guard** — `endpoint` now
  requires HTTPS + passes `isPublicUrl()` (was `z.url()` only).
  Side-fix: `isPublicUrl()` no longer falsely classifies DNS labels
  starting with `fc`/`fd` (e.g. `fcm.googleapis.com`) as IPv6
  unique-local; the IPv6 check is now gated on a colon being present.
- **IP-geolocation lookup is now HTTPS-only.** Default provider is
  `ipwho.is` (free, HTTPS, no key). Existing `ip-api.com` plaintext
  HTTP path leaked auth-event IP + timestamp on every login (GDPR Art.
  32 + Art. 44). Operators can override via `IP_GEO_LOOKUP_URL` (HTTPS
  only) or disable entirely with `IP_GEO_LOOKUP_DISABLED=1`.
- **`/api/ai/test` no longer returns provider error message + body
  excerpt to the client.** Diagnostics land server-side via Wide Events
  (annotate); client gets a categorised generic message. Closes provider
  URL / partial key / internal header leak.
- **`/api/import` rate-limit added** — 5 imports/hour/user. Was
  unlimited (bulk-injection vector).
- **Trusted-proxy XFF semantics** — `getClientIp()` now reads
  `X-Forwarded-For` right-to-left with a configurable
  `TRUST_PROXY_HOPS` (default 1, matches typical single-proxy
  self-host). Closes XFF rotation bypass of per-IP rate-limits.
- **Audit-log retention job** — `audit_logs` rows older than
  `AUDIT_LOG_RETENTION_DAYS` (default 365) are purged daily. Closes
  GDPR Art. 5(1)(e) "storage limitation" gap.
- **Idempotency cachable-status filter** is now an exported, unit-tested
  function — pins the do-not-cache contract for 401/403/408/429/5xx.
- **Bearer mock tightening** in `require-auth-bearer.test.ts` +
  `idempotency.test.ts`: `apiToken.findUnique` calls are now asserted
  to use `where: { tokenHash: <hashed> }`, so a regression to raw-token
  comparison would break the suite immediately.

### Internal

- **Server-side enum drift cousins closed.** Five module-level
  hardcoded type-arrays in `/api/insights/comprehensive`,
  `/api/dashboard/summary`, `/api/analytics`, `/lib/insights/general-status`,
  `/api/import` are now derived from `measurementTypeEnum.options`.
  External-contract enums extended additively:
  `/api/measurements/series` (`oxygen`, `totalBodyWater`, `boneMass`),
  `/api/dashboard/widgets` (`oxygenSaturation`), `DashboardWidgetId` +
  `DEFAULT_DASHBOARD_LAYOUT`. New coverage test asserts the canonical
  enum stays the source of truth.
- **Doctor-PDF text-content tests** — replaced bytes-only "renders body
  composition rows" theatre with `pdf-parse`-driven assertions on the
  actual rendered DE + EN labels and values. Adds dev dep `pdf-parse`.

## [1.3.2] — 2026-04-28

### Fixed

- **Glucose tiles on the dashboard rendered the raw i18n key
  `targets.glucoseFasting` instead of the translated label** (closes
  #108). Both `messages/en.json` and `messages/de.json` had two
  top-level `targets` blocks; `JSON.parse` silently keeps the last
  occurrence, and that block was missing the four glucose labels. The
  duplicate is now collapsed into a single block. A duplicate
  `bugreport.bugTitlePlaceholder` shadowed inside `bugreport` was
  cleaned up too. Two further keys (`dashboard.sleep`,
  `dashboard.steps`) were missing from both locales and were falling
  back to hard-coded English; both are now translated.
- **New i18n locale-integrity test**
  (`src/lib/__tests__/i18n-locale-integrity.test.ts`) fails the build
  on duplicate keys at any nesting depth and on key drift between
  `en` and `de` — closes the structural gap that let the duplicate
  `targets` block ship in the first place.

### Changed

- **Screenshot upload removed from the bug-report form** (also part
  of #108). The form previously accepted an image attachment that
  was stored in the local DB but never reached the published GitHub
  issue — GitHub does not accept inline base64 data URIs in issue
  bodies and offers no public API to attach images to an issue
  programmatically. Rather than ship misleading
  "a screenshot was attached" placeholder text in the resulting
  issue, the upload UI is now gone and the placeholder note is no
  longer added when promoting feedback. The `screenshotBase64`
  column and the admin-side preview of previously-submitted
  screenshots are unchanged — existing reports keep their
  attachments locally. We plan to revisit a real screenshot pipeline
  in a future release.

## [1.3.1] — 2026-04-27

### Fixed

- **Compose env-var validation no longer breaks Coolify-style deploys.**
  `docker-compose.yml` previously used `${VAR:?required}` shell-parameter
  syntax for the four secrets and `POSTGRES_PASSWORD`. Some hosting
  platforms (Coolify in particular) parse compose files eagerly and
  store the _fallback error string_ (`"POSTGRES_PASSWORD is required"`)
  as the literal env-var value when `POSTGRES_PASSWORD` was unset,
  which then collided with `DATABASE_URL` and broke the running app
  with `P1000: Authentication failed`. Compose now uses plain `${VAR}`
  interpolation; validation moved into `docker-entrypoint.sh`, which
  fails fast with a clear stderr message listing the unset variables.

### Notes

If you upgraded an existing Compose stack from 1.2.x → 1.3.0 and hit
the `POSTGRES_PASSWORD is required` literal-as-value bug, set
`POSTGRES_PASSWORD` in your environment to whatever your existing
Postgres data volume was originally initialised with (likely
`healthlog` if you started from a pre-1.2.1 release), then redeploy.
Postgres only honours `POSTGRES_PASSWORD` on first volume init — the
existing user keeps the original password regardless of env changes.

## [1.3.0] — 2026-04-27

### Added — Body composition + targeted hardening

- **Total body water and bone mass as measurement types** (closes #89). New
  enum values `TOTAL_BODY_WATER` and `BONE_MASS`, both stored canonically
  in kilograms (matches Withings hydration/bone-mass measures and Health
  Connect's `TotalBodyWaterRecord` / `BoneMassRecord`). Migration is
  purely additive (`ALTER TYPE ... ADD VALUE`) — safe to apply against
  any 1.2.x database without downtime.
- **Withings sync picks both up automatically.** The Withings client now
  maps measure type `77` (hydration / water mass) and `88` (bone mass).
  Anyone with a Withings Body+ scale and an active connection will see
  the new metrics flowing in on the next sync without any extra config.
- **Doctor-report PDF includes both new types** in the vital-signs table
  when data exists, with locale-aware labels in English and German.
- **Dashboard widgets registered for both** (default-invisible — opt in
  via Settings → Dashboard layout).

### Security

- **SSRF guard hardened** (`isPublicUrl`). The previous implementation
  used `parseInt` with permissive prefix checks like `h.startsWith("10.")`
  which let `010.0.0.1` slip through — and worse, the WHATWG URL parser
  silently normalises `010.0.0.1` to `8.0.0.1` (octal interpretation), a
  real bypass on naive checks. The new guard adds a pre-URL leading-zero
  check on the raw input, a strict IPv4 parser, and proper IPv6
  bracket / loopback / link-local handling. Now blocks `127.0.0.0/8`,
  `0.0.0.0/8`, `10.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`,
  `192.168.0.0/16`, `100.64.0.0/10` (CGNAT), `::1`, `fe80::/10`,
  `fc00::/7`. Comprehensive regression tests included.
- **GitHub PAT redacted from logged error bodies.** When a feedback
  escalation to GitHub fails, the response body was being passed
  verbatim into `getEvent()?.addWarning(...)` — flowing to Loki. The
  body is now stripped of the configured token before logging.
- **Per-user threshold writes are rate-limited** (30 writes / 5 min) to
  make audit-log enumeration unattractive. Audit-logging itself was
  already there.

### Performance

- **N+1 in `/api/insights/comprehensive` fixed.** The medication-compliance
  loop hit Postgres once per active medication. It now batches into a
  single `medicationId IN (...)` query and groups in memory. Latency
  improvement scales linearly with the user's active medication count.

### Reliability

- **pg-boss draining on SIGTERM/SIGINT.** `docker stop`, Coolify redeploys,
  and Kubernetes pod terminations now trigger `boss.stop({ graceful: true,
timeout: 30s })` so in-flight handlers finish instead of being killed.
  Previously, pending handlers could be lost or replayed on restart.
- **CI now blocks on TypeScript strict checks.** `continue-on-error: true`
  removed for typecheck. Tests already were blocking. ESLint stays
  non-blocking for now — the existing `settings/page.tsx` monolith has
  long-standing `react-hooks/set-state-in-effect` violations whose proper
  fix lives in the 1.4.0 settings-split refactor; a blocking lint here
  would just gate every PR until that refactor lands. Required cleaning
  up two `any` types in `api-handler.ts` (justified inline — Next.js
  variadic handler signature constrained by `Promise<Response>` return).

### Polish

- **Bottom-nav touch targets** sized to WCAG 2.5.5 minimum (44×44 CSS px).
  Visual icon stays at 20 px so the design doesn't shift.
- **Phase-config dialog** marks the decorative coloured dot `aria-hidden`
  because the redundant text label already conveys the phase to screen
  readers. No more meaningless `image` node announcements.
- **Admin-status labels** for "Web Push" and "Bug Report" now go through
  `t()` (new `admin.integrationWebPush` / `admin.integrationBugReport`
  keys in en + de). They were the last hard-coded English strings on
  the admin page.

### What's _not_ in this release (tracked for later)

- **Onboarding redesign** (dashboard-first empty-state flow + persistent
  Getting Started checklist) and the **typed `apiClient` wrapper** that
  underpins it are tracked for a focused 1.4.0 cycle. The 1.2.1 patch
  already closed the acute symptoms of #87 (silent-failure toast +
  default schedule), so the redesign is now a proper UI investment
  rather than a bug-fix.
- **Withings sync is mapping both new measures**, but **a dedicated
  Bearer-auth ingest endpoint for external pipelines** (n8n + Health
  Connect, requested in #89) ships in 1.4.0 alongside the API-token
  flow.

## [1.2.1] — 2026-04-27

### Fixed

- **Onboarding**: Medications added during onboarding are now actually persisted (closes #87). The wizard previously sent an empty `schedules: []` array, the server-side validation rejected it with a 422, the client never checked `response.ok`, and the user was redirected to the dashboard as if everything had worked. Onboarding now wraps each step in `try/catch`, surfaces failures via toast, and attaches a default reminder window (`08:00–09:00 daily`) so the medication actually persists. A hint under the medication list explains the default.
- **Docker setup** (closes #88):
  - `docker-compose.yml` now uses `ports: "3000:3000"` (was `expose: "3000"`, which made the app unreachable from the host).
  - `POSTGRES_PASSWORD` is a single env var that both the Postgres service and `DATABASE_URL` interpolate, so they cannot drift apart.
  - `.env.example` now points at the in-container hostname `db:5432` (was `localhost:5432`, which never resolves inside the app container).
- **Documentation**:
  - `package.json` synced to 1.2.0 (was lagging on 1.1.0).
  - `CLAUDE.md` and `AGENTS.md` corrected to 23 models (the `Feedback` model added in v1.2 was missing from the count).
  - `README.md` Quick Start gives a realistic time estimate, generates the four secrets in one block straight into `.env`, and points reverse-proxy users at the docs.

### Added — Tooling & Supply Chain

- **Pre-built multi-arch images on GHCR**: `.github/workflows/docker-publish.yml` now builds `linux/amd64` + `linux/arm64` images on every push to `main` and on every `v*` tag, publishing to `ghcr.io/mbombeck/healthlog`. Self-hosters no longer need a build toolchain — `docker compose pull && docker compose up -d` is enough. The bundled `docker-compose.yml` references the published image with a `build:` block as fallback for contributors.
- **Supply-chain attestations**: each published image carries a SLSA build provenance statement and a Software Bill of Materials. `SECURITY.md` documents how to verify them and how to pin a specific version.
- **Documentation single source of truth**: `getting-started/installation.mdx` is now the canonical setup guide (mirrors the bundled `docker-compose.yml`); `self-hosting/docker.mdx` slimmed to image internals + ops notes only. The landing page's Quick Start terminal block now includes the secrets-generation step (was missing).

### Notes

This is a patch release that closes the install/onboarding friction reported in #87 and #88. The bigger user-facing changes (additional measurement types like total body water and bone mass per #89, full onboarding redesign, typed API client) are tracked for `1.3.0`.

## [1.2.0] — 2026-04-18

### Added — Personalization, Glucose & Multi-Provider AI

- **Per-user custom thresholds**: Override the computed default ranges (BP, BMI, glucose, pulse) with values from your clinician. Audit-logged with previous/new values and timestamps. Doctor Report PDF flags custom ranges and prints both your target and the standard guideline value.
- **Blood glucose tracking**: New metric with `fasting`, `postprandial`, `random`, and `bedtime` contexts. Display unit switch between mg/dL and mmol/L (lossless conversion). Context-aware classification per ADA 2024 / DGIM. Per-context charting on dashboard and Doctor Report PDF.
- **Dashboard customization**: Show/hide and drag-to-reorder every dashboard widget. Per-user preference, reset-to-defaults button. Layout persists across the same user on the same device.
- **Built-in feedback system**: New in-app Send Feedback flow (Bug / Feature / Question / Other) with anonymized system info attachment. Stored in HealthLog's own database — no GitHub config required. Optional `Escalate to GitHub` button for admins who configure a PAT.
- **Multi-provider AI insights**: Provider abstraction extended with **Anthropic Claude** and **local OpenAI-compatible endpoints** (Ollama, LM Studio, vLLM, LiteLLM) alongside OpenAI. Per-user provider selection. Local endpoints keep all health data on your network.
- **Locale-aware UI polish (English-first)**: Numbers, dates, glucose units, BP, weight, and BMI all formatted via `useFormatters()` from the active locale. Doctor Report PDF and AI insight prompts now respect locale end-to-end (no hand-rolled `Intl.*` with fixed locales).

### Changed

- Reference range computation extracted into a dedicated `src/lib/health/thresholds.ts` module with computed defaults and override resolution.
- AI provider routing reworked to dispatch by `provider` field on the user record; OpenAI remains the default for legacy users.
- Dashboard route renders widgets from `UserDashboardLayout` model when present, otherwise falls back to the default order.
- Doctor Report PDF: locale-aware headers, glucose section, custom-range badges.

### Security

- GitHub PAT for feedback escalation stored AES-256-GCM encrypted in the database (never as env var).
- Local AI endpoint URLs validated against SSRF (no localhost/RFC1918 unless explicitly allowed by admin).
- Custom threshold writes rate-limited and audit-logged with IP.

## [1.1.0] — 2026-04-06

### Added — AI Insights Overhaul

- **ChatGPT Proxy Integration**: Insights now run through a local openai-oauth proxy using your ChatGPT subscription — no separate API billing required
- **Admin AI Fallback**: Admins can configure a global API key (OpenAI/OpenRouter) as fallback for users without their own connection
- **Provider Abstraction**: New `src/lib/ai/` module with pluggable providers (Codex OAuth, Admin Key, None) and automatic failover
- **Medical Insight Prompts**: 7 specialized prompts based on ESC/ESH 2023, WHO, DGE, and DEGAM guidelines
  - Blood Pressure: ESC/ESH classification, morning risk ladder (J-HOP), pulse pressure, seasonal variation
  - Weight: 5%/10% milestone recognition, plateau detection, body composition divergence
  - Pulse: Fitness interpretation ladder, 80-100 bpm elevated-risk band, rate-pressure product
  - BMI: Age-adjusted DEGAM classification for 65+
  - Medication Compliance: Chronotherapy hints, mood-adherence risk prediction, 90-day tracking
  - General Status: Cross-domain synthesis with cardiovascular risk stratification
  - Mood: Bidirectional correlations with vitals and adherence
- **Enriched Feature Extraction**:
  - Sleep duration and activity steps (previously ignored)
  - Rate-Pressure Product (pulse × systolic BP, myocardial demand indicator)
  - Body composition divergence flag (weight stable + body fat rising)
  - Mood-adherence risk predictor
  - Seasonal BP variation (winter vs summer, requires >180 days data)
  - BP standard deviation (sdSys30/sdDia30) as variability risk marker
  - Pulse pressure (arterial stiffness marker)
  - 5 cross-metric Pearson correlations (weight↔BP, pulse↔BP, mood↔pulse, mood↔BP, mood↔weight)
  - 90-day averages and all-time statistics for all metrics
  - Historical comparison (current 7d vs previous 30d baseline)
- **New UI Components**:
  - `InsightStatusCard`: Compact per-metric status card with classification indicator and fade-in animation
  - `InsightAdvisorCard`: Premium structured card with findings, correlations, recommendations (ready for integration)
- **OAuth Routes**: `/api/auth/codex/authorize`, `/callback`, `/disconnect` for ChatGPT connection
- **Admin AI Settings**: `/api/admin/ai-settings` for global API key management

### Changed

- Insight prompts now use personal advisor tone ("dein Blutdruck") with positive-first pattern
- Reasoning scaffold in system prompt (What changed? → Why? → What to do?)
- Conditional correlation instructions (only mention when |r| > 0.4)
- InsightResult schema enriched with `insightType`, `primaryRecommendation`, `classificationLabel`
- BP target calculation now uses paired readings (both sys AND dia must be in range simultaneously)
- Medication streak tracking extended from 7-day to 30-day window
- CSP updated to allow `chatgpt.com` for OAuth flow

### Security

- Rate limiting on all OAuth and admin endpoints
- PKCE (S256) + state parameter for OAuth CSRF protection
- Encrypted token storage at rest (AES-256-GCM)
- Error messages truncated to prevent upstream response body leaks
- Admin key preview shows last 4 chars of decrypted key (not ciphertext prefix)
- `prefers-reduced-motion` support for insight card animations

### Removed

- `openaiKeyEncrypted` field from User model (replaced by provider abstraction)
- Direct OpenAI API calls from insight generators (now routed through provider)
- Legacy API key input in settings UI (replaced by ChatGPT connect button)

## [1.0.1] — Previous release
