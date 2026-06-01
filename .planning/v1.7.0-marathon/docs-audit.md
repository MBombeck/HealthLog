# Docs + README audit vs. release/v1.7.0 (2026-05-31)

Read-only audit. Three sources cross-referenced:

- **Docs site** `/Users/marc/Projects/healthlog-docs` — branch **`main`**, clean working
  tree. HEAD `6402505 docs: accuracy pass, explanatory links, and current version`.
  (Not on an in-progress branch; the prior audit's `docs/apns-pinning-selfhost` work has
  already merged — TLS, cert-pinning, iOS page, sitemap/robots, OG meta all present.)
- **README** `/Users/marc/Projects/HealthLog/README.md`.
- **Ground truth** = code on `release/v1.7.0` (`424d12de chore(release): v1.7.0`),
  `CHANGELOG.md` (through v1.7.0), `docs/api/openapi.yaml` (`version: 1.7.0`, all v1.7
  routes present).

Key context: **the OpenAPI spec is fully current to 1.7.0** (health-record export,
`/api/sync/changes`, `/api/sync/state`, `/api/dashboard/snapshot`, `nextDueAt`, schedule
fields all documented and CI-gated). The drift is entirely in the **hand-written MDX docs
pages** and the **README prose**, not in the machine contract.

Classification legend: **HALLUCINATED** (described, does not exist) / **STALE**
(old version / removed / wrong) / **MISSING v1.7.0** (shipped, absent from docs) /
**POORLY EXPLAINED** (needs an explainer link or diagram) / **STRUCTURE/SETUP**.

---

# SOURCE A — DOCS SITE (`healthlog-docs`, branch `main`)

## A. HALLUCINATED (highest priority)

### A-H1 — `/api/auth/me` "Gravatar URL" (the headline lie)
- **Doc:** `src/content/docs/api/authentication.mdx:91` — *"Returns the current user
  including their Gravatar URL."*
- **Code evidence:** `src/app/api/auth/me/route.ts:46-53` returns a self-hosted
  `avatarUrl` (relative `/api/user/avatar/...?v=<ms>`), explicitly *"Replaces the Gravatar
  leak"*. Gravatar was retired in v1.5.5 (`src/lib/gravatar.ts` deleted; only stale
  matches now are in `proxy.ts` CSP comment + generated Prisma). The route also returns
  `unitPreference`, `glucoseUnit`, `disableCoach`, and the v1.7.0 `fullName` /
  `insurerName` / `insuranceNumber` patient-identity fields — none documented.
- **Why it matters:** This states the *opposite* of a privacy win (Automattic no longer
  sees the email hash). It is the single most wrong line in the docs.
- **Fix:** Rewrite to *"Returns the current user profile, including a self-hosted
  `avatarUrl` (served from your own database — no third-party Gravatar request), the
  display-unit preference, and the optional patient-identity fields used by the
  health-record export."* Add the full response field list, mirroring the OpenAPI
  `MeResponse` schema.

### A-H2 — `configuration/admin-settings.mdx:113` "the email Gravatar"
- **Doc:** Users panel *"lists every account … with the role badge, the email Gravatar,
  the registration date …"*
- **Code evidence:** same as A-H1 — Gravatar removed v1.5.5; admin user list renders the
  self-hosted avatar / initials fallback.
- **Fix:** Change "the email Gravatar" → "the profile avatar (self-hosted, or
  username-initials fallback)".

### A-H3 — Medication schedule model is the pre-v1.5 flat shape
- **Doc:** `src/content/docs/features/medications.mdx:23-39` documents `MedicationSchedule`
  as only `{ windowStart, windowEnd, label, daysOfWeek, dose }` and says multi-dose =
  "create multiple schedules with different days". No mention of any recurrence beyond
  comma-separated weekday numbers.
