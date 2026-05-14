# HealthLog v1.4.22 — release summary

## Release brief

v1.4.22 is the polish release that closes loops the Insights redesign, the AI Coach, and the BD-Zielbereich tile have been carrying since v1.4.16. Two beats define it. The first is the Coach prose rewrite — the model used to open every reply with a number, which read clinical and database-cursor-shaped; v1.4.22 reframes the persona as warm, curious, and reserved, and moves every aggregate value out of the prose into a collapsible "Worauf bezieht sich das?" / "What I'm looking at" disclosure under each turn. The second is the long tail of small fixes that finally settle metrics, layout, and a11y where they should have landed two releases ago: the BD-Zielbereich headline re-anchored to the last-30-day window (with all-time as a sub-row), the Targets / Zielwerte page grew per-target sparklines and a Δ-vs-last-month caption, the sticky section navigation lifted above the Insights hero with proper `aria-current` + `motion-reduce` semantics, the comparison-overlay collapsed into a single global preference under Settings → Dashboard, and the admin / API-tokens horizontal scrollbar is gone on the fifth attempt. PROMPT_VERSION ratcheted 4.20.2 → 4.22.0 — the first minor-digit bump in the v1.4.x line, intentional because the persona, the sentinel-block contract, and the warmth of the prose all changed in one coherent step. v1.4.22 is the milestone that makes v1.5's iOS push start on a clean foundation instead of debt repayment.

## Live state

| Field              | Value                                                                          |
| ------------------ | ------------------------------------------------------------------------------ |
| URL                | `https://healthlog.bombeck.io`                                                 |
| `/api/version`     | `1.4.22`                                                                       |
| Image digest       | `sha256:865154614303fdc362ee3941776f73ec0f60e1f16112ec272a75cbbe28e2cffb`      |
| Version transition | 2026-05-10T22:43:50+02:00 (host-side retag fallback)                           |
| GH release         | https://github.com/MBombeck/HealthLog/releases/tag/v1.4.22                     |
| Branch model       | second release through the `develop` → `main` model (introduced in v1.4.20 F1) |

## Smoke (no session)

`/api/version` → 200 (returns `1.4.22`). Every gated route (`/`, `/insights`, `/insights/report/2026-W19`, `/admin/api-tokens`, `/settings/integrations`, `/achievements`) returns 307 → `/auth/login`, confirming the proxy gate is alive on the new image.

## What shipped

**Insights surface polish.** Six changes that together move the page from "feature-rich and slightly cluttered" to "deliberate". The BD-Zielbereich tile got its fourth-attempt fix: the headline now reads `windows.last30Days?.pct` instead of the all-time aggregate, surfaces all-time as a sub-row, and gains a synthesised trend arrow plus a 7-day-trend chip. The on-surface comparison toggle retired from `/insights` because the canonical picker has lived in Settings → Dashboard since v1.4.16 (two surfaces violated the no-split-Settings rule). Three half-row layouts that left empty space got a row-fill rule. Trends-row card heights equalised. The "Muster" / "Patterns" row renamed to "Zusammenhänge" / "Relationships" because the row directly above already uses Trends. The sticky section navigation lifted above the hero with proper a11y semantics (`aria-current`, focus-visible ring, `motion-reduce`, observer-ratio sorting). And a single missing `stripChartTokens()` call upstream was producing raw `metric:WEIGHT` / `metric:BLOOD_PRESSURE_SYS` token leaks in recommendation prose; fix landed plus four DE Health-Score component labels normalised to German nouns.

**Coach prose rewrite + collapsible evidence.** PROMPT_VERSION 4.20.2 → 4.22.0. The Coach used to open every reply with a number; the new persona is warm, curious, reserved — a partner sitting alongside the user, not pushing data. Numbers move out of the prose into a `---KEYVALUES---` … `---END---` sentinel block that the chat route parses out server-side and renders as a `<details>` disclosure under each assistant turn, closed by default and hidden when no key-values came back. Three-way hard caps on the sentinel (1 KB payload, 8 lines max, per-line Zod) so a prompt-injection attempt can't grow the persisted envelope. The user avatar reuses the existing Gravatar URL at the same dimensions as the Coach avatar. The medical disclaimer pinned at the bottom of the message thread on every viewport (clinical-adjacent UI must not gate the disclaimer behind a chevron tray). The settings cog removed because it was a dead button in v1.4.21 — per-user prompt-tuning is deferred to v1.4.23. A graceful fallback covers the sentinel-only-output edge case so the model never surfaces a raw marker.

**Other surfaces + backlog cleanup.** The Targets / Zielwerte page stopped reading like a clinical cheat-sheet. Each `<TargetCard>` grew a 30-day inline SVG sparkline beneath the range bar plus a localised "Δ −2.3 kg vs. last month" caption; both null when either window has fewer than 3 readings so cold-start accounts don't see a misleading flat trace. The admin / API-tokens horizontal scrollbar fell to a live Playwright probe that traced the residual culprit to `whitespace-nowrap` on the date `<td>`s. The AuthShell post-hydration redirect on incomplete onboarding moved into `proxy.ts` so the dashboard flash is gone; the proxy reads a non-httpOnly `hl_onboarding` cookie that auth routes mirror from `onboardingCompletedAt`, with `SameSite=Strict` so cross-site requests can't see it. The `setOnboardingPendingCookie` write folded into `createSession()` so issuing a session without onboarding state is type-impossible. Twelve backlog items from `v1421-backlog.md` swept; hygiene continued (191 maintainer-name references in source comments swept, v1.4.14+v1.4.15 bilingual CHANGELOG entries normalised to English-only, the AI-vendor-specific contributor file retired in favour of `CONTRIBUTING.md`).

