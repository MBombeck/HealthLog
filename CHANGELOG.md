# Changelog

## [1.4.1] — 2026-05-08

### Security

- **moodLog integration no longer accepts internal-network URLs.** A
  user could previously save `http://169.254.169.254/` (cloud-metadata)
  or any RFC1918 address as their moodLog instance; the daily sync
  worker would then fetch from that target with the user's API key in
  the Authorization header. The credentials write path now refuses
  non-public hosts, the sync worker re-checks the URL at the actual
  fetch site (so legacy rows stored before the guard are also
  refused), and the fetch is now `redirect: "manual"` so a public
  host cannot 302 to an internal target with the bearer on the
  redirect hop.
- **Error reports never echo bearer tokens, Telegram bot tokens, or
  query-string secrets.** `WideEventBuilder.setError()` and the
  Glitchtip incident path now run every error message and stack
  trace through a central `redactSecrets()` filter that scrubs
  `Bearer …`, Telegram `bot<digits>:<token>` URLs, and `?secret=`,
  `?code=`, `?token=`, `?api_key=` query strings. The substitution
  is generic `[REDACTED]` so partial entropy is never revealed.

### Fixed — Citation accuracy

- **Blood-pressure classification now cites ESH 2023.** The dashboard
  tile, the doctor-report PDF, and the inline analytics comments
  used to label the band as "ESC/ESH 2018". The numbers haven't
  changed (the 2023 ESH update kept the 2018 thresholds), but the
  joint authoring did — ESC withdrew from the 2023 document, so the
  correct citation is "ESH 2023" alone.
- **Steps target source label is `Saint-Maurice JAMA 2020`** instead
  of `WHO`. Every other surface in the app (AI prompts, inline
  comments, drift tests) already enforced this attribution; the
  insights/targets surface was the last "WHO" label in the tree.
  WHO publishes physical-activity _time_, not a step quota.
- **Saint-Maurice "mortality plateau 8000–12000" attribution
  softened.** The original JAMA 2020 paper reports continued
  dose-response benefit (HR 0.49 at 8k, HR 0.35 at 12k) — not a
  plateau. The plateau-shaped finding belongs to Paluch 2022
  _Lancet Public Health_ (PMID 35247352), not Saint-Maurice. The
  inline comments and AI prompts now say "continued dose-response
  benefit through ~12,000 steps/day" instead.

### Added — CI safety nets

- **Postgres-backed integration test suite is now executable.** The
  testcontainers infrastructure shipped in 1.4.0; this release wires
  the per-test boilerplate through vitest's `globalSetup` so all
  four files share one container. `pnpm test:integration` runs ten
  tests (rate-limit race, idempotency replay-attack contract, GDPR
  Article-17 cascade delete, session create / read / expire) against
  a real Postgres in under four seconds. CI runs the suite on every
  PR.
- **Playwright + axe-core E2E foundation.** A new `pnpm e2e` runs
  five public-surface specs (version endpoint, proxy auth-redirect,
  login form autofill hints, DE/EN locale switch, axe-core
  accessibility gate) against the production build in CI. Authenticated
  flow specs (quick-entry, doctor-report, settings round-trip,
  test-buttons, onboarding) ride a follow-up release because they
  need a seeded test user; the foundation makes adding them a
  one-PR step.

### Changed — Admin internals

- **Admin page is now per-section components.** The status-card grid
  shipped in 1.4.0 sat on top of a 2,700-line monolith; that monolith
  is now 14 focused files in `src/components/admin/` with a 77-line
  `src/app/admin/page.tsx` shell that mounts them. Every section
  keeps the same DOM, ids, query keys, and i18n keys — no
  user-visible change.

### Fixed

- **Final ESLint error is gone.** The medications page's "API
  endpoint" dialog ran its initial-load fetch through a `useCallback`
  paired with `useEffect` and triggered the strict
  `react-hooks/set-state-in-effect` rule. Refactored to TanStack
  Query — same network calls, no effect, lint count is now zero on
  `main`.

### Documentation

- **Repo-internal docs synced for v1.4.** README adds the
  Multi-tenant ready and Test connection buttons feature blocks, the
  API reference table includes the eleven new v1.4 endpoints, and
  the model count is corrected to 26 (RefreshToken). AGENTS.md and
  CLAUDE.md reflect the per-route `/settings/[section]` layout and
  the per-section admin layout. `docs/api/openapi.yaml` documents
  the new endpoints (version, refresh, refresh/revoke,
  status-overview, backup/test, the five test-connection probes).
  `docs/migration/v1.3-to-v1.4.md` corrects the now-wrong "no
  migrations" claim and adds full env-var sections for the
  worker/web split, encryption-key versioning, and off-host backup
  target.