- **Code evidence:** The canonical recurrence engine supports `rrule` (RFC-5545),
  `rollingIntervalDays`, `intervalWeeks`, one-shot (`oneShot`), and now (v1.7.0)
  `asNeeded` (PRN) + cyclic (`cycleWeeksOn`/`cycleWeeksOff`/`cycleAnchor`). CHANGELOG
  v1.5–v1.7 + migrations `0091`/`0092`. Also `deliveryForm` (ORAL/INJECTION/OTHER, mig
  `0088`) and injection-site rotation (v1.6.0).
- **Classification:** borderline HALLUCINATED — the doc describes a schedule shape that no
  longer reflects how the feature works; a reader building against it will be wrong.
- **Fix:** Rewrite the Schedules section around the recurrence engine: weekly / bi-weekly
  (`intervalWeeks`) / rolling (`rollingIntervalDays`) / RRULE / one-time / PRN / cyclic,
  plus route-of-administration and injection sites. Link RRULE → RFC 5545 (see C-2).

## B. STALE

### A-S1 — Whole feature-doc set frozen at v1.4.x
- **Docs:** `features/dashboard-customization.mdx`, `features/health-metrics.mdx`,
  `features/achievements-hidden.mdx`, `configuration/admin-settings.mdx`,
  `settings/ai-providers.mdx`, `insights/how-it-works.mdx` cite v1.4.5–v1.4.19
  throughout; `ai-providers.mdx:3,14` frames everything as "the v1.4.16 layout";
  `how-it-works.mdx:94` says per-user learning is *"planned for v1.4.17"*.
- **Evidence:** app is on 1.7.0; these surfaces changed materially through v1.5–v1.7.
- **Fix:** A version-string sweep. The descriptions don't need a version at all — drop the
  "(v1.4.x+)" tags or replace with the current behaviour. At minimum stop describing the
  AI panel as "v1.4.16's new layout".

### A-S2 — Pinned image tags disagree across pages
- **Docs:** `self-hosting/docker.mdx:55` pins `:1.6.0`; `self-hosting/updates.mdx:63,83`
  show `:1.4.34` / `:1.4.25`; `self-hosting/scaling.mdx:25,31` show `:1.4.30.1`;
  `self-hosting/coolify.mdx:55-62` use `:1.4.36`.
- **Evidence:** current release tag `1.7.0`.
- **Fix:** Bump the *example* tags to `1.7.0` (or use a neutral `<version>` placeholder)
  so a copy-paste doesn't pull a year-old image. Keep historical tags only inside the
  Coolify "this bug happened on v1.4.33→35" anecdote where the version is the point.

### A-S3 — `self-hosting/docker.mdx:17` "native arm64 image planned for v1.5"
- **Doc:** *"`linux/amd64` (native arm64 image planned for v1.5; build from source on
  arm64 hosts in the meantime)"*.
- **Evidence:** CLAUDE.md + README state GHCR ships **multi-arch `amd64` + `arm64`** today.
- **Fix:** Change to "multi-arch `linux/amd64` + `linux/arm64`" and drop the "planned"
  clause.

### A-S4 — `export-import.mdx` automatic-backup schedule contradicts itself
- **Doc:** line 89 says *"Sundays at 03:00"* (Europe/Berlin per `scaling.mdx:64`), but the
  code block at line 95-99 says *"Sunday 03:00 UTC"*.
- **Fix:** Pick one (Berlin per `scaling.mdx` + CHANGELOG) and make both lines agree.

### A-S5 — `export-import.mdx` import example uses a mood scale that may be wrong
- **Doc:** `export-import.mdx:67` import example shows `"mood": 7`. README + mood docs
  describe a **5-point** scale.
- **Evidence:** verify against `mood` Zod schema; if 1–5, `7` is an invalid example.
- **Fix:** Confirm the range and correct the example value; this is a copy-paste hazard.

## C. MISSING v1.7.0 (shipped, absent from docs)

The v1.7.0 release notes list these; **none** appear in any MDX content page (only oblique
Wikipedia-linked mentions of "FHIR" exist on `ios/ios-app.mdx`):

