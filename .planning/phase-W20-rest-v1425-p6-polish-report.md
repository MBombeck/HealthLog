# Phase W20-rest — v1.4.25 P6 polish cluster

**Wave**: 5 cleanup (parallel with W15 + W18)
**Scope**: 11 P6 polish items per `.planning/v1426-backlog.md`. W20a (single-line headings + inline trend arrow + baseline alignment) already shipped earlier.
**Branch**: `develop`
**Pre-state**: `ab54d86b` (Wave 4b closeout)

## Strict-rule reminders honoured

- No `messages/*.json` edits (W15 territory).
- No CSS hsl(var) anti-pattern files, charts core, errors, audit-log, deviceType, drift-guard, simplifier S1-S12 (W18 territory).
- No Coach prompt YAMLs (W19c-Safety stable).
- No `Co-Authored-By: Claude` trailer.
- No `--no-verify`.

## Shipped (3 commits)

### 1. `c80e0a08` — P6-1 Pearson incomplete-beta replacement

`fix(insights): exact Student's-t p-value via incomplete beta`

Replaced the standard-normal approximation of the t-distribution tail with a rigorous regularised-incomplete-beta evaluation. Numerical Recipes §6.4 Lentz continued-fraction recurrence + Lanczos lnGamma prefactor. The two-sided p of |t| with df = I_x(df/2, 1/2) for x = df / (df + t^2); symmetric-tail identity I_x(a,b) = 1 - I_{1-x}(b,a) keeps the recurrence in its convergent half-plane.

Reference values agree with R `pt()` to ~1e-4 across the surfacing range:
- r=0.5, df=18 → exact p ≈ 0.0248 (R: 0.02493, our impl: 0.02477).
- r=0.3, df=18 → exact p ≈ 0.1988 (R: 0.19905).
- r=0.7, df=18 → exact p ≈ 0.00059 (R: 0.00060).

Side effect: the pre-existing "noise → no significance" fixture had r=-0.494 (a real moderate correlation) that the old normal-approx loosely accepted but the exact survival correctly flags as p≈0.027. Fixture regenerated against a truly orthogonal LCG-derived stream (r≈0.0005).

Surface: `src/lib/insights/correlations.ts` + `src/lib/insights/__tests__/correlations.test.ts`. Three new exact-p reference tests. Touch-disjoint with W18 (chart files) and W15 (i18n).

Tests: 20 pass (correlations.test.ts), 106 pass (all of `src/lib/insights/`).

### 2. `e23dd28` — P6-3 Coolify auto-deploy maintainer toggle

`ci(coolify): explicit maintainer toggle for auto-deploy gate`

Three releases in a row shipped via host-side SSH retag fallback because the COOLIFY_WEBHOOK / COOLIFY_TOKEN secrets were absent, the deploy step warned and exited 0, and the workflow stayed green. Silent miss → surfaced only when `/api/version` refused to advance.

`vars.COOLIFY_AUTO_DEPLOY` repository variable now disambiguates:
- `on` — fail the step when secrets are absent (loud catch on next release).
- `off` — unconditional skip with a notice (host-side SSH is the chosen path).
- unset / other — legacy warn-and-skip behaviour.

Variable lives under repo Settings → Secrets and variables → Actions → Variables (intentionally readable). Backward-compatible default; flipping the toggle to `on` turns silent miss into a noisy error.

Surface: `.github/workflows/docker-publish.yml`. YAML parse verified.

### 3. `766b64e` — P6-8 GitHub translation-feedback issue template

`feat(github): translation-feedback issue template`

The maintainership banner that surfaces on AI-initial locales (FR / ES / IT / PL) linked to `issues/new?template=translation.md`, but the template file was never added to the repo. GitHub fell back to a blank issue body and the funnel produced unstructured reports.

New `translation.yml` form asks for locale, the route/component where the wording appeared, current vs. suggested phrasing, and the kind of issue (grammar, register, terminology, ...). Banner URL moves to `template=translation.yml` to match the filename.

Surface: `.github/ISSUE_TEMPLATE/translation.yml` (new), `src/components/i18n/maintainership-banner.tsx` (URL update only). No i18n string churn (banner copy is unchanged).

Tests: 6 pass (`src/components/i18n/__tests__/maintainership-banner.test.tsx`); no test pins the URL.

## Deferred to v1.4.26 (8 items + rationale)

### P6-2 — Sentinel parser observability for HealthKit envelopes
**Defer.** No HealthKit envelope parser exists yet — the v1.4.23 schema landed but the actual XML / FHIR envelope parsing is scheduled for v1.5 iOS Swift sprint against the locked contracts. Extending the W5 `SentinelParseResult.malformedEntries[]` pattern to HealthKit envelopes is premature before the parser surface exists. Revisit when the iOS adapter (e.g. `/api/integrations/healthkit/import-envelope`) lands.