### Notes

- No database migration in 1.4.1.
- No environment-variable change required to upgrade.
- No API contract change — every route added in 1.4.0 is still
  there; no shapes or status codes flipped.
- The audit pass that drove this release identified five medium
  security items and three P0 performance items that warrant
  deeper architectural work; those are tracked in
  `docs/ops/v141-followup-issues.md` and ride a future release.

## [1.4.0] — 2026-05-08

### Added — Foundation, safer ranges, and a faster dashboard

- **UI guidelines, design tokens, and shared primitives.** A new
  `docs/ui-guidelines.md` is the single source of truth for spacing,
  typography, button hierarchy, dialog-vs-sheet decisions, accessibility
  baseline (WCAG 2.1 AA), and the autofill / honeypot pattern for
  health-data forms. Two new shadcn primitives — `<Skeleton>` and
  `<EmptyState>` — replace the previous mix of spinners and "No data"
  placeholder strings. Future v1.4.x components reference the doc; the
  primitives ship with screen-reader-aware semantics and respect
  `prefers-reduced-motion`.
- **`/api/version` public endpoint** exposing the build's version,
  optional Git SHA / build timestamp, license, and canonical links.
  Wires the future Settings → About surface and a thin "Check for
  updates" UX. Static-cached so the route adds zero DB load.
- **`src/lib/medical-citations.ts`** — single source of truth for
  cited medical guidelines (id, name, year, URL, caveat). Future
  medical surfaces import these constants instead of duplicating
  strings in code, prompts, and `messages/*.json`. A new drift-test
  asserts every entry has a non-empty URL + caveat and that the
  recurring "WHO ≥ N steps" hallucination cannot reappear as a constant.

### Fixed — Patient safety and citation accuracy

- **Diastolic blood-pressure orange band no longer reaches 60 mmHg.**
  With the default age-based targets (DBP 70–79), the lower orange
  wing was computed as `diaLow − 10 = 60`. A reading of 60 mmHg landed
  in "mildly low" yellow instead of red even though that level is the
  general-adult hypotension threshold and the J-curve risk floor in
  ESH 2023 for treated hypertensives. Orange floor is now clamped at
  65 mmHg, so 60 mmHg lands in red. The user-override path stays
  intact and remains audit-logged.
- **BP guideline citations consolidated on ESH 2023.** The codebase
  had a mix of "ESC/ESH 2018" (analytics) and "ESC/ESH 2023" (AI
  prompts). The 2023 hypertension document is ESH-only — ESC withdrew
  from the joint authoring — so neither label was correct. Every site
  now cites "ESH 2023" with the published source URL. Numbers
  unchanged.
- **"WHO ≥ 8 000 steps/day" hallucination fully removed.** WHO
  publishes activity _time_ (150–300 min/wk moderate), not a step
  quota. The v1.3.3 fix only landed in `effective-range.ts`; four AI
  prompt strings and the `getStepsRange()` helper carried the old
  wording forward. Saint-Maurice et al., JAMA 2020 (mortality plateau
  8 000–12 000) is now cited everywhere and the two surfaces agree on
  the band. Sleep target moves from "ESC" (no adult sleep guideline)
  to AASM 2015.
- **Body-fat ACE bands corrected and three-way drift resolved.** The
  classifier used `essential = 6 (M) / 14 (F)` as the floor — but
  that's actually ACE's _Athletes_ lower bound. Readings below were
  mislabelled "Essential" instead of "Below essential" (a danger
  band). Six-band classifier now mirrors the ACE table, and the three
  sites that had three different green-band numbers
  (`value-bands.ts`, `targets/route.ts`, `classifications.ts`) all
  derive from `getBodyFatTargetRange` (ACE fitness + acceptable bands).
- **Bedtime-glucose citation softened.** ADA Standards 2024 §6
  publishes pre-prandial 80–130 and post-prandial <180 — no published
  adult bedtime target. The 90–150 mg/dL band stays (reasonable adult
  overnight band) but the inline citation now states the absence
  explicitly and references ISPAD 2022 (pediatric) as the closest
  comparator.

### Fixed — Localisation reaches the notification path

- **Medication reminders now follow the user's locale.** Telegram,
  ntfy, and Web Push reminders previously read "Erinnerung", "Bald
  fällig", etc. regardless of the user's stored language. Templates
  for every phase (`green`/`yellow`/`orange`/`red`) and every keyboard
  button now resolve from `messages/{de,en}.json` per
  `med.user.locale`. Telegram callback IDs stay stable English
  identifiers so the dispatcher keeps matching across locale changes.
