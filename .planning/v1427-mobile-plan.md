---
file: .planning/v1427-mobile-plan.md
purpose: v1.4.27 mobile-capability audit + fix structure, inserted between R3b and R4
created: 2026-05-15
target_tag: v1.4.27
sequenced_after: R3b (B6 i18n sweep + B7 symmetry/dead-code)
sequenced_before: R4 (9-contributor QA pass)
---

# v1.4.27 — Mobile capability audit and fix

## Motivation

Maintainer directive (mid-flight, after R3a dispatch): v1.4.27 should ship a clear improvement in mobile capability across the entire web application. Every surface needs to be auditable on three axes — visual responsive behaviour, mobile UX logic, and code currency against the latest Tailwind v4 + shadcn + Next.js 15 best practices.

The audit + fix runs as two new rounds inserted between R3b and R4:

```
R3a (current) → R3b (B6 + B7) → R3c mobile audit → R3c-summary → R3d mobile fixes → R4 QA → R5 release
```

## R3c — Mobile audit (7 parallel auditors)

Each auditor owns one surface area. Each writes one report at `.planning/research/v1427-r3c-mobile-<slug>.md`.

| Slot | Slug | Surface |
|---|---|---|
| MA1 | `dashboard` | `/` home page, every dashboard tile, charts row, GLP-1 secondary tile, hero column, dashboard-layout settings |
| MA2 | `insights` | `/insights` index plus seven sub-pages (`blutdruck`, `gewicht`, `puls`, `stimmung`, `medikamente`, `bmi`, `schlaf`), tab strip, status cards, daily briefing, health-score card, weekly-report page if it has any markup |
| MA3 | `coach` | Coach composer, message thread, evidence disclosure, settings sheet, prefill flows |
| MA4 | `measurements-workouts` | Measurements list + new-measurement form + detail; workouts list + detail; manual-attach flow |
| MA5 | `medications` | Medication list + form + schedule editor + DrugLevelChart in standalone mode + therapy timeline |
| MA6 | `settings-admin` | Every `/settings/*` sub-page (account, thresholds, sources, dashboard-layout, notifications, telegram, integrations, language, data-sources, advanced) + every `/admin/*` sub-page |
| MA7 | `auth-public` | Sign-in, sign-up, password-reset, terms, `/privacy`, `/about`, error pages, public landing snippets |

### Three audit axes per surface

**Visual (responsive behaviour).** Each auditor verifies the surface at 320, 375, 390, 414, and 768 px viewport widths.

- Horizontal scroll absence at every breakpoint.
- Tap targets at least 44 × 44 pt for every interactive element (button, link, icon-button, switch, checkbox, slider thumb).
- Modal / dialog / sheet width caps respect viewport (`max-w-[calc(100vw-2rem)]` or shadcn `sm:max-w-md` rule).
- Sticky headers and CTAs do not overlap content at scroll-bottom.
- Safe-area insets honoured on routes that render at the viewport edge.
- Text legibility at small sizes — line-height, letter-spacing, contrast against background tokens.
- Truncation on flex children — `min-w-0` plus `truncate` where text could overflow.
- Chart reflow: every chart consumes width fluidly, no fixed `width="600"` artefacts.

**Logic (mobile UX patterns).** Each auditor evaluates whether the surface uses patterns appropriate to a touch device.

- Bottom-sheet vs desktop dialog for primary entry points on mobile.
- Sticky bottom-CTA pattern on long forms instead of off-screen submit buttons.
- Off-canvas navigation drawer on small viewports instead of inline sidebar.
- Pull-to-refresh on list surfaces if the underlying data is refreshed on demand elsewhere.
- Long-list virtualisation (or pagination) when the surface can carry hundreds of rows.
- Touch gestures (swipe to delete, swipe to dismiss) where the desktop UX uses a hover-revealed action button.
- Keyboard handling: the on-screen keyboard does not occlude active inputs; `inputmode` and `autocomplete` are correct on every field.

**Code (current best-practice).** Each auditor reads the underlying components and identifies code that is out of step with current framework conventions.

- Tailwind responsive utility order — mobile-first cadence (`p-4 sm:p-6 lg:p-8`), not desktop-first overrides (`p-8 max-sm:p-4`).
- Tailwind v4 patterns where the repo runs v4 (CSS variable architecture, `@theme inline`, no `hsl(var(--…))` legacy).
- shadcn component versions — flag any component that diverges from the upstream pattern (e.g. an old `<Dialog>` shape that the v0.8+ upstream has replaced).
- No `@media` queries in CSS that should be Tailwind utilities.
- No fixed pixel widths on container components (`w-[680px]`, `min-w-[500px]`) — replace with `max-w-*` plus fluid widths.
- Missing `min-w-0` on flex children that contain `truncate`.
- Missing `inline-flex` / `flex-shrink-0` on icon-button rows that overflow on narrow viewports.
- Inline `style={{ width: '…' }}` props on layout components.
- Deprecated motion APIs (e.g. Framer Motion v6 patterns on a v11 install).
- Missing `aria-*` on interactive non-button elements.
- Inputs missing `inputmode`, `autocomplete`, `enterkeyhint`.

