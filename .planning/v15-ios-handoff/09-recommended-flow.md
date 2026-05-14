---
file: 09-recommended-flow.md
purpose: The iOS-side workflow recipe — first-time setup, contract-diff loop, parallel-dispatch discipline, pre-release Quality Gate checklist, mock-vs-live test strategy, CI surfaces, and the iOS-only gotchas that the server doesn't see.
when_to_read: Day 1 of iOS work. Re-read before every PR that touches a server-bound contract, before every parallel-dispatch session, and before tagging any v1.5.x release.
prerequisites: 00-philosophy.md, 01-repo-tour.md, 03-api-contracts.md, 08-locked-contracts.md
estimated_tokens: ~6000
version_anchor: v1.4.25 / sha 49f71c92
---

## TL;DR

The iOS app is a thin client of a strict-Zod server, so the day-to-day workflow centres on three loops: a contract-diff loop that catches drift before it lands, a parallel-dispatch loop that lets multiple iOS sub-agents work in touch-disjoint slots without merge pain, and a Quality Gate loop that runs eight reviewers in parallel against `develop` before the release-merge to `main`. Mocks belong in unit tests, testcontainers in integration tests, and a staging Coolify instance in e2e. Everything else here is the why, the recipes, and the gotchas.

## Decision tree — what to do now

| Situation | First action |
| --- | --- |
| Cold-start, never run the dev server | § 1 First-time setup |
| Touching anything server-bound (DTO, endpoint URL, query params) | § 2 Contract-diff loop |
| Spawning more than one iOS sub-agent in parallel | § 3 Touch-disjoint discipline |
| Tagging a v1.5.x release | § 4 Marathon-pattern handoff + § 5 Quality Gate |
| Writing a new test | § 6 Mock vs live |
| Looking at red CI on a PR | § 7 CI workflow + § 8 iOS-only gotchas |

---

## § 1 — First-time setup

### 1.1 Clone + bootstrap

```bash
# from a fresh shell
git clone git@github.com:MarcBombeck/HealthLog.git
cd HealthLog
git checkout develop                    # daily work goes here, never on main
nvm use 20                              # Node 20+ — required by Next.js 16
corepack enable                         # pnpm 10.31.0 ships via Corepack
pnpm install
pnpm db:generate                        # regenerate Prisma client
```

### 1.2 Postgres + the dev server

```bash
docker compose up -d postgres           # Postgres 16 on 5432
cp .env.example .env.local              # then edit DATABASE_URL + SESSION_SECRET
pnpm db:migrate:deploy                  # apply migrations 0001..0060
pnpm dev                                # Next.js dev server on :3000 (Turbopack)
```

Health-check the boot:

```bash
curl http://localhost:3000/api/health
# expect: {"data":{"status":"ok","worker":"running",...},"error":null}
```

### 1.3 Issue an API token for the iOS Simulator

The iOS app uses Bearer auth. The fastest way to a working iOS build:

```bash
# 1. Register a dev user (creates the cookie session)
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"ios-dev@example.com","username":"ios-dev","password":"correct-horse-battery-staple"}' \
  -c cookies.txt

# 2. Mint a wildcard-scope token (web Settings → API tokens does the same)
curl -X POST http://localhost:3000/api/tokens \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"name":"iOS Simulator dev","permissions":["*"],"expiresInDays":365}'
# → returns { data: { token: "hlk_..." } }
```

Drop the `hlk_*` value into the iOS Simulator app's Settings → API base URL + token. Default API base for the Simulator is `http://localhost:3000` — the iOS app's network layer reads it from `UserDefaults` so multi-host operators (self-hosters) can point at their own Coolify instance.

### 1.4 Apple Health permissions in the Simulator

The iOS Simulator **cannot read Apple Health data** — HealthKit on Simulator is a stubbed framework. Two options:

| Need | Path |
| --- | --- |
| Manual ad-hoc data | Tap the manual-entry sheet in the iOS app; it round-trips through `POST /api/measurements` (single) |
| Realistic HealthKit data shapes | Test on a physical iPhone with seeded HealthKit data, OR seed Postgres directly with `POST /api/measurements/batch` against the seeded fixtures |