- **Dashboard greeting and streak label** are localised server-side.
  Previously hard-coded `"Hi, ${name}"` and `"Tage in Folge"` — both
  now i18n-key-resolved.
- **Mixed-locale Zod validation messages unified to English.** Two
  measurement-form messages and four admin-validation messages
  flipped between German and English depending on which schema fired.
  All consolidated on English (the app is English-first; the German
  UI maps field labels client-side).

### Fixed — Chart math edge cases

- **`summarize` and `trendSlope` use the same time anchor.** Averages
  snapped to `Date.now()`; slopes snapped to the latest point in the
  series. A stale series reported a trend even though the dashboard
  tile correctly hid the average. Both now anchor on `Date.now()`, so
  a stale series returns `null` consistently from every windowed stat.
- **`summarize([])` returns `null` for `min`/`max`/`mean`** instead
  of zeros that leaked into chart axes and AI feature bundles as
  fake readings.
- **`weeklyAverages` is Berlin-timezone aware.** A Sunday-evening
  Berlin reading bucketed into the next week on the UTC production
  container because `Date.getDay()` was system-local. ISO-Monday key
  now resolves via `Intl.DateTimeFormat({ timeZone: "Europe/Berlin" })`.
- **`pairByTimestamp` JSDoc** documents the greedy nearest-match
  heuristic and when a Hungarian-style match would matter (sparse
  health data is well below that bar).

### Fixed — Hidden friction

- **AI provider connection-test honours the unsaved selection.**
  Changing the AI provider in `/settings`, then clicking "Verbindung
  testen" without saving first, used to silently run the test against
  the stored provider — surfacing as a confusing OK / failure unrelated
  to what the user had on screen. Plaintext keys never persist; the
  existing SSRF guard, rate limit, and V3 error-leak shielding stay in
  place.
- **Health-data inputs no longer autofill the user's account
  password.** The base `<Input>` primitive defaults to
  `autoComplete="off"` plus the LastPass / 1Password ignore attributes
  whenever the caller doesn't pass a semantic value. Auth and profile
  forms continue to autofill normally because they pass an explicit
  `autoComplete` (`"username"`, `"email"`, `"current-password"`,
  `"new-password"`).
- **Step-range target aligned across two callsites.**
  `getStepsRange()` returned `{7000, 10000}` while
  `effective-range.ts` returned `{8000, 15000}`; two surfaces showed
  different "green" bands to the same user. Both now use
  `{8000, 15000}`, anchored on Saint-Maurice 2020.

### Performance

- **Two more N+1 queries closed.** `extractFeatures` (used by every
  AI-insight route) issued one `prisma.medicationIntakeEvent.findMany`
  per active medication; replaced with a single batched query and an
  in-memory group. `/api/insights/targets` issued one `findFirst` per
  measurement type; replaced with a single `distinct: ["type"]` query.
  Same shape as the v1.3.0 fix to `/api/insights/comprehensive`.

### Changed — Dashboard

- **Tile strip is always one row.** Replaces the wrapping
  `grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5` layout
  with a `flex snap-x snap-mandatory overflow-x-auto` strip. When the
  user enables more tiles than fit the viewport, the strip
  horizontal-scrolls instead of wrapping; the user trims the set in
  Settings → Dashboard Layout.

### Added — Settings, integrations, and operations

- **Settings page now lives at `/settings/[section]`.** Eight focused
  routes (`account`, `integrations`, `notifications`, `dashboard`,
  `ai`, `api`, `advanced`, `about`) replace the single 3,000-line page.
  Existing `/settings#anchor` links 308-redirect; the side-bar, in-app
  deep links, and the AI / Withings / Codex callbacks all follow the
  new structure.
- **About page** lists the running version, build SHA, license,
  repository link, CHANGELOG link, docs link, and a "Check for
  updates" button that pings the public GitHub releases API. Backed by
  the `/api/version` endpoint shipped earlier in 1.4.0.
- **Admin console** is built around a status-first card grid (Users,
  Integrations, Monitoring, Backups, Maintenance, Audit Log) with each
  area in a focused panel beneath. Per-section extraction of the old
  inline panels is tracked for v1.4.1 — the v1.4.0 admin page already
  routes through the new aggregator endpoint and the status-card
  grid.
- **Five new "Test connection" buttons in Settings.** Withings,
  moodLog, Web Push, Glitchtip, and Umami now ship with one-click
  connection probes — same pattern as the existing AI / Telegram /
  ntfy tests, with per-button rate limit, sanitised error reporting,
  redirect-follow SSRF guard, and an `errorCode` in the response
  envelope so the UI can localise the message.
