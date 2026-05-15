---
file: .planning/v1428-backlog.md
purpose: v1.4.28 backlog seeded from v1.4.27 deferrals
created: 2026-05-15
---

# v1.4.28 backlog

Items deferred from v1.4.27 with a clear rationale. Sorted by source bucket.

## From bucket B1 — Dashboard rebuild (v1.4.27)

- **F7 weekly-report dead click — needs maintainer screenshot.** Scan budget (30 min) across `src/` and `messages/` returned no dead affordance. Every weekly-report click target on `/insights` routes correctly to `/insights/report/[week]`. The retired `<InsightsCardPreview>` was the only dashboard-anchored insight CTA in v1.4.27 — its removal in B1 commit 3 is the most likely reason the maintainer perceived a dead click. Ask the maintainer to point at the dead element with a screenshot. If they confirm the dashboard side, add a slim "Wochenreport für KW {N}" banner on `/` mirroring the `<WeeklyReportBanner>` from the hero, gated on a fresh advisor payload.

## From bucket B7 — Symmetry sweep + dead-code cleanup (v1.4.27)

- **README-referenced admin / monitoring orphan endpoints.** Five endpoints flagged by R1.6 as candidate-orphan have no runtime caller in `src/` but are documented as part of the API surface in `README.md` lines 362–382 + `CHANGELOG.md` 752–753. Per the v1.4.27 fix-plan scope-maximization directive ("if a consumer surfaces e.g. CI script, uptime probe, README reference, defer that single endpoint to v1.4.28"), each of the five defers:
  - `/api/admin/ai-settings` (GET + PUT) — README line 362–363 + CHANGELOG 752 + 3261.
  - `/api/admin/backup/test` (POST) — README line 368 + CHANGELOG 752.
  - `/api/admin/status-overview` (GET) — README line 367 + CHANGELOG 753 + AGENTS.md 194.
  - `/api/monitoring/glitchtip/test` (POST) — README line 381.
  - `/api/monitoring/umami/test` (POST) — README line 382.
  - **Decision needed:** either wire each endpoint to a real consumer (admin Settings UI, ops dashboard, uptime probe) or drop both the route and the README mention in the same commit. The README mention alone is not load-bearing if no operator reads it; a 30-second `gh search code` over the public mirrors of HealthLog deployments would tell us whether a downstream operator scripts against any of them.
