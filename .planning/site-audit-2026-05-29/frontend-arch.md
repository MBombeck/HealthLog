# Frontend / shadcn architecture audit — 2026-05-29

Read-only senior-architect + frontend review of the HealthLog web frontend.
Scope excludes the medication surface (`src/components/medications/**`,
`src/app/medications/**`), which is under active rework. Covered: dashboard,
insights, AI coach, settings (incl. AI + integrations), onboarding, auth,
measurements, mood, workouts, layout/proxy, shared UI primitives.

Overall: the codebase is high quality. Accessibility and performance work is
extensive and well documented (skip link, 44px tap targets, `aria-current`,
`motion-reduce`, focus-visible rings, per-tile Suspense + layout-stable
skeletons, slim/thick analytics split, centralised query-key factory). Genuine
defects are few. No P0 (fully broken / blocking) issue was found.

---

## P0 — broken / blocking

None found.

---

## P1 — clear defects

### P1-1 Dashboard range colors bypass tokens and fail light-mode AA contrast
`src/app/page.tsx:126-128` (`getRangeColorClass`) and `:145`, `:151`, `:158`
(`getRangeHint` legend) return raw Tailwind `text-green-400` /
`text-orange-400` / `text-red-400`.

These pale `-400` shades are hard-coded rather than routed through the semantic
`--success` / `--warning` / `--info` tokens defined in
`src/app/globals.css`. Those tokens carry deliberate light-mode AA-contrast
overrides (`--success: #14720a`, `--warning: #a34d14`); the raw `-400` shades do
not, so green/orange range text fails WCAG 2.1 AA contrast on the light theme.
This is a genuine contrast defect, not just a consistency nit, because the same
information has no non-color encoding here.

Fix: replace the raw classes with the semantic token classes
(`text-success` / `text-warning` / destructive equivalent) so both themes get
the AA-compliant value. Audit `targets/page.tsx:241` (`text-orange-500`) in the
same pass for the matching inconsistency.

### P1-2 `togglePrivacy` swallows fetch failures
`src/components/settings/ai-section.tsx:1797-1805`. The handler does not check
`res.ok` and has no try/catch; it calls `onPrivacyChanged()` unconditionally
after the `await fetch(...)`. A 4xx/5xx or network error leaves the UI showing
the new privacy mode while the server kept the old one — a silent desync on a
privacy-sensitive control. Every sibling mutation in this file handles errors;
this one is the outlier.

Fix: guard on `res.ok`, surface a toast/error on failure, and only call
`onPrivacyChanged()` on success (mirror the sibling mutation pattern in the same
file).

### P1-3 25-character notes cap is too restrictive for health notes
`src/components/measurements/measurement-form.tsx:28`
(`const MAX_COMMENT_LENGTH = 25;`), mirrored in
`src/components/measurements/measurement-list.tsx:108`. 25 chars cannot hold a
meaningful clinical note ("took after large meal, felt dizzy standing up").

Fix: raise to a sensible health-note length (e.g. 200-280) in both call sites,
keep them in sync (ideally a single shared constant), and confirm the server
Zod schema + DB column accommodate the new bound.

---

## P2 — polish

### P2-1 ResponsiveSheet desktop dialog caps at `sm:max-w-md`
`src/components/ui/responsive-sheet.tsx:163`. The desktop Dialog branch caps at
`sm:max-w-md`, which squeezes the measurement form's `sm:grid-cols-3` BP layout
on wide screens. Consider a wider cap (or a per-instance `className` override)
for form-bearing sheets so desktop space is not wasted.

### P2-2 GLP-1 side-effect chips render for all users unconditionally
`src/components/mood/mood-form.tsx:255-301` (`GLP1_SIDE_EFFECT_KEYS`). The chips
show on every mood entry for every user regardless of whether they are on GLP-1
therapy; the inline comment admits "Always visible for now (cheap UX...)". This
adds irrelevant cognitive load for the majority who are not on GLP-1.

Fix: gate the chip block on an active GLP-1 medication signal (already available
elsewhere in the app's medication context) so it only appears when relevant.

### P2-3 1514-line dashboard client component
`src/app/page.tsx` is a single 1514-line `"use client"` component with a large
inline IIFE (lines ~697-1511) assembling the trendCards/charts arrays. It works
and renders correctly, but the size hurts maintainability and pushes
client-bundle weight. Consider extracting the card/chart assembly into typed
helper modules and splitting presentational sub-components; evaluate whether any
of the assembly can move to an RSC boundary.

---

## Strong positives observed (preserve on churn)

- `src/components/ui/button.tsx` — documented loading-icon-SWAP to avoid CLS;
  good focus-visible + variant coverage.
- `src/components/layout/{auth-shell,top-bar,sidebar-nav,bottom-nav}.tsx` —
  skip link, 44px targets, `aria-current`, focus rings, safe-area insets,
  bottom-nav 5+More pattern.
- `src/components/ui/dialog.tsx`, `empty-state.tsx`, `native-select.tsx` —
  solid primitives; close-X 44px mobile / 36px desktop (documented WCAG 2.5.8
  exception).
- `src/app/auth/login/page.tsx` — open-redirect guard, `aria-describedby`
  error wiring, underline-always link (axe `link-in-text-block`).
- `src/app/insights/page.tsx` + `daily-briefing.tsx` — dynamic imports +
  layout-stable skeletons; per-metric routed key-finding rows.
- `aria-live` coverage across ~27 files; no stray `<div onClick>` /
  `<span onClick>` or raw `<img>` outside the excluded medication surface.
