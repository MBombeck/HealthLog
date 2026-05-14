# HealthLog v1.4.24 — roadmap

Milestone: **v1.4.24 — pre-iOS final polish** (not yet kicked off)
Latest tag at start: v1.4.23 (live in prod)

Carry-over candidates already captured in
`.planning/v1423-backlog.md`:

- Pearson incomplete-beta replacement — v1.4.23 W5 H6 raised
  `MIN_PAIRED_N` from 14 → 20 as a conservative surfacing-gate
  patch. Land the rigorous incomplete-beta or normal-approx
  replacement before v1.5/v1.6 auto-correlation discovery ships.
- OpenAPI drift gate flip from warn-only to hard-fail — generator
  covers ~880 lines vs the legacy hand-maintained spec's 5 468;
  complete registry coverage in parallel so the lockstep happens
  before the iOS DTO codegen is downloading the spec
  automatically.
- Settings-cog vs per-message-controls UX consolidation — Design
  pushback during W6 raised concern that the dual surface
  duplicates intent. Wait on first-week thumbs data, decide
  whether per-user prompt prefs drift from per-message ratings.
- `coach-prefs.test.ts` integration `NextRequest` URL mock
  regression — pre-existing failure that predates v1.4.23.
  Investigate the harness's `cookies()` mock interaction with
  `NextRequest`'s URL parsing.
- Sec-MED-1 + LOW cluster — intra-batch dedup accounting
  (Sec-LOW-1), idempotency 422 retry hint in the OpenAPI 422
  description (Sec-LOW-2), APNs key-file path redaction in
  wide-event meta (Sec-LOW-3), refresh-token failure audit
  `userId` extension (Sec-LOW-4).
- S-05 simplify deferral (Session B) — touched too many call
  sites for a single reconcile commit.

Reserved next strategic milestones:

- **v1.5** — iOS app + Apple Health integration + per-metric APNs
  alerts. Refreshed strategic plan with concrete file paths at
  `.planning/phase-W6-v1423-product-lead-review.md`. P1 is now a
  ~5-day iOS Swift sprint because every server-side contract
  landed in v1.4.23. Per-user timezone foundation
  (`.planning/feature-user-timezone.md`, issue #167) is now scoped
  into v1.4.25 — Marc directive 2026-05-14, packs the iOS-launch
  prep into the v1.4.25 polish window instead of slipping it.
- **v1.6+** — Auto-correlation discovery (FDR-controlled), Coach
  full-page route at `/insights/coach`, conversation-driven goal
  setting.

---

## Previous milestone — v1.4.23 (completed 2026-05-11)

| Wave | Goal                                                                                                                                                                                                                                                                                                                       | State |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1    | Research — Apple Health type mapping, APNs library decision (`@parse/node-apn`), OpenAPI tooling choice (`zod-openapi` + `yaml@^2`)                                                                                                                                                                                        | done  |
| 2    | Apple Health foundation — F1 `MeasurementType` extension + sleep-stage enum + composite dedup index, F2 `APPLE_HEALTH` source + UI badge, F3 `POST /api/measurements/batch` + sleep-stage analytics aggregation                                                                                                            | done  |
| 3    | APNs scaffolding — F4 `@parse/node-apn` sender + dispatcher cascade rewire, `Device` columns + paired CHECK constraint, `POST /api/devices` apnsToken acceptance + cross-user-hijack guard                                                                                                                                 | done  |
| 4    | OpenAPI generator + Coach metric slot + native-auth hardening + Coolify runbook — F5 `zod-openapi` registry + warn-only CI gate, F6 nine HealthKit categories in strict schema + PROMPT_VERSION 4.23.0, F7 per-device refresh-token replay-detection + device-management endpoints, F8 Coolify runbook + `::notice::` line | done  |
| 5    | Hygiene (H1-H7) — sentinel parser malformed-enum annotation, analytics chunked-paged aggregate, drawer controlled-prop refactor, per-user prompt prefs surface, `medication_schedules.days_of_week` deploy, Pearson n≥20 gate, Coach feedback observation view                                                             | done  |
| 6    | Multi-agent QA + reconcile — six reviews (code, security, design, senior-dev, simplify, product-lead); 1 CRIT + 9 HIGH + 4 simplify + 3 MED applied; LOWs triaged into v1423-backlog                                                                                                                                       | done  |
| 7    | Release v1.4.23 — bump, CHANGELOG, release-merge, tag, GHCR, Coolify deploy, /api/version=1.4.23, smoke, GH release, docs + landing sync, brief                                                                                                                                                                            | done  |

Milestone completed 2026-05-11 — v1.4.23 LIVE in prod.
Release brief: `docs/audit/v1423-summary.md`.
Backlog seeded to `.planning/v1423-backlog.md`. v1.5 strategic plan refresh
at `.planning/phase-W6-v1423-product-lead-review.md`.

---

## Previous milestone — v1.4.22 (completed 2026-05-10T22:43:50+02:00)

| Wave | Goal                                                                                                                                                                                                                           | State |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 1    | Research + probe — Playwright PROD probe (BD-Zielbereich 5th attempt, api-tokens 5th attempt, metric token leaks, Targets page brainstorm); health-coach prompt research                                                       | done  |
| 2    | Insights surface polish — A1 BD framing, A2 BD-Kachel parity, A3 comparison-toggle global, A4 grid normalisation, A5 Muster rename + tabs above hero, A6 token-leak fix                                                        | done  |
| 3    | Coach polish — B1 prompt rewrite (PROMPT_VERSION 4.20.2 → 4.22.0), B2 collapsible evidence, B3 Gravatar parity, B4 disclaimer move, B5 settings cog removal                                                                    | done  |
| 4    | Other surfaces + backlog cleanup — C1 Zielwerte sparkline + Δ-vs-last-month, C2 api-tokens 5th attempt, C3 Coolify auto-deploy runbook, C4 AuthShell flicker → proxy.ts, C5 node-26-alpine deferred, D backlog wave (12 items) | done  |
| 5    | Multi-agent QA + Product-Lead — code, security, design, senior-dev, simplify, product-lead; 0 CRIT, 7 HIGH all applied inline, ~6 MED applied, rest deferred                                                                   | done  |
| 6    | Release v1.4.22 — bump, CHANGELOG, release-merge, tag, GHCR, host-side retag deploy (Coolify secrets still missing), /api/version=1.4.22, smoke, GH release, docs+landing sync, brief                                          | done  |

Milestone completed 2026-05-10T22:43:50+02:00 — v1.4.22 LIVE in prod.
Release brief: `docs/audit/v1422-summary.md`.
Image digest:
`sha256:865154614303fdc362ee3941776f73ec0f60e1f16112ec272a75cbbe28e2cffb`.
Backlog seeded to `.planning/v1422-backlog.md`. v1.5 strategic plan at
`.planning/phase-W5-v1422-product-lead-review.md`.

---

## Previous patch — v1.4.21 (completed 2026-05-10T17:46+00:00)

| Phase | Goal                                                                                                                                                   | State |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| F     | Same-day patch on top of v1.4.20 — Daily Briefing regenerate fix, Coach day-level snapshot, duplicate streaming bubble, drawer header, scope picker UI | done  |
| E     | Release v1.4.21 — develop → main release-merge, bump, CHANGELOG, tag, GHCR, host-side retag fallback, /api/version=1.4.21, smoke, GH release, brief    | done  |

Patch completed 2026-05-10T17:46+00:00 — v1.4.21 LIVE in prod.
Release brief: `docs/audit/v1421-summary.md`.
Image digest:
`sha256:4e818d44702c3581a14d6480a953fd20d16cbbaf21c41e0c778c07340d3c4b1c`.

---

## Previous milestone — v1.4.20 (completed 2026-05-10T16:49:25Z)

| Phase | Goal                                                                                                                                                        | State |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| F0    | Bootstrap — commit dangling v1.4.19 reports, scaffold STATE+ROADMAP                                                                                         | done  |
| F1    | Branch model — long-lived `develop` from `main` HEAD; GHCR builds on `main` + `v*` only                                                                     | done  |
| F2    | Document branch + release model — CONTRIBUTING.md + docs site mirror page                                                                                   | done  |
| FX    | User-facing artifact cleanup — PII (no real names, no health figures), internal jargon, German leaks; CHANGELOG + docs/audit + GH releases + docs + landing | done  |
| F5    | Best-practice GitHub repo audit — CODE_OF_CONDUCT.md, issue + PR templates, dependabot expansion, package.json metadata                                     | done  |
| F6    | Multi-agent QA on new docs — 38 docs pages cross-checked vs deployed state, CRIT + HIGH inline                                                              | done  |
| B1    | Hero strip + Daily Briefing + Suggested-prompts                                                                                                             | done  |
| B2    | AI Coach drawer + SSE streaming + encrypted persistence                                                                                                     | done  |
| B3    | Correlation discovery + Trends row with AI annotations                                                                                                      | done  |
| B4    | Weekly Report + Storyboard markers + Mobile passes                                                                                                          | done  |
| B5    | Personal Health Score (composite 0–100, 3 bands)                                                                                                            | done  |
| D     | Multi-agent QA — code, security, design, senior-dev, simplify, product-lead; 13 HIGH + 6 MED + 5 simplify-yes inline; 22 MED + 16 LOW deferred              | done  |
| E     | Release v1.4.20 — develop → main release-merge, bump, CHANGELOG, tag, GHCR, host-side retag deploy fallback, /api/version=1.4.20, smoke, docs+landing sync  | done  |

Milestone completed 2026-05-10T16:49:25Z — v1.4.20 LIVE in prod.
Release brief: `docs/audit/v1420-summary.md`. Backlog seeded to
`.planning/v1421-backlog.md`. v1.5 strategic plan at
`.planning/phase-D-v1420-product-lead-review.md`.

---

## Previous milestone — v1.4.19 (completed 2026-05-10T12:39:59Z)

| Phase | Goal                                                                                                                                               | State |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 0     | Bootstrap — STATE+ROADMAP for v1.4.19                                                                                                              | done  |
| A1    | BD-Zielbereich constant 50% (4th attempt) — live-DB root-cause + integration test                                                                  | done  |
| A2    | Charts mobile audit — universal X-tick density helper, mobile-first stacked headers across HealthChart / MoodChart / MedicationComplianceChart     | done  |
| A3    | `/insights` polish — Comparison-toggle relocated, single page-level refresh, BP/Weight tile strip removed, raw-token leak guarded                  | done  |
| A4    | AI prompt — GROUND RULE 7 forbids default-positivity opener, PROMPT_VERSION 4.16.1 → 4.19.0                                                        | done  |
| A5    | Settings/Integrations status-UI — `<IntegrationStatusPill>` consolidates Withings + Mood Log, divider parity, locale-aware relative-time           | done  |
| A6    | Settings mobile audit — input heights equalised at 36 px, action buttons standardised, Sprache select hoisted to its own row                       | done  |
| A7    | Admin polish — feedback tab strip scrollbar, api-tokens 4th-attempt truncate+tooltip, Einklappen toggle removed, Zielwerte i18n                    | done  |
| A8    | Quality-of-life audit — 78 findings prioritised CRITICAL / HIGH / MED / LOW                                                                        | done  |
| B     | Apply A8 — 6/6 CRITICAL + 21/25 HIGH inline; 31 MED + 16 LOW carried to v1.4.20 backlog                                                            | done  |
| D     | Multi-agent QA (5 reviewers) + Product-Lead → v1.5 redesign plan filed                                                                             | done  |
| E1-E3 | Release v1.4.19 — tag, GHCR build green, host-side retag deploy via fallback (Coolify deploy hung, retried via SSH), GH release, docs+landing sync | done  |

Milestone completed 2026-05-10T12:39:59Z — v1.4.19 LIVE in prod.
Release brief: `docs/audit/v1419-summary.md`. Backlog seeded to
`.planning/v1420-backlog.md` (carry-over) and v1.5 strategic items in
`.planning/v15-backlog.md` + `.planning/phase-D-v1419-product-lead-review.md`.

---

## Previous milestone — v1.4.18 (completed 2026-05-10T11:45+02:00)

| Phase | Goal                                                                                                         | State |
| ----- | ------------------------------------------------------------------------------------------------------------ | ----- |
| 0     | Bootstrap — STATE+ROADMAP for v1.4.18                                                                        | done  |
| A1    | BD-Zielbereich tile — 7T/30T sub-values render real numbers (currently "—" even with data)                   | done  |
| A2    | `/admin/api-tokens` table scrollbar (3rd attempt) — Playwright live-verify against prod, fix actual offender | done  |
| A3    | Chart visual revert + per-chart toggles — drop gradient/emoji/auto-mean, ship 3 opt-in overlay toggles       | done  |
| B1    | Achievements expansion — research + 15-25 new, hidden Easter-eggs, lock filter, hidden cards                 | done  |
| D     | Multi-agent QA + Product-Lead — code-reviewer, security, design, senior, simplify, product                   | done  |
| E     | Release v1.4.18 — bump, CHANGELOG, tag, GHCR, deploy, /api/version=1.4.18, smoke, docs+landing sync          | done  |

Marathon completed 2026-05-10T11:45+02:00 — v1.4.18 LIVE in prod.
Full report: `docs/audit/v1418-summary.md`. Backlog seeded to
`.planning/v1419-backlog.md` (tactical) and `.planning/v15-backlog.md`

- `.planning/phase-D-v1418-product-lead-review.md` (strategic).

---

## Previous milestone — v1.4.17 hotfix (live 2026-05-10T07:58+00:00)

| Phase  | Goal                                                                                                       | State |
| ------ | ---------------------------------------------------------------------------------------------------------- | ----- |
| Hotfix | `/insights` TypeError on legacy cached blob — `isLegacyInsightPayload()` flag + advisor card short-circuit | done  |
| Audit  | `git grep -nE '\.replace\(' src/` — 82 hits scanned, crash site is the only fragile case                   | done  |
| E      | Release v1.4.17 — bump, tag, GHCR, host-side retag deploy, GH release                                      | done  |

Hotfix completed 2026-05-10T07:58+00:00 — v1.4.17 LIVE in prod.
Detailed report: `.planning/phase-v1417-hotfix-report.md`.

---

## Previous milestone — v1.4.16 (completed 2026-05-10T04:05+02:00)

| Phase | Goal                                                                                                  | State |
| ----- | ----------------------------------------------------------------------------------------------------- | ----- |
| 0     | Bootstrap — STATE+ROADMAP for v1.4.16                                                                 | done  |
| A1    | Sidebar admin-expand bug — Admin nav from non-admin route + Gravatar dropdown side-effects            | done  |
| A2    | BD-Zielbereich real-fix (regression from v1.4.15 A4) — root-cause + E2E                               | done  |
| A3    | `/admin/api-tokens` table responsive — card-list mobile fallback                                      | done  |
| A4    | "7-Tage-Schnitt" → "7-Tage-Trend" DE + indicator on ALL charts                                        | done  |
| A5    | Top-tile-selector real-fix — widget-id enum drift fixed                                               | done  |
| A6    | Medication-chart 7d-trend + target-range — match other charts                                         | done  |
| A7    | AI Generator rate-limit 10/h + cache-invalidate-on-new                                                | done  |
| A8    | Umlaute encoding bug + login-overview UTF-8 audit + long-window split-half delta                      | done  |
| B1a   | Charts visual leap — gradients, baseline, rich tooltip, mood emoji glyphs                             | done  |
| B1b   | Insights surface visual leap — page hero, recs grid, summary typography, dashboard preview            | done  |
| B2    | AI provider settings UX cleanup — single pulldown-driven form, fallback chain editor                  | done  |
| B3    | Admin System-Status host-load chart — CPU/memory/disk-io graph last 2h                                | done  |
| B4    | Admin logs visibility deepening — filterable audit log + structured wide-event tail                   | done  |
| B5a   | Medical-reference grounding — AHA / ESC / ESH / WHO bundle + UI citations                             | done  |
| B5b   | Multi-provider redundancy — try-each-on-hard-failure, configurable fallback order                     | done  |
| B5c   | Per-recommendation explainability — WHY / WINDOW / CITATIONS card with mini-chart                     | done  |
| B5d   | Confidence score per recommendation — deterministic 0-100 from sufficiency / recency / signal         | done  |
| B5e   | User-feedback loop — thumbs persisted to RecommendationFeedback + daily aggregator                    | done  |
| B6    | Settings naming-audit — stringency, consistency, no double naming                                     | done  |
| B7    | Settings → Export menu (Arztbrief consolidated) — new `/settings/export` route                        | done  |
| B8    | Extended comparison views — Vormonat / Vorjahr overlay across charts + tiles + insights               | done  |
| C     | Catch-up — 5 of 8 deferred HIGH + 3 of 5 mobile MED + docker-publish drop qemu-arm64                  | done  |
| D     | Multi-agent QA + Product-Lead — code-review, security, design, senior, simplify, product-lead         | done  |
| E1-E3 | Release v1.4.16 — bump, tag, GHCR (both green), host-side retag deploy, GH release, docs+landing sync | done  |

Marathon completed 2026-05-10T04:05+02:00 — v1.4.16 LIVE in prod.
Full report: `docs/audit/v1416-summary.md`. v1.5 backlog seeded at
`.planning/v15-backlog.md`.

---

## Previous milestone — v1.4.15 (completed 2026-05-09T22:50+02:00)

| Phase    | Goal                                                                                                         | State |
| -------- | ------------------------------------------------------------------------------------------------------------ | ----- |
| 0        | Bootstrap — STATE+ROADMAP for v1.4.15                                                                        | done  |
| A1       | Nav conditionals + sidebar context-awareness                                                                 | done  |
| A2       | `/admin` overview redesign + `/admin/api-tokens` responsive                                                  | done  |
| A3       | Quick-add labels + Stimmung-Card mobile + onboarding flicker                                                 | done  |
| A4       | Dashboard analytics fixes (BD-Zielbereich, Medikamente graph, Stimmung agg, 7-Tage-Trend, top-tile selector) | done  |
| A5       | Mobile UX audit + chart scroll-lockup fix                                                                    | done  |
| B-mobile | Mobile audit fix-application (5 commits, 2/2 CRITICAL, 6/8 HIGH)                                             | done  |
| B1       | Backup completeness — restore, download, upload, audit, docs                                                 | done  |
| B2       | Withings + moodLog sync robustness — status UI, refresh rotation, telegram on fail                           | done  |
| B3       | Notification reliability — auto-disable on 410, exp backoff, status visible                                  | done  |
| B4       | Achievements UI — `/achievements` page + dashboard card                                                      | done  |
| B5       | Onboarding tour first-run — spotlight, Esc/arrows, restart from Settings                                     | done  |
| B6       | Doctor-report v2 — configurable date range, practice-name on cover                                           | done  |
| C1       | AI/Codex hardening — provider abstraction, JSON schema, citations, scope, slug-drift defense                 | done  |
| C2       | Auto-deployment — Coolify webhook on GHCR push, failure-notify                                               | done  |
| C3       | CI/e2e reliability audit — root-cause flaky specs, docker-publish cache fix                                  | done  |
| C4       | i18n coverage audit — EN+DE parity, non-empty test guards                                                    | done  |
| C5       | Empty-states audit — 13 surfaces upgraded                                                                    | done  |
| D        | Multi-agent QA (5 reviewers + reconcile)                                                                     | done  |
| E1–E3    | Release v1.4.15 — bump, tag, GHCR, host-side retag deploy, docs+landing sync, Marc-Brief                     | done  |

Marathon completed 2026-05-09T22:50+02:00 — v1.4.15 LIVE in prod.
Full report: `docs/audit/v1415-summary.md`.

---

## Previous milestone — v1.5 (relabelled v1.4.14, completed 2026-05-09)

| Phase | Goal                                                                                                                                   | State |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 0     | Bootstrap — STATE+ROADMAP, git/CI/prod sanity, single chore commit                                                                     | done  |
| 1     | Verify Codex-OAuth end-to-end (device-start shape, prod logs, gpt-5.3-codex slug)                                                      | done  |
| 2     | v1.4.6 deferred backlog — T2.1..T2.7 (wipe scope, DST math, 5xx → 422/503, status-card test, redact regex, Backups view, /admin/users) | done  |
| 3     | End-to-end test coverage — authed dashboard, add-measurement, KI flow, doctor PDF, insights, mobile smoke, axe-core extended           | done  |
| 4     | Performance audit — Playwright capture, `docs/audit/v15-performance.md`, top-3 wins inline                                             | done  |
| 4b    | Admin Panel refactor — `/admin/[section]` dynamic routes mirror Settings; sidebar Admin group; legacy hash redirects; bundle-size win  | done  |
| 5     | UX polish — design-review top-10 friction points, CRITICAL/HIGH triage                                                                 | done  |
| 6     | Multi-agent QA (parallel) — code-reviewer, security, visual/UX, simplify                                                               | done  |
| 7     | Pre-release verification — typecheck / lint / format / test / integration / build / e2e                                                | done  |
| 8     | Release v1.4.14 — rebrand patch deploy (host-side retag, GHCR `:1.4.14`, image digest `0ced46004a54…`)                                 | done  |
| 9     | Docs + landing site sync to v1.4.14                                                                                                    | done  |
| 10    | Backfill GitHub releases v1.4.7..v1.4.13 from CHANGELOG                                                                                | done  |
| 11    | Final summary `docs/audit/v1414-summary.md` with Marc-Brief                                                                            | done  |

Marathon completed 2026-05-09T18:35+02:00 — v1.4.14 LIVE in prod.
Full report: `docs/audit/v1414-summary.md`.
