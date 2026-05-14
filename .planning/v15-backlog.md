# v1.5 backlog seed

Source: phase-D findings (code-review / security / design / senior-dev
/ simplify) plus `phase-D-product-lead-review.md` and Wave-C deferred
items. Compiled: 2026-05-10 by phase-D reconcile.

This is the input for the v1.5 milestone planning. The Product-Lead
review (`.planning/phase-D-product-lead-review.md`) IS the strategic
plan for v1.5; this file collects the tactical follow-ons.

---

## From Product-Lead strategic review (the v1.5 backbone)

Lift directly from `phase-D-product-lead-review.md` §C ("v1.5
Roadmap") and §D ("Follow-on initiatives v1.6+"). Sized in the
review.

**Section C — v1.5 candidates (Marc to pick the 6 weeks of focus):**

- **C.1** Coolify image-digest auto-deploy (S, 5min Marc-side toggle).
- **C.2** Native ARM runner matrix for docker-publish (S).
- **C.3** Cross-user feedback aggregation prompt-tuning ratchet
  (M; depends on B5e shipped).
- **C.4** Dedicated `/insights/compare` page (S–M;
  `comparison.insightsCallout.{lastMonth,lastYear}` keys reserved).
- **C.5** AI streaming + prompt-version A/B + per-user prompt prefix
  (S–M + M + M; depends on C.3).
- **C.6** Charts library decision (L; chart wrapper rewrite — must be
  decided before any new chart commit lands).
- **C.7** iOS native client API contract freeze + bulk endpoint +
  versioned `/api/v1/` router (M).
- **C.8** Security hardening sweep (passkey replay-attack, idempotency
  TTL configurable, audit-log retention) (S/S/M).
- **C.9** Performance — Recharts deferred bundle on `/`,
  `/measurements`, `/mood` + SSR insights + Prisma read-replica
  (S/M/M).
- **C.10** Cross-device backup encryption + S3 push (M).
- **C.11** Integrations — Apple Health → Oura → Garmin (M each;
  recommended order: Apple Health first via iOS XML import).

Marc's 6-week focus pick from the review: **C.1 + C.2 + C.4 + C.7 +
C.10 + C.11a Apple Health**.

**v1.4.18 Product-Lead update** (`phase-D-v1418-product-lead-review.md`):
add `C.12 — Per-user UI preference persistence as a platform pattern`
as a running side-quest (extracts the v1.4.18 A3
`useChartOverlayPrefs` shape into a reusable primitive, applies to
sidebar collapsed state, dashboard tile order, per-section default
time-window, per-channel notification prefs). Sized S per surface,
M for the extracted hook + route. Parallelisable with C.7. Drops
nothing from the original 6-week pick.

Three additional v1.5 candidates from the v1.4.18 review:

- **C.13** Achievement engine as a "next-best-action" predicate
  engine. The v1.4.18 evaluators are pure predicates over user data;
  extend to "you're 1 day from `mood-streak-7`" dashboard nudges. M.
- **C.14** Hidden-achievement pattern as "discover features"
  tutorial. Reuses the opaque-card + unlock-on-trigger primitive for
  product discovery (Connect a wearable, Set up automation, Export
  for your doctor). M. Replaces the v1.4.15 onboarding tour.
- **C.15** Engagement loop on top of the achievement surface
  (streak repair tokens / monthly digest emails / friend-only
  leaderboards). S/M/M. Privacy-first social.
- **C.16** Admin/Settings shell layout audit. Run a focused pass
  across all 13 admin sections + 10 settings sections at three
  viewports (Pixel-5, iPad portrait, desktop) with Playwright +
  scrollWidth diffing. Catalog every overflow. S–M.

**Section D — v1.6+ follow-on initiatives:**

1. Compliance-export admin tool (off B4 audit-log filter API)
2. Anomaly-detection alerts (off B3 host-metrics)
3. Per-prompt-version × per-provider quality dashboard
4. "Explain like I'm 5" public preview surface
5. Yearly health-summary email digest (off B8 comparison overlay)
6. Rationale-driven on-device predictions (`confidence.ts` math
   client-side)
7. Public-facing API for self-export (`/developers` page)

---

## From design review

### Deferred CRITICALs (root cause: scope-completion-without-route-wiring)

- **C1 — `/insights` does NOT mount `<InsightAdvisorCard>` /
  `<RecommendationsGrid>` / `<RecommendationCard>` / `<ConfidenceMeter>`
  / `<RecommendationFeedback>`.** The B5c/d/e/B1b polish components are
  still test-only. Wiring requires either rewriting the 7 per-status
  status endpoints (`/api/insights/{general,blood-pressure,weight,
pulse,bmi,mood,medication-compliance}-status`) to return the
  rationale+confidence+citation rich shape, OR migrating the page to
  consume `/api/insights/generate`'s comprehensive payload directly.
  Either path is the v1.4.17 migration the senior-dev review (H3 in
  code-review) flagged. **Defer — too wide for tonight's reconcile.**
  Workaround: v1.4.16 release notes / Marc-Brief must phrase the polish
  components as "groundwork for v1.4.17 user-facing rollout" rather
  than headline UX. Screenshots of the unmounted advisor card surface
  do NOT belong in v1.4.16 marketing material.

- **C2 — `<InsightsCardPreview>` (dashboard insights tile) has zero
  live imports.** Mounting on `/` requires a new GET endpoint that
  returns `User.insightsCachedText` + cache-aware staleness markers.
  The B1b commit `d2cdf9d` left this as "When dashboard wiring lands…"
  Same scope reason as C1 — defer to v1.4.17 alongside the per-status
  migration.

### HIGH (deferred)

- **H5 design — InsightsPageHero gradient `via-dracula-cyan/8` is too
  faint on mobile LCD.** Bump opacity to `/15`. Trivial; deferred
  because the gradient passes the contrast tests today and Marc's
  Apple-Health benchmarking lens is a v1.4.17 visual sweep concern.

- **H8 design — DE fallback-chain row overflow on Pixel 5.** The
  reviewer's premise is partly mistaken: the row buttons are
  icon-only with `aria-label` only, so DE-string-length doesn't
  affect layout. The 5-control row IS visually busy at 393 px but
  wraps cleanly with `flex-wrap`. Defer for a future settings
  polish pass.

### MED/LOW (deferred bucket)

- **M1** — App-log preview table needs card-list mobile fallback
  at `<md` (mirror api-tokens / users patterns).
- **M2** — RecommendationFeedback success state has no path to
  revoke / change verdict.
- **M3** — `<RecommendationsGrid>` border colours at `/70`
  opacity not contrast-verified against `--card`.
- **M4** — `<ConfidenceMeter>` aria-label includes only the raw
  integer; add band semantic ("high confidence (75/100)").
- **M5** — InsightsPageHero empty state with `updatedAt=null`
  feels heavy; promote `onRegenerate` button to inline CTA.
- **M6** — Severity colour token map duplicated 3× (HeroFinding,
  RecommendationCard, RecommendationsGrid). Centralise to
  `src/lib/severity-colors.ts`.
- **M7** — Sticky `<InsightsSectionNav>` should add
  `overscroll-x-contain` for iOS Safari back-swipe.
- **M8** — `<HostMetricsChart>` tooltip formatter keys on
  localised name string; key on dataKey instead.
- **M9** — Mood chart emoji glyphs render differently per OS;
  swap to lucide SmilePlus/Frown/Meh/Smile/Laugh SVGs.
- **M10** — RecommendationCard collapsed state has no "tap for
  details" hint affordance.
- **M11** — Loading skeleton uses unconditional staggered
  `animationDelay` ignoring prefers-reduced-motion.
- **M12** — `/insights` first-load shows bare spinner instead of
  skeleton-mirroring-final-layout.
- **M13** — App-log empty state doesn't distinguish "buffer empty"
  from "filter matched nothing".
- **M14** — Settings → Export `<input type="date">` is browser-
  locale-driven. Wrap with shadcn Calendar+Popover.
- **M15** — non-issue (HostMetricsChart Legend stacks fine).
- **M16** — non-issue (tour anchors verified).
- **M17** — non-issue (i18n parity green).
- **M18** — non-issue (ConfidenceMeter ring `r=10` fits).
- **M19** — Tile delta callout muted on neutral-direction metrics
  loses the "value did move" signal. Add muted ↑/↓ glyph.
- **M20** — Severity Badge text uppercase but uses raw EN
  vocabulary ("URGENT" / "IMPORTANT" / …) — add
  `insights.recommendation.severity.{urgent,important,suggestion,
info}` i18n keys.
- **M21** — `<ScatterCorrelationChart>` (correlation cards on
  /insights) does NOT receive B1a polish. Extend
  ChartLinearGradient + RichChartTooltip.
- **M22** — Verify `MedicationComplianceChart` 80/100/baseline
  label-stack live render once v1.4.16 deploys.

---

## From code-review

### HIGH (deferred)

- **H1** — `feedback-aggregator` bucket-key collision claim. The
  reviewer cited `.join("")` as the problem; actual code already uses
  `\x01` (SOH) as the separator. **Already-fixed; not deferred — note
  the reviewer mis-read the source.**
- **H3** — Strict B5b/B5c/B5d AI features not wired into production
  `/api/insights/generate`. Maps directly to design-C1 root cause.
  Same v1.4.17 migration item.
- **H4** — `findRecommendationsMissingRationale()` is a no-op on
  parsed AIInsightResponse (always returns []). Fix in v1.4.17
  alongside H3.
- **H7** — Comparison overlay `data` may be single-period only.
  Audit the dashboard fetcher upstream to confirm the visible overlay
  maps to the prior period, not the current period shifted forward.
  Add a unit test pinning the contract.
- **H8** — `seedKey` in ai-section race-window. Track userPicked state
  separately so chainData arrival can't overwrite a user click.

### MED/LOW (full bucket)

- **M1** — `/api/admin/audit-log/actions` unbounded groupBy(action).
  Add an index on `audit_logs.action` OR cache the list 5 min.
- **M2** — `RecommendationCard.metricTypeToChartTypes()` falls
  through to verbatim type for unknown values.
- **M3** — `appendLogEvent` runs unconditionally for high-volume
  background jobs. Skip kind === "background" from buffer.
- **M5** — `chainBodySchema.providerType` double-cast hides type.
- **M6** — `ContractCard` "draft" pill clamp dead-code path.
- **M7** — host-metrics `BigInt → Number` no overflow guard
  (acceptable for v1.4.16 scale; document).
- **M8** — feedback-aggregator upsert swallows errors; let pg-boss
  retry instead.
- **M9** — `host-metric-sampler.getHostMetricRetentionDays()`
  redundant double-check.
- **L1-L10** — Various nits (provider-runner duplicated chain
  walker, recommendations-grid stagger cap, findClosestDia
  per-sys pairing, etc.) — all flagged in the review for
  opportunistic touch-ups.

---

## From security

### HIGH (already-fixed in this reconcile)

- **H1** — meta + action.details NOT redacted at admin egress.
  **Fixed** (`fb12f09`).
- **H2** — `/api/admin/audit-log` returned raw details without
  redaction. **Fixed** (same commit `fb12f09`).

### MED/LOW (deferred)

- **M1** — `/api/insights/feedback` had no rate limit. **Fixed**
  (`6863ecb`).
- **M2** — `metricSourceType` is client-supplied free-form;
  pin to `aiRecommendationSchema.metricSource.type` enum.
- **M3** — audit-log `target` substring match on raw JSON
  expensive; bound to ≥3 chars OR add GIN/trigram index.
- **M4** — `User.aiProviderChain` priority normalisation only at
  PUT layer; mirror at parser layer for defence-in-depth.
- **M5** — `GET /api/user/ai-provider` decrypts apiKey just for
  last-4. Store a 4-char preview alongside encrypted column.
- **L1** — Document `RecommendationFeedback` per-user-rec storage
  trade-off in v1.4.16 summary doc.
- **L2** — host-metrics returns ~1440 rows for 24h (acceptable).
- **L3** — `redactSecrets` regex doesn't cover Basic auth or
  generic JWT shape. Add `Basic\s+\S+` and `\beyJ...` patterns.

---

## From senior-dev

### HIGH (architectural — deferred)

- **H1** — `src/lib/ai/` directory has 19 flat files (4,726 lines)
  with five orthogonal concerns. Re-shape to `providers/ runtime/
schema/ domain/ prompts/`. Mechanical rename + import-rewrite.
- **H2** — `<InsightAdvisorCard>` (690 lines) is a god-component.
  Extract `_advisor/{hero-finding, inline-charts, data-quality-
drawer, legacy-payload-cta}.tsx`.
- **H3** — `<RecommendationCard>` (417 lines) approaching split
  point. Extract `metricTypeToChartTypes` + `<CitationFootnote>`
  - `<RationaleCard>`.

### MED (deferred)

- **M1** — provider-runner two near-identical fallback runners.
  Inline-extract a generic `runChain<T>(chain, attempt)` higher-
  order. (Same as code-review L3.)
- **M2** — `<RecommendationFeedback>` reaches into `useAuth()`
  directly. Pass `userId` from parent instead.
- **M3** — Dual response-shape carries forward from v1.4.15 M6
  (`schema.ts` + `types.ts`). Bite the migration in v1.4.17.
- **M4** — Two metric-vocab maps in different files. Extract
  `src/lib/insights/metric-vocab.ts`.
- **M5** — `<RationaleCard>` 6-prop list will only grow; pass
  `rec={norm}` instead.
- **M6** — `i18n.insights.recommendation.*` mixes 4 buckets at
  same depth. Re-shape to nested objects per feature bucket.
- **M7** — `feedback-attribution.ts` reads latest audit row to
  pick provider; couples feedback to audit-log shape. Add
  `User.lastUsedProviderType` column or AppSettings cache.
- **M8** — `feedback-aggregator` empty-string join (already-
  fixed; reviewer mis-read).
- **M9** — Five admin sections hand-roll the same `fetch + json
  - throw`mini state machine. Promote to`src/lib/api-client.ts` `fetchJsonOrThrow<T>`.

### LOW

- **L1** — duplicate `// ─── Section Separator ───` comment in
  insight-advisor-card.tsx:284-286.
- **L2** — `<RecommendationFeedback>` 17-line `setState during
render` block needs a one-line CLAUDE.md-rule comment.
- **L3** — `ProviderChainResolved` type defined in runner
  (consumer), should live with parser.
- **L4** — `legacy-payload.ts` 55-line module could live in
  `schema.ts` next to `findRecommendationsMissingRationale()`.
- **L5** — Confidence band thresholds in 3 separate files. Add
  `src/lib/ai/confidence-bands.ts` with `CONFIDENCE_BANDS = {…}`.
- **L6** — `host-metric-sampler` reads env on every call.
- **L7** — `RecommendationFeedback` model field naming verbose
  (cosmetic).
- **L8** — `formatCitationLabel(ref, locale)` helper not
  centralised.
- **L9** — `reminder-worker.ts` (1,350 lines) — split per queue
  under `src/lib/jobs/queues/<queue>.ts`.

---

## From simplify

### Apply-no (judgement calls — Marc to decide)

- **F1 — strict `runWithFallback` test-only.** Two paths: (a)
  delete + migrate test suite to `runRawCompletionWithFallback`,
  or (b) wire `/api/insights/generate` to the strict variant
  NOW and delete the legacy. (b) is the v1.4.17 migration the
  comment promises. Defer the call to Marc.
- **F8 — `RecommendationCard.normalise()` indirection.** Replace
  with `recAsObject(rec)` helper. Mechanical rewrite spans 8+
  JSX sites; warrants Marc's eye on the simplified version.

---

## From Wave-C deferred (originally v1.4.16 catch-up scope)

- **Coolify image-digest auto-deploy trigger** — already in
  Product-Lead C.1.
- **Native ARM runner matrix for docker-publish** — already in
  Product-Lead C.2.
- **Per-agent worktree adoption** — held for v1.4.16, succeeded.
  Codify the "worktree-per-agent" rule in CLAUDE.md.
- **Senior-dev H1 + H2 splits from v1.4.15** — both still open
  (carry forward into v1.4.17 architectural pass).
- **Mood-chart H3 (chart-presentation) from v1.4.15** — chart-
  ownership rule keeps this with charts owners; pick up when
  next chart-presentation pass runs.
- **Measurements BP grouping + DOM weight** — deferred from
  v1.4.15 A5 mobile.

---

## v1.4.19 Product-Lead carry-over (strategic — for v1.5 frame)

Filed against `.planning/phase-D-v1419-product-lead-review.md`. Most
of the strategic content there is the v1.4.20 plan (Insights redesign

- AI Coach) which already sits in the handoff at
  `~/Downloads/design_handoff_insights_redesign`. The items below are
  v1.5+ scope and frame how v1.4.20's surfaces should grow.

* **Conversation persistence eviction** — once Coach storage ships,
  auto-archive conversations after 90 days, hard-delete after 365.
  Quoted ~500 KB/user/month at 20 turns × 50 conversations.
* **Correlation FDR-control** — v1.4.20's scope is 3 hypotheses, no
  multiple-comparison correction needed. v1.5's auto-discovery
  surface needs Benjamini–Hochberg or similar before shipping.
* **Apple Health absence in v1.4.20** — the redesign reserves three
  micro-stat tiles. Two slots filled today (Withings pulse, mood);
  the third reads "Apple Health: coming with iOS app" until v1.5.
  Don't embarrass; label honestly.
* **Streaming UI on slow networks** — Coach SSE needs explicit
  Slow-3G testing before shipping; skeleton-shimmer / progressive
  render are easy to get wrong at 30 KB/s.
* **Prompt-injection refusal in Coach** — open-ended user input box;
  reuse v1.4.15 C1 scope-hardened refusal patterns and add
  Coach-specific prompt-test assertions. Every user message gets
  `redactSecrets()` before landing in system context.
* **`safeParse()` legacy-payload pattern** — Coach payload + Daily
  Briefing payload + Health Score payload each meet a strict zod
  schema and a cached blob. Each needs a legacy-payload-CTA path,
  not a crash. Audit every new `safeParse()` call pre-tag (v1.4.17
  hotfix lesson).
* **Cross-user feedback aggregation prompt-tuning** — v1.4.16 B5e
  set up storage; the loop is still open. v1.4.20 wires it (Coach
  conversations + recommendation thumbs feed the same aggregator;
  helpful-rate < 50 % per `(severity × confidence_band)` bucket
  appends OMIT/REPHRASE rules to the next PROMPT_VERSION).
* **Coolify image-digest auto-deploy** — deferred since v1.4.16; 5-
  min Marc-side UI toggle. v1.4.20 is the right release to flip so
  every AI Coach iteration cycle benefits from no-rebuild
  docs/planning commits.
* **Native ARM runner matrix for `docker-publish`** — v1.4.16
  dropped arm64 due to qemu SIGILL; native `ubuntu-24.04-arm`
  re-adds it. Pairs with v1.5 iOS app on Apple Silicon dev
  machines.
* **Worktree mandate for parallel agents** — process debt; the
  shared-cwd race continues to bundle stray files into unrelated
  commits (A4, A5, A6 in v1.4.19). v1.4.20 should require one
  worktree per parallel agent.

## From issue triage

- **Per-user timezone (Option B in the proposal).** Issue #167
  surfaced that the entire app is hardcoded to `Europe/Berlin` — UI
  display, analytics buckets, reminder cron, Withings sync mapping,
  PDF report, Coach context, ten distinct symptoms in total. The
  full design space, migration strategy, schema changes, DST and
  date-string risks (`MoodEntry.date` freeze vs `MedicationSchedule`
  re-anchor — they need different contracts), test parametrisation
  plan and product-call questions are written up in
  `.planning/feature-user-timezone.md`. Sized L: 1–2 weeks elapsed.
  Independent from the v1.4.25 quick fix (ISO-8601-with-offset CSV
  export) which closes #167 on its own without touching this scope.
  Triggering issue: GitHub #167.

## Process / meta

- **Cross-agent commit-message drift** — reduced materially in
  v1.4.16 via worktree adoption. Keep the rule.
- **Marathon meta** — phase 0 / phase A-C / phase D / phase E
  cadence held. Multi-day scope (v1.4.x marathon → tag → release)
  is the right granularity for this project.
