---
file: .planning/research/v15-assistant-optional.md
purpose: Operator-side toggles for assistant surfaces — coverage + UX + iOS contract + implementation plan
created: 2026-05-16
contributor: assistant-optional research
---

# Assistant-optional architecture for HealthLog

## Premise

HealthLog wires an LLM provider into seven distinct user-facing surfaces. Some operators run the app self-hosted on AGPL infrastructure, hand-pick a non-LLM stack for privacy reasons, or just want the manual measurement / target / charts story without any model-generated text. Today the only operator lever is whether `AppSettings.adminAiKeyEncrypted` is populated; that on/off is too coarse — it disables every surface uniformly, and silently downgrades each card to a "no provider configured" empty state rather than removing the affordance. This report proposes a per-surface operator toggle scheme so an operator can keep, e.g., the Daily Briefing visible while removing the Coach drawer and the per-metric status text.

The premise stays separate from the per-user consent gate (`User.insightsPrivacyMode`, the Research-Mode dialog on the Drug-Level chart). Operator flags are a global supply-side switch; per-user privacy stays a per-user demand-side opt-in. Both layers compose: a surface is enabled only when (operator-enabled) AND (per-user opt-in if required).

## Part A — Coverage matrix

Seven distinct surfaces consume an LLM provider. Each row maps the user-visible mount, the server endpoint, the current opt-out path (if any), and the operator toggle this report recommends.

| # | Surface | User-facing mount | Server endpoint | Current opt-out | Proposed operator toggle |
|---|---|---|---|---|---|
| 1 | Daily Briefing card | `src/components/insights/daily-briefing.tsx` mounted on `/insights` page header | `/api/insights/generate` (parsed into briefing slot) + `/api/insights/cards` (iOS) | None: hidden only if provider absent OR feature flag in `features.ts` advises off | `briefing.enabled` |
| 2 | Coach drawer + FAB + inline pill | `layout-coach-fab.tsx`, `coach-launch-button.tsx`, `layout-coach-mount.tsx` → `coach-panel/coach-drawer.tsx` | `/api/insights/chat` (SSE), `/api/insights/chat/[id]`, `/api/insights/chat/messages/[id]/feedback`, `/api/auth/me/coach-prefs` | None: launch fails silently when provider chain empty | `coach.enabled` |
| 3 | Insights regenerate icon | `insights-tab-strip.tsx` regen IconButton (mother page only) | `/api/insights/generate` (POST) | None: button stays even with empty advisor | `briefing.enabled` (shares flag — same endpoint) |
| 4 | Comprehensive insight body (recommendations grid, hero strip narration) | `recommendations-grid.tsx`, `hero-strip.tsx` via `useInsightsAdvisorQuery()` | `/api/insights/generate` (GET cache read) | None | `briefing.enabled` |
| 5 | Per-metric status cards (7 metrics) | `insight-status-card.tsx` mounted on each `/insights/<metric>` sub-page | `/api/insights/weight-status`, `/bmi-status`, `/blood-pressure-status`, `/pulse-status`, `/mood-status`, `/medication-compliance-status`, plus generic `general-status` | `hasProvider` falsy → "no provider" empty card | `insightStatus.enabled` (single flag covering all 7 sub-routes) |
| 6 | Health-Score delta `?` explainer popover | `health-score-delta-explainer.tsx` triggered from `health-score-card.tsx` inside `hero-strip.tsx` | Pure client text (no LLM call) but bound to the briefing payload's delta-explanation slot | None | `healthScoreExplainer.enabled` |
| 7 | Correlation card narration | `correlation-card.tsx`, `correlation-row.tsx` consume `/api/insights/correlations` | `/api/insights/correlations` (LLM-narrated correlations) | None | `correlations.enabled` |

Five natural toggles cover all seven surfaces:

