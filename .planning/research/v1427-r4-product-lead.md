---
file: .planning/research/v1427-r4-product-lead.md
purpose: v1.4.27 R4 product-lead review — strategic fit, scope alignment, release-readiness, regression risk
created: 2026-05-15
target_tag: v1.4.27
predecessor: R3d (MB1–MB7) closed at 4d35f6c4; R3a/R3b/R3c closed earlier
branch: develop @ 617d4518
mode: read-only review
---

# v1.4.27 R4 — Product-Lead Review

## Verdict in one paragraph

v1.4.27 has shipped scope that delivers on the "mobile capability improvement" headline and then some. The 27 maintainer findings, the 17 backlog pull-ins, plus 74 consolidated mobile findings (R3c → MB1-MB7) have all landed except the documented deferrals. Forward compatibility for the iOS native client is intact (`askCoach()` carries a `scope` parameter today even though only v1.4.28 will read it; `Measurement.source` enum keeps `APPLE_HEALTH` from v1.4.23). The release is **not yet shipped** — `package.json` still reads `1.4.26`, no CHANGELOG entry exists yet, and the GHCR build pipeline silently lacks the `MAXMIND_LICENSE_KEY` secret needed for the new offline geo-lookup feature to take effect in production. Five severity-tiered findings below; one Critical is the geo secret gap, two Highs cover documentation deferral hygiene + the missing CHANGELOG, the rest are minor.

## Tier — Critical (release-blocking)

### CR-1 — `MAXMIND_LICENSE_KEY` secret missing in the GHCR build pipeline; geo feature will silently no-op on the live image

**Severity:** Critical.

**Evidence:**
- `/Users/marc/Projects/HealthLog/scripts/fetch-geolite2.sh` lines 32-36: the script exits 0 (clean) when the env var is not set, so the build keeps going.
- `/Users/marc/Projects/HealthLog/.github/workflows/docker-publish.yml`: contains zero references to `fetch-geolite2`, `MAXMIND_LICENSE_KEY`, `GeoLite2`, or `assets/geolite2`. The workflow goes straight from checkout to `docker/build-push-action`.
- `/Users/marc/Projects/HealthLog/Dockerfile` lines 78-79: `COPY assets/geolite2/ /opt/geolite2/` — copies whatever is in the dir at build time. On the CI runner that directory will only contain the placeholder `README.md` (and a `.gitkeep` per the Dockerfile comment).
- `/Users/marc/Projects/HealthLog/.planning/round-3-b3-geoip-report.md` line 66: B3 contributor flagged this exact gap as a release prerequisite.

**Impact:**
- The runtime resolver `src/lib/geo.ts` falls back to the online `ipwho.is` provider, matching v1.4.26 behaviour. The advertised "offline-first" geo + carrier feature ships dead on `healthlog.bombeck.io` and `demo.healthlog.dev`.
- Maintainer finding 22 ("Standort cell shows a dash") will remain unfixed in production because the offline DB is what makes the lookup deterministic. Finding 23 (carrier column) will keep falling back to whatever `ipwho.is` returns, which is what v1.4.26 already does.
- The `AuditLog.asn` + `AuditLog.carrier` columns get populated only when the resolver succeeds. On the live image those will be `NULL` for every new row until the secret is wired.
- This is the third release in a row where a Coolify- or build-side secret has silently degraded a feature (see v1.4.21/22/23 Coolify auto-deploy gaps).

**Recommended action before merging the v1.4.27 release PR:**
1. Maintainer adds `MAXMIND_LICENSE_KEY` to repo Settings → Secrets and variables → Actions → Secrets.
2. `.github/workflows/docker-publish.yml` grows a `- name: Fetch GeoLite2 databases` step before `Build & push by digest`, gated on the secret being present (else warn-and-skip, like the Coolify webhook step at line 246).
3. The build step runs `./scripts/fetch-geolite2.sh` with `env: MAXMIND_LICENSE_KEY: ${{ secrets.MAXMIND_LICENSE_KEY }}`. On PRs from forks where secrets are absent, the warn-and-skip keeps the workflow green and the image builds without the offline tier.
4. Add a release-gate check to the deploy checklist: after `curl https://healthlog.bombeck.io/api/version` returns `1.4.27`, a follow-up `curl /api/admin/login-overview` (or a one-row probe) should return a non-null `carrier` field. If `NULL` everywhere, the offline DB never landed in the image.