- **AI insights can reference any of your charts inline.** When a
  finding centres on a single metric (e.g. systolic blood pressure),
  the corresponding chart renders directly under the explanation.
  Server-side allow-list — only the allowed metric tokens render; any
  other model emission drops silently.
- **Off-host backup target.** Daily encrypted JSON dumps to any
  S3-compatible bucket. Worker-side IAM grant is intentionally
  PutObject + GetObject only — retention is the bucket's
  lifecycle-rule job, so a compromised worker cannot wipe the backup
  history. Restore script + step-by-step doc shipped under
  `docs/ops/backup-restore.md`, and an admin "Backup target" test
  button validates the configuration.
- **Encryption-key versioning.** Rotate the at-rest encryption key
  without downtime via `pnpm tsx scripts/rotate-encryption-key.ts <id>`.
  Existing data keeps decrypting under its original key while the new
  one is rolled out. Walk-through + rollback notes in
  `docs/ops/encryption-key-rotation.md`.
- **Worker / web split.** Optional
  `HEALTHLOG_PROCESS_TYPE=web|worker|all` (default `all` for the
  single-container setup) lets you scale background jobs and HTTP
  traffic independently. The proxy refuses HTTP traffic with a 503 +
  `X-HealthLog-Process-Type: worker` header in worker mode so a
  misrouted request fails loudly instead of a silent half-served
  response.
- **Native API clients now get short-lived 24-hour access tokens with
  refresh-token rotation.** The browser keeps the existing 90-day
  Bearer. Reuse-detection (presenting a refresh token a second time)
  revokes every refresh token for the user — the small cost of a
  forced re-login on the legitimate device buys defense-in-depth
  against an undetected stolen-token replay.
- **Critical-path coverage on Telegram / Withings / moodLog /
  Glitchtip webhook handlers + the four admin routes lifted to ≥80%
  line coverage,** plus `src/lib/auth/audit.ts`. ~+100 new tests.

### Fixed — Operational hardening from the v1.4 review pass

- **Container time zone is correct.** Alpine images ship without
  `tzdata`; the daily backup cron `30 2 * * *` Europe/Berlin was
  silently falling back to UTC. The runner stage now installs
  `tzdata` and exports `TZ=Europe/Berlin` so schedules fire at the
  documented local time.
- **Compose healthcheck uses `wget --spider /api/version`** — `/api/version`
  is now in the proxy's public-paths allowlist, so the healthcheck no
  longer 302-redirects through the auth gate (which was accepting the
  login page as a 200 success).
- **Idempotency replay-cache no longer caches refresh tokens.** The
  guard already blocked the `hlk_` access-token prefix; the new
  `hlr_` refresh tokens are blocked too.
- **Logout-on-device revokes the paired access token.** Calling
  `/api/auth/refresh` with `revoke: true` now flips both the refresh
  row and the matching `ApiToken` row to revoked, so a leaked access
  token cannot outlive its refresh-token sibling.
- **`users.locale` migration drift backfilled.** The column had been
  on `schema.prisma` since the v1.3 locale-aware reminder work but
  never landed in the migration history (it must have been applied
  via `prisma db push` to dev/prod). Any environment built strictly
  from `prisma/migrations/` (CI testcontainers, brand-new self-host
  installs) is now consistent. Migration is `ADD COLUMN IF NOT
EXISTS`, so it's a clean add on a fresh database and a safe no-op
  against any environment that was already kept in sync.

### Notes

- Largely additive release. Existing API contracts (response
  envelopes, OpenAPI 3.1 spec) are unchanged. New endpoints surface
  optional fields; no breaking changes.
- New migration `0025_refresh_tokens` adds the rotating refresh-token
  table; new migration `0025_user_locale_drift_fix` backfills the
  schema-vs-migrations drift on `users.locale`. Both are
  forward-compatible — `IF NOT EXISTS` guards make them idempotent on
  any environment already pushed-to.
- Operators of the off-host backup feature must configure a bucket
  lifecycle policy for retention. The worker has no DeleteObject
  grant by design.
- Native API clients (iOS, n8n, Health Connect) need to update their
  login flow: native logins now return both a 24-hour access token
  and a refresh token. The browser flow is unchanged.
- **Tracked for v1.4.1:** per-section admin panel extraction (the
  status-card grid + aggregator already ship in 1.4.0; the inner
  per-section file split is structural cleanup), the Postgres-backed
  integration test suite (testcontainers infrastructure ships in this
  release; the four integration tests themselves need a follow-up
  pass against the merged schema), and Playwright E2E + axe-core CI
  gates.

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