- `coach.enabled` → drawer + chat + history rail + feedback endpoint + coach-prefs route.
- `briefing.enabled` → Daily Briefing card + recommendations grid + hero narration + the regen icon (every consumer of `/api/insights/generate`).
- `insightStatus.enabled` → all 7 per-metric `*-status` routes and the cards that read them.
- `correlations.enabled` → the correlation tile narration on the mother page.
- `healthScoreExplainer.enabled` → the `?` popover on the delta line; LLM-derived rationale stays gated by `briefing.enabled` upstream but the operator can independently hide the trigger so the score number reads as a bare KPI.

If Marc wants an even smaller surface, a single root flag `assistant.enabled = false` short-circuits everything — useful for operators who never want any LLM surface. The five sub-flags then only apply when the root flag is `true`.

## Part B — Toggle UX

### Where the operator sets them

Recommendation: a new admin section slug `assistant` inserted between `ai-quality` and `coach-feedback` (which currently mount the existing provider-config and feedback panels). The slug list in `src/components/admin/section-slugs.ts` becomes:

```
system-status, general, services, integrations,
ai-quality, assistant, coach-feedback, feedback,
reminders, users, api-tokens, login-overview,
app-logs, backups, danger-zone
```

The new panel — `assistant-section.tsx` — renders one master `assistant.enabled` toggle at the top and five sub-toggles below (greyed out when the master is off). Each toggle reuses the shared `<SettingsToggle>` primitive that `general-settings-section.tsx` already uses, so the UX matches `registrationEnabled`, `moodLogGlobal`, `bugReportEnabled`, etc. word for word. No new component library territory.

The slug separation is deliberate: `ai-quality` keeps its current scope (provider keys, model selection, feedback summary), `coach-feedback` keeps its inbox, and `assistant` is the surface-visibility cut. Cross-references between the three panels can use the shared `_shared.tsx` link helper.

### Persistence shape

Two viable shapes:

| Option | Pro | Con | Recommendation |
|---|---|---|---|
| Six new boolean columns on `AppSettings` (master + five) | Matches the existing pattern (`registrationEnabled`, `telegramGlobal`, etc.); migration trivial; queryable from Prisma with native columns; admin form binds 1:1 | Slightly chatty schema; every new sub-flag needs another migration | **Preferred** |
| Single `assistantFlags Jsonb` column with TS-typed shape | One migration ever; future sub-flags additive without DDL | Harder to migrate existing query patterns; loses Prisma column-level type safety; admin form needs JSON-merge logic | Defer |

The codebase has already chosen the column-per-flag pattern five times over (registration, telegram, ntfy, web-push, api, mood-log, bug-report) — this should follow suit. Migration adds six columns to `app_settings`, all defaulting to `true`.

### Cache strategy

Existing global toggles (`getGlobalServiceAvailability()` in `src/lib/app-settings.ts`) issue a per-request Prisma lookup with a try/catch fallback. That pattern is fine for low-traffic admin surfaces but the assistant flag is read inside the hot SSE path (`/api/insights/chat`), the per-metric status routes (called from every sub-page mount), and the Coach FAB visibility check on every Insights page load. Recommendation:

- Server side: cache the `AppSettings` row in a 60s in-memory map keyed by `singleton`. The admin PUT handler issues a single cache-bust on save. 60s lag on toggle is acceptable since the only client-side reader (`useFeatureFlags()` below) revalidates on focus through React Query.
- Client side: one new endpoint `GET /api/feature-flags` (public, no auth required since the values are not secret) feeds a `useFeatureFlags()` hook with React Query `staleTime: 60_000`. Every consumer (`<DailyBriefing>`, `<LayoutCoachFab>`, `<InsightStatusCard>` callers, `<HealthScoreDeltaExplainer>`) reads from this hook and returns `null` when the relevant flag is off. The hook is single-source-of-truth so the same render decision drives both the React tree and the admin-side preview.

### Default state for fresh installs

Recommendation: **assistant `ON`** for the master flag and **`ON`** for all five sub-flags. Rationale:

1. The current behaviour is "assistant always available when a provider is configured" — preserving the existing default is the lowest-friction upgrade path.
2. Operators who deliberately don't configure a provider already get an empty-state fallback on every surface; the toggle doesn't make their experience worse.
3. EU AI Act compliance for the assistant surfaces falls below "high-risk" (HealthLog is a wellness journal, not a medical device — Coach prompts disclose this and refuse medical advice) so opt-out is sufficient, opt-in not mandated. See the peer-research section for citations.
4. iOS surfaces the flags through the same endpoint and will respect them additively (Part D); a default-OFF would break every existing iOS install on first contact with the v1.4.x backend.

If a future operator wants a strict-default install (e.g. a clinic-side deployment with no LLM by policy), they set the master flag once in the admin panel post-install. The seed migration could optionally honour an `ASSISTANT_DEFAULT_OFF=1` env var for first-boot installs, but that's a v1.4.31+ polish, not v1.4.30.

## Part C — User-facing fallback shapes

When a surface is disabled the user must read coherent content without the missing piece. The fallback matrix:

| Surface | Disabled UI | Replacement | Empty-slot risk |
|---|---|---|---|
| Daily Briefing card | Card removed entirely from `/insights` header | Hero strip slides up; comparison toggle moves into the trends-row metaSlot | None — grid is `auto-flow` so the row collapses |
| Coach drawer | FAB hidden (`<LayoutCoachFab>` returns null); inline `<CoachLaunchButton>` pill returns null; suggested-prompts chips return null; layout-level `<CoachDrawer>` mount returns null | The "ask Coach" prompt chips on hero strip already render conditionally — same null check covers them | Hero strip needs `nullsafe` guard on the chips region so the gap doesn't leave dead whitespace |
| Insights regen icon | `onRegenerate` prop omitted from `<InsightsTabStrip>`; the existing conditional already supports this | None — the icon-only button just isn't rendered | None — tab strip already handles `onRegenerate === undefined` |
| Per-metric status card | Card returns `null` instead of the current "no provider" placeholder | A short hand-written manual paragraph reading "Track this metric to view trends" with a link to the latest measurement entry — pure-text, no LLM | Sub-page needs to ship the manual paragraph variant; it can live as a translated string `insights.status.manualOnly` |
| Health-Score delta explainer | The `?` glyph after the delta text doesn't render; delta number stays visible | None — the delta line still reads "+2 vs last week" without the trigger | None |
| Correlation card | Card returns `null`; the row above (manual correlation matrix) widens to fill | The numerical correlation coefficient still ships from `/api/correlations` if needed; only the LLM narration is hidden | Needs a non-LLM fallback row variant that shows the coefficient + a hand-written gloss like "weak positive" |

### iOS fallback contract

The iOS `Insight` model already tolerates absent surfaces: `/api/insights/cards` returns `data: []` when no advisor blob is present. The contract extension this report recommends:

- `GET /api/feature-flags` returns `{ data: { assistant: { enabled, coach, briefing, insightStatus, correlations, healthScoreExplainer } } }`. iOS reads this on app launch, caches it for the session, and gates each tab / card render off the same flags.
- The five surface endpoints (`/api/insights/generate`, `/chat`, the seven `*-status` routes, `/correlations`) start returning `403` with `errorCode: "assistant.disabled.<surface>"` when the operator flag is off. iOS treats `403` + that errorCode as a graceful empty-state signal, not an authentication error.

This means an iOS build older than v1.5 that doesn't know about the flag endpoint still degrades cleanly: it gets `403`, surfaces an "unavailable" banner, no crash. The breaking-change-free upgrade contract holds.

## Part D — iOS contract impact

The Coach SSE drawer is the v1.5 iOS differentiator per the v1.5-r-e research outcome. If an operator disables it, the iOS Coach tab needs to render an "Operator disabled" state rather than a blank screen with a typed-but-doomed input.

Recommended contract delta — **additive, no breaking change**:

1. New endpoint `GET /api/feature-flags` (public, cache-control `public, max-age=60`). Response shape:
   ```json
   {
     "data": {
       "assistant": {
         "enabled": true,
         "surfaces": {
           "coach": true,
           "briefing": true,
           "insightStatus": true,
           "correlations": true,
           "healthScoreExplainer": true
         }
       }
     }
   }
   ```