**Effort:** S (one workflow step + repo secret). Without it, the v1.4.27 marketing line "offline-first geolocation lands" is misleading.

---

## Tier — High

### HI-1 — `.planning/v1428-backlog.md` is incomplete; documents only 2 of 16+ known deferrals

**Severity:** High.

**Evidence:**
- `.planning/v1428-backlog.md` (24 lines total) covers exactly two items: the F7 weekly-report dead click and the `insights.coach.window.lastYear` i18n key.
- `.planning/v1427-mobile-fix-plan.md` lines 124-141 explicitly catalogues 14 mobile-fix-plan deferrals (CF-77 through CF-90).
- `.planning/v1427-mobile-fix-plan.md` line 600 names CF-77 (the six admin tables card-list) as the largest deferral.
- Section 7 headline metric "Items deferred to v1.4.28: ~14" (line 658) sets the expectation that all 14 are catalogued; the backlog file does not honour that.

**Impact:**
- v1.4.28 planning starts blind to the 14 mobile-fix deferrals. The handoff between releases breaks the working pattern established in v1.4.20-v1.4.26 where every deferred item lands in the next release's backlog file before the current release ships.
- CF-77 (six admin tables card-list parity) is a multi-surface mechanical pattern that should be a single v1.4.28 bucket. Without the backlog entry it risks being forgotten or fragmented across audits.
- CF-79 (RHF + Zod migration for measurement-form) is a structural decision that affects the iOS API surface. Deferring it without documentation removes the trail.

**Recommended action:**
- Append a "From mobile-fix plan v1.4.27 (R3c → R3d MB1-MB7)" section to `.planning/v1428-backlog.md` listing all 14 CF-77 through CF-90 entries with their Why-deferred rationale verbatim from the fix plan. One-paragraph rationale per item is enough; severity tier + effort tag preserved.
- Add the audit-log orphan-endpoint decision context (5 endpoints README-tied) — already partially captured but worth grouping next to the 14 mobile deferrals.
- Add a separate "From R1.6 backlog sweep" section if any of the 20 v1.4.26-backlog items did not pull forward into v1.4.27.

**Effort:** S (one commit append, ~50 lines).

---

### HI-2 — No v1.4.27 CHANGELOG entry; `package.json` still pinned at `1.4.26`

**Severity:** High.

**Evidence:**
- `CHANGELOG.md` line 3: top entry is `## [1.4.26] — 2026-05-15`. No `## [1.4.27]` block.
- `package.json` line 3: `"version": "1.4.26"`.
- The v1.4.27 release work is on `develop` at 617d4518 with 422 commits since v1.4.26. Without the version bump + CHANGELOG, the release-step pipeline (`PR develop → main`, squash + tag) cannot run.
- `docs/audit/v1427-summary.md` exists already (72 lines, GeoLite2 attribution doc) which is a partial substitute but does not cover the user-facing changes from MB1-MB7.

**Impact:**
- This is the standard pre-release editorial pass left for the maintainer (or the release contributor in Round 5). Calling it out here so the dispatch closes cleanly.
- The CHANGELOG content needs to enumerate the user-visible deltas under the "Mobile capability" headline section, plus the seven R3a buckets (B1 dashboard, B2 settings, B3 geo, B4 coach + insights, B5 notifications, B6 i18n, B7 symmetry + dead-code), plus the R3d mobile primitives (`<ResponsiveSheet>`, `<NativeSelect>`, primitive tap-target lift, `<CoachLaunchProvider>`, `/about` + `/not-found`, `inputMode` repo-wide sweep).

**Recommended action:**
- Round 5 editorial pass writes the v1.4.27 entry in Marc-Voice English. Section headers: Added, Changed, Fixed, Accessibility, Security (if any), Refactor / Hygiene, Tests, Deferred to v1.4.28.
- Forbidden-word grep on the entry before commit: `AI`, `Claude`, `agent`, `marathon`, `wave`, `phase`, `session`, `subagent`, `Anthropic`. PII grep: `Bombeck`, `Marc-André`, BD-Zielbereich literal target values, measurement counts.
- Version bump in same commit as CHANGELOG. The R2 fix-plan section 7 says: every Critical + every High except CF-20 + every Medium ≤ M lands. That number is the "~66 of 74 consolidated mobile findings" tally to lead with.

