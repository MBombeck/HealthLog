# HealthLog UI Guidelines

> Visual & interaction patterns in the HealthLog PWA. The binding rules
> for card anatomy, spacing, text colour, tokens and primitives live in
> [`contributing/ui-standards.md`](./contributing/ui-standards.md); where
> this document disagrees with them, the standards win. If a pattern
> below doesn't fit your case, propose an addition in the same PR.

Last updated: 2026-05-08 (v1.4 cycle)

---

## 1. Foundations

### 1.1 Theme

HealthLog is a Dracula-themed app with a light counterpart (Alucard). Both
themes share the same six-color signal palette (purple, pink, green, cyan,
orange, red, yellow, lavender), exposed as CSS variables and as Tailwind
`dracula-*` color tokens. Use the semantic tokens (`--primary`,
`--destructive`, `--card`, …) for chrome and the `--dracula-*` tokens for
data viz only.

| Surface                      | Token              |
| ---------------------------- | ------------------ |
| App background               | `--background`     |
| Card / popover surface       | `--card`           |
| Primary action               | `--primary`        |
| Destructive action           | `--destructive`    |
| Secondary / muted background | `--secondary`      |
| Border                       | `--border`         |
| Focus ring                   | `--ring`           |
| Chart series 1–5             | `--chart-1`…`-5`   |
| Brand signal: purple         | `--dracula-purple` |
| Brand signal: green (good)   | `--dracula-green`  |
| Brand signal: orange (warn)  | `--dracula-orange` |
| Brand signal: red (alert)    | `--dracula-red`    |
| Brand signal: cyan (info)    | `--dracula-cyan`   |

Dark mode is the default. The theme switcher in the sidebar three-dot menu
toggles `.dark` / `.light` on `:root`. Always test both modes before
shipping a component.

### 1.2 Spacing

Tailwind's default 4-pixel scale. Reach for these stops first:

| Use                                  | Token         | Pixels |
| ------------------------------------ | ------------- | ------ |
| Inline gap between icon and label    | `gap-1`       | 4      |
| Tight stack inside a card            | `gap-2`       | 8      |
| Label-to-field stack (form fields)   | `space-y-2`   | 8      |
| Section block (heading + body)       | `space-y-4`   | 16     |
| Page section separator               | `space-y-6`   | 24     |
| Dashboard tile-row gap, hero spacing | `gap-4`       | 16     |
| Page-edge padding (mobile / desktop) | `px-4 / px-6` |        |

Avoid arbitrary `space-y-5`, `gap-3.5`, etc. unless aligning to a fixed
external constraint.

### 1.3 Typography

The app uses the Tailwind defaults inherited via shadcn/ui. Reach for
these classes first:

| Use                                | Class                                   |
| ---------------------------------- | --------------------------------------- |
| Page title (h1)                    | `text-2xl font-semibold tracking-tight` |
| Section heading / section card     | `text-lg font-semibold`                 |
| Tile / inner card title            | `text-base font-semibold`               |
| Body text                          | `text-sm`                               |
| Muted helper / metadata            | `text-sm text-muted-foreground`         |
| Microcopy / footer                 | `text-xs text-muted-foreground`         |
| Tabular data (latency, large nums) | `font-mono tabular-nums`                |

Card titles come in exactly two sizes: `text-lg font-semibold` for a
section-level card (one per page region) and `text-base font-semibold`
for tiles and inner cards. Don't introduce a third level — a smaller
heading is a sign the content wants a list row, not a card.

Never use `font-bold` for emphasis — bump to `font-semibold` instead and
let the design system breathe.

### 1.4 Radius and elevation

`--radius: 0.625rem` (10px) is the default. The Tailwind tokens
`rounded-md` (`--radius-md` ≈ 8px) and `rounded-lg` (`--radius` ≈ 10px)
cover 95% of cases. Use `rounded-2xl` only for hero cards or large
modals.

Elevation is achieved via `shadow-xs`, `shadow-sm`, or
`shadow-[0_1px_0_rgba(255,255,255,0.04)]` for very subtle separators on
dark backgrounds. Avoid Tailwind's heavy shadows (`shadow-lg`+) in chrome.

