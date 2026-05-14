# W10 Dead-Code Candidates — v1.4.25 Reconcile Input

Scan run: 2026-05-14 on branch `develop` (5 ahead of `origin/develop`).
Method: `find` + `grep` against `src/` + targeted Node scripts for
literal/template i18n-key extraction and exported-symbol cross-reference.
The `/api/insights/general-status` precedent (deleted in commit `edae569`
as part of W3f) confirmed the heuristic — its route file is gone but
`generateGeneralStatusForUser` lives on for the reminder worker, exactly
as the deletion commit's epitaph describes.

## Summary

| Category | Count | Confidence |
| --- | --- | --- |
| A — Definitely dead (delete-safe) | **10 items** | High — zero callers anywhere |
| B — Probably dead (deferred-callers possible) | **17 items** | Medium — iOS contracts, test-only, or background-job indirection |
| C — Stale comments | **3 items** | Medium — references to features that were never wired |
| D — Orphan schema | **0 items** | Schema is clean — every column has a code reference |

Plus an aggregate finding: **~414 dead i18n keys in `messages/en.json`**
(top 80 itemised below, full list in `/tmp/i18n_dead_v3.txt` during the
scan session). The reconcile reviewer can prune in bulk because the
`i18n-locale-integrity.test.ts` only checks EN↔DE drift, not whether
keys are consumed.

---

## Category A — Definitely dead

### A1. `src/app/api/export/full-backup.json/route.ts` (untracked)

Duplicate of `src/app/api/export/full-backup/route.ts` with a `.json`
suffix in the URL. The `export-section` UI calls only the suffix-less
variant.

```
grep -rln "/api/export/full-backup" src --include='*.ts' --include='*.tsx'
src/app/api/export/full-backup.json/route.ts   # the dupe itself
src/app/api/export/full-backup/route.ts        # the live one
src/components/settings/export-section.tsx     # UI calls suffix-less
```

Action: delete the four `.json`/`.csv` directories — they were added
locally but never reached `git add`. The four sibling dirs below
share the same finding.

### A2. `src/app/api/export/measurements.csv/route.ts` (untracked)

Same shape as A1 — dupe of `/api/export/measurements`. UI calls
suffix-less. **Untracked since 2026-05-14 13:37**.

### A3. `src/app/api/export/medications.csv/route.ts` (untracked)

Same shape as A1. **Untracked since 2026-05-14 13:37**.

### A4. `src/app/api/export/mood.csv/route.ts` (untracked)

Same shape as A1. **Untracked since 2026-05-14 13:37**.

### A5. `src/components/insights/insights-page-hero.tsx`

`@deprecated` since v1.4.20 phase B1, superseded by `<HeroStrip>`.
Comment claims dashboard preview keeps it alive — verify and delete:

```
grep -rln "InsightsPageHero" src --include='*.ts' --include='*.tsx'
src/components/insights/insights-page-hero.tsx                       # self
src/components/insights/hero-strip.tsx                               # comment-only ref
src/components/insights/__tests__/insights-page-hero.test.tsx        # tests of dead code
```

No production import. Action: delete the component + its test file.

### A6. `BASE_SYSTEM_PROMPT` constant in `src/lib/ai/prompts/base-system.ts:196`

```
/** @deprecated Use getBaseSystemPrompt(locale) instead. Kept for backwards compatibility. */
export const BASE_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT_DE;
```

Search result:
```
grep -rn "BASE_SYSTEM_PROMPT[^_]" src --include='*.ts' --include='*.tsx'
src/lib/ai/prompts/base-system.ts:196   # the export itself, only
```

No callers. Action: delete the export.

### A7. `INSIGHTS_SYSTEM_PROMPT` constant in `src/lib/insights/prompt.ts:106`

```
/** @deprecated Use getInsightsSystemPrompt(locale) instead. Kept for backwards compatibility. */
export const INSIGHTS_SYSTEM_PROMPT = INSIGHTS_SYSTEM_PROMPT_DE;
```

