# v1.4.33 IW9 — Polish + reliability (implementation report)

Author: IW9 implementation wave
Branch: `develop`
Base commit: `6135c325`
Date: 2026-05-16

## Scope

Eight commits over the polish-and-reliability surface flagged in
`.planning/round-v1433-audit-polish.md` + the Lighthouse-derived
punch list. Touch surface stayed disjoint from IW2 (next.config),
IW3 (dashboard page), IW4 (settings shells), IW5 (Coach panel), IW6
(insights data wiring), and IW7 (layout/nav). The Card / Button
primitives are shared but qualified as cross-cutting.

## Commits

| sha         | scope                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| `87e4cdcb`  | fix(layout): normalise auth-shell container width on max-w-screen-xl           |
| `fe942991`  | fix(insights): consolidate route scroll-reset into a single hook               |
| `3a5f7deb`  | fix(ui): normalise Card defaults to p-4 md:p-6                                 |
| `e65cdc97`  | fix(ui): reserve Button loader space to eliminate CLS during in-flight requests |
| `b763424b`  | fix(a11y): give every Progress bar an accessible name                          |
| `0cac3d35`  | fix(a11y): give icon-only buttons accessible names on the medications page    |
| `2620064e`  | fix(a11y): repair non-sequential heading order on three surfaces              |
| `2438dce6`  | docs(layout): pin the legal-page narrow-column convention in code comments    |

Eight atomic commits.

## Findings — landed

### A3 Win 1 — container width drift (audit §4.2)

`src/components/layout/auth-shell.tsx`, `src/app/bugreport/page.tsx`

Pre-v1.4.33 the dashboard shell capped at `max-w-[76.8rem]` (1228 px),
settings/admin used `max-w-screen-xl` (1280 px), bugreport used
`max-w-6xl` (1152 px). Three different content widths produced a
52-128 px lateral shift on every route switch. Normalised on
`max-w-screen-xl` everywhere (auth-shell + bugreport's inner cap
dropped — shell owns the frame).

### A3 Win 3 — duplicate scroll-reset (audit §2.1)

`src/hooks/use-scroll-reset-on-route.ts` (new),
`src/components/insights/sub-page-shell.tsx`, `src/app/insights/page.tsx`

Both the SubPageShell and the insights mother page fired their own
`requestAnimationFrame → window.scrollTo({top:0})` on mount. On slow
hydrates the second callback re-snapped the viewport after the chart
skeleton inflated — the "viewport jumps on click" complaint. Hoisted
to a single `useScrollResetOnRoute()` hook; both consumers now share
one source of truth. Existing sub-page-shell tests stay green.

### A3 Win 4 — Card padding inconsistency (audit §4.1)

`src/components/ui/card.tsx`

The shadcn Card defaults shipped `py-6` + `px-6` (uniform 24 px) while
the dashboard tile-strip + chart cards used `p-4 md:p-6` (16 px
mobile, 24 px md+). Side-by-side on `/insights` the correlation cards
+ daily-briefing read as denser than chart cards next to them.
Normalised on `p-4 md:p-6` across Card / CardHeader / CardContent /
CardFooter; existing consumers that override via `cn(...)` still win.
All 400 component/insights/charts tests pass.

### CLS 0.186 — Loader-Circle space reserve (Lighthouse)

`src/components/ui/button.tsx`, `src/app/bugreport/page.tsx`,
`src/app/medications/page.tsx`

The Lighthouse run pinned a 0.186 CLS on `div.space-y-2 > Button >
Loader-Circle`. Root cause: bugreport + medications-import buttons
drew `{loading && <Loader2/>}<Icon/>` (rendering BOTH icons during
the request), growing the button by ~24 px. Fixed with a ternary
swap so Loader2 occupies the same 16x16 slot as the static icon.
Both buttons also gained `aria-busy={loading||undefined}` for SR
narration. The Button primitive now carries an inline doc-comment
that documents the loading-state convention.

### a11y — Progressbar accessible names (Lighthouse)

`src/app/insights/medikamente/page.tsx`,
`src/app/achievements/page.tsx`,
`src/components/medications/medication-card.tsx`,
`src/components/medications/glp1-medication-card.tsx`

Eight Radix `<Progress>` consumers were missing `aria-label`, so the
SR announcement collapsed to the role name. Reused the on-screen
caption keys (e.g. `medications.compliance7d`) so the SR matches the
visible label. The three `role="progressbar"` divs in
`health-score-card.tsx`, `getting-started-checklist.tsx`, and
`OnboardingShell.tsx` already carried aria-labels (verified, no
change).

### a11y — Icon-only Link/Button names (Lighthouse)

`src/app/medications/page.tsx`

Five icon-only Buttons (reset + status DropdownMenu triggers, three
copy actions) were missing `aria-label`. Reused `common.moreOptions`
and `common.copy` keys (no new translation strings added; messages
files off-limits to IW9).

Icon buttons in `src/components/settings/**` (IW4),
`src/components/insights/coach-panel/**` (IW5), and the bottom-nav
already carried aria-labels — audited but unchanged.

### a11y — Heading order (Lighthouse)