2. iOS launch sequence (additive to existing `/api/auth/me`): after auth, fire `GET /api/feature-flags` once, cache for the session. Each tab's `task { await loadFeatureFlags() }` short-circuits the LLM-backed surface if its flag is false.
3. Per-endpoint enforcement: each gated route adds the same operator-flag check at the top, returning `403` + `errorCode: "assistant.disabled.<surface>"` when off. This makes the contract self-enforcing — even an iOS app that ignores the flag endpoint still degrades correctly because the endpoint stops serving.
4. The OpenAPI spec gains the new endpoint and the `errorCode` values; both feed the iOS code-gen pipeline so the Swift error enum gets the cases for free.
5. The cards adapter at `/api/insights/cards` keeps returning `data: []` when `briefing.enabled = false` so the existing iOS empty state ("No insights yet — log measurements to start") fires unchanged.

The Coach tab on iOS gains a single new view variant — `CoachDisabledView` — bound to the flag. Copy: "The Coach is currently unavailable on this server." No personal info, no operator name leak. Same shape applies to a Briefing-disabled state on the Insights tab and an InsightStatus-disabled state on each metric sub-page.

## Part E — Implementation plan

### E1 — Schema migration (S, ~30 min)

```prisma
model AppSettings {
  // ... existing fields ...
  assistantEnabled                Boolean @default(true) @map("assistant_enabled")
  assistantCoachEnabled           Boolean @default(true) @map("assistant_coach_enabled")
  assistantBriefingEnabled        Boolean @default(true) @map("assistant_briefing_enabled")
  assistantInsightStatusEnabled   Boolean @default(true) @map("assistant_insight_status_enabled")
  assistantCorrelationsEnabled    Boolean @default(true) @map("assistant_correlations_enabled")
  assistantHealthScoreExplainerEnabled Boolean @default(true) @map("assistant_health_score_explainer_enabled")
}
```

Migration safe — six additive nullable-then-default columns, zero data movement.

### E2 — Server-side reader / writer (M, ~2h)

- Extend `src/lib/app-settings.ts` with `getAssistantFlags(): Promise<AssistantFlags>` mirroring `getGlobalServiceAvailability()` — same try/catch + defaults pattern, same 60s in-memory cache.
- Extend `adminSettingsSchema` (`src/lib/validations/admin.ts`) with the six booleans.
- Extend `src/app/api/admin/settings/route.ts` GET + PUT handlers to surface and accept them. The `booleanFields` list grows by six entries.
- New endpoint `src/app/api/feature-flags/route.ts` — public GET, returns `{ data: { assistant: AssistantFlags } }`. No auth required; the values are not secret and the iOS app needs them on startup before any auth.

### E3 — Gate the five LLM endpoints (M, ~3h)

Each of the gated endpoints adds a one-liner at the top:

```typescript
const flags = await getAssistantFlags();
if (!flags.enabled || !flags.coach) {
  return apiError("Coach is disabled on this server", 403, undefined, undefined, { errorCode: "assistant.disabled.coach" });
}
```

Five distinct gates: `/api/insights/chat`, `/api/insights/chat/[id]`, `/api/insights/chat/messages/[id]/feedback`, `/api/insights/generate`, the seven `*-status` routes (one shared gate, one flag), `/api/insights/correlations`. The Health-Score explainer doesn't need a server gate (pure client text from briefing payload) — its UI suppression alone is enough.

### E4 — Client-side `useFeatureFlags()` hook (S, ~1h)

```typescript
// src/hooks/use-feature-flags.ts
export function useFeatureFlags() {
  return useQuery({
    queryKey: ["feature-flags"],
    queryFn: async () => {
      const res = await fetch("/api/feature-flags");
      return (await res.json()).data;
    },
    staleTime: 60_000,
    gcTime: 300_000,
  });
}
```