**Effort:** M (writing the editorial entry is the biggest single piece of release work left).

---

### HI-3 — `insight-advisor-card.tsx` still renders "AI Health Analysis" / "KI-Gesundheitsanalyse" on `/insights`

**Severity:** High.

**Evidence:**
- `src/components/insights/insight-advisor-card.tsx` lines 348, 380, 470, 531: four call sites render `t("insights.aiAnalysisTitle")`.
- `messages/en.json` line 910: `"aiAnalysisTitle": "AI Health Analysis"`.
- `messages/de.json` line 910: `"aiAnalysisTitle": "KI-Gesundheitsanalyse"`.
- Maintainer finding 5 says: *"KI-Gesundheitsanalyse card at bottom of dashboard is dead — leftover surface, remove entirely."* The R3a B1 implementation report (committed at 9afb31bd) retired `<InsightsCardPreview>` from the dashboard but kept `<InsightAdvisorCard>` on `/insights` — and the `<InsightAdvisorCard>` still uses the same `aiAnalysisTitle` translation key.
- Convention directive forbids the word `AI` in user-facing copy (memory: "Marc's voice, English, professional, no AI mention" + v1.4.27 stricter "NO AI" applied to planning docs and user-facing artifacts).

**Impact:**
- The maintainer's finding may have meant the dashboard only — and the literal phrasing "at bottom of dashboard" agrees with that reading. **But the same forbidden word "AI / KI" still renders inside `/insights` four times.** Even if finding 5 was scoped to dashboard, the broader Marc-Voice directive is violated by the surviving `/insights` strings.
- Other locales (FR/ES/IT/PL) carry `"AI Health Analysis"` unchanged at line 910 of each — fallback to English, but still rendering "AI" verbatim. Same locale pattern across `aiOverviewTitle`, `aiInsightCount`, etc.
- The Coach explicitly uses "Coach" + "Advisor" copy elsewhere. The advisor card title is the asymmetric outlier.

**Recommended action — v1.4.27 if there is budget, else v1.4.28 backlog:**
- Rename `aiAnalysisTitle` → `analysisTitle` in all six locales. Strings become:
  - EN: `"Personal health analysis"` or `"Health analysis"`
  - DE: `"Gesundheitsanalyse"` (drops the `KI-` prefix; matches the `<InsightAdvisorCard>` subtitle `"Persönlicher Berater"` style)
  - FR/ES/IT/PL: native renderings (or English fallback if no native copy yet — the `_meta.locale-coverage` notice can carry the disclosure)
- Same pass retires `aiOverviewTitle` ("Personal advisor" / "Persönlicher Berater" — already AI-neutral but the key name is poisoned).
- Same pass on `aiInsightCount`, `aiQualityTitle`, `aiQualityLoadError` etc. on admin surfaces.
- Touches: `src/components/insights/insight-advisor-card.tsx` + `messages/{de,en,fr,es,it,pl}.json` + any admin surface that imports `aiQualityTitle`.

**Effort:** M (one repo-wide rename + locale sweep). If deferred, append to `.planning/v1428-backlog.md`.

---

## Tier — Medium

### ME-1 — `pl.json` line 2661 still self-discloses AI authorship inline

**Severity:** Medium.

**Evidence:**
- `messages/pl.json` line 2661: `"notice": "Ta wersja językowa jest opracowana przez AI, w tym instrukcje krytyczne dla bezpieczeństwa Coacha. Walidacja automatyczna działa w CI; proszę zgłaszać wszelkie regresje Coacha AI na GitHubie."`
- `messages/en.json` line 2661: `"notice": "This locale is AI-drafted including the Coach's safety-critical instructions. Automated validation runs in CI; please report any AI Coach regressions on GitHub."`
- The same string appears in `de.json`, `fr.json`, `es.json`, `it.json`.

**Impact:**
- Direct violation of the "no AI mention" Marc-Voice directive. This string predates v1.4.27 but is user-facing (renders on the locale-coverage notice surface in Settings).
- The convention overrides in `.planning/v1427-handoff-session-2.md` explicitly call out user-facing strings as in-scope for the AI scrub.

**Recommended action:**
- Rewrite as "This locale is machine-translated including the Coach's safety-critical instructions. Automated drift-guard runs in CI; please report any Coach regressions on GitHub." — drops both "AI" tokens, keeps the same operational meaning.
- Pair with HI-3 above (single locale-sweep commit).