For batch-shape testing, the canonical fixture lives in `tests/integration/__fixtures__/apple-health-batch.json`. Replay it with:

```bash
curl -X POST http://localhost:3000/api/measurements/batch \
  -H "Authorization: Bearer $HLK_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Client-Type: native" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data-binary @tests/integration/__fixtures__/apple-health-batch.json
```

### 1.5 STOP HERE if…

| If you only need… | …skip to… |
| --- | --- |
| To call ONE endpoint and verify the wire shape | `03-api-contracts.md` § matching route |
| To wire login + refresh in Swift | `05-auth-flows.md` § 2 |
| To debug a 422 from a batch | `08-locked-contracts.md` § 2 |

---

## § 2 — The contract-diff loop

Every iOS PR that touches an endpoint, a DTO, a query string, or an enum value MUST verify the contract before merge. Drift hides until prod.

### 2.1 The 4-step loop

```
1. git fetch origin && git rebase origin/develop  # absorb latest server changes
2. pnpm openapi:check                              # diff Zod registry vs committed YAML
3. (if 2 fails) pnpm openapi:generate              # regenerate the YAML, commit if intentional
4. Regenerate iOS Swift codegen from docs/api/openapi.yaml
```

### 2.2 What `openapi:check` actually does

```typescript
// from scripts/check-openapi.ts:6
// Hard-fails on drift since v1.4.25 — the Zod registry is the
// source of truth for the public API contract that the v1.5 iOS
// Swift codegen consumes.
```

Two outcomes:

| Result | What happened | Action |
| --- | --- | --- |
| Exit 0 | Zod registry == committed YAML | Safe; proceed |
| Exit 1 with diff | A server change drifted the Zod schemas without regenerating | Run `pnpm openapi:generate`, review the diff, commit if the change is intentional. If the diff includes a breaking shape change, raise it before merging |

### 2.3 Swift codegen recipe

```bash
# On the iOS side, mirror the server YAML into Swift
swift run swift-openapi-generator generate \
  --output-directory Sources/HealthLogAPI/Generated \
  --config openapi-generator-config.yaml \
  ../HealthLog/docs/api/openapi.yaml
```

Codegen-driven DTOs replace hand-written `Codable` structs. If a field that the iOS UI relies on disappeared from the regenerated source, the build breaks — exactly the failure mode you want.

### 2.4 What to do when the diff is intentional

```
1. Open the server PR that introduced the drift.
2. Confirm the change is additive (server policy: additive across minor versions).
3. If the change is breaking (rare): coordinate the iOS rev-lock with the server tag.
4. Commit the regenerated YAML in the SAME PR that ships the iOS-side change.
```

Marc's rule: never ship an iOS PR that depends on un-merged server work. The server tag lands first; the iOS PR rebases against it.

### 2.5 Where the contract-diff fire alarms go off

| Symptom | Most likely cause | Fix |
| --- | --- | --- |
| iOS 422 with `meta.errorCode: "validation_failed"` on a field your DTO sends | iOS DTO has a key the server's Zod-strict parser rejects | Regenerate Swift codegen; remove the stale key |
| iOS 422 on a field your DTO does NOT send but the server now requires | Server added a required field; codegen catches it | Regenerate; populate the new field |
| iOS 200 with wrong-shaped data | Enum value changed spelling | Regenerate; the Swift enum now reflects new spelling |
| CI red on `openapi-drift` | A server hand-edit bypassed the registry | Server-side fix only — never patch the YAML by hand |

---

## § 3 — Touch-disjoint discipline (parallel iOS sub-agents)

Marc's release pattern depends on dispatching multiple sub-agents in parallel against touch-disjoint surfaces. The iOS workspace inherits the same convention.

### 3.1 The rule

> Two sub-agents working at the same time MUST NOT touch the same file. Period.

If two slots both edit `Sources/HealthLogCoach/CoachView.swift`, you get merge conflicts that compound across the wave. The dispatcher pre-divides surfaces so this is impossible.