### A-M1 — Health-record export (PDF + HL7 FHIR R4 bundle) — **biggest gap**
- **Belongs in:** `features/export-import.mdx` (add a "Health-record export" section) and a
  new `api/health-record.mdx` (or extend `api/external-ingest.mdx`).
- **Evidence:** `POST /api/export/health-record` — `src/app/api/export/health-record/`;
  OpenAPI `openapi.yaml:41-162` (`format: pdf | fhir | package`, `application/fhir+json`
  HL7 FHIR R4 document Bundle: LOINC-coded `Observation`s, BP panel, `MedicationStatement`,
  `DiagnosticReport`; `export:<userId>` 10/h bucket; AI summary opt-in, flagged
  not-clinically-validated). Patient identity (`fullName`/`insurerName`/`insuranceNumber`,
  KVNR mod-10 validated + encrypted) feeds the FHIR `Patient`.
- **Fix:** New section documenting the three formats, the per-domain section selection,
  the date range, the opt-in AI summary disclaimer, and the patient-identity prerequisite.

### A-M2 — PRN + cyclic schedules, `nextDueAt`, cadence-canonical compliance
- **Belongs in:** `features/medications.mdx` (rewrite per A-H3) + `api/medications.mdx`.
- **Evidence:** CHANGELOG v1.7.0 Added/Changed; OpenAPI `nextDueAt` at lines 3588/3748/5742;
  compliance bucket gains `due`/`expectedCount`.
- **Fix:** Document `asNeeded`, `cycleWeeksOn/Off/Anchor`, the read-only `nextDueAt`, and
  that compliance now counts against the real cadence (weekly/bi-weekly/rolling/RRULE/PRN)
  not a daily denominator. The current 7d/30d/90d compliance section reads as if everything
  is daily.

### A-M3 — Full HealthKit metric coverage + display-unit preference
- **Belongs in:** `features/health-metrics.mdx` + `api/measurements.mdx` (the type table at
  `measurements.mdx:9-21` lists only 11 types).
- **Evidence:** v1.7.0 adds charts for flights climbed, audio exposure, walking speed/step
  length/asymmetry/double-support, respiratory rate, body-composition family, mobility,
  daylight, etc. (v1.5.5 already added RESTING_HEART_RATE/HRV/VO2_MAX/walking metrics).
  Walking speed renders km/h, distance km; **canonical storage stays SI**. New
  metric/imperial toggle (Settings → Display, mig `0094`), surfaced as `unitPreference` on
  `/api/auth/me`.
- **Fix:** Expand the measurements type table to the full mapped set; add a "Units &
  display preference" note explaining SI-canonical storage + render-time transform.

### A-M4 — Unified dashboard snapshot + nightly insight pre-generation
- **Belongs in:** `features/dashboard-customization.mdx` and/or `architecture/background-jobs.mdx`.
- **Evidence:** `GET /api/dashboard/snapshot` (OpenAPI `:1855`); nightly budget-gated
  pg-boss job warms the comprehensive insight + briefing so `/insights` is a cache read.
- **Fix:** Add a short "First-paint snapshot & nightly pre-generation" note — explains why
  the dashboard now paints together and why `/insights` no longer blocks on the model.

### A-M5 — Offline / sync delta feed
- **Belongs in:** `features/pwa-offline.mdx` and `api/native-clients.mdx`.
- **Evidence:** `GET /api/sync/changes` (opaque-cursor delta feed + measurement tombstones,
  OpenAPI `:291`) and `GET /api/sync/state` (`:273`); measurement deletes now soft-delete
  (tombstone) with refresh-token-keyed retention; `errorCode` on refresh distinguishes
  revoked-family vs transient. Migration `0096`.
- **Fix:** Document the delta-feed contract for native/offline clients and the soft-delete
  tombstone semantics.

### A-M6 — Coach data clustering
- **Belongs in:** `features/ai-insights.mdx`.
- **Evidence:** v1.7.0 — Coach accepts chosen clusters (cardiovascular, body comp,
  activity, workouts, sleep, mood, glucose, medication, mobility, environment) with a soft
  budget cap that degrades lowest-signal clusters first.