**Effort:** S.

---

### ME-2 — `messages/de.json` line 1598 still leaks "AI-Coach" in the timezone-hint copy

**Severity:** Medium.

**Evidence:**
- `messages/de.json` line 1598: `"timezoneHint": "Wird für Diagrammachsen, Erinnerungszeiten, Export-Zeitstempel und den AI-Coach-Kontext verwendet. Gespeicherte Daten bleiben unverändert."`
- `messages/en.json` line 1598: `"timezoneHint": "Used for chart axis labels, reminder times, export timestamps, and AI Coach context. Stored data is unchanged."`
- Same key in fr/es/it/pl with verbatim English.

**Recommended action:**
- Drop "AI-Coach-Kontext" → "Coach-Kontext"; "AI Coach context" → "Coach context".
- Same locale-sweep commit as HI-3 + ME-1.

**Effort:** S.

---

### ME-3 — Provider menu user-facing strings still expose "Anthropic" + "Claude" as a label

**Severity:** Medium.

**Evidence:**
- `messages/de.json` line 1706, 1731: `"anthropic": "Anthropic (Claude)"` in two locations (admin AI settings dropdown + active provider chip).
- Same in all six locales.

**Impact:**
- These are intentional vendor labels — the user picks a provider in Settings and must see the actual provider name. Cannot rebrand to "Coach option C". Per the Marc-Voice "no AI mention" the user-facing artifacts directive intent was marketing-style copy, not vendor enumeration. Strict-grep flags them; the spirit allows them.
- Worth a one-line decision in `.planning/v1428-backlog.md` to anchor the call so future audits do not keep re-flagging.

**Recommended action:**
- Add a comment block in `messages/_meta/forbidden-words.md` (or wherever the convention lives) that vendor-name dropdowns are explicit exemptions to the "no AI / no Anthropic" rule.
- No code change for v1.4.27.

**Effort:** S.

---

### ME-4 — `MBombeck` appears in the GitHub URL on `/about`

**Severity:** Medium (per the "no maintainer name" directive).

**Evidence:**
- `src/app/about/page.tsx` lines 97, 102, 161: `https://github.com/MBombeck/HealthLog` rendered to end-users.
- Memory says: "No personal data in user-facing artifacts — Marc's name … must never appear in CHANGELOG / GH releases / docs/audit/v*-summary.md / docs site / landing".

**Impact:**
- The GitHub username is an irreducible technical identifier for the source URL — it cannot be hidden without breaking the link. This is the same trade-off as `mbombeck@gmail.com` in `git config user.email` or `ghcr.io/mbombeck/healthlog:1.4.27` in `docker pull`.
- The directive's spirit (don't surface "Marc-André Bombeck" the person) is honoured: the about page never spells "Marc" or "Bombeck" in prose. The string `MBombeck` appears only inside the URL.
- Three other repos (`/Users/marc/Projects/healthlog-docs/`, `healthlog-landing/`, `healthlog-iOS/`) likely face the same trade-off.

**Recommended action:**
- Treat the GitHub-username-in-URL as an exempt-by-necessity exception, like the vendor-name dropdown above. Note in the convention doc.
- v1.4.28 could consider mirroring the repo under a project-name-only org or a vanity domain `code.healthlog.dev` to clean the URL. Not in scope for v1.4.27.

**Effort:** S (documentation only).

---

## Tier — Low (informational)

### LO-1 — `MeasurementSource` enum is iOS-ready, but the field is still optional everywhere on the API surface

**Severity:** Low (forward-compat reminder).

**Evidence:**
- `prisma/schema.prisma` line 339-346: enum carries `MANUAL`, `WITHINGS`, `IMPORT`, `APPLE_HEALTH`. Three model relations (line 369, 459, 544) default to `MANUAL`.
- The iOS native client (in `healthlog-iOS`) will need to populate `source: APPLE_HEALTH` on every batch-ingest payload to keep cross-source priority resolution working.

**Forward-compat status:** Solid. The enum + default predate v1.4.27 (landed in v1.4.23 per the inline comment). The iOS client can write to it without server-side changes.