### 3.2 Wave decomposition recipe

```
Goal: ship N independent iOS features in one session.

Step 1 — Inventory the work. List every file each feature touches.
Step 2 — Find a partition. Group features so no file appears in two groups.
Step 3 — Dispatch in parallel. Each slot gets one group + a touch list.
Step 4 — Merge order. Slot 1 commits first, slot 2 rebases on slot 1, etc.
```

When a clean partition isn't possible (e.g. two features both touch `AppShell.swift`), serialise those two — one waits.

### 3.3 Atomic-commit rule

Each slot ships **one commit per logical change**, never a "WIP" or a squashed mega-commit. The release surfaces the commits as line-items in the CHANGELOG; one commit per item makes the changelog readable.

| Acceptable | Not acceptable |
| --- | --- |
| `feat(coach): add streaming chat view` | `wip: coach + dashboard + auth` |
| `fix(auth): refresh on 401` | `various fixes` |
| `chore(deps): bump Alamofire to 5.10` | `update deps and refactor` |

### 3.4 Marc-Voice commit-message style guide

| Rule | Example |
| --- | --- |
| English, terse, professional | `fix(measurements): unblock batch ingest on 422` |
| Use Conventional Commits prefixes | `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `style`, `build`, `ci` |
| Imperative mood — "add" not "added" | `feat(coach): add streaming SSE parser` |
| Scope in parentheses, lowercase | `feat(insights): render dailyBriefing tile` |
| No AI tells | NEVER `Co-Authored-By: Claude`, NEVER `--no-verify`, NEVER reference "agent / marathon / phase / wave / session" in the message |
| No PII | Marc's name, health figures, BD-Zielbereich values, measurement counts never appear in commit messages |

Counterexamples that would fail a review:

```
# BAD — agent-voice
fix(coach): patch streaming bug (Claude-assisted)

# BAD — AI mention
feat(insights): add briefing tile (generated via Claude Opus)

# BAD — marathon language
feat(auth): wave-3 refresh-token rotation

# BAD — PII leak
fix(targets): restore Marc's 140/90 BD-Zielbereich after migration