- **Fix:** Add a "What data the Coach sees" subsection listing the clusters and the toggle.

### A-M7 — Profile identity fields on Account
- **Belongs in:** an Account/Settings page (none currently documents the Account section).
- **Evidence:** v1.7.0 full name / insurer / insurance number; v1.6.0 profile-photo upload.
- **Fix:** Document the Account identity card + avatar upload (ties to A-H1/A-H2 avatar fix).

## D. POORLY EXPLAINED (add an authoritative explainer link / diagram)

Clinical & infra jargon a self-hoster meets cold. `features/health-metrics.mdx` is still
the most term-dense page and (per prior audit P2) carries few outbound references. Concrete
links to add the first time each term appears:

| Concept | Where | Authoritative link to add |
|---|---|---|
| FHIR R4 | export-import / health-record page (A-M1) | https://hl7.org/fhir/R4/ |
| LOINC | health-record + measurements | https://loinc.org/ |
| UCUM (units) | measurements (unit transforms) | https://ucum.org/ |
| RRULE / RFC 5545 | medications (A-H3) | https://datatracker.ietf.org/doc/html/rfc5545 |
| AES-256-GCM | `security/overview.mdx`, installation | https://en.wikipedia.org/wiki/Galois/Counter_Mode |
| Passkeys / WebAuthn | already linked on ios-app; add on `api/authentication.mdx` | https://www.w3.org/TR/webauthn-2/ |
| AGPL-3.0 | introduction / footer | https://www.gnu.org/licenses/agpl-3.0.en.html |
| APNs | notifications / ios-app (linked) — add on notifications | https://developer.apple.com/documentation/usernotifications |
| Argon2id | `security/overview.mdx` | https://en.wikipedia.org/wiki/Argon2 |
| BYOK / local LLM (Ollama) | `settings/ai-providers.mdx` | https://ollama.com/ |
| ESH 2023 / ADA 2024 / NICE NG115 | health-metrics (named, unlinked) | ESH: https://www.eshonline.org/ · ADA *Standards of Care*: https://diabetesjournals.org/care · NICE NG115: https://www.nice.org.uk/guidance/ng115 |
| Postgres rollups (DAY/WEEK/MONTH) | `architecture/database.mdx` | concept needs a one-paragraph explainer + the existing rollup diagram if any |

**Diagram opportunity:** a "health-record export → FHIR Bundle" diagram (Patient +
Observation + BP panel + MedicationStatement + DiagnosticReport) on the new A-M1 page would
make the FHIR story legible. The source-priority SVG is already reused well on apple-health.

---

# SOURCE B — README (`HealthLog/README.md`)

The README is the strongest of the three surfaces and is largely current. Findings:

## B. STALE

### B-S1 — "Current line: v1.5" everywhere; no v1.7 awareness
- **Doc:** README `:41` *"Current line: v1.5"*; `:156` Tech-Stack "Native client … v1.5";
  `:488` Roadmap "**v1.5** (current)" row mentions only iOS.
- **Evidence:** app is on 1.7.0; v1.6 (medication editor + route-of-administration) and
  v1.7 (health-record export, flexible schedules, full HealthKit, dashboard snapshot)
  shipped.
- **Fix:** Update the status line to v1.7 line; add a Roadmap row (or fold into v1.5) noting
  v1.6 medication editor / route-of-administration and v1.7 health-record export +
  PRN/cyclic + full HealthKit + first-paint snapshot.

### B-S2 — Key-Features list omits all v1.7.0 features
- **Doc:** README "Key Features" (`:71-105`) and the "How it compares" table (`:57-67`).
- **Evidence:** No bullet for **health-record / FHIR R4 export**, **PRN/cyclic schedules**,
  **display-unit (metric/imperial) preference**, **dashboard first-paint snapshot**, or the
  **sync delta feed**. The Medications bullet (`:81`) covers windows + intervalWeeks but not
  PRN/cyclic or route-of-administration. The Doctor-Report bullet (`:89`) is PDF-only.