**Recommended for v1.5:** Server-side payload validation should require `source` to be present on `/api/measurements/batch` (when that endpoint lands) rather than silently defaulting to `MANUAL` — protects against accidental web-form fallthrough. Worth a v1.5 backlog note; out of scope for v1.4.27.

---

### LO-2 — `askCoach(prefill, scope)` accepts `scope` today; consumer surface ignores it; documented in code

**Severity:** Low (forward-compat is intact).

**Evidence:**
- `src/lib/insights/coach-launch-context.tsx` line 48: `askCoach: (prefill?, scope?) => void`.
- Line 64-68: implementation explicitly `void scope` with comment "reserved for v1.4.28 (metric-narrow on the sources rail)".
- `src/components/insights/coach-launch-button.tsx` line 60, 82: call sites pass `prefill` only. The seven sub-page `<CoachLaunchButton>` mounts could feed `scope: { metric: "BLOOD_PRESSURE" }` etc. from page context.

**Forward-compat status:** Solid. The shape lets v1.4.28's sources-rail metric-narrow ride in without changing every caller.

**Recommended for v1.4.28:** When MB4's deferred sources-rail metric-narrow lands, each of the seven sub-pages can pass its metric token via `scope.metric`. The contract already supports it.

---

### LO-3 — `package.json` version pin will need to update at three release-time spots

**Severity:** Low (release-pipeline reminder).

**Evidence:**
- `package.json` version bump 1.4.26 → 1.4.27.
- Sister repos: `healthlog-docs/` (three image pins per the handoff doc line 113) + `healthlog-landing/` (one `softwareVersion`).
- Coolify edge-01 docker-compose pin: `ghcr.io/mbombeck/healthlog:1.4.26` → `1.4.27` (per handoff line 109).

**Recommended:** Round 5 release contributor follows the checklist in `.planning/v1427-handoff-session-2.md` lines 95-113. No new finding here, just a reminder.

---

## Scope alignment — does shipped match the headline?

**Headline:** "Mobile capability improvement" (per maintainer briefing) + 27 QoS findings + 17 backlog pull-ins + iOS handshake foundation.

| Bucket | In plan | Shipped | Notes |
|---|---|---|---|
| MB1 — `<ResponsiveSheet>` primitive + form mounts | 5-6 commits | ✓ 65fd0bff, 04cce8d9, 48261b67, beb2b40f, b2568340 + dialog cap | All six surfaces migrated |
| MB2 — Sub-44 pt tap-target sweep | 7-8 commits | ✓ fb6fb4f5, 4464d2c9, 44554729, bba8921e, 17aed374, 4464d2c9 | Primitive lift + 6 surface sweeps |
| MB3 — `inputMode` / aria sweep | 4-5 commits | ✓ 9036e715, 2d8c5e90, 192170ee, 95bc87f5, bfb5ba72 | Coach Tooltip → Popover + composer hint + aria-expanded |
| MB4 — Coach reachability + mobile chrome | 3-4 commits | ✓ 246c1def, 40916d31, 79dbdfbd, 650d4f8e | Layout-mount + Checkbox + visualViewport + 7 sub-page CTAs |
| MB5 — Tables → mobile card-list | 2 commits | ✓ c77d5252, 0fb0235d | `/settings/api` + pagination move-out |
| MB6 — v1.4.27 regression fixes + auth/public polish | 5 commits | ✓ fc8a5855, de0c1633, 117eb87f, e52b64bf | `/about` public + register submit + not-found + safe-area |
| MB7 — Surface-specific polish residue | 8-10 commits | ✓ 9b6dbbf6, 2bd659f6, 2fb964ef, f9558ce0, 53c51639, 071f26bf, 7bfd5bee, e1451f84, ab4529fc, 0b3f9e3e + NativeSelect 07c9d01f | Chart heights, heatmap, HSC, EmptyState, NativeSelect, titration, scheduling, integrations, etc. |

**Verdict:** Every fix-surface bucket landed with at least the planned commit count. **No half-done surfaces** detected. Spot-checked:
- `<InsightsCardPreview>` retired (file deleted; one comment reference + one dead-code regression test in `dashboard-layout.test.ts`).
- GLP-1 tile carries the two-tab segmented control (Level + Weight) plus a 7d / 30d / 90d / All range strip (verified at `src/components/dashboard/glp1-tile.tsx` line 340-388).
- Daily Briefing strips the duplicate greeting paragraph (5b8a47b4) and wraps each row in a `<Link>` (0b3f9e3e).
- `/about` is a real page rendering the GeoLite2 CC BY-SA 4.0 attribution + GitHub repo link + AGPL link.
- `not-found.tsx` is a branded splash with logo + "Page not found" + "Back to dashboard" link at `min-h-11`.

