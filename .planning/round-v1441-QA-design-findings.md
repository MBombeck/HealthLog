# v1.4.41 Design-review findings

## Verdict
APPROVE

## Critical (visible regression — CLS / contrast / a11y break)
None.

## High (placeholder mismatch, focus order, motion)
None.

## Medium
None.

## Low
- **L1 — Tile-strip Suspense placeholder lacks a min-height for the all-suspend edge case.**
  `src/app/page.tsx:1427-1431`. The placeholder div has `h-full w-full` which fills the grid cell via `auto-rows-fr`, but only if at least one sibling tile renders real content to set the row's natural height. If every tile were to suspend at once, `auto-rows-fr` would fall back to the padding-box height (`p-4 md:p-6` ≈ 48 px) and the row would jump to the real `text-3xl`-driven height (~120 px) once tiles resolve — CLS. Today the boundary never paints because every tile body is synchronous (data already gated on the parent), so this is a future-proofing concern rather than a live regression. A follow-up could add a `min-h-[6rem]` (or token) to the placeholder to fix the future RSC-hoist edge cleanly. Not a blocker for v1.4.41.
- **L2 — Placeholder div omits cosmetic flex layout classes that the live trend-card carries.**
  Live tile chrome (`src/components/charts/trend-card.tsx:241`): `bg-card border-border flex h-full w-full min-w-0 flex-col rounded-xl border p-4 md:p-6`. Placeholder (`src/app/page.tsx:1429`): `bg-card border-border h-full w-full rounded-xl border p-4 md:p-6`. The missing `flex min-w-0 flex-col` classes are children-positioning concerns; the placeholder has no children, so the visual footprint (background, border, radius, padding, fill behaviour) is byte-identical for the user. Not a fix; flagged for documentation completeness.

## Strengths
- **Placeholder chrome matches the live tile.** The Suspense fallback uses the identical `bg-card border-border rounded-xl border p-4 md:p-6` chrome as `TrendCard`, `ChartSkeleton`, and `MedicationComplianceChart` — every dashboard surface paints from the same card primitive. No token drift.
- **`aria-hidden="true"` on the placeholder is correct.** The div has no semantic content (no label, value, or interactive element) and exists purely to reserve layout space. Screen readers correctly skip it. Focus order is unaffected (no focusable descendants exist anywhere inside the Suspense fallback).
- **Test pin updated in lock-step.** `src/app/__tests__/dashboard-suspense-boundaries.test.ts:50-61` was hardened to require the `aria-hidden="true"` placeholder pattern; a future regression that drops the placeholder back to `null` lands a failing test rather than silently regressing the streaming-composition contract.
- **queryKey migrations on `auth/login`, `auth/register`, `notifications`, `about-section`** are clean refactors — `["literal"]` swapped for `queryKeys.<name>()` factory calls only. No JSX, no className, no markup, no copy changes. Design surface is byte-identical.
- **Doctor-report PDF (`5296a612`) is visually unchanged.** The fix lives in `src/lib/doctor-report-data.ts` (aggregator) + `src/app/api/doctor-report/availability/route.ts` (probe) — both upstream of the render. Soft-deleted rows correctly drop from the section-availability gate, so empty sections still toggle off (no orphaned section header surface). The PDF renderer (`src/lib/doctor-report-pdf-core.ts`) and the settings hero (`src/components/settings/arztbericht-hero-card.tsx` → `DoctorReportDialog`) are unchanged. No empty-state regression risk.
- **Grid layout discipline preserved.** The tile-strip continues to use the `grid auto-rows-fr [grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))]` track (`src/app/page.tsx:1393-1396`). The placeholder participates in the same track and stretches with `h-full`; no breakpoint-specific overrides needed.