**Multi-leg QA + reconcile.** Six-leg review (code, security, design, senior-dev, simplify, product-lead) found 0 CRITICAL across all reviews. Seven HIGH findings — all applied inline. About six MEDs applied inline (judgment-pick high-leverage); the rest documented in `.planning/v1422-backlog.md` for v1.4.23. Highlights of the inline applications: BD-Zielbereich tile compareDelta now matches caption (subtracts `bpInTargetPctPriorMonth` instead of `bpInTargetPctAllTime`); `createSession()` requires `onboardingPending` as a parameter so the cookie-write fan-out is one site; `createSseStream` extracted to `src/lib/sse/create-stream.ts` ahead of v1.5 iOS streaming endpoints; `berlinDayKey()` lifted to a shared `src/lib/analytics/berlin-day.ts` helper so the targets sparkline and analytics route share the same bucketing; BP tile collapses to a single secondary row at `<sm`; sticky section nav got the full a11y polish in one commit; `<TokenStatusBadge>` extracted from the duplicated desktop + mobile api-token surfaces.

## Token-budget impact

Coach token budget unchanged from v1.4.21. The prose rewrite swaps inline numbers for a sentinel block that the route strips before persisting; the per-turn cost remains ≈3 000 tokens for a full-scope snapshot, ≈600–700 for a single-source last-7-days narrowed turn. The 25 000 tokens-per-user-per-day cap is unchanged; ≈8 turns/day for a heavy full-scope user, plenty of room for a single-metric narrowed conversation.

## Branch model

The `develop` → `main` model (introduced in v1.4.20 F1) carried its second release cleanly. Long-lived `develop` accumulated 35 commits between v1.4.21 and v1.4.22 (W1 research, W2/W3/W4 implementation, W5 reconcile, release-prep). The release-merge into `main` was a single `--no-ff` with the full list of commits in the merge body. Future GHCR builds run on `main` only.

## Quality

- W1 research + W2/W3/W4 implementation + W5 reconcile across 35 commits on `develop` (`8606767` → `b094eaa`)
- 1-commit prettier pass on W5 touchpoints (`bbdc3fb`)
- 1-commit release-prep on `develop` (`d71e879`)
- Release-merge `005fed0` on `main`
- Tests: 2026 → 2111 unit (+85), 81 → 89 integration (+8), typecheck clean, lint baseline (15 warnings, no new)

## Carry-overs

The Coolify image-digest auto-deploy bug is still present and the workflow's auto-deploy step skipped because the `COOLIFY_WEBHOOK` / `COOLIFY_TOKEN` repo secrets aren't configured. The `.planning/coolify-auto-deploy-howto.md` runbook landed in W4 C3 documents the one-time UI toggle; bumping the secrets and flipping the toggle should drop the host-side retag fallback for v1.4.23. Worked around with the host-side retag procedure (`docker pull :1.4.22 → docker tag :latest → docker compose up -d --force-recreate`) on apps-01. Same fault that hit v1.4.19, v1.4.20, and v1.4.21.

The full v1.4.23 carry-over list lives in `.planning/v1422-backlog.md`. Highlights: sentinel parser malformed-enum hardening (Sr-M5, ~30 LOC, highest signal-to-effort ratio of the deferred items); analytics-route unbounded `findMany` paging; targets-route 7-pass sparkline coalesce; `CoachDrawer key={prefill}` controlled-prop refactor (Sr-HIGH-4); per-user prompt-tuning surface; medication_schedules.days_of_week schema-drift cleanup.

## Strategic next

v1.5 plan in `.planning/phase-W5-v1422-product-lead-review.md`. Headline is the iOS native client + Apple Health ingest contract — six phases, P1 first launch (bearer + refresh-token end-to-end with one login page + one dashboard widget) through P6 cross-user feedback aggregator cron. New measurement types (HRV, Sleep, Resting HR, Steps, BodyFat, Glucose) extend the Coach to PROMPT_VERSION 5.0.0 with conservative phrasing rules around clinical sleep-stage conclusions and HRV claims. Per-metric APNs alerts add `src/lib/notifications/senders/apns.ts`. The Insights page split (the ~9-surface orchestrator) lands in v1.5 P5 alongside the Vitals tile row, not v1.4.23, so the split maps to the exact sub-trees the Apple Health work touches.

## Deploy path used

Host-side SSH retag fallback. The GHCR tag-build (workflow run `25639069964`) succeeded, but the auto-deploy step skipped because the `COOLIFY_WEBHOOK` / `COOLIFY_TOKEN` repo secrets aren't configured. A Coolify MCP `force=true` deploy was queued (`owrpyzoi1ijsvhge0hfv25bw`) but didn't refresh the digest within the 5-minute polling window — same `:latest` pinning bug from v1.4.21. The `ssh apps-01 'docker pull :1.4.22 → docker tag :latest → docker compose up -d --force-recreate'` procedure flipped `/api/version` from `1.4.21` to `1.4.22` at 22:43:50 +02:00.