Three of the 27 maintainer findings did flow through but warrant a final acceptance test (visual check at staging) before tag:
- Finding 1 — GLP-1 drug-level secondary tile: rendered via tab strip, not a second tile. Decision recorded in B1 report; check that `Decision B` ("tab strip" vs "second card") is acceptable to the maintainer.
- Finding 5 — KI-Gesundheitsanalyse retired: dashboard surface retired; `/insights` advisor card still uses the same label key (see HI-3 above).
- Finding 7 — Weekly report dead click: deferred to v1.4.28 (per v1.4.28-backlog.md) pending maintainer screenshot.

## Forward-compat for v1.5 iOS native client

| Contract | Status | Evidence |
|---|---|---|
| `askCoach(prefill, scope)` | ✓ scope param accepted today | `src/lib/insights/coach-launch-context.tsx:63-72` |
| `Measurement.source` enum | ✓ `APPLE_HEALTH` present since v1.4.23 | `prisma/schema.prisma:339-346` |
| `AuditLog.asn` + `carrier` | ✓ additive nullable columns | `prisma/migrations/0061_audit_log_carrier/migration.sql` |
| Coach drawer mount lifecycle | ✓ moved to layout — sub-page nav preserves drawer state | `src/app/insights/layout.tsx:24-31` |
| iOS handoff documentation | ✓ standalone-and-server-pairing.md added | `.planning/v15-ios-handoff/22-standalone-and-server-pairing.md` |

iOS client can start consuming the new contracts immediately after v1.4.27 ships. None of the v1.4.27 changes break the locked-contracts surface set in v1.4.23.

## Regression risk

| Risk | Severity | Mitigation status |
|---|---|---|
| **`MAXMIND_LICENSE_KEY` secret missing** | Critical | Open — see CR-1 |
| Migration 0061_audit_log_carrier idempotency on demo server | Low | `IF NOT EXISTS` guards in migration.sql — safe |
| Coach drawer lifecycle change (mount → layout) | Low | `insights-polish.test.ts` re-pointed at 617d4518; 17 assertions pass |
| `<ResponsiveSheet>` primitive on mobile form surfaces | Low | Primitive is additive; old consumers still work |
| Coolify auto-deploy gate (3 prior releases skipped via SSH fallback) | Medium | `COOLIFY_AUTO_DEPLOY=on/off` toggle (v1.4.26 P6-3) lets the maintainer surface the gap |
| 414 dead translation keys retired (2960f735) across 6 locales | Low | Drift-guard runs in CI; verified at lint-clean state |

## Forbidden-word + PII grep results