---

## 2. Components

This section is **prescriptive, not exhaustive**. Each entry pairs a
Radix/shadcn primitive with the cases it's the right answer for and the
cases where another primitive should win.

### 2.1 Buttons

Every button comes from `@/components/ui/button`. Pick by purpose:

| Purpose                                               | Variant       | Size              |
| ----------------------------------------------------- | ------------- | ----------------- |
| Primary action on a page or dialog                    | `default`     | `default`         |
| Cancel, dismiss, secondary action next to primary     | `outline`     | `default`         |
| Tertiary in-row action (edit, copy, snooze)           | `ghost`       | `sm`              |
| Destructive (delete, revoke, disconnect)              | `destructive` | `default` or `sm` |
| Icon-only action (toolbar, chart toggles, table rows) | `ghost`       | `icon-sm`         |
| Inline link to external help docs                     | `link`        | `sm`              |
| Toolbar / table row action when space is tight        | `outline`     | `xs`              |

**Position rules.**

- Forms (full-width or modal): primary on the **right**, cancel/back on
  the **left**. Match shadcn dialog defaults.
- Settings sections: a single sticky `Save` button at the **right end**
  of the section header _or_ per-row inline `Save`. Never both in the
  same section.
- Test buttons (Telegram test, AI ping, etc.): immediately to the right
  of the related Save / Apply control. Never below — keeps the eye
  motion horizontal.
- Destructive actions live in their own confirm dialog with a
  type-to-confirm input when the action is irreversible (delete account,
  revoke API token, drop user data).

**Disabled state.** A disabled button must always come with a tooltip or
helper text explaining why. Silent disabled buttons frustrate users.

### 2.2 Inputs and forms

Forms keep a controlled draft in component state and validate it with the
Zod schemas from `src/lib/validations/`; the server's schema is the authority.
Wrap inputs in `<label>` (visible) plus `aria-describedby` for helper text.

- **Text / number / email**: `<Input>`. Always set `autocomplete`. See §4.4.
- **Multi-line**: shadcn `<Textarea>` (add via `pnpm dlx shadcn@latest add textarea` if missing).
- **Single choice ≤4 options**: prefer `<RadioGroup>` or a SegmentedControl
  pattern using `<Tabs>`. Never use `<Select>` for tiny enums — extra clicks.
- **Single choice 5–15 options**: `<Select>` (shadcn).
- **Single choice >15 options**: `<Combobox>` (shadcn `<Command>` + `<Popover>`)
  with type-ahead.
- **Multi choice**: `<Checkbox>` group, or shadcn `<MultiSelect>` when 7+ choices.
- **Date / datetime**: shadcn `<Calendar>` inside a `<Popover>`. Always
  label the timezone (Europe/Berlin).
- **Numeric range**: `<Slider>` only when the value space is continuous
  _and_ the user routinely sweeps. For most thresholds and counts, an
  `<Input type="number">` plus stepper buttons is faster and less
  fiddly. See §6 (Slider audit) for the migration path.
- **Boolean toggle**: `<Switch>` for settings. Exactly two persistence
  patterns are legal (see §2.2.1); pick one per card, never mix.
  `<Checkbox>` stays reserved for "applies on Save" _lists_ (e.g. select
  measurements to export) and for action parameters that are not
  persisted at all (export options).

#### 2.2.1 Settings persistence patterns

Every control under `/settings` follows exactly one of two save
patterns. The pattern is a property of the **card**, not of the
individual control:

1. **Immediate persist** — a standalone boolean that is the card's only
   mutable state. The `<Switch>` fires the mutation in
   `onCheckedChange`, disables itself while pending, updates
   optimistically with rollback, and toasts on success/error. No Save
   button anywhere on the card. Examples: hide-Coach, ntfy enable,
   cycle tracking, research mode, mood reminder, Coach nudges.
2. **Draft + Save** — the card edits a multi-field payload (or a list
   the server PUTs whole). All controls — including `<Switch>` rows —
   mutate a local draft only; a visible Save button flushes the draft
   in one request and the card surfaces its dirty state. Examples:
   Coach preferences, Telegram (enable + bot token), provider fallback
   chain, dashboard layout, threshold editor.