Search result:
```
grep -rn "INSIGHTS_SYSTEM_PROMPT[^_]" src --include='*.ts' --include='*.tsx'
src/lib/insights/prompt.ts:106          # the export itself, only
```

No callers. Action: delete.

### A8. `src/components/medications/intake-timeline.tsx` — `IntakeTimeline` component

Component is exported but never rendered anywhere in `src/`:

```
grep -rn "IntakeTimeline" src --include='*.ts' --include='*.tsx'
src/components/medications/intake-timeline.tsx:31:interface IntakeTimelineProps {
src/components/medications/intake-timeline.tsx:36:export function IntakeTimeline({
src/components/medications/intake-timeline.tsx:39:}: IntakeTimelineProps) {
```

Three hits — all inside the file itself. Action: delete.

### A9. `src/components/charts/compliance-charts.tsx` — `ComplianceCharts` wrapper

```
grep -rn "ComplianceCharts" src --include='*.ts' --include='*.tsx'
src/components/charts/compliance-charts.tsx:38:interface ComplianceChartsProps {
src/components/charts/compliance-charts.tsx:42:export function ComplianceCharts({ medications }: ComplianceChartsProps) {
```

Two hits — both inside the file. The component imports
`<ComplianceHeatmap />` and `<ComplianceLineChart />` which are
themselves live, but this wrapper is dead. Action: delete the wrapper;
keep the two children.

### A10. `queryKeys.insightsGeneralStatus` in `src/lib/query-keys.ts:33-34`

Live-route-deletion residue from W3f. The route file is gone, but the
query-key constant was left behind:

```
grep -rn "insightsGeneralStatus" src --include='*.ts' --include='*.tsx'
src/lib/query-keys.ts:33                        # the constant
src/lib/__tests__/query-keys.test.ts:19         # the matching test
```

The only consumer is its own integrity test. Action: drop the constant
+ the matching test assertion.

---

## Category B — Probably dead (deferred-callers possible)

### B1. iOS adapter routes — DO NOT TOUCH

Per the v1.4.23 release outcome ("backend foundation for iOS Health app
integration: Apple Health enum + Measurement.source + batched ingest"),
these endpoints have no web-frontend caller by design — they exist for
the v1.5 iOS Swift app to consume against a frozen contract. **Listed
here so the W10 reconcile reviewer is aware they look orphan but
aren't.**

| URL | File | iOS notes |
| --- | --- | --- |
| `/api/dashboard/summary` | `src/app/api/dashboard/summary/route.ts` | doc: "Aggregator endpoint for the iOS DashboardSummary view" |
| `/api/insights/cards` | `src/app/api/insights/cards/route.ts` | doc: "iOS adapter over `/api/insights/comprehensive`" |
| `/api/insights/correlations` | `src/app/api/insights/correlations/route.ts` | doc: "placeholder iOS endpoint" |
| `/api/integrations/healthkit` | `src/app/api/integrations/healthkit/route.ts` | doc: "HealthKit (iOS) integration config" |
| `/api/measurements/by-external-ids` | `src/app/api/measurements/by-external-ids/route.ts` | doc: "iOS deletion reconciliation" |
| `/api/medications/intake-summary` | `src/app/api/medications/intake-summary/route.ts` | likely iOS — uses `toBerlinDayKey` aggregator |

**Action: KEEP.** These are load-bearing for v1.5 even though they
look like zombies.

### B2. External-caller webhooks — KEEP

| URL | File | External caller |
| --- | --- | --- |
| `/api/internal/deploy-webhook` | `src/app/api/internal/deploy-webhook/route.ts` | Coolify deploy-status callback (phase C2 / v1.4.15) |
| `/api/monitoring/csp-report` | `src/app/api/monitoring/csp-report/route.ts` | Browser CSP `report-uri` |
| `/api/withings/callback` | `src/app/api/withings/callback/route.ts` | Withings OAuth |
| `/api/withings/webhook` | `src/app/api/withings/webhook/route.ts` | Withings push |
| `/api/telegram/webhook` | `src/app/api/telegram/webhook/route.ts` | Telegram updates |
| `/api/integrations/moodlog/webhook` | `src/app/api/integrations/moodlog/webhook/route.ts` | MoodLog push |

**Action: KEEP.** Confirmed external callers.

### B3. `/api/audit-log` (user-facing)

```
grep -rn 'fetch.*"/api/audit-log"\|/api/audit-log[")]' src --include='*.ts' --include='*.tsx'
# zero hits in components/. The admin variant /api/admin/audit-log IS used.
```

The route returns the current user's `auditLog` entries (limit/offset
query), but no surface in `/settings/audit-log` or anywhere else
fetches it. The OpenAPI spec documents it — could be a documented iOS
surface in waiting OR a wholly orphaned endpoint from before
`/settings/auditLog*` keys moved to inline rendering.