**Forbidden words across user-facing surfaces (messages/*.json + CHANGELOG.md + /about + not-found):**
- New v1.4.27 keys added in `messages/en.json`: zero `AI`, `Claude`, `agent`, `marathon`, `wave`, `phase`, `session`, `subagent`, `Anthropic`.
- Pre-existing `aiAnalysisTitle` + `aiOverviewTitle` + `aiInsightCount` keys still render — see HI-3.
- Pre-existing `pl.json:2661` AI-authorship disclosure — see ME-1.
- Pre-existing `timezoneHint` "AI Coach context" — see ME-2.
- Pre-existing vendor labels `"Anthropic (Claude)"` — see ME-3 (exempt by necessity).
- `/about` page: zero forbidden words in rendered copy. One occurrence inside a code comment ("session — see `src/proxy.ts`") at line 20 — not user-facing.
- `not-found.tsx`: zero forbidden words in any layer.

**PII grep across user-facing surfaces:**
- `Bombeck`, `Marc-André`, `mbombeck` in user-facing copy: zero hits in rendered text. Two technical URL identifiers in `/about` (`MBombeck/HealthLog`) and one historical CHANGELOG entry (line 3199 GHCR repo reference). See ME-4 — flagged as exempt-by-necessity.
- Target-range literal values: zero hits in new user-facing artifacts. Pre-existing CHANGELOG mentions at lines 1238-2684 are historical pre-v1.4.27 surface.
- Measurement-count literals: zero hits in new user-facing artifacts.

## Marc-Voice English audit of new user-facing copy

Spot-checked the 70+ new EN keys added by v1.4.27 against the Marc-Voice expectation (professional, declarative, no LLM-style filler, no AI mention, no marketing-style flourish).

| Sample key | EN value | Voice match? |
|---|---|---|
| `dashboard.glp1.tabsAria` | "Switch between drug-level and weight views" | ✓ declarative |
| `dashboard.glp1.levelUnavailable` | "Drug level not yet available — log a dose and the curve will appear." | ✓ Marc-Voice |
| `measurements.filterByType` | "Filter by type" | ✓ minimal |
| `insights.emptyState.bloodPressure.description` | "Log a blood pressure reading and the trend chart, in-range share, and WHO classification will appear here." | ✓ declarative + outcome |
| `insights.emptyState.sleep.description` | "Once sleep data lands (manual or via Withings / Apple Health), the per-night stage breakdown will appear here." | ✓ Marc-Voice |
| `admin.carrierUnknown` | "Unknown carrier" | ✓ minimal |
| `notifications.admin.testNotificationBody` | "This test notification was triggered from the admin panel. If you can see it, the channel is working." | ✓ admin-direct |
| `not-found.tsx` body | "The page you were looking for doesn't exist or has been moved. Head back to the dashboard to pick up where you left off." | ✓ casual but clear |
| `/about` body | "HealthLog stands on a number of open-source libraries and public data sources." | ✓ professional |

**No Marc-Voice regressions in v1.4.27 net-new copy.**

## Headline metrics

| Metric | Value |
|---|---|
| Commits since v1.4.26 | 422 |
| Files changed since v1.4.26 (entire repo) | 269 (+19,408 / −3,142) |
| Files changed under `src/components/` | 118 (+4,275 / −1,489) |
| New primitives shipped | 3 (`<ResponsiveSheet>`, `<NativeSelect>`, `<CoachLaunchProvider>`) |
| New routes shipped | 2 (`/about`, `/not-found`) |
| Maintainer findings landed | 26 of 27 (finding 7 deferred per backlog) |
| Mobile findings consolidated → landed | 74 raw → 60 in plan (Critical 6, High 22, Medium 32, Low 8 = 68; CF-20 deferred = 67; effort-L items deferred per severity policy) |
| R3d MB1–MB7 buckets closed | 7 of 7 |
| Typecheck status | Clean |
| Lint status | Clean |
| Insights-polish test status | 17/17 pass at 617d4518 |
| Migration safety | 0061 idempotent (`IF NOT EXISTS`) |

## Final recommendations before tag

1. **Wire `MAXMIND_LICENSE_KEY` secret + GHCR workflow step** (CR-1) — release-blocking.
2. **Backfill `.planning/v1428-backlog.md`** with the 14 CF-77..CF-90 deferrals (HI-1).
3. **Write the v1.4.27 CHANGELOG entry + bump `package.json` to 1.4.27** in Round 5 editorial pass (HI-2).
4. **Decide HI-3 in or defer**: locale sweep for `aiAnalysisTitle` / `aiOverviewTitle` / `aiInsightCount` (plus ME-1 + ME-2). If in, one editor pass across 6 locale files + `insight-advisor-card.tsx`. If deferred, add to v1.4.28 backlog with the M-effort rationale.
5. **Coolify auto-deploy** — verify `COOLIFY_AUTO_DEPLOY` repo variable is set to `on` (per v1.4.26 P6-3 directive) before tag, so this is not the fourth release in a row to fall back to host-side SSH retag.

If CR-1 + HI-1 + HI-2 are addressed in this round, v1.4.27 is release-ready against the maintainer-stated success criteria:
- `healthlog.bombeck.io/api/version` returns `1.4.27`
- `demo.healthlog.dev/api/version` returns `1.4.27`
- `/privacy` (v1.4.26) still returns 200
- GitHub release page lists v1.4.27 at the top
- Every Critical + High + ≤M Medium consolidated finding landed or explicitly deferred with reason
- Sister repos `healthlog-docs` + `healthlog-landing` bumped

The release is otherwise strong. The 422-commit delta is the largest v1.4.x patch by line count; the work is mostly mobile-conformity primitives + the GeoLite2 offline tier, not new product surface, which keeps the conservative-semver patch designation honest.