`src/components/insights/therapy-timeline.tsx`,
`src/components/admin/feedback-inbox-section.tsx`,
`src/components/admin/reminders-section.tsx`

Three non-sequential descents:
- TherapyTimeline sr-only drug heading was h4 under SubPageShell h1
  (CardTitle is a `<div>`, not a heading). Promoted to h2.
- Feedback inbox detail sheet's metadata / screenshot h4 sat inside
  a ResponsiveSheet whose Radix DialogTitle is h2. Demoted to h3.
- Admin RemindersSection results h4 sat under SectionFrame h1.
  Promoted to h2.

### bfcache breaker verification (Lighthouse)

Audited `src/**` for `beforeunload` / `unload` / `pagehide` /
`onfreeze` listeners, plus WebSocket / EventSource / iframe patterns
that block bfcache. **No client-side breakers found**. The Lighthouse
"bfcache disabled (3 failure reasons)" is therefore upstream of the
React tree — `Cache-Control: no-store` on dynamic responses (Next.js
default for authenticated routes) is IW2's `next.config.ts` surface.
Verification complete from the client side; no change needed in IW9
scope.

### Legal-page width documentation (audit §3.4)

`src/app/privacy/page.tsx`, `src/app/about/page.tsx`

`max-w-3xl` (768 px) on the privacy + about main columns is
intentional (long-form legal text reads better at 70-80 chars/line).
Pinned in inline comments so a future contributor doesn't "fix" the
deviation from the shell width.

## Out of scope (deferred / declined)

- **Settings icon-only buttons** — All `size="icon"` Buttons in
  `src/components/settings/**` carry aria-labels already (verified
  via grep + spot-check). Touch boundary respected with IW4.
- **Coach panel headings** — Audited heading order in
  `coach-panel/**` (h3 sr-only "History" / "Sources"); IW5's report
  shows the rails are intentionally rendered under the drawer's
  Sheet title (h2), so h3 is sequential. No change.
- **z-index global token suite** (audit §6.1, §6.3) — Would
  require a `globals.css` token introduction + a sweep across 15+
  consumers (dialog/sheet/popover/dropdown/tooltip/select/toast/
  bottom-nav/top-bar/skip-link/tour). Out of the IW9 window;
  documented as a v1.4.34 candidate.
- **Spacing-token half-step sprawl** (audit §5.1) — Coach bubble
  `px-3.5 py-2.5` is IW5's surface; suggested-prompts chips +
  medication-form inner cards stayed. Defer to a focused
  "spacing-token audit" round.
- **Dashboard `<h3>` chart titles** (audit-adjacent) — Charts
  emit `<h3>` directly under a dashboard `<h1>` (h2 skip). The
  charts are reused on insights sub-pages where the trends-row
  provides an h2, so demoting the chart's heading would break the
  sub-page outline. Cleaner fix: add an sr-only h2 group label
  around each dashboard chart card. Owned by IW3's dashboard
  surface; deferred to the next polish round.
- **WelcomeCarousel debounce on `scrollToSlide`** (audit §2.4) —
  Low-severity, fires only on double-tap during first auth.
  Deferred.
- **HealthScoreCard `md:min-h-[280px]`** (audit §4.6) — IW6's
  insights territory; brief flagged it as IW7-adjacent. Deferred.

## Quality gates

```
$ npx tsc --noEmit
 (clean across IW9-touched files)
$ npx vitest run src/components/ui src/components/insights/__tests__ \
                  src/components/charts/__tests__
 Test Files  54 passed (54)
      Tests  400 passed (400)
$ npx vitest run src/components/insights/__tests__/sub-page-shell.test.tsx
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

The full suite has five failing tests but none from IW9-touched
files:
- `src/app/__tests__/insights-b3-wiring.test.ts` — stale expectation,
  IW2 moved CorrelationRow/TrendsRow under `next/dynamic`.
- `src/components/settings/__tests__/settings-shell.test.tsx` (×3) —
  expects "Benachrichtigungen" but IW4 renamed to
  "Benachrichtigungs-Kanäle"; IW4 owns the update.
- `src/components/insights/coach-panel/__tests__/message-thread.test.tsx`
  — IW5 owns.

## Files touched

- `src/components/layout/auth-shell.tsx`
- `src/app/bugreport/page.tsx`
- `src/hooks/use-scroll-reset-on-route.ts` (new)
- `src/components/insights/sub-page-shell.tsx`
- `src/app/insights/page.tsx`
- `src/components/ui/card.tsx`
- `src/components/ui/button.tsx`
- `src/app/medications/page.tsx`
- `src/app/insights/medikamente/page.tsx`
- `src/app/achievements/page.tsx`
- `src/components/medications/medication-card.tsx`
- `src/components/medications/glp1-medication-card.tsx`
- `src/components/insights/therapy-timeline.tsx`
- `src/components/admin/feedback-inbox-section.tsx`
- `src/components/admin/reminders-section.tsx`
- `src/app/privacy/page.tsx`
- `src/app/about/page.tsx`

No `messages/*.json` changes (IW9 stayed off the locale surface per
brief; only reused existing keys).