A `<Switch>` inside a draft+Save card is legal **only** when the card
shows the Save button; a card with both an auto-persisting switch and
a Save-gated field is a bug. Every setting presented under `/settings`
persists server-side. `localStorage` is reserved for device-local UI
state that is not a setting (sidebar collapse, last-update-check
timestamp, tour progress) — label such keys with a comment at the
declaration site and never render them with Save/Saved affordances.

**Validation.** Inline messages below the field. Field gets
`aria-invalid="true"` and a destructive border. Form-level errors land
in a `<Alert variant="destructive">` at the top. Never show a toast for
a field-level error.

### 2.3 Dialog vs Sheet vs Drawer

The wrong choice here is the most visible UX mistake we make. Pick by
intent, not by hand-feel.

| Use                                                             | Primitive                      | Rationale                                                        |
| --------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Confirm a destructive or irreversible action                    | `Dialog` (`AlertDialog` shape) | Modal blocks accidental dismiss; user must read.                 |
| Inspect a single item's details with no edit                    | `Dialog`                       | Centered, focused, dismissible.                                  |
| Edit a single item with ≤6 fields                               | `Dialog`                       | Tight focus, quick save.                                         |
| Edit a single item with 7+ fields, or with deep sub-sections    | `Sheet` (right)                | Wide working surface, scrollable, doesn't crop on tall content.  |
| Mobile bottom-up sub-action (filter, sort, multi-select picker) | `Sheet` (bottom)               | Thumb-friendly, dismiss by swipe.                                |
| Multi-step wizard                                               | Full route                     | Page transitions communicate progress better than a stuck modal. |
| Side-by-side compare or trend deep-dive                         | Full route                     | Charts need the viewport.                                        |

Never nest Dialogs. If a Dialog needs another modal action, escalate the
inner step to a separate route or use shadcn's `<AlertDialog>` chained on
top of a `<Sheet>`.

### 2.4 Cards and lists

- **Card**: a self-contained unit of content. Use `<Card>` from
  shadcn. Header, body, footer follow Pretendard-style hierarchy.
- **Tile**: a _small_ card showing a single metric on the dashboard.
  See §3.2 for the one-row constraint. Tiles must include current value,
  unit, optional sparkline, and a single tap-target area.
- **List row**: `<div className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-accent/40 rounded-md">` — left side has icon + primary
  - meta, right side has trailing controls. Never put primary actions in
    the right-side ellipsis menu — only secondary or destructive.
- **Empty state**: every list and tile has an explicit empty-state
  component with an icon, a one-sentence explanation, and a single
  primary action ("Add measurement", "Connect Withings"). See §5.

### 2.5 Tables

`<Table>` (shadcn) for tabular data only — measurements list, audit log,
admin views. Default to `<Card>` + list rows for everything else;
tables on mobile collapse poorly. When you must use a table on mobile,
swap to a vertical list at `sm:` breakpoint.

### 2.6 Filter bars over data lists

Every list surface with filters (measurements, mood, future admin
lists) uses the unified `<FilterBar>` rail from
`src/components/ui/filter-bar.tsx` — never a per-page row of large
labelled `<Select>`s and date inputs.

- **Grammar**: `[icon] [Zeitraum] [Typ] [Quelle] [extras…]
[Zurücksetzen] … [count]`. Canonical dimension order is date range,
  type, source; surface-specific dimensions append after.
- **Pill = trigger + chip**: inactive pills show only the dimension
  name; active pills show `Name: Wert`, pick up the primary accent and
  grow a removable ✕. No separate chip row.
- **Reset** renders only while at least one dimension is active.
- **Mobile** (< `sm`): the rail is a horizontal scroll row (hidden
  scrollbar, edge-bleed); the result count wraps to its own line.
- The component is presentation-only — filter state, query keys and
  fetching stay in the owning page. Use `FilterBarSelect` for enum
  dimensions and `FilterBarDateRange` for the from/to pair.