# GOOD
feat(auth): rotate refresh tokens on use
feat(coach): add SSE streaming view with provenance disclosure
fix(targets): persist user target range after edit
```

### 3.5 Branch model — `develop` is the daily target

```
   feature/* ──┐
               ├──► develop ──► (release-merge via PR) ──► main ──► tag vX.Y.Z
   fix/*    ──┘                                              │
                                                             └──► CHANGELOG entry pinned to the tag
```

The iOS app's GHCR-equivalent (App Store TestFlight) builds **from main only**. A dev push to develop never produces a TestFlight build — the GitHub Actions workflow trigger is `tags: 'v*'` on `main`.

---

## § 4 — Marathon-pattern handoff (for v1.5.x release sessions)

Marc-memory has a `release-marathon` skill that codifies the pattern. The iOS workspace inherits the rules.

### 4.1 The non-negotiables

| Rule | Why |
| --- | --- |
| NO `Co-Authored-By: Claude` trailer | Marc-Voice: every artefact reads as Marc's authorship |
| NO `--no-verify` on `git commit` or `git push` | Pre-commit hooks (lint, typecheck, test) gate every commit |
| NO `--no-edit` on `git rebase` | The `--no-edit` flag is not a valid rebase option |
| NO direct push to `main` | `main` only accepts release-merge PRs from `develop` |
| NO tagging by sub-agent | Marc tags after the release-merge PR lands |
| NO destructive git commands (`reset --hard`, `push --force` to main, `branch -D`, `clean -f`) unless Marc explicitly asks | Risk of losing other slots' work |

### 4.2 Pre-flight rule

Before opening any iOS PR in a marathon session, read the handoff doc (this directory) first. The wave-0 read budget is roughly:

- `README.md` (this directory)
- `00-philosophy.md`
- `01-repo-tour.md`
- `08-locked-contracts.md`
- `09-recommended-flow.md` (this file)

Total ~15k tokens. Skipping this surface is the most common cause of merge-blocking review feedback.

### 4.3 Research-first for architecturally-new work

If the iOS feature is genuinely new architecturally (e.g. APNs payload routing, HealthKit observer-query topology, Withings deep-link return), spin up a research note under `.planning/research/` BEFORE writing code. Benchmark Apple Health / Withings / Oura first, propose an ecosystem-fit plan, then implement. Marc's rule from `feedback_research_before_complex_features`.

### 4.4 Phase reports

Every completed phase writes a report at `.planning/phase-W<n>-v1.5.<patch>-<slug>-report.md`. The report captures:

- Phase scope (the task description verbatim)
- What landed (commits + files)
- What deferred (with a one-line "why")
- Test deltas (unit / integration / e2e numbers before vs after)
- Open questions for Marc

These are internal — never published to `docs/` or CHANGELOG.

### 4.5 Decision-relay communication

When a sub-agent hits a decision boundary that needs Marc's input (a UI taste call, an MDR-adjacent feature, a breaking-shape proposal), it pauses and writes a one-paragraph decision-relay note. It does NOT silently pick a direction. Examples that always relay:

- "Should the Coach drawer use a SwiftUI `.sheet` or `.fullScreenCover`?"
- "Should iOS surface the Research Mode chart inline or behind a Settings link?"
- "Should refresh-token reuse trigger a silent re-login or a hard logout?"

---

## § 5 — Pre-release Quality Gate checklist (W21-pattern)

Marc's v1.4.25 W21 ran an 8-reviewer parallel pass before the release-merge. The iOS workspace mirrors it.

### 5.1 The eight reviewers

| Reviewer | What they check | Output |
| --- | --- | --- |
| **code-review** | Bug-spotting, error handling, off-by-ones, dead branches | `phase-W<n>-code-review-findings.md` |
| **security** | Secret leaks, auth boundary, injection vectors, token storage | `phase-W<n>-security-findings.md` |
| **design** | Touch targets ≥ 44×44 pt, contrast WCAG-AA, palette consistency | `phase-W<n>-design-findings.md` |
| **senior-dev** | Architecture, layering, future-proofing, idiomatic Swift | `phase-W<n>-senior-dev-findings.md` |
| **simplifier** | Dead code, redundant abstractions, over-engineered surfaces | `phase-W<n>-simplifier-findings.md` |
| **product-lead** | User-facing acceptance criteria, copy quality, flow polish | `phase-W<n>-product-lead-assessment.md` |
| **i18n-runtime-probe** | Hard-coded strings, locale-bundle parity, missing keys | `phase-W<n>-i18n-runtime-findings.md` |
| **dead-code-scan** | Unused exports, unreferenced files, orphaned migrations | `phase-W<n>-dead-code-findings.md` |

### 5.2 The reconcile pass

After the 8 reviewers land, run a **reconcile** pass that:

1. Collates findings into severity buckets (C / H / M / L)
2. Maps each must-fix finding to a touch-disjoint Fix-* surface
3. Estimates commit count per surface
4. Dispatches fix sub-agents in parallel against those surfaces

The reconcile plan lives at `.planning/phase-W<n>-reconcile-plan.md` and is the single canonical source for "what's still pending before tag". Example: `.planning/phase-W21-reconcile-plan.md` (v1.4.25's W21 reconcile, 63 must-fix findings → 7 Fix-* surfaces).

### 5.3 Severity rubric

| Severity | Rule |
| --- | --- |
| **Critical** | Ship-blocker. Security leak, MDR-line crossing, data loss. Always applied before tag |
| **High** | Apply before tag unless a clean defer-rationale exists |
| **Medium** | Apply if the file is already open in another Fix-* slot (cheap reuse) |
| **Low** | Defer to the next patch unless trivially cheap |

### 5.4 Pre-tag final-pass checklist

Once Fix-* surfaces land:

```
[ ] pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build      (server)
[ ] pnpm test:integration                                                              (server, testcontainers)
[ ] pnpm e2e                                                                            (server, Playwright)
[ ] pnpm openapi:check                                                                  (no drift)
[ ] Swift codegen runs cleanly against docs/api/openapi.yaml
[ ] xcodebuild test -scheme HealthLog                                                   (iOS unit + UI tests)
[ ] PII-grep against CHANGELOG + release notes: no Marc / 140/90 / BD-Zielbereich
[ ] AI-tell grep: no "Claude / agent / marathon / phase / wave / session" in user-facing artefacts
```

If every box ticks, open the release-merge PR develop → main. Marc reviews + tags.

---

## § 6 — Mock vs hit-live test strategy

Three test layers, three different data realities.

### 6.1 The decision tree

| Need | Layer | Backing |
| --- | --- | --- |
| Test a single function | Unit | Mocked Prisma (`vi.mock("@/lib/db")`) |
| Test a full HTTP path against a real DB | Integration | Testcontainers Postgres (`pnpm test:integration`) |
| Test a user flow across multiple pages | E2E | Playwright against a Coolify staging instance |
| Test the iOS app against the real server | E2E | iOS Simulator pointed at staging URL |

### 6.2 Unit tests — what to mock

```typescript
// from a typical Vitest unit test
import { vi, describe, it, expect } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: { measurement: { findMany: vi.fn() } } }));
vi.mock("@/lib/auth/session", () => ({ requireAuth: vi.fn().mockResolvedValue({ user: { id: "u1" } }) }));
```

Rules:

- Mock Prisma; never hit a real DB
- Mock external HTTP (Withings, Anthropic, OpenAI)
- Stub time with `vi.useFakeTimers()` and pin to a specific ISO instant
- Never mock Zod — schemas must validate against real input shape

### 6.3 Integration tests — testcontainers

```bash
pnpm test:integration
# Boots a fresh Postgres 16 container, runs migrations, spawns a test instance, runs every spec, tears down.
```

These tests are the safety net against drift between Prisma client and the migrations. If `pnpm test` passes but `pnpm test:integration` fails, you have a schema-vs-client mismatch — almost always a migration rollback bug.

### 6.4 E2E — staging only

The iOS Simulator's e2e flow points at the Coolify staging URL (separate from production). Staging has:

- A fresh Postgres + restored backup
- Marc's seeded test account
- Real AI providers (Anthropic key in env)
- Real Withings sandbox creds

Never run iOS e2e against production. The smoke difference matters only for the dispatcher cron schedule — staging cron schedules use a `Europe/Berlin` clone but disable the offhost-backup queue (it shouldn't touch S3).

### 6.5 iOS unit + UI tests

```bash
# Unit tests — XCTest, mocked URLSession
xcodebuild test -scheme HealthLog -destination 'platform=iOS Simulator,name=iPhone 15'

# UI tests — XCUITest against the iOS Simulator with a stubbed server
xcodebuild test -scheme HealthLogUITests -destination 'platform=iOS Simulator,name=iPhone 15'
```

Stub the server with a local `URLProtocol` subclass that intercepts every request. No physical server runs during iOS unit tests — the goal is to verify the iOS state machine in isolation.

---

## § 7 — CI workflow surfaces

Two CI surfaces matter: the server's GitHub Actions and the iOS-side GitHub Actions (or Xcode Cloud). They overlap deliberately.

### 7.1 What the server CI runs on every PR

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `e2e.yml` | PR + push | Playwright against ephemeral Postgres |
| `integration.yml` | PR + push | Vitest integration (testcontainers) |
| `security.yml` | PR + daily | `pnpm audit`, secret scanning, OpenAPI drift gate (HARD-FAIL) |
| `docker-publish.yml` | Tag `v*` on `main` only | Multi-arch GHCR image build |
| `post-publish-verify.yml` | After GHCR build | Pulls the new image, runs health probes |

The hard-flip gate to watch: `pnpm openapi:check` inside `security.yml`. If it fails, the PR cannot merge — even with admin override, Marc's policy is to fix the drift instead.

### 7.2 What the iOS CI should run

```
1. xcodebuild test -scheme HealthLog                            # unit + UI tests
2. xcodebuild archive -scheme HealthLog -configuration Release  # ship-able archive
3. Swift codegen drift check (regenerate, diff, fail if differ)
4. SwiftLint --strict
5. (Optional) accessibility audit on UI tests via XCTest
```

iOS CI does NOT need to run the server's tests. The contract is OpenAPI YAML; if YAML and Swift codegen agree, iOS doesn't care how the server tests itself.

### 7.3 The cross-side handoff

```
Server PR     → develop  → CI green → review → merge
Server tag    → main     → CI green → GHCR build → Coolify staging
Server tag    → main     → docs/api/openapi.yaml frozen on the tag
                                          │
                                          ▼
iOS PR        → develop → CI green (Swift codegen against frozen YAML)
iOS PR        → develop → review → merge
iOS tag       → main    → CI green → TestFlight
```

iOS NEVER cross-references the server's `develop` branch's OpenAPI. iOS targets the latest server tag's YAML, period. This keeps both sides shippable independently.

---

## § 8 — Common iOS-only gotchas

These don't surface in any server log because the server never sees them.

### 8.1 Apple Health permissions on Simulator

```
Symptom : HKHealthStore.requestAuthorization returns immediately, no prompt
Cause   : iOS Simulator stubs the HealthKit framework; no real permission flow exists
Fix     : Test on a physical device, OR seed Postgres via /api/measurements/batch
```

The iOS app should detect the Simulator and surface a "running on Simulator — manual entry only" banner in dev builds.

### 8.2 Withings web-only OAuth vs iOS deep-link return

```
Symptom : User taps "Connect Withings" → opens SFSafariViewController → never returns to app
Cause   : Withings redirect_uri is server-side (https://...example.com/api/withings/callback), 
          but the iOS app needs a deep-link back into the app after the cookie session
          confirms the connect
Fix     : Server-side handler at /api/withings/callback ends with a 302 redirect to a custom
          URL scheme (e.g. healthlog://withings/connected), which iOS catches via Universal
          Links (in production) or a custom URL scheme (in dev). The Apple Health bridge
          does NOT have this issue — there's no OAuth involved.
```

Details in `02-server-architecture.md` § Withings integration.

### 8.3 RESEARCH_MODE_DISCLAIMER_VERSION drift on server redeploy

```
Symptom : iOS user previously acknowledged the Research Mode disclaimer; after a server
          redeploy, the chart is gated again with a "you must re-acknowledge" dialog
Cause   : The constant in src/lib/medications/glp1-pk.ts moved forward (e.g.
          "2026-05-14.1" → "2026-05-21.1") because the server team bumped it.
Fix     : iOS reads the live currentDisclaimerVersion from GET /api/auth/me/research-mode
          on every Coach turn and on every Research Mode chart render. NEVER cache the
          version string client-side longer than one session.
```

See `08-locked-contracts.md` § 6.

### 8.4 SSE Coach streaming via URLSession.bytes(for:), not long-polling

```swift
// CORRECT — URLSession.bytes streams as the server emits
let (bytes, response) = try await URLSession.shared.bytes(for: request)
for try await line in bytes.lines {
    if line.hasPrefix("data: ") {
        let frame = String(line.dropFirst(6))
        // decode SSE event frame
    }
}

// WRONG — would buffer the entire response before any UI update
let (data, response) = try await URLSession.shared.data(for: request)
```

The Coach UX depends on token-by-token reveal. Buffered reads collapse to a "wait 4s, then everything appears at once" experience that defeats the entire point. See `14-coach-mental-model.md` § Evidence-grounding.

### 8.5 The Idempotency-Key lifecycle on iOS

```
Step 1 : Generate UUID().uuidString once per logical write
Step 2 : Persist the key + body to disk
Step 3 : POST with Idempotency-Key header
Step 4 : On 2xx or non-retryable 4xx (400/415/422), drop the key
Step 5 : On 5xx or network failure, retry with the SAME key (24h replay window)
Step 6 : On 401, refresh the token, retry with SAME key
```

The most common iOS bug here: generating a fresh UUID on retry. That produces a duplicate write, not the idempotent replay. See `17-error-handling.md` § 3.

### 8.6 Time zones in measurement timestamps

```
Symptom : An iOS sample at 23:50 in Pacific/Auckland lands in the wrong day on the dashboard
Cause   : iOS sent the timestamp as a UTC string, the server day-bucketed it in UTC instead
          of the user's TZ
Fix     : Send the timestamp as ISO-8601 WITH offset (e.g. "2026-05-14T23:50:00+12:00").
          The server's userDayKey() resolver uses User.timezone to bucket, but the offset
          on the wire is what locks the wall-clock moment.
```

### 8.7 The `X-Client-Type: native` header is mandatory on login

```
Symptom : iOS login succeeds but no refresh token comes back
Cause   : Without X-Client-Type: native (or the UA prefix HealthLog-iOS), the server treats
          the call as web and only sets a cookie
Fix     : Always send X-Client-Type: native on /api/auth/login and /api/auth/register
```

See `05-auth-flows.md` § 2.

### 8.8 Push notifications — the APNs token lifecycle

```
Step 1 : iOS requests notification permission
Step 2 : iOS receives an APNs device token (32 bytes hex)
Step 3 : iOS POSTs the token to /api/devices with platform: "ios" + apnsEnvironment
         ("sandbox" for dev builds, "production" for App Store)
Step 4 : Server stores Device.apnsToken with a partial unique index
Step 5 : On every app launch, iOS re-POSTs the token (APNs tokens rotate silently)
Step 6 : On logout, iOS DELETEs the token via /api/devices/[id]
```

The most common bug: forgetting Step 5. APNs rotates tokens silently; stale tokens fail to deliver. The server's dispatcher cleans up tokens that fail twice in a row.

### 8.9 Coolify staging vs production URLs

```
Production : https://healthlog.example.com         (Marc's main instance)
Staging    : https://staging.healthlog.example.com (refreshed nightly from prod backup)
Local      : http://localhost:3000                 (dev server)
```

Never run iOS e2e tests against production. Never run integration tests against staging. Local-Postgres-via-testcontainers for integration; staging-only for e2e.

### 8.10 Six locales — string keys must exist in all of them

```
Symptom : iOS app shows the raw key "coach.refusal.glp1_dose" instead of the translation
Cause   : The key was added to en.json but not to de.json / fr.json / es.json / it.json / pl.json
Fix     : Add the key to all six bundles in the same PR. The server's i18n integrity test
          blocks PRs that drop a key; the iOS side has no such gate — review carefully.
```

See `19-i18n-system.md` § 3.

---

## § 9 — Common iOS PR shapes (cheat sheet)

| PR type | Files typically touched | Reviewer focus |
| --- | --- | --- |
| New endpoint client method | `Sources/HealthLogAPI/Generated/*` (regen) + one new `*ViewModel.swift` | Contract-diff loop |
| New screen | One Swift file under `HealthLog/Views/`, one ViewModel, one string bundle update × 6 | Design + i18n |
| New HealthKit metric | `HealthKitClient.swift` + `MeasurementType` mirror + server-side `apple-health-mapping.ts` first | Server PR first, iOS PR second |
| Bug fix | Single file, single test | Single reviewer (code-review) |
| Dependency bump | `Package.swift` + lockfile | senior-dev — check for behaviour changes |

---

## § 10 — STOP HERE if…

| If your task is… | …skip the rest and read… |
| --- | --- |
| Just calling one endpoint | `03-api-contracts.md` § matching route |
| Wiring login + refresh | `05-auth-flows.md` |
| Building a Coach UI | `14-coach-mental-model.md` + `15-insights-architecture.md` |
| Building a dashboard tile | `11-web-ui-tour.md` § Dashboard + `12-design-system.md` |
| Understanding contract-locks before any code change | `08-locked-contracts.md` |

Otherwise: continue to `10-research-pointers.md`.