**Action: confirm with reviewer.** If no near-term consumer is
planned, downgrade to A11.

### B4. `/api/admin/ai-settings` (admin GET/PUT)

Defines GET + PUT for `AppSettings.adminAiKeyEncrypted` / model /
baseUrl, but no UI consumes it. The live admin AI surface is
`/api/admin/ai-quality` (read-only summary) — settings appear to be
configured via env vars + `AppSettings` row only, never via an admin
form.

```
grep -rn "ai-settings\|aiSettings" src/components --include='*.tsx'
# zero hits
```

**Action: confirm with reviewer.** Either wire the admin form (a
planned UI) or delete the endpoint.

### B5. `/api/admin/backup/test` (singular, smoke test)

```
grep -rn "backup/test\|BackupTestRun" src --include='*.ts' --include='*.tsx'
src/app/api/admin/backup/test/route.ts          # the route itself only
```

The route comment says "admin-only smoke test for the off-host backup
target". No admin UI button calls it. The live family is
`/api/admin/backups/...` (plural). Likely leftover from v1.4.x backup
work that was replaced by the plural-path family.

**Action: confirm with reviewer.** Strong delete candidate.

### B6. `/api/admin/status-overview`

Returns a status snapshot used by the admin dashboard. Only
`/api/admin/backups/route.ts:63` references it in a comment
("Mirrors the value surfaced by `/api/admin/status-overview`"), no
fetch caller. The admin dashboard might consume it via React Query
inline without a string literal — verify before deletion.

```
grep -rn "status-overview" src --include='*.ts' --include='*.tsx'
src/app/api/admin/backups/route.ts:63   # comment only
src/app/api/admin/status-overview/__tests__/route.test.ts:*  # self-tests
```

**Action: confirm with reviewer.** Possibly orphan, possibly
inline-consumed in admin components without a quoted URL.

### B7. `/api/import` (user-facing import)

```
grep -rn '/api/import"\|/api/import?\|fetch.*import' src/components --include='*.tsx'
# zero hits in components/
```

Tests cover it but no UI calls it. Looks like a deferred backup-restore
sibling. **Action: confirm.**

### B8. `/api/settings/account` (DELETE account)

```
grep -rn '/api/settings/account' src/components --include='*.tsx'
# zero hits — no "Delete my account" UI calls it
```

Doc-comment promises cascading account deletion but no settings page
exposes a delete-account button. Either dead OR a planned surface.

**Action: confirm.**

### B9. `/api/monitoring/glitchtip/test` + `/api/monitoring/umami/test`

Both exist as test/smoke endpoints. No UI button triggers them — the
admin variants `/api/admin/monitoring/glitchtip-test` and
`/api/admin/monitoring/umami-test` exist separately AND are also
orphans by the same scan (but those are the admin-callable surfaces).

These four collectively suggest one duplicated set. **Action: ask
reviewer which two to keep.**

### B10. `src/lib/ai/mock-client.ts` — `MockAIProvider`