### 2.7 Section-card headers — icon column + content column

Every Settings/Admin section card header follows one shape, implemented
by `<SettingsCardHeader>` (`src/components/settings/_card-header.tsx`)
or an equivalent inline structure:

- **Icon column** (left): one Lucide icon, `text-muted-foreground h-5 w-5`.
  Icons in card headers are always neutral — never `text-primary` or any
  `dracula-*` accent. Purple/primary is reserved for actions and
  highlight states (§2.8), not for iconography.
- **Content column** (right of the icon, `gap-2` → 28 px offset): the
  title, its description, and **everything textual that follows in the
  card** — descriptions, follow-up headings after separators, form
  stacks, helper/feedback lines. Apply `pl-7` to body blocks so nothing
  textual ever starts further left than the title above it, and
  follow-up headings align with the title column, not the icon.
- **Exception — full-bleed structures**: data tables, tile/card grids,
  charts, ladder lists, and `<hr>` separators may span the full card
  width. The rule governs text alignment, not structural surfaces.
- The page-level section `<h1>` is `sr-only`: the shell header already
  carries "Einstellungen · <Sektion>", so a visible in-section repeat
  is a double title. Keep the `<h1>` in the DOM for the document
  outline and `aria-labelledby`.

### 2.8 Status indicators

Use the same color taxonomy across the app:

| State     | Color token          | Examples                                       |
| --------- | -------------------- | ---------------------------------------------- |
| Good      | `--dracula-green`    | Connected, in target, healthy                  |
| Info      | `--dracula-cyan`     | Up-to-date, neutral signal                     |
| Caution   | `--dracula-orange`   | Mildly out of range, expiring token, slow sync |
| Alert     | `--dracula-red`      | Out of range, sync failed, critical            |
| Pending   | `--muted-foreground` | Loading, indeterminate                         |
| Highlight | `--dracula-purple`   | New / featured / promoted                      |

Show a colored dot **plus** a label. Never rely on color alone.

---

## 3. Layouts

### 3.1 Page shell

Every authenticated page is wrapped by `<TopBar>` + `<SidebarNav>` (left)

- `<BottomNav>` (mobile). Don't reinvent these on a per-page basis.

* Mobile breakpoint: `<sm` shows bottom-nav, hides sidebar.
* `sm`–`md`: sidebar in icons-only mode.
* `md+`: sidebar full mode unless user has collapsed it
  (`localStorage:healthlog-sidebar-collapsed`).

Page content goes in `<main className="mx-auto max-w-5xl px-4 sm:px-6 py-6 space-y-6">` unless the page is a full-bleed dashboard or settings shell.

### 3.2 Dashboard tiles — one-row rule

Tiles at the top of the dashboard live in a **single row**. Width caps
at the chart's width directly below. **Never** wrap to a second row.

If the user enables more tiles than fit, the dashboard surfaces a banner
inviting them to deactivate or reorder via Settings → Arrangement. The
layout editor in Settings shows a live preview of the constraint and
flags overflow before save.

CSS: `grid-cols-N` where N = active tile count, capped by
`Math.min(activeTiles, maxTilesForViewport(width))`. Drag-reorder via
`@dnd-kit/sortable`. Toggle-show via the layout editor only — not in the
tile itself, to avoid accidental hide.

### 3.3 Settings — `/settings/[section]`

The 1.4 release split the legacy 3150-LOC settings monolith into one
route per top-level section. The pattern holds: every section is a
route under `/settings/[section]` with its component under
`src/components/settings/`. The section list has grown far past the
original eight (account, integrations, notifications, ai, api,
advanced, about now sit alongside security, access, sources, coach,
environment, export, mcp, and more); the registry in
`src/components/settings/settings-shell.tsx` is authoritative.
Cross-section search lives in the section sidebar header.

The legacy `/settings` route is a permanent (308) redirect to
`/settings/account`.

### 3.4 Admin — `/admin/[section]`

Same shape as Settings, with the right-hand sidebar listing:

- Users
- Integrations status
- Monitoring (Wide Events, GlitchTip, Umami)
- Backups
- Maintenance
- Audit log