- **Fix:** Add a "Health-record export (PDF + FHIR R4)" bullet; extend Medications to
  PRN/cyclic + injection route; add a units-preference note; optionally a "How it compares"
  row "FHIR R4 export — Yes".

### B-S3 — Quick Start vs. `.env` filename mismatch (minor)
- **Doc:** README `:116` `cp .env.example .env` and `:444` Local Dev also `.env.example`.
- **Evidence:** repo ships `.env.production.example` (the one `pnpm check-env` validates);
  confirm `.env.example` actually exists. If only `.env.production.example` exists, the
  copy command is wrong.
- **Fix:** Verify the example filename and align (this also affects docs installation.mdx,
  see B/Setup below).

## A. HALLUCINATED — none material
README's API tables were the prior audit's P1; spot-check shows they're now accurate:
`GET /api/auth/me` is described as *"Current user profile + avatar URL"* (`:326`, correct,
NOT Gravatar), and the avatar upload/delete rows (`:329-330`), Codex device-OAuth, and
`/api/auth/refresh` are present. The OpenAPI-locked subset is the source of truth and the
README agrees with it. (The v1.7 routes `/api/export/health-record`, `/api/sync/changes`,
`/api/dashboard/snapshot` are absent from the README tables — classify as **MISSING v1.7**
not hallucinated; add them to the relevant `<details>` blocks.)

## C. MISSING v1.7.0
- **B-M1:** README API tables don't list `POST /api/export/health-record`,
  `GET /api/sync/changes`, `GET /api/sync/state`, `GET /api/dashboard/snapshot`,
  `PATCH /api/auth/me/unit-preference`. Add to the "Health Data" / "Public + additions"
  `<details>` blocks.

## D. POORLY EXPLAINED
README already does well (links Spezi, TestFlight, etc.). Light opportunity: first mention
of **AES-256-GCM** (`:165`), **AGPL-3.0** (`:39`), and **APNs** (`:95`) could carry the same
authoritative links listed in D above, but README convention is sparse-linking — low
priority. FHIR/LOINC appear only in the iOS section (`:516,524`) without links.