Used only by two integration tests (`recommendation-card-integration.test.tsx`,
`recommendation-card-confidence-integration.test.tsx`). No production
import path.

**Action: KEEP.** Legitimate test fixture.

### B11. `src/lib/openapi/registry.ts`

Used only by `scripts/check-openapi.ts` and `scripts/generate-openapi.ts`.
No `src/` import.

**Action: KEEP.** Legitimate build-tool consumer.

---

## Category C — Stale comments

### C1. `@deprecated v1.4.20` markers without removal action

Three `@deprecated` annotations exist with claims of "kept for
backwards compatibility":

```
grep -rn "@deprecated" src --include='*.ts' --include='*.tsx'
src/components/insights/insights-page-hero.tsx:10   # superseded by HeroStrip
src/lib/insights/prompt.ts:105                       # superseded by getInsightsSystemPrompt
src/lib/ai/prompts/base-system.ts:195                # superseded by getBaseSystemPrompt
```

All three have ZERO production callers. These are listed in Cat A —
the **comment** is the stale residue, the **code** is the dead artifact.

### C2. `src/app/api/insights/targets/route.ts:807` — orphan ref to `general-status`

```
// general-status}.ts already enforce this attribution; this
```

Half-quoted reference; the deleted route's lib (`general-status.ts`)
remains so this comment is still semantically accurate but the typo
`general-status}.ts` (note the stray brace) suggests this comment
needs a cleanup pass.

### C3. Removed-feature mentions in seed/docs

None found in `src/`. The `git log` for the W3f deletion already
embeds the rationale in the commit message — no further code-comment
cleanup needed beyond C1/C2.

---

## Category D — Orphan schema

A schema field scan against `prisma/schema.prisma` (210 columns
across all models) cross-referenced with every `*.ts` / `*.tsx` file
in `src/` returned **zero** fields referenced 0 times in code. Marc's
schema is clean — every column has at least one read/write site.

Migrations also align — no migration introduces a column that's later
dropped without a follow-up migration.

**No Cat D candidates.**

---

## i18n dead-key aggregate

Final scan with template-prefix awareness
(`/tmp/i18n_dead_v3.mjs`) flagged **414 keys** in `messages/en.json`
that do not appear as any of:

- A literal `"foo.bar.baz"` / `'foo.bar.baz'` / `` `foo.bar.baz` `` in
  `src/**/*.ts(x)`
- A tail-match of the full path (subtree-scoped translators)
- Covered by a template-literal prefix (e.g. `\`medications.site${x}\``
  covers `medications.siteAbdomenLeft`)

Top 20 namespaces:

```
settings: 114
admin: 75
classifications: 69
medications: 21
onboarding: 21
dashboard: 15
charts: 14
common: 12
bugreport: 12
auth: 10
notifications: 10
targets: 9
measurements: 7
comparison: 6
mood: 5
thresholds: 4
achievements: 4
format: 3
gettingStarted: 2
nav: 1
```

**Notable confirmed-dead keys** (spot-checked individually; zero
references anywhere in `src/`):

```
common.success
common.confirm
common.notLoggedIn
common.noAccess
common.replace
nav.charts
auth.loginTitle
auth.registerTitle
auth.passkeyFailed
auth.passwordStrength
auth.strengthWeak
auth.strengthFair
auth.strengthGood
auth.strengthStrong
auth.strengthVeryStrong
dashboard.subtitle
dashboard.days30Short
dashboard.lastMeasurement
dashboard.noMeasurements
dashboard.trendUp
dashboard.trendDown
dashboard.trendStable
dashboard.quickEntry
dashboard.complianceGood
dashboard.complianceLow
medications.markTaken
medications.markSkipped
medications.noMedications
medications.glp1Headline
medications.glp1NextInjection
charts.title
charts.subtitle
charts.timeRange
charts.days7
charts.days30
charts.days90
charts.targetRanges
mood.sourceManual
mood.sourceWeb
mood.sourceTelegram
mood.sourceDaylio
mood.noEntries
settings.title
settings.subtitle
settings.security
settings.ai.title
settings.ai.disconnect
settings.ai.connectChatgptCta
onboarding.welcome
onboarding.skip
onboarding.medicationsTitle
auth.loginTitle             # login page renders auth.loginWithPasskey / auth.password instead
```