Status badges use the §2.8 color taxonomy. Each section opens to a card
grid, never a long fluid list.

---

## 4. Patterns

### 4.1 Loading states

- **Page-level**: a `<Skeleton>` matching the final layout. Never show a
  full-screen spinner. Mount the skeleton inside the same `<main>` shell
  the loaded page renders into.
- **Inline**: button loading state shows a spinner + label change
  ("Saving…", "Testing…"). Disable other form controls while pending.
- **Long-running**: progress bar with a remaining-step count; for
  background tasks (export, backup), surface in a toast that links to
  the operation log instead of blocking the UI.

Skeletons must respect `prefers-reduced-motion: reduce`.

### 4.2 Empty states

A reusable `<EmptyState>` shape:

```tsx
<EmptyState
  icon={<Plus className="size-6" />}
  title={t("empty.measurements.title")}
  description={t("empty.measurements.description")}
  action={<Button>{t("empty.measurements.add")}</Button>}
/>
```

Every list, every chart, every dashboard tile that can be empty has an
explicit, translated empty-state. No "No data" placeholder strings.

### 4.3 Error states

- **Form errors**: inline below the offending field; aggregate at the
  top of the form for global errors (e.g. "Server unreachable").
- **Page errors**: Next.js `error.tsx` boundaries with a friendly
  recovery action ("Retry", "Go home"). Send the error to GlitchTip
  through the existing client.
- **Network errors during save**: `<Alert variant="destructive">` at
  the top of the form _plus_ a retry button. Never silently fail.

### 4.4 Forms and password managers

- Measurement, medication, and mood form fields use
  `autocomplete="off"` on every input that browsers keep guessing wrong.
- API-token inputs and AI-provider key inputs use
  `autocomplete="new-password"` so the browser doesn't autofill the
  user's account password.
- Honey-pot fields (offscreen `<input>` with `autocomplete="email"` and
  `tabIndex={-1}`) sit at the top of measurement forms to catch
  aggressive autofill.
- Forms always include a hidden `<input type="text" name="username"
autocomplete="username" value={user.email} readOnly tabIndex={-1}>`
  inside password change and passkey screens so password managers
  attribute saved credentials correctly.

### 4.5 Test buttons (every integration)

Each configurable integration ships a Test button next to its Save
control. Behavior:

- **Trigger**: ad-hoc API call to the integration with a small,
  identifiable payload ("HealthLog test ping").
- **State**: button shows a spinner with localized "Testing…" label.
  Result lands inline in a `<StatusCallout>` directly below — green for
  success with the relevant detail (last sync, message ID, response
  status) or red for the error (sanitized message — never leak the
  upstream URL or API key).
- **History**: each test writes a row to a tiny per-integration log
  visible in the section. Last 5 tests, timestamp + result.
- **Coverage**: required for Telegram, ntfy, Web Push, AI provider,
  Withings, Nightscout, GlitchTip, Umami, email (when wired), backup
  target. Headless E2E asserts presence + working call for each.

### 4.6 Server actions and mutations

Mutations go through TanStack Query, never raw fetch calls in components. Every mutation:

1. Optimistically updates the cache with a rollback handler.
2. Toast on success ("Saved" — translated) and on error (with retry).
3. Re-validates queries it touches.

For multi-step flows, write a typed `apiClient` helper in
`src/lib/api/clients/` rather than re-doing fetch in three places.

### 4.7 Inline help

A small `?` `<Tooltip>` next to the label is the default for non-trivial
fields (e.g. "Why does this default to ESH 2023?"). Tooltips must be
keyboard-accessible (Radix handles this) and translated.

For long explanations, link out to `https://docs.healthlog.dev/...` —
never embed multi-paragraph help inline.

---

## 5. Accessibility

We aim for **WCAG 2.1 AA**, with the following non-negotiables:

- Color contrast ≥ 4.5:1 for normal text, 3:1 for large text and UI
  components. Verified by `@axe-core/playwright` in CI on every page.