Consumers: `<LayoutCoachFab>`, `<LayoutCoachMount>`, `<CoachLaunchButton>`, `<DailyBriefing>` parent guard on `/insights/page.tsx`, `<InsightsTabStrip>` regen-icon guard, every `<InsightStatusCard>` caller, `<HealthScoreDeltaExplainer>`, `<CorrelationCard>`. Each callsite gains a one-line conditional render.

### E5 — Admin UI panel (M, ~3h)

- New `src/components/admin/assistant-section.tsx` — six `<SettingsToggle>` rows, master toggle controls the disabled state of the sub-toggles.
- `src/components/admin/admin-shell.tsx` adds the new slug to the sidebar and section renderer.
- Add `assistant` to `ADMIN_SECTION_SLUGS` in `src/components/admin/section-slugs.ts`.
- `src/app/api/admin/data/route.ts` and `src/app/api/settings/data/route.ts` may need to include the flags in their export payload (audit trail value).

### E6 — i18n strings (S, ~1h)

Six new keys per locale × six locales (de, en, es, fr, it, pl) = 36 strings:

- `admin.assistant.title` / `admin.assistant.description`
- `admin.assistant.masterToggleLabel` / `admin.assistant.masterToggleDescription`
- `admin.assistant.coachToggleLabel` / `admin.assistant.coachToggleDescription`
- ... × five sub-toggles
- `insights.status.manualOnly` / `insights.coach.disabledByOperator` / `insights.briefing.disabledByOperator`

The operator-disabled strings stay generic — "currently unavailable on this server" — to avoid leaking operator-identity info into a user-facing copy. Marc's voice contract holds.

### E7 — Tests (M, ~3h)

- Unit: `getAssistantFlags()` returns defaults when row missing / throws.
- Unit: `adminSettingsSchema` accepts new fields.
- Unit (per gated route): with flag off, returns 403 + correct errorCode.
- Unit: `useFeatureFlags` short-circuit checks for each suppressed component.
- E2E (Playwright): admin toggles flag → user-facing surface suppressed within 60s; admin toggles back → surface reappears on next session.
- E2E: iOS-token request to `/api/insights/chat` with flag off returns 403 + correct errorCode.

### E8 — Documentation (S, ~30 min)

- Update `docs/admin/system-administration.md` (if it exists; otherwise the in-app section help slot) with the new panel description.
- CHANGELOG entry phrased in Marc-voice English: "Operators can now selectively disable assistant surfaces (Coach, Daily Briefing, per-metric status, correlations, score explainer) from the admin panel without removing the LLM provider configuration."

### Total effort

| Chunk | Size |
|---|---|
| E1 schema | S |
| E2 server reader/writer | M |
| E3 endpoint gates | M |
| E4 client hook + consumer rewires | S |
| E5 admin UI | M |
| E6 i18n | S |
| E7 tests | M |
| E8 docs | S |
| **Total** | **~M (1 release wave, ~12-14 dev hours)** |

## Part F — Plan-slot recommendation

Three options ranked:

| Option | Risk | When the operator value lands | Trade-off |
|---|---|---|---|
| **A. Ride into v1.4.30 as a single focused operator wave** | Low | All five toggles in one release | The release is "operator polish" themed; no user-visible feature, no iOS native work — matches the v1.4.x cadence of small focused releases |
| B. Split across v1.4.30 (scaffold + Coach) / v1.4.31 (Briefing + status) / v1.4.32 (correlations + explainer + polish) | Lower | Coach toggle in v1.4.30, full coverage by v1.4.32 | Three releases of partial operator visibility; the admin panel becomes inconsistent until v1.4.32 lands |
| C. Defer entirely to post-v1.5 | Lowest | After the iOS sprint | Marc's strategic concern stays unaddressed; future iOS app already shipped without flag-awareness ⇒ iOS will need a follow-up release to honour the flags |

**Recommendation: Option A.** Reasons:

1. The whole scope is ~14 dev-hours — fits a single autonomous wave easily.
2. iOS hasn't shipped yet (per v1.5 R-E it's a ~5-day Swift sprint), so the flag endpoint and 403-with-errorCode contract can ship in v1.4.30 and iOS picks them up natively from day one — no follow-up release needed.
3. Operator-side toggles are a one-shot delivery: half-implemented they're confusing ("why is Coach disabled by the admin but the Briefing still rendering?"). All-or-nothing is the right product cut.
4. The implementation is mostly mechanical: schema + flag hook + five gates + five UI guards + admin panel + tests. There's no design ambiguity, no UX research debt. It's the kind of small focused release the v1.4.x cadence is optimised for.

If Marc wants to defer (Option C), the only added cost is one extra iOS release down the line to honour the flag endpoint — the backend work would still want this same shape eventually, so the deferral really only saves the admin-UI hours.

## Peer-research grounding

- **WHOOP** ships an opt-out request as a top-voted community feature; the assistant is not currently disable-able client-side. Reactive to user pressure, not proactive design. ([Whoop Community — Making Whoop Coach Optional](https://www.community.whoop.com/t/making-whoop-coach-optional/14410))
- **MacroFactor** treats each coaching module as skippable per-week; no global off-switch but every module is opt-in at the point of presentation. ([MacroFactor Check-Ins and Coaching Modules](https://help.macrofactorapp.com/en/articles/247-introduction-to-check-ins-and-coaching-modules))
- **Apple Health** keeps AI predictions opt-in and viewable/deletable per Apple's privacy disclosure. ([Apple Health privacy](https://www.apple.com/health/))
- **Withings** ships Withings+ with AI assessments but offers no opt-out toggle visible in their app-store materials. ([Withings App Store](https://apps.apple.com/ie/app/withings/id542701020))
- **Cronometer** keeps the integration scoped to Apple Health categories — fine-grained data-source toggles, no AI-narration toggle because Cronometer doesn't ship one.
- **Industry best practice for LLM feature flags** (2025): kill switches that evaluate instantly with no remote call, default-safe-state, on-call accessible without code changes. ([Octopus Deploy — Feature Flag Best Practices](https://octopus.com/devops/feature-flags/feature-flag-best-practices/), [WP Pluginsify — LLM Feature Flags](https://wppluginsify.com/blog/llm-feature-flags-safe-rollouts-of-ai-in-apps/))
- **EU AI Act Article 9 + Article 14** require risk-management and human-oversight for high-risk AI; wellness journals like HealthLog fall below the high-risk threshold (no diagnostic intent, explicit no-medical-advice disclosure) so opt-out is sufficient, opt-in not mandated. Operator-side kill switch nevertheless aligns with Article 14 human-oversight principles. ([EU AI Act Article 14](https://artificialintelligenceact.eu/article/14/), [Medicine, Healthcare and the AI Act — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12282355/))
- **Healthcare AI deployment** (Becker's Hospital Review 2025): UCHealth ships every agentic AI surface with an immediate operator kill switch, full audit logs, strict permissions. Industry direction is converging on operator-side controls. ([Becker's — Kill switches and guardrails](https://www.beckershospitalreview.com/healthcare-information-technology/ai/kill-switches-guardrails-the-raging-debate-over-healthcare-ai-agents/))
- **GDPR alignment**: the assistant surfaces process pseudonymous health data; an operator-side kill switch is a sufficient lawful-basis safety valve under Article 25 (data protection by design and by default). ([GDPR + AI Act overlap — IAPP](https://iapp.org/resources/article/mapping-interplays-gdpr-eu-ai-act))

## Open question for Marc

Should the `correlations.enabled` toggle be merged into `briefing.enabled` (since correlation cards arguably belong to the briefing surface conceptually), reducing the operator-facing flag count from five to four? Splitting them adds operator control at the cost of one more sub-toggle the operator must understand; merging simplifies the UX at the cost of all-or-nothing for the briefing surface. The Withings/Cronometer benchmark suggests fewer toggles win — but Marc's preference for granular operator control may favour keeping them split.
