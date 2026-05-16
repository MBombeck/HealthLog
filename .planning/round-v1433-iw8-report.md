# IW8 implementation report — v1.4.33

Branch: `develop`. Scope: A5 F2 (CRITICAL), A5 F14, A5 F19, A4 dead-code sweep.

## Commits

| SHA | Title |
| --- | --- |
| `f9b8f3bd` | fix(onboarding): stop spotlight tour from intercepting dashboard clicks |
| `585637d5` | fix(layout): harden bottom-nav so it cannot overlap the last viewport line |
| `9c738b60` | fix(monitoring): sample web-vitals at 10% so the beacon stops self-throttling |
| `99af5304` | chore(cleanup): retire AssistantDisabledNotice + dead settings.placeholder copy |
| `1a101505` | fix(monitoring): defer web-vitals sample draw to useEffect to satisfy react-hooks/purity |

Five atomic commits. The fifth is a lint follow-up to the F19 fix —
`react-hooks/purity` rejects `Math.random()` inside `useMemo`, so the
sample-decision draw moved to a `useEffect` + `useRef` pair.

## F2 — onboarding-tour overlay blocks every dashboard click (Critical)

`src/components/onboarding/tour.tsx`

The dim backdrop was a single full-viewport `<button>` with a
`clip-path` punching a visual hole around the spotlight target.
`clip-path` only changes paint — the button's hit-box stayed over the
entire viewport, so every click in the spotlight area (Hinzufügen,
header avatar, sidebar links) hit the dim layer and triggered Skip
without forwarding the click to the underlying target. New users
were effectively locked out of the most common dashboard action.

The fix renders the dim backdrop as up to four rectangular panels
arranged around the spotlight rect (top / bottom / left / right
strips) and sets `pointer-events: none` on the tour root. The
spotlight area is now genuinely click-through — the spotlighted
target receives clicks normally — and the dim panels keep the "tap
backdrop to dismiss" affordance via their own `onClick` handlers.
The tooltip opts back into click capture via `pointer-events: auto`
so its buttons stay reachable. A purely-visual spotlight ring (also
`pointer-events: none`) replaces the carved-out clip-path so the
target still gets a visible highlight without re-capturing clicks.
The center-placement fallback (no spotlight rect available) keeps
the legacy full-cover dim behaviour for steps without a target.

### Regression guard

`e2e/onboarding-tour-passthrough.spec.ts` — two Playwright specs:

1. With the tour mounted (overrides `/api/auth/me` to flip
   `onboardingTourCompleted` to `false`), clicking the
   `data-tour-id="dashboard-quick-add"` header button opens the
   Hinzufügen dropdown menu (`aria-expanded="true"` + a visible
   `role="menuitem"`). The tour stays mounted.
2. Clicking any of the new dim panels (`data-testid="onboarding-tour-dim"`)
   still skips the tour, preserving the existing affordance.

Vitest SSR contract (`tour.test.tsx`) stays green 8/8 — `role=dialog`,
`aria-modal`, the data-testid hooks, step counter, and i18n keys are
unchanged.

## F14 — mobile bottom-nav defence (High)

`src/components/layout/bottom-nav.tsx`

The bar was `bg-card/80` (80% translucent) and relied on the inner
flex row's `h-16` alone for height. The audit captured page content
bleeding under the bar on `/settings/account` and `/settings/ai`.
Per the brief, the bar component owns the safe-area / floor contract
and the page shell (IW4) owns its own bottom-padding above the bar.

Defence in depth: pinned `min-h-16` on the outer `<nav>` (defence
against a future flex-collapse quirk) and switched the surface from
`bg-card/80` to a solid `bg-card`. The safe-area inset and fixed
bottom-anchor stayed as they were. A future page-shell oversight now
produces a hard occlusion (visibly broken on review) rather than a
translucent bleed (silently shipped).

Bottom-nav SSR test stays green 4/4.

## F19 — web-vitals reporter self-throttled at 429 (Medium)

`src/components/monitoring/web-vitals-reporter.tsx`

`useReportWebVitals` fires up to six metrics per navigation. The
reporter posted every measurement on every page-load, so a typical
session burned through the route-side per-IP 60/min rate-limit in
seconds. The runtime audit captured `POST /api/internal/web-vitals
429` for almost every metric after the first navigation —
telemetry was self-throttling.

Switched to client-side sampling at `SAMPLE_RATE = 0.1`. The
sample-decision is drawn once per mount inside `useEffect` (the
draw is impure so it can't live in the render body or `useMemo`) and
stashed in a `useRef` so every metric callback inside the same
navigation reads the same decision — partial sampling would mix
LCP-without-CLS noise into the aggregates. The route-side rate-limit
stays in place as a backstop.

Pre-hydration callbacks (very rare) find `sampledRef.current === null`
and drop the beacon — same defensive contract.

## A4 — dead-code sweep

`src/components/insights/assistant-disabled-notice.tsx` (deleted),
`src/components/insights/__tests__/assistant-disabled-notice.test.tsx`
(deleted), `src/components/settings/section-placeholder.tsx`, and
`messages/{de,en,es,fr,it,pl}.json`.

* `AssistantDisabledNotice` was introduced in v1.4.31 for the
  operator-disabled assistant surface but never wired into a render
  site. Deleted the component + its SSR test + the four locale keys
  it consumed across all six locale files:
  - `insights.briefingDisabledByOperator`
  - `insights.statusDisabledByOperator`
  - `insights.correlationsDisabledByOperator`
  - `insights.coach.disabledByOperator`

  The `AssistantDisabledError` thrown by `requireAssistantSurface()`
  and the `assistant.disabled.<surface>` errorCode envelope stay —
  iOS clients read the errorCode to render an inline notice. Stale
  doc comments in `api-handler.ts` and `feature-flags/index.ts` that
  referenced the deleted component are updated to describe the
  surface generically.

* `settings.sections.placeholder.coming_soon` was a one-line
  fallback for `<SectionPlaceholder>`. Every slug in
  `SETTINGS_SECTION_SLUGS` has had a matching component since
  v1.4.22 so the placeholder body is unreachable through the type
  system. The defensive component itself stays as a guard but now
  inherits the section's own description for the `EmptyState` body,
  retiring the dedicated locale key from all six files.

Locale-integrity contract (key parity across `de`, `en`, `es`, `fr`,
`it`, `pl`) stays green. Touched-file lint and full `pnpm vitest run
src` (4111 passing) clean.

## Coordination notes

- IW4 (settings shell) is the right owner for the page-side
  `pb-{height-of-bottom-bar}` contract. F14's bar-side defence is
  complementary and does not replace it.
- IW6 (insights) ships the `feat(insights): regroup tab-strip pills`
  commit (`85d74dd9`) that lands in parallel — no file overlap.
- IW1 (analytics) ships the analytics route + summaries-slice work
  in parallel — no file overlap.
- IW3 (dashboard page) ships the page.tsx work — no file overlap.

## Files

- `src/components/onboarding/tour.tsx`
- `src/components/layout/bottom-nav.tsx`
- `src/components/monitoring/web-vitals-reporter.tsx`
- `src/components/settings/section-placeholder.tsx`
- `src/lib/api-handler.ts` (doc-comment update only)
- `e2e/onboarding-tour-passthrough.spec.ts` (new)
- `messages/{de,en,es,fr,it,pl}.json` (locale removals only)
- `src/components/insights/assistant-disabled-notice.tsx` (deleted)
- `src/components/insights/__tests__/assistant-disabled-notice.test.tsx` (deleted)