### Auditor toolkit

Each auditor draws on:

- Read + Grep + Glob for code-side review across their surface area.
- `mobile-first-design` skill for the mobile-first cadence checklist.
- `design-review` skill for the seven-phase frontend rubric.
- `tailwind-v4-shadcn` skill for current v4 patterns.
- `shadcn-ui` skill for current upstream component shapes.
- Context7 (`mcp__claude_ai_Context7__query-docs`) for any framework lookup (Tailwind v4, Next.js 15, shadcn, motion, react-hook-form).
- Optional: Playwright probe via `playwright-skill` if the auth setup permits a quick login + screenshot loop. Skip if it costs more than 15 min to wire up — code-first audit is the floor.

### Report format

Each auditor's report uses this skeleton:

```markdown
---
file: .planning/research/v1427-r3c-mobile-<slug>.md
purpose: Mobile capability audit — <surface area>
created: 2026-05-15
auditor: <slot id>
---

# Mobile audit — <surface area>

## Summary

<2-3 sentences: how many components reviewed, how many issues found by severity tier, headline takeaway>

## Findings

### F<n> — <one-line title>
- Severity: Critical | High | Medium | Low
- Axis: visual | logic | code
- File: <path:line if applicable>
- Symptom: <what breaks or looks wrong>
- Evidence: <viewport / grep result / Playwright observation>
- Recommended fix: <one-line shape of the patch>
- Effort: <S | M | L>

[repeat per finding]

## Headline metrics
- Components reviewed: <n>
- Findings by tier: C: <n> H: <n> M: <n> L: <n>
- Mobile-hostile patterns flagged for B7-style symmetry pass: <n>

## Open questions for the consolidator
<anything the auditor could not decide alone — sequencing, scope, ambiguous patterns>
```

## R3c-summary — Mobile consolidator

One contributor reads all seven audit reports and produces `.planning/v1427-mobile-fix-plan.md` with:

- Consolidated find-list, de-duplicated, sorted by severity tier.
- Fix-surface buckets (MB1, MB2, MB3, …) — touch-disjoint by file, mirroring the B1-B7 collision-matrix discipline of the main fix plan.
- File-touch collision matrix.
- Decisions on any ambiguous findings flagged by auditors.
- Dispatch sequence: which buckets run in parallel, which need to sequence behind which.

## R3d — Mobile fixes (4-6 parallel contributors)

Per consolidator-bucket. Each contributor follows the same conventions as the R3a buckets:

- Branch model: commit to `develop`. Never `main`.
- Forbidden words: AI, Claude, agent, marathon, wave, phase, session, subagent, Anthropic. Use round, pass, contributor, slot, automation, release work.
- Per-commit gate: `pnpm typecheck` + `pnpm lint` + relevant `pnpm test`. Hook failure → fix + new commit.
- No `Co-Authored-By: Claude` trailer. No `--no-verify`. No `--no-gpg-sign`.
- Atomic commits per logical sub-task.
- Each writes a short report at `.planning/round-3d-<bucket>-report.md`.

## Severity application policy

- Critical and High findings: apply in v1.4.27 unconditionally.
- Medium findings: apply in v1.4.27 if effort ≤ M (medium); defer L (large) items to `.planning/v1428-backlog.md`.
- Low findings: apply if the same fix-contributor already touches the file for a higher-severity finding (zero-cost pile-on); otherwise defer.

## Schedule into the v1.4.27 ladder

```
R3a (running) → R3b (B6 + B7) → R3c mobile audit (7 parallel) → R3c-summary → R3d mobile fixes (4-6 parallel) → R4 QA → R5 release
```

Estimated wall-clock for the new section: 60-90 min on top of the existing ladder.

## Anti-goals

- No new framework migrations. If the audit finds the repo on Tailwind v3 while v4 is current — flag for v1.4.28, do not migrate in v1.4.27.
- No new component-library swaps. If the audit finds an outdated shadcn component — patch the local copy to match upstream, do not introduce a new dependency.
- No mobile-only routes or PWA scope expansion. v1.4.27 stays scoped to "the web application is good on mobile."
- No iOS-side code (that lives in the separate `healthlog-iOS` repository).

## Done when

- Every R3c auditor report exists at `.planning/research/v1427-r3c-mobile-<slug>.md`.
- `.planning/v1427-mobile-fix-plan.md` exists with touch-disjoint buckets.
- Every Critical and High finding plus every effort-≤-M Medium finding has landed via R3d commits on `develop`.
- Every R3d contributor has written a short report.
- The release CHANGELOG entry for v1.4.27 carries a "Mobile capability" section under the headline groups.
