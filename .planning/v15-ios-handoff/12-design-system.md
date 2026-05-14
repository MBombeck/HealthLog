---
file: 12-design-system.md
purpose: Visual language reference — tokens, components, mobile-first rules, accessibility floors — so the iOS native build mirrors the web look without re-deriving it.
when_to_read: Before laying out any iOS screen, picking colours, or sizing touch targets. Re-read when porting a specific web surface (dashboard tile, chart band, range bar) to UIKit/SwiftUI.
prerequisites: 02-server-architecture.md (stack), 11-web-ui-tour.md (per-page composition)
estimated_tokens: 5200
version_anchor: v1.4.25 / sha 49f71c92
---

# Design System — Tokens, Components, Mobile-First Rules

## TL;DR

Dracula in the dark, Alucard in the light, both wired through shadcn CSS variables. Tailwind v4 with `@theme inline` re-exports every token. Mobile-first: every surface starts at 360 px, progressive-enhances upward; no top/bottom split of the same concept on one screen; touch targets ≥ 44 × 44 CSS px; WCAG AA contrast in both themes. iOS native should ship one palette per appearance (light/dark) and reuse the chart hex literals verbatim so screenshots line up next to the web app.

---

## 1. Token Architecture

### 1.1 Layer cake

```
                    ┌──────────────────────────────┐
                    │  globals.css                 │
                    │  ───────────                 │
                    │  Dracula raw palette (root)  │
                    │  Dark mode overrides (.dark) │
                    │  Light mode overrides (.light)│
                    └─────────────┬────────────────┘
                                  │
                    ┌─────────────▼────────────────┐
                    │  @theme inline {…}           │
                    │  ────────────────            │
                    │  Re-exports CSS vars as      │
                    │  Tailwind `--color-*` tokens │
                    │  so `bg-card` / `text-fg` JIT│
                    └─────────────┬────────────────┘
                                  │
                    ┌─────────────▼────────────────┐
                    │  shadcn components           │
                    │  ────────────────            │
                    │  Read tokens by semantic name│
                    │  (primary, muted, ring …)    │
                    └──────────────────────────────┘
```

### 1.2 Raw Dracula palette

```css
/* from src/app/globals.css:108-122 */
:root {
  --dracula-bg:        #282a36;
  --dracula-current:   #44475a;
  --dracula-fg:        #f8f8f2;
  --dracula-comment:   #9aa3b3;
  --dracula-cyan:      #8be9fd;
  --dracula-green:     #50fa7b;
  --dracula-orange:    #ffb86c;
  --dracula-pink:      #ff79c6;
  --dracula-purple:    #bd93f9;
  --dracula-red:       #ff5555;
  --dracula-yellow:    #f1fa8c;
  --dracula-lavender:  #d6acff;
}
```

### 1.3 Semantic aliases

| Semantic | Dark (Dracula) | Light (Alucard) | Use |
|----------|----------------|------------------|-----|
| `--background` | `#282a36` | `#f5f5f5` | Page canvas |
| `--foreground` | `#f8f8f2` | `#1f1f1f` | Body text |
| `--card` | `#1e1f29` | `#ffffff` | Tiles, panels, dialogs |
| `--muted` | `#44475a` | `#dcdeef` | Disabled chrome |
| `--muted-foreground` | `#9aa3b3` | `#5b6273` | Captions, hints |
| `--primary` | `#bd93f9` (purple) | `#644ac9` | Buttons, CTAs |
| `--destructive` | `#ff5555` | `#cb3a2a` | Delete, danger |
| `--border` | `#44475a` | `#cfcfde` | Hairlines |
| `--success` | `#50fa7b` | `#14720a` | Positive state |
| `--warning` | `#ffb86c` | `#a34d14` | Caution |
| `--info` | `#8be9fd` | `#036a96` | Neutral note |

> STOP HERE if you intend to introduce a new colour outside this list. Marc's rule: charts and badges go through the named tokens; raw hex only inside Recharts series definitions.

### 1.4 Chart series hex literals (lock these)

Recharts series colours are hard-coded in the dashboard for visual identity. Mirror exactly on iOS:

```ts
// from src/app/page.tsx:990, 1038, 1059, 1079, 1113, 1133
weight       → #bd93f9   // purple
bp_systolic  → #ff79c6   // pink
bp_diastolic → #8be9fd   // cyan
pulse        → #50fa7b   // green
body_fat     → #ffb86c   // orange
sleep        → #8be9fd   // cyan
steps        → #50fa7b   // green
bmi (derived)→ #f1fa8c   // yellow
```

Traffic-light bands (range overlays):

```ts
red    → #ff5555 opacity 0.16
orange → #ffb86c opacity 0.18
green  → #50fa7b opacity 0.20
```

The Recharts library may not exist on iOS; whatever native chart wrapper iOS picks (Swift Charts) must reproduce these colour stops at the same opacities or screenshots will visibly diverge between platforms.

---

## 2. Theme Toggle

| Concern | Web implementation | iOS equivalent |
|---------|--------------------|-----------------|
| Switch | `ThemeProvider` from `next-themes` writes `.dark` / `.light` on `<html>` | `UITraitCollection.userInterfaceStyle` / `@Environment(\.colorScheme)` |
| Storage | `localStorage` + a cookie so SSR doesn't flash | `UserDefaults` mirrored from the `User.theme` field |
| Default | "system" — follows OS appearance | Same |

The web app re-exports the theme in a cookie because the Next.js SSR step needs it before hydration. iOS can skip the cookie dance; just persist locally and respect `traitCollection`.

---

## 3. Component Library

### 3.1 Inventory

```
src/components/ui/      ← shadcn primitives
├── alert-dialog.tsx
├── avatar.tsx
├── badge.tsx
├── button.tsx          ← cva variants: default / destructive / outline / secondary / ghost / link
├── card.tsx
├── date-input.tsx
├── dialog.tsx
├── dropdown-menu.tsx
├── empty-state.tsx     ← custom; the only non-shadcn primitive
├── input.tsx
├── label.tsx
├── logo.tsx
├── password-strength.tsx
├── progress.tsx
├── select.tsx
├── separator.tsx
├── sheet.tsx           ← bottom sheets + side drawers
├── skeleton.tsx
├── sonner.tsx          ← toasts
├── switch.tsx
├── table.tsx
├── tabs.tsx
└── tooltip.tsx
```

### 3.2 Button variants

```ts
// from src/components/ui/button.tsx:8-34
default     → bg-primary  text-primary-fg  hover:bg-primary/90
destructive → bg-destructive text-white  hover:bg-destructive/90
outline     → border  bg-background  hover:bg-accent
secondary   → bg-secondary text-secondary-fg  hover:bg-secondary/80
ghost       → hover:bg-accent  (no background at rest)
link        → text-primary underline-offset-4 hover:underline

size: default(h-9) | xs(h-6) | sm(h-8) | lg(h-10)
      icon(size-9) | icon-xs(size-6) | icon-sm(size-8) | icon-lg(size-10)
```

iOS port table:

| Web variant | UIKit / SwiftUI equivalent |
|-------------|-----------------------------|
| `default`   | `UIButton.Configuration.filled` tinted with `primary` |
| `destructive` | `.filled` tinted red, `.role = .destructive` on Apple menu items |
| `outline`   | `.bordered` |
| `secondary` | `.gray` |
| `ghost`     | `.plain` |
| `link`      | `UIButton` w/ `attributedTitle` underline |

### 3.3 The custom EmptyState

The web app has exactly one bespoke primitive: `<EmptyState>`. Used on the dashboard zero-state, every insight sub-page when the metric has < 5 readings, and the medications list when empty. Same shape on iOS:

```tsx
// from src/components/ui/empty-state.tsx, conceptual contract
{ icon: ReactNode, title: string, description?: string, action?: ReactNode }
```

iOS equivalent: a reusable `EmptyStateView` SwiftUI struct with the same four slots.

---

## 4. Mobile-First Conventions

### 4.1 Marc's mobile rules