- Touch targets ≥ 44×44 CSS px on bottom-nav and primary action buttons
  (WCAG 2.5.5). Two idioms implement the floor, and they are deliberate:
  - **Form controls** (`Input`, `NativeSelect`, `SelectTrigger` default
    size): `h-11 sm:h-10` is baked into the primitives — 44 px on
    mobile, back to the 40 px desktop tier. Never re-add `min-h-11` on
    top of these; it forces 44 px on desktop and breaks the row rhythm.
  - **Buttons on dense touch surfaces** (medication detail, dashboard
    quick actions): `min-h-11 sm:min-h-9` — 44 px mobile floor,
    compact `sm` tier on desktop. Plain `min-h-11` without the `sm:`
    reset is legacy spelling; don't introduce new ones, and align a
    button to its direct neighbours when editing one.
- Focus is always visible: shadcn's `focus-visible:ring` is preserved on
  every customized component.
- Every interactive element has an accessible name. Icon-only buttons
  get `<span className="sr-only">` labels and `aria-label`.
- `prefers-reduced-motion: reduce` disables animations beyond a 200 ms
  fade.
- Charts include text-equivalent summaries (`aria-describedby` linked to
  a `<p className="sr-only">` summary) and exposed data via the visible
  legend / table view toggle.

CI fails on any `serious` or `critical` axe-core violation.

---

## 6. Slider audit and migration

Sliders look pretty but are a poor fit for most numeric inputs because
they sacrifice precision. The 1.4 audit catalogues every `<Slider>` in
the codebase and migrates the inappropriate ones:

| Setting                             | Current control | Better control                  |
| ----------------------------------- | --------------- | ------------------------------- |
| Mood intensity (0–10)               | Slider          | SegmentedControl                |
| Notification quiet-hours range      | Two sliders     | Two `<Input type="time">`       |
| Threshold-override numeric values   | Slider          | `<Input type="number">` + steps |
| AI insight depth (1–5 levels)       | Slider          | `<RadioGroup>` cards            |
| Export retention days (7/30/90/365) | Slider          | `<Select>` with preset options  |

A slider stays appropriate for "scrub through history" or "set chart
zoom range" — operations where the value is continuous and live preview
is the point.

---

## 7. Internationalization

All user-facing strings come from `messages/en.json` (default) plus
the `de`, `es`, `fr`, `it`, and `pl` bundles beside it. Guard tests
(`i18n-call-site-coverage`, `i18n-locale-integrity`) enforce that every
`t()` key resolves in EN and propagates across all six locales. Use
`useTranslations()` on the client and
`getServerTranslator()` (`src/lib/i18n/server-translator.ts`) on the
server. Numbers, dates, currencies, and units always go through
`useFormatters()` — never hand-roll `Intl.NumberFormat(...)` with a
fixed locale.

Server-rendered content (PDFs, notifications, server-issued category
labels) must use the locale of the user the content is for, not the
locale of the request that triggered the job.

---

## 8. Motion

Default transitions: `transition-all duration-150 ease-out`. Heavier
animations (insight cards, dialog enter/exit) use the shadcn defaults.
Reduce-motion always wins.

Loading skeletons pulse via Tailwind `animate-pulse`. Don't introduce
custom keyframes without adding a `prefers-reduced-motion` fallback.

---

## 9. Component checklist (for new features)

Before opening a PR for a new component or page, walk through:

- [ ] Uses tokens from §1, not hard-coded hex/rgba.
- [ ] Buttons follow §2.1 variant + position rules.
- [ ] Inputs follow §2.2; correct `autocomplete`; honey-pots where needed.
- [ ] Dialog vs Sheet vs Drawer per §2.3.
- [ ] Loading, empty, and error states from §4.1–4.3 implemented.
- [ ] All strings via `t()`; numbers via formatters.
- [ ] Mobile viewport tested (Chrome DevTools 375×667 and 414×896).
- [ ] Light + Dark mode tested.
- [ ] Keyboard navigation: Tab order, Enter to submit, Esc to dismiss.
- [ ] axe-core clean (no serious/critical).
- [ ] Headless screenshot test added if UI is non-trivial.

---

_Maintained as part of the v1.4 release cycle. Propose changes alongside
the code that motivates them._