## STRUCTURE/SETUP (README)
- README Quick Start (`:113-135`) is correct and matches `.env.production.example` required
  vars (`POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `API_TOKEN_HMAC_KEY`). It does **not**
  generate a `SESSION_SECRET` — which is correct (see Setup finding below; the docs site is
  wrong, not the README). GeoLite2 + APNs `.p8` setup is not in the README (acceptable —
  they live in `docs/ops/` and are operator-advanced).

---

# CROSS-CUTTING — STRUCTURE / SETUP

### S-1 — `installation.mdx` generates a non-existent `SESSION_SECRET` (HALLUCINATED setup step)
- **Doc:** `getting-started/installation.mdx:30` —
  `echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env`.
- **Code evidence:** `SESSION_SECRET` is referenced **zero** times anywhere in `src/`,
  `scripts/`, `docker-compose.yml`, or `.env.production.example`. Sessions are
  Postgres-backed (`src/lib/auth/session.ts`); there is no session-secret env var. The
  README Quick Start correctly omits it.
- **Impact:** harmless but misleading — tells self-hosters to mint and (presumably) wire a
  secret the app never reads, and implies a stateless-session model the app doesn't use.
- **Fix:** Delete the `SESSION_SECRET` line from `installation.mdx`. Match the README's
  three-secret set exactly.

### S-2 — `.env` filename consistency across README + docs
- README uses `.env.example`; verify the repo's actual example file
  (`.env.production.example` is the CI-validated one). Align README, `installation.mdx`,
  and `quick-start.mdx` on whatever file actually ships.

### S-3 — Encryption-key rotation / `ENCRYPTION_KEYS` map not explained on docs install page
- `installation.mdx:36` mentions only the single legacy `ENCRYPTION_KEY` and warns it's
  unrecoverable if lost — but never points at the modern `ENCRYPTION_KEYS` map +
  `ENCRYPTION_ACTIVE_KEY_ID` + the rotation CLI (README `:166` covers this well; docs
  should link `docs/ops/encryption-key-rotation.md`). POORLY EXPLAINED for operators.

### S-4 — iOS integration is well covered
- `ios/ios-app.mdx` is current and accurate (TestFlight, HealthKit two-way sync, pairing,
  passkey, on-device Coach, doctor export, troubleshooting, cert-pinning). No findings —
  this fully closes the prior audit's iOS P1s.

---

# PRIOR AUDIT (`site-audit-2026-05-29`) — status of its P1s/P2s

| Prior finding | Status |
|---|---|
| Docs: no `@astrojs/sitemap` / sitemap.xml (P1) | **CLOSED** — `b7bb708 docs(seo): add sitemap, robots.txt…`. |
| Docs: no dedicated iOS page (P1) | **CLOSED** — `e534b93 docs(ios): add a dedicated iOS app page`; `ios/ios-app.mdx` present + linked from intro. |
| Docs: external explanatory links on clinical pages (P2) | **PARTIAL** — ios-app.mdx links liberally; `health-metrics.mdx` still sparse (see D). |
| Docs: intro iOS bullet + achievement count (P2) | **CLOSED** — intro now has an iOS bullet (`:25`) and says "59 … (six hidden)". 59 verified against `achievements.test.ts:88` (`toHaveLength(59)`); hidden 5–8 (`:107-108`). |
| Docs: per-page OG/Twitter (P3) | **CLOSED** — `b7bb708` adds default OG/Twitter meta. |
| README: `GET /api/auth/me` "Gravatar" drift (P1) | **CLOSED in README** (`:326` now "avatar URL"), but the **same lie migrated/persists in the DOCS site** — `authentication.mdx:91` + `admin-settings.mdx:113` still say Gravatar (A-H1, A-H2). The prior audit only checked the README. |
| README: avatar/Gravatar privacy bullet (P2) | **OPEN** — README Security section still has no "self-hosted avatars / no Gravatar email-hash leak" bullet. |
| README: achievement count "30+" vs "59" (P2) | **CLOSED** — README now says "59 persistent achievements" (`:99`); the "30+" the prior audit cited is gone. |
| README: Node 20 → 22 (P2) | **OPEN** — README `:442` still says "Node.js 20+"; CLAUDE pins Node 22 (Alpine). |
| README: roadmap stale (P3) | **OPEN + worse** — now stale at v1.5 while app is v1.7 (B-S1). |
| Landing repo P1s/P2s | **out of scope** — this audit did not open `healthlog-landing`. The landing JSON-LD `softwareVersion 1.4.32` and iOS-section gaps from the prior audit should be re-verified separately. |

---

# Fix-priority rollup

1. **A-H1 / A-H2** — kill the Gravatar lie in `authentication.mdx:91` + `admin-settings.mdx:113`.
2. **S-1** — delete the phantom `SESSION_SECRET` from `installation.mdx:30`.
3. **A-H3 / A-M2** — rewrite `medications.mdx` schedule model (RRULE/rolling/intervalWeeks/
   one-shot/PRN/cyclic + route-of-administration) + cadence-canonical compliance.
4. **A-M1** — add the health-record (PDF + FHIR R4) export to `export-import.mdx` + API docs.
5. **A-M3** — full HealthKit metric table + units-preference on `measurements.mdx`/`health-metrics.mdx`.
6. **A-S1 / A-S2 / A-S3** — version-string + pinned-tag + arm64 sweep across docs.
7. **B-S1 / B-S2 / B-M1** — README v1.7 status, feature bullets, API rows.
8. **D** — explanatory links (FHIR/LOINC/UCUM/RRULE/AES-GCM/WebAuthn/AGPL/APNs) + a FHIR-bundle diagram.
9. Cleanups: A-S4 backup schedule UTC↔Berlin, A-S5 mood scale example, B-S3/S-2 `.env` filename, S-3 key-rotation link.