1. **No top/bottom split of the same concept.** Don't put a provider dropdown at the top of Settings and the provider config form at the bottom — the user has to scroll to see the consequence of the toggle. Drive the form *under* the dropdown. (Memory: `feedback_settings_no_split`.)
2. **Single-line headings + inline trend arrow + baseline alignment** (W20a). Tile headings never wrap; trend arrow sits on the same baseline as the value.
3. **Tabs above the hero**, not below. Sub-page navigation lives at the top of the scroll view; the hero is the first scroll-snap target underneath.
4. **Full-width grid rule.** The tile strip starts and ends at the exact same x-coordinates as the chart row below it. No 12-column grids on mobile; the tiles fill the container.
5. **Equal-height trends row.** Every chart in the chart row is the same height to give a calm vertical rhythm.

### 4.2 Touch targets

```ts
// post-Fix-L (W21) — WCAG 2.5.5 floor
min-w-11 min-h-11   // 44×44 CSS px
```

`size="sm"` (h-8 = 32 px) is *below* the floor; add `className="min-h-11"` whenever a small button lives in a mobile-first surface. The web app currently does this on every quick-add dropdown trigger.

iOS gets this for free: UIKit's `hitTest` honours `accessibilityFrame`; SwiftUI's default control sizes are already ≥ 44 pt. Just don't shrink them.

### 4.3 Container widths

| Breakpoint | Container |
|------------|-----------|
| `< 640px`  | full-width with `px-4` page padding |
| `≥ 640px`  | `max-w-2xl mx-auto` |
| `≥ 1024px` | `max-w-5xl mx-auto` |
| `≥ 1280px` | `max-w-6xl mx-auto` |

iOS: lock the readable-content layout to ~720 pt max on iPad; on iPhone, fill the safe-area width with system-standard insets.

---

## 5. Specific Patterns You Will Re-implement

### 5.1 Trend tile (dashboard strip)

```
┌───────────────────────────────┐
│ ⚖  Weight              ↗  +1.2│  ← icon + label + trend arrow + delta
│                               │
│   78.4 kg                     │  ← latest value (large, bold)
│                               │
│   7d: 78.1   30d: 77.6        │  ← sub-values
└───────────────────────────────┘
```

Source: `<TrendCard>` at `src/components/charts/trend-card.tsx`. Key contract: every tile is the same width (CSS grid `auto-fit, minmax(9rem, 1fr)`) and the chart row below shares the same start/end columns. Translate to iOS: a `LazyVGrid` with `GridItem(.adaptive(minimum: 144))` and equal-height rows.

### 5.2 MedicationDetailSection chrome (Fix-N lock)

```
┌──────────────────────────────────────────┐
│ Titration  (drug INN badge)   [+ Add]    │ ← header row, px-3 py-2.5
├──────────────────────────────────────────┤ ← border-border/60 hairline
│                                          │
│   …section body…                         │ ← px-3 py-3
│                                          │
└──────────────────────────────────────────┘
   border-border/60 rounded-md border
```

Locked since W21 Fix-N. The wrapper `<MedicationDetailSection>` enforces this contract so the three GLP-1 panels (Titration, Scheduling, SideEffects) cannot drift on padding or border opacity. Code at `src/components/medications/medication-detail-section.tsx`.

iOS: a `SectionContainer` view with the exact same paddings (12 pt horizontal, 10 pt header-vertical, 12 pt body-vertical) and a hairline divider at 60 % `separator` opacity.

### 5.3 Range bar (Dracula consistency)

The "value vs traffic-light range" chip used everywhere (Targets page, dashboard sub-pages, doctor report):

```
   ▓▓▓▓▓░░░░░░░░░░░░░░░  ← red zone   (#ff5555 @ 16%)
   ░░░▓▓▓▓▓▓▓▓░░░░░░░░░  ← orange    (#ffb86c @ 18%)
   ░░░░░░░░░▓▓▓▓▓▓▓░░░░  ← green     (#50fa7b @ 20%)
   ░░░░░░░░░░░░░░▓▓▓▓▓▓  ← orange
   ░░░░░░░░░░░░░░░░░▓▓▓  ← red
              ↑
              current value marker
```

Opacities are non-negotiable. Less opacity reads as "barely there"; more opacity drowns the value marker. iOS Swift Charts: use `RuleMark` per band with `.foregroundStyle(.color.opacity(0.20))`.

### 5.4 InsightsCardPreview (dashboard)

A compact 3-recommendation preview pinned above the chart row on the dashboard. Severity-ordered, with a "View all" link → `/insights`. Self-hides when the user has no provider. Source: `src/components/insights/insights-card.tsx`.