### P6-4 — Coach `lastYear` window option
**Defer — spec ambiguity + UI integration spans i18n.** The enum extension in `src/lib/ai/coach/types.ts` is touch-disjoint clean, and `windowToDays()` could trivially map `lastYear → 365`. But:

1. **Semantic ambiguity**. Chart-side `lastYear` (`src/lib/dashboard-layout.ts`) means "overlay the matching window from 365 days earlier" — a comparison shift, not a window length. Coach-side `last7days / last30days / last90days / allTime` are all window lengths from now back. `allTime` already caps the timeline at 365 days. A Coach `lastYear` should mean either:
   - "the same 30-day window, shifted 365 days back" (comparison semantics), or
   - "calendar year YYYY-1" (Jan 1 to Dec 31 of last year), or
   - "rolling 365 days back from today" (which `allTime` already covers).
   Each meaning produces a different snapshot prompt and a different system-prompt vocabulary update.

2. **9 surfaces touch the existing union**: `mood-chart.tsx`, `mini-window.ts`, `generate-insight.ts`, `schema.ts`, `types.ts`, `coach/types.ts`, `coach/system-prompt.ts` (EN + DE — prompt-text grammar), `rationale-schema.test.ts`. Most are NOT Coach-specific (they're chart windows + insight dataWindow rationale). Extending only the Coach union without the others creates an inconsistent contract.

3. **UI exposure requires `messages/*.json`** — the picker calls `t(\`insights.coach.window.${w}\`)`, which needs a `lastYear` key in six locales. W15 owns that file this wave.

Recommend: Marc decides which semantic before v1.4.26 wave splits this into a feature-shaped phase rather than a polish item.

### P6-5 — Coach prefill on health-score row tap
**Defer.** Per-row callback (tap row → "tell me more about my mood component") requires plumbing through the hero strip → health-score-card → coach drawer with a new prefill prop. The hero-strip surface touches Coach drawer state (`coach-drawer.tsx` is touched by the W19c-stable footprint). Risk of merge conflict with W19c-stable contracts and the broader Coach state machine. Revisit when the post-Wave-4b Coach surface is locked.

### P6-6 — Per-night sleep-stage stacked column chart
**Defer.** Requires a new server endpoint that returns per-day × per-stage time series (the current `/api/insights/sleep` returns aggregate + perNight only for the trailing 7/14/30 nights). Touches `src/components/insights/sleep-stage-stacked-bar.tsx`, which is W18's surface this wave (P4-2 chart-tz audit). Cannot ship in parallel. Revisit in v1.4.26 alongside the iOS body-composition sub-page work.

### P6-7 — Locale-native date format ordering
**Defer.** Sits entirely in `messages/{fr,es,it,pl}.json` `format.dateShort` / `format.timeShort` / `format.dateTime` keys. W15 territory this wave.

### P6-9 — Hand-review FR/ES/IT/PL prose on high-traffic surfaces
**Defer.** Sits entirely in `messages/{fr,es,it,pl}.json`. W15 territory this wave. Per the v1.4.25 W9e report the prose rewrite is a per-locale L-effort item that wants a native-speaker review pass anyway — not a polish surface.

### P6-10 — Cat-B endpoint triage
**Defer with maintainer recommendations.** The 17 endpoints flagged need human go/no-go per `.planning/research/w10-dead-code-candidates.md` §Category B. Listed below with my recommended action:

| Endpoint | Recommendation | Rationale |
| --- | --- | --- |
| `/api/audit-log` (user-facing) | **wire UI in v1.4.26** | `/settings/audit-log` placeholder exists; the route returns the user's own entries — a natural settings sub-page. Cost: ~80 LOC for a paginated list. Documented as iOS-adapter-ready in the OpenAPI gate. |
| `/api/admin/ai-settings` (GET/PUT) | **delete** | Live admin AI surface is `/api/admin/ai-quality` (read-only). Settings are configured via env vars + AppSettings row directly. PUT path is a foot-gun (in-flight key rotation could break running providers). |
| `/api/admin/backup/test` (singular) | **delete** | Plural `/api/admin/backups/...` is the live family. Singular endpoint is a leftover. |
| `/api/admin/status-overview` | **keep** (verify inline-consumer first) | Admin dashboard likely consumes via React Query without a string-literal URL. Run a quoted-grep + a `git log` on `src/app/admin/` before deleting. |
| `/api/import` | **delete** | Tests cover it but no UI calls it. Looks like a deferred backup-restore sibling that never landed. If Marc decides it's a planned restore surface, mark with a `// PLANNED` comment. |
| `/api/settings/account` (DELETE account) | **delete OR wire** | Doc-comment promises cascading account deletion. No settings page exposes a delete-account button. GDPR-adjacent — Marc should wire a settings affordance for the iOS launch or delete the route. |
| `/api/monitoring/glitchtip/test` + `/api/monitoring/umami/test` | **delete the non-admin pair** | The `/api/admin/monitoring/{glitchtip,umami}-test` variants are the admin-callable surfaces (also orphan by static scan, but those are the ones an admin button would call). The non-admin pair is a duplicate. |

No code touched here — endpoint deletion requires Marc's per-endpoint go-ahead. Recommendation feeds into a v1.4.26 dedicated cleanup phase.

### P6-11 — Mood verbal labels follow-up
**Already shipped in v1.4.25; no remaining surfaces.** The v1.4.25 polish pass (W11 "Refactor" CHANGELOG bullet) wired:
- `MOOD_LABEL_KEYS` + `t(MOOD_LABEL_KEYS[mood])` in `src/components/mood/mood-list.tsx` (desktop table + mobile rows + Select filter).
- `formatMoodTick` + `formatTooltipValue` in `src/components/charts/mood-chart.tsx` (y-axis ticks + tooltip rows).
- Mood-form already uses `labelKey` per level.

No remaining numeric-only mood display surfaces found in `src/components/` or `src/app/insights/`. The Coach key-value parser emits `mood: 4.1 [/5]` per the system-prompt grammar — that line is the prompt's load-bearing contract with the model, not user-facing UI. Effectively closed.

## Test summary

| Surface | Tests run | Pass | Fail |
| --- | --- | --- | --- |
| `src/lib/insights/__tests__/correlations.test.ts` | 20 | 20 | 0 |
| `src/lib/insights/` (full directory) | 106 | 106 | 0 |
| `src/components/i18n/__tests__/maintainership-banner.test.tsx` | 6 | 6 | 0 |
| `pnpm typecheck` (full repo) | — | clean | — |
| `pnpm lint` (full repo) | — | clean | — |

## v1.4.26 backlog additions

- **P6-1 follow-up**: now that exact incomplete-beta is in place, consider revisiting `MIN_PAIRED_N`. The v1.4.23 H6 raise from 14 to 20 was defence-in-depth for the loose normal approximation; the exact survival is accurate at every df. A future product-lead memo (post-iOS) may lower MIN_PAIRED_N back to 14 if usage data from the v1.4.16 B5e feedback aggregator shows users miss the borderline cards. Pin: the n=15 surfacing-gate test in `correlations.test.ts` is the touch-point.
- **P6-4 spec clarification**: Marc to decide `lastYear` semantics for Coach scope before the next P6 wave.
- **P6-5 plumbing prerequisite**: hero-strip → coach-drawer prefill callback hierarchy needs a Wave-4b post-mortem review first.
- **P6-10 endpoint cleanup phase**: dedicated phase to act on the 7 recommendations above, plus the audit-log UI wire-up.

## Parallel-wave coordination notes

During this work I observed multiple commits landing in parallel from other Wave-5 agents:
- `f16d4b3f fix(api): rename coach.batch.too_large to measurement.batch.too_large` (P4-3, W18).
- `fbb3c2c4 fix(charts): anchor sleep-stage day-tick Date to UTC` (P4-2 sleep-stage UTC; that commit incorrectly captured my Pearson incomplete-beta delta in the diff while carrying the sleep-stage message). The author then `git reset HEAD~1` and re-committed under `fddb9754 chore(i18n): drop 380 dead translation keys` (P1-1, W15).

My subsequent Pearson commit (`c80e0a08`) re-staged the same Pearson delta cleanly with the correct message. The duplicate Pearson code in the abandoned `fbb3c2c4` is no longer in HEAD's ancestry (reset moved past it). Reflog entry `HEAD@{2}` documents the abandoned commit if archaeology is needed later.

No destructive ops requested; no force-push; no rebase. All commits are forward-merge.

## Files touched

- `src/lib/insights/correlations.ts` (+~130 LOC: regularizedIncompleteBeta, betaContinuedFraction, lnGamma).
- `src/lib/insights/__tests__/correlations.test.ts` (+3 tests, 1 fixture regen).
- `.github/workflows/docker-publish.yml` (+29 LOC: COOLIFY_AUTO_DEPLOY var gate).
- `.github/ISSUE_TEMPLATE/translation.yml` (new, 81 LOC).
- `src/components/i18n/maintainership-banner.tsx` (URL `translation.md` → `translation.yml`).
- `.planning/phase-W20-rest-v1425-p6-polish-report.md` (this report).