**Caveat on `classifications.*` keys** (69 of the 414): the
`i18n-locale-integrity` allowlist mentions four of them
(`classifications.bp.Optimal`, `classifications.bp.Normal`,
`classifications.pulse.Normal`, `classifications.bodyFat.Fitness`)
as legitimate EN==DE==key cases. The `classifications.ts` lib returns
English string literals directly (no i18n lookup), so the keys in
en.json are wholly redundant. Removing them is safe as long as the
allowlist in `i18n-locale-integrity.test.ts` is updated in the same
commit.

**Caveat on dynamic-template lookups**: the v3 scan caught 27
template-prefix patterns including `medications.site`,
`settings.testConnection.errors.`, `coach.http.`,
`comparison.baseline.`, `targets.label.`, `targets.status.`,
`achievements.badges.`, and `insights.coach.metric.`. Keys under
those prefixes are correctly preserved. The 414 dead-key count
**excludes** any subtree under one of those prefixes.

**Recommended action**: the W10 reconcile commit should drop the 414
keys from both `messages/en.json` AND `messages/de.json` (the locale
drift test will fail if only one side is touched). For caution, start
with the high-confidence top 200 (the `common.*`, `auth.*`,
`dashboard.*`, `charts.*`, `medications.*` block above) — that's
already a noticeable size win and lets the reconcile reviewer audit
the rest in a follow-up.

---

## Highest-confidence deletions (priority order)

For the W10 reconcile's single atomic commit, propose this order:

1. **A1–A4** — drop the four untracked `*.csv` / `*.json` route
   directories. Zero risk (they were never committed).
2. **A8 + A9** — delete `intake-timeline.tsx` + `compliance-charts.tsx`
   plus their tests. Each is a single-file delete with no inbound
   references.
3. **A5** — delete `insights-page-hero.tsx` + matching test. Update
   the comment in `hero-strip.tsx` that references it.
4. **A6 + A7** — drop the two `@deprecated` prompt-constant exports.
   Single-line deletes.
5. **A10** — drop `queryKeys.insightsGeneralStatus` + its test
   assertion. Cleans up W3f's residue properly.
6. **C2** — fix the half-quoted `general-status}.ts` comment in
   `targets/route.ts:807`.
7. **i18n** — drop the 200 highest-confidence dead keys from both
   locale files (after a second-pass review).

Items in Category B should NOT be touched in W10. Bring them to the
reviewer separately so iOS-contract and admin-form decisions get
their own discussion thread.

---

## Verification commands the reviewer can re-run

```bash
# Confirm the four untracked .csv/.json export routes are still uncommitted
git status src/app/api/export/

# Confirm orphan components have only self-references
grep -rn "IntakeTimeline\|ComplianceCharts" src --include='*.ts' --include='*.tsx'

# Confirm @deprecated constants have only their own export-site references
grep -rn "BASE_SYSTEM_PROMPT[^_]\|INSIGHTS_SYSTEM_PROMPT[^_]\|InsightsPageHero" src --include='*.ts' --include='*.tsx'

# Confirm general-status query-key has only test references
grep -rn "insightsGeneralStatus" src --include='*.ts' --include='*.tsx'

# Confirm iOS adapter endpoints are documented as iOS-only
head -25 src/app/api/dashboard/summary/route.ts \
        src/app/api/insights/cards/route.ts \
        src/app/api/insights/correlations/route.ts \
        src/app/api/integrations/healthkit/route.ts \
        src/app/api/measurements/by-external-ids/route.ts
```