iOS: a `InsightPreviewCard` view at the top of the dashboard `ScrollView`, identical content shape — title, severity dot, body, "View all" trailing chevron.

---

## 6. Typography

| Role | Web class | Size | Weight |
|------|-----------|------|--------|
| Page title (h1) | `text-2xl font-bold tracking-tight` | 24 px | 700 |
| Section heading | `text-lg font-semibold` | 18 px | 600 |
| Tile label | `text-sm font-medium text-muted-fg` | 14 px | 500 |
| Tile value | `text-2xl font-bold` | 24 px | 700 |
| Body | `text-sm` | 14 px | 400 |
| Caption / hint | `text-xs text-muted-fg` | 12 px | 400 |
| Mono (rare — tokens, ids) | `font-mono` | inherits |

Font stack: system sans / system mono via `--font-sans` and `--font-mono` (Geist Sans / Geist Mono in production, but the variable lets you swap). iOS: SF Pro Text + SF Mono — closest analogues.

---

## 7. Spacing & Radius

| Token | Value |
|-------|-------|
| `--radius` | `0.625rem` (10 px) — the base |
| `--radius-sm` | 6 px |
| `--radius-md` | 8 px |
| `--radius-lg` | 10 px |
| `--radius-xl` | 14 px |

Cards use `rounded-md` (8 px); buttons `rounded-md`; dialogs `rounded-lg`; the Sheet bottom-drawer uses a top-only `rounded-t-2xl`.

iOS: `RoundedRectangle(cornerRadius: 10)` for cards, `12` for sheets.

---

## 8. Accessibility Floors

| WCAG | Web enforcement | iOS port |
|------|------------------|----------|
| 1.4.3 Contrast | Both palettes audited AA on the white/dark card | Re-audit on iOS — system grays differ |
| 2.1.1 Keyboard | Focus ring `ring-3 ring-ring/50` on every focusable | UIKit gets focus engine for free on iPad |
| 2.4.7 Focus visible | `focus-visible:` everywhere | iOS focus on tvOS only; iPhone uses VoiceOver |
| 2.5.5 Touch targets | `min-h-11 min-w-11` | System buttons already ≥ 44 pt |
| 4.1.2 Name/role/value | `aria-label`, `aria-labelledby`, `role` on custom widgets | `.accessibilityLabel`, `.accessibilityRole` |

> Since v1.4.24: the `MedicationDetailSection` wrapper enforces `aria-labelledby` wiring so the three GLP-1 panels can no longer drift apart on screen-reader semantics. The iOS sibling should expose each section as an `.accessibilityElement(children: .contain)` with a heading element marked `.accessibilityAddTraits(.isHeader)`.

---

## 9. Self-Test

If your iOS screen passes this checklist it is design-system compliant:

- [ ] Background = `Color("dracula-bg")` in dark, `Color("alucard-bg")` in light, sourced from a colour asset catalog with matched dark/light variants.
- [ ] Every chart series uses the exact hex in §1.4.
- [ ] No tappable target < 44 × 44 pt.
- [ ] Page title is 24 pt bold; nothing on the screen is larger except the latest tile value.
- [ ] Card corners are 10 pt rounded; section headers carry a hairline divider at 60 % separator alpha.
- [ ] A range bar uses the three opacity stops `0.16 / 0.18 / 0.20` for red/orange/green.
- [ ] An EmptyState component is used for every zero-data surface (no inline "no data" sentence).
- [ ] Dynamic Type scales the page (test at `xxxLarge`).

---

## 10. What NOT to Port

The web app has a handful of accidents iOS should not inherit:

| Web reality | iOS guidance |
|-------------|---------------|
| `next-themes` cookie-based default | Use `traitCollection.userInterfaceStyle` only |
| Recharts `<ResponsiveContainer>` width-fixed hack | Swift Charts auto-sizes |
| `getRangeColorClass()` returning string class names | Use `Color` directly via a `valueBand(for:)` helper |
| `data-tour-id="…"` markers (Shepherd.js spotlight) | iOS uses `.accessibilityIdentifier` for UI tests instead |
| `next/dynamic` chart imports for SSR avoidance | No equivalent — every Swift view is rendered client-side |