- **i18n key `insights.coach.window.lastYear` missing across six locales.** B7 commit 6 added the `lastYear` snapshot-window enum value and wired the source-chip resolver to look up `insights.coach.window.lastYear`. The key resolves through the i18n fallback chain to the raw key string today; B6 (the i18n bucket) owns messages/*.json and should add the key to all six locales in v1.4.28. EN copy: "year so far"; DE: "Jahresrückblick"; FR/ES/IT/PL: respective locale-native translations.

## From mobile-fix plan v1.4.27 (R3c → R3d MB1-MB7)

The R3 mobile-fix plan catalogued 16 strategic defers spanning admin tables, form-stack rewrites, gesture libraries, and onboarding polish. Each carries the verbatim rationale from `.planning/v1427-mobile-fix-plan.md` section "Deferred to v1.4.28 (effort > M or strategic scope)".

- **CF-77 — Six admin tables miss card-list fallback.** Severity High · MA6-F2 · effort L. Per-table contributor work load; mechanical pattern but ~6 tables × non-trivial card design. The largest single deferral; should be a dedicated v1.4.28 bucket rather than fragmented across audits.
- **CF-78 — `<DateTimeInput>` rewrite (shadcn DatePicker + TimePicker).** Severity Medium · MA4-F7 · effort L. Introduces a new dependency or component family; out of scope for a polish round.
- **CF-79 — RHF + Zod migration for `measurement-form` + measurement-list edit.** Severity Medium · MA4-F10 · effort M-bordering-L. Broad scope; touches the API integration shape and therefore the iOS-side native API contract. Document the call before starting the migration so the iOS client can mirror the schema.
- **CF-80 — Bottom-sheet primitive across all medication entry-points (settings-style flows stay centred).** Severity Medium · MA5-F13 · effort L. Repo-wide; CF-1 + MB1 already handle the core form flows for v1.4.27, but the medication subset is large enough to warrant its own pass.
- **CF-81 — InjectionSitePicker SVG tap-target spec documentation.** Severity Low · MA5-F17 · effort M. Deliberate trade-off, not a true regression — but the spec needs a public note so future contributors don't re-flag.
- **CF-82 — `medication-form.tsx` refactor into `<ScheduleEditor>` + `<ScheduleList>`.** Severity Low · MA5-F18 · effort L. Pure code hygiene; sits on the same form-stack as CF-79.
- **CF-83 — Swipe-to-delete on measurements + history-rail rows.** Severity Low · MA4-F13 + MA3-F5 partial · effort L. New gesture-library dependency. Should pair with CF-78 to share the gesture stack decision.
- **CF-84 — Web workouts list + detail UI.** Severity Low · MA4-F14 · effort L. Strategic v1.5 work aligned with the iOS workouts views; v1.4.28 only if the iOS side is ready first.
- **CF-85 — Coach drawer `!max-w-*` important fight.** Severity Low · MA3-F15 · effort S. Defer until upstream shadcn `<Sheet>` exposes a width prop; track upstream PR.
- **CF-86 — Thresholds skeleton-to-actual layout jump for users with overrides.** Severity Low · MA6-F9 · effort S but skeleton heuristic complexity. Sweep candidate.
- **CF-87 — Login overview filter row progressive disclosure.** Severity Low · MA6-F16 · effort M. UX preference, not a regression.
- **CF-88 — Coach source-chip provenance row sub-20 px.** Severity Low · MA3-F13. Deferred until chips become interactive (v1.5 deep-link feature).
- **CF-89 — Onboarding step-pages arrow-pager defensive flex-wrap.** Severity Low · MA7-F16 · effort S. Defensive only; not currently broken.
- **CF-90 — BaselineForm sticky-bottom Save row on `<sm`.** Severity Low · MA7-F17 · effort M. One-time onboarding flow; low-traffic surface.
- **CF-20 (in v1.4.27 plan, captured here for visibility) — admin card-list fallback.** Subset of CF-77; tracked under the larger umbrella to avoid duplicate work.

## From R4 simplifier — `.planning/research/v1427-r4-simplifier.md`

The simplifier review catalogued nine v1.4.28-candidate cleanups grouped under a "simplification micro-bucket". Suggested ordering picks the highest-leverage items first.

- **F-H1 — Insights sub-page data-fetch + empty-state scaffold consolidation.** Severity High · effort M. Seven sub-pages each duplicate the same React-Query-driven analytics fetch + empty-state branch. Extract `useInsightsAnalytics(metric)` hook + `<MetricEmptyState>` primitive so the eighth sub-page (e.g. `vo2-max` added in v1.4.28) is a one-file change. Pairs with F-M1.
- **F-M1 — `AnalyticsData` interface declared seven times.** Severity Medium · effort S. Hoist into a shared types module (one-line edit per consumer once F-H1 lands).
- **F-M2 — `dynamic(() => import("@/components/charts/health-chart"))` repeats six times.** Severity Medium · effort S. Carve a single `<HealthChartDynamic>` re-export instead of six identical `next/dynamic` call sites.
- **F-M3 — `<EmptyState ctaSize="lg">` prop landed with zero consumers.** Severity Medium · effort S. Either consume the prop across the eight insights `<EmptyState>` consumers + dashboard empty state, or revisit the prop in v1.4.28 once consumers actually exist.
- **F-M4 — `useCoachLaunch().setOpen` exported but only one consumer.** Severity Medium · effort S. Tighten the public surface; drop the `CoachLaunchScope` parameter until v1.4.28 actually wires it (today's call sites all pass `undefined`). Also covered by senior-dev MED-2.
- **F-M5 — Seven insight-status test files duplicate the same mock prelude.** Severity Medium · effort S. Extract a shared test helper so the next insight-status page added in v1.4.28 does not duplicate the prelude again.
- **F-M6 — `CoachDrawer` weighs in at ~560 LOC.** Severity Medium · effort M. Carve out `<MobileRailTray>` (sources rail + history rail) into its own component. Natural target for the v1.4.28 unification with the new sub-page tray work.
- **F-M7 — Stale v1.4.x version markers in code comments.** Severity Medium (hygiene) · effort S. Heavy comment scrub for old "v1.4.16 hotfix" / "v1.4.20 attempt" markers that no longer carry context. Mechanical, defer-able.
- **F-L1 through F-L9 — minor cleanups (`CHART_MINI_HEIGHT_PX` orphan, dynamic-import unwrap helper, `useIsMobile` carve-out, `<ResponsiveSheet>` body branch dedup, glp1-tile single-consumer hooks, metric-availability enum lookup, `<CoachLaunchButton>` dual-render branches, in-file sub-component carve-outs).** Severity Low · effort S each. Background hygiene to roll into the simplification micro-bucket when the file is next open.

## From R4 senior-dev — `.planning/research/v1427-r4-senior-dev.md`

The senior-dev review queued eight v1.4.28 candidates after closing the v1.4.27 BLOCKER + HIGH tier.

- **HIGH-1 fix — `<ResponsiveSheet>` footer slot rail wiring.** Severity High · effort M. The footer slot is dead code on every consumer except `export-section`. Move inline form footers to `<ResponsiveSheet footer={…}>` across all five primary form call sites. ~80 LOC.
- **HIGH-2 fix — `<ResponsiveSheet>` viewport-rotation focus/scroll loss.** Severity High · effort M. The Sheet/Dialog mount swap at the breakpoint boundary drops focus + scroll position on viewport rotation. Pick a rotation strategy: lock-at-mount vs unified Dialog/Sheet root. The brief writes the trade-off out in full.
- **MED-1 fix — three remaining raw `<select>` blocks bypass `<NativeSelect>`.** Severity Medium · effort S. Sweep `ai-section.tsx`'s three raw `<select>` blocks to `<NativeSelect>` so the height + outline tokens stay consistent.
- **MED-2 fix — `CoachLaunchScope.metric` type narrowing.** Severity Medium · effort S. Today the type is `{ metric?: string }`; narrow to the `CoachScopeSource` union before v1.4.28 wires the parameter. Pairs with simplifier F-M4.
- **MED-3 fix — `<ResponsiveSheet>` Dialog branch ignores `bodyClassName` for the footer.** Severity Medium · effort S. Extract `RESPONSIVE_SHEET_FOOTER_CLASS` constant or document the divergence as intentional.
- **MED-4 decision — Coach launch surface on empty-state Insights sub-pages.** Severity Medium · effort S if yes. Add a `<CoachLaunchButton />` below the primary action on the seven empty insights sub-pages, or document the intentional one-CTA call.
- **Drift cleanup — 5 remaining `<Dialog>` consumers to migrate.** Severity Medium · effort S each. `phase-config-dialog`, `ResearchModeAcknowledgmentDialog`, `mood-list` row-edit, `measurement-list` row-edit, `target-edit-sheet` should all migrate to `<ResponsiveSheet>` for parity with the v1.4.27 primary form flows.
- **react-hook-form deps hygiene.** Severity Low · effort S. Either commit to RHF (paired with CF-79) or drop the two currently unused deps.

## From R4 design — `.planning/research/v1427-r4-design.md`

The design review queued twelve Medium-tier polish items behind the v1.4.27 critical sweep. Every item lives below the Critical/High floor that v1.4.27 closed.

- **M1 — GLP-1 tile padding cascade breaks the chart-row rhythm at `md+`.** `src/components/dashboard/glp1-tile.tsx` line 248 uses `px-4 py-4` at every breakpoint while neighbouring chart cards use `p-4 md:p-6`. Lift the two cards (GLP-1 tile + HealthScoreCard) to `md:p-6` or carve a shared `<Tile>` wrapper.
- **M2 — Briefing CTA empty-state variant mismatch.** Briefing uses `variant="outline"`, dashboard empty uses `variant="default"` — same role, opposite primacy signal. Pick one variant for both.
- **M3 — Glp1Tile range strip overlaps the segmented-control tabs on Galaxy Fold (280 px).** `flex-wrap items-center justify-between` drops the range strip onto the second line. Ladder a `sm:flex-row flex-col` or `justify-start gap-3` to keep the relationship clearer at very narrow viewports.
- **M4 — Tab-strip active pill paints `bg-primary/10` + `text-primary` (low-contrast on dark mode).** Roughly 4.1 : 1 contrast on `text-xs` labels. Settings sidebar uses the same vocabulary and inherits the same number. Sweep three surfaces or rebalance the palette.
- **M5 — `useIsMobile("sm")` bottom-sheet branch caps Coach at 95 dvh — only 5 % of the page visible.** 34 px of underlying `/insights` is left visible — a single line of body text. `<ResponsiveSheet>` phone branch picked 90 dvh; Coach drawer should follow.
- **M6 — Daily Briefing wraps the entire row in a `<Link>` — `<DeltaBadge>` gets pulled into the link name.** Screen readers announce the entire link as `"<headline> <delta> <detail>"`. Carve the delta out with `aria-hidden="true"` or wrap just the headline in the link.
- **M7 — "VO2 max" tile label uses an `??` fallback string from a translation that always resolves.** `t()` never returns `undefined`; the `??` fallback is dead code. Sweep the five fallback sites or trust the translator.
- **M8 — Compliance heatmap pinned-tooltip cleanup leaks on rapid taps near the right edge.** Capture-phase ordering can clear the second pin before the rect handler re-pins. Filter on `event.target instanceof SVGElement` or register the listener on the next animation frame.
- **M9 — `<Glp1Tile>` schedule pill row drops the "in X days" countdown for the lastInjection date.** Next-injection pill includes a `t("dashboard.glp1.inDays", { count })` suffix; last-injection pill renders only the date. Symmetry closes the "is this active therapy?" read in a single glance.
- **M10 — `<SubPageShell>` description prop is set on `/insights/blutdruck` only.** The brief promised an "Apple-Health-style one-line scaffold on every metric page"; only Blutdruck passes a description today. Either populate the six missing descriptions or drop the prop.
- **M11 — Settings mobile section strip uses `min-h-11` chips; desktop sidebar uses `py-2` (≈ 32 px tall).** Same control, same role, two heights. Lift the desktop rows to `py-2.5` (40 px) or `min-h-10` for a consistent 40/44 ladder.
- **M12 — `not-found.tsx` button uses raw classNames instead of `<Button asChild>`.** "Back to dashboard" CTA duplicates the v1.4.27 `<Button asChild>` pattern manually. Three-line fix to bring the page back into the shared primitive.

## From R4 UI-conformity — `.planning/research/v1427-r4-ui-conformity.md`

Three P0 drift classes survived v1.4.27 because each is a multi-file mechanical sweep best handled as a single v1.4.28 bucket.

- **Admin section chrome divergence (11 surfaces).** 11 admin section cards render `<div className="text-lg font-semibold">` for the card title (not a heading element). Six other admin sections use `<h2 className="text-lg font-semibold">` for the same role. Bring all 11 into line with Settings: every section gets a `<section aria-labelledby=…>` landmark + `<h2>` heading + card chrome. Decision call: pull the dual-pattern surfaces into a shared `<SectionCard>` primitive.
- **`<SectionCard>` primitive carve-out (21 candidates).** The `<div className="bg-card border-border rounded-xl border p-6">` card pattern appears 21 times across admin + settings. Extract a `<SectionCard>` primitive so the chrome stays consistent; sweep all 21 sites.
- **Loader spinner palette + size + motion-reduce vocabulary drift (18 variations).** Eighteen Loader2 call sites across the repo carry different size + colour + motion-reduce combinations. Pick one canonical vocabulary (`text-primary h-6 w-6 animate-spin motion-reduce:animate-none` is the most common shape) and sweep.
- **Two tab-strip implementations coexist.** `<insights/insights-tab-strip.tsx>` is a hand-rolled `<nav>` with `<Link>` pills; `admin/feedback-inbox-section.tsx` uses the shadcn `<Tabs>` primitive. Either consolidate on shadcn `<Tabs>` (lift the insights strip's sticky+fade behaviour into a wrapper) or move the feedback-inbox to the bespoke shape. Pick one for v1.4.28.
- **`<InsightStatusCard>` missing on `/insights/schlaf`.** Six of seven sub-pages mount `<InsightStatusCard>` underneath the chart; Sleep does not. Either mount the per-section assessment slot on Sleep or document the slot as optional with a `// no per-section assessment yet` comment.
- **`admin/feedback-inbox-section.tsx` raw `<table>` with no mobile card list.** The only admin table without a mobile card list fallback. Pairs with CF-77 — same mechanical pattern, scope it in the same bucket.

## From R4 product-lead — vendor label exemptions

Per the convention compliance audit on the locale bundles, two exempt-by-necessity vendor labels are documented in `docs/audit/v1427-summary.md` so future audits don't re-flag them:

- **Provider-chooser dropdown options (`settings.ai.providerOptions.anthropic` + `settings.ai.activeProviderOptions.anthropic`).** Renders `Anthropic (Claude)` across all six locales because the operator selects the actual vendor product. Rebranding would break recognition.
- **GitHub source URL on `/about` (`https://github.com/MBombeck/HealthLog`).** The username segment is irreducible technical identifier; the page never spells "Marc" or "Bombeck" in body copy.

Mirror entries to `messages/_meta/forbidden-words.md` if and when that convention surface lands; until then `docs/audit/v1427-summary.md` is the canonical record.

## From R4 i18n — partial-translation residue across the wider bundle

The locale-coverage probe surfaced 1,664 keys where at least one of FR/ES/IT/PL still equals the EN value. The headline namespaces with the largest gaps:

- `achievements.badges.*` — 118 EN-leak rows.
- `admin.section.*` — 99 EN-leak rows.
- `settings.ai.*` — 65 EN-leak rows.
- `settings.sections.*` — 56 EN-leak rows.
- `insights.coach.*` — 51 EN-leak rows.
- `targets.status.*` — 36 EN-leak rows.
- `admin.feedback.*` — 34 EN-leak rows.
- `insights.recommendation.*` — 20 EN-leak rows.
- `settings.testConnection.*` — 18 EN-leak rows.
- `insights.correlationRow.*` — 16 EN-leak rows.

**Decision call for maintainer:** v1.4.28 chooses between (a) tightening the drift-guard to fail when a FR/ES/IT/PL value equals its EN sibling and the EN sibling contains alphabetic ASCII (broad-coverage but big churn), or (b) targeted per-namespace sweeps prioritised by user-facing surface visibility.

**Suggested drift-guard tightenings (decisions for the maintainer):**
1. Whitespace-around-placeholder guard — extend `i18n-drift-guard.test.ts` with `/[A-Za-zÀ-ÿ]\{|\}[A-Za-zÀ-ÿ]/` returning no match. Would have caught the ten `pageInfo`-shape strings closed by v1.4.27 R4 RC1.
2. GLP-1 EN-leak guard — narrow per-namespace assertion that values differ from their EN sibling.
3. Native-pagination connector test — `pageInfo` assertion that the FR/ES/IT/PL value contains a space-flanked connector matching the native pagination phrase.

## From R4 dead-code — `.planning/research/v1427-r4-dead-code.md`

The dead-code scan found 14 orphan exported functions/consts (Low severity each) and five README-tied endpoints (already documented above under B7). No deferred markers remain in code (`InsightsPageHero`, `BASE_SYSTEM_PROMPT`, `INSIGHTS_SYSTEM_PROMPT` were retired earlier in v1.4.27). The orphan exports are mechanical sweeps; defer-able indefinitely.

- **14 orphan exported functions / consts.** Cosmetic; bundle one cleanup pass into the simplification micro-bucket alongside F-L1.
- **Stale Vitest mock.** One sweep candidate; out of scope as a standalone item.
- **Two cosmetic stale code comments.** Mechanical; pair with F-M7.
