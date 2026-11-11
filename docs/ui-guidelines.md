# HealthLog UI Guidelines

> Interaction patterns for the HealthLog web app. Card anatomy, spacing,
> text colour, colour tokens, typography and the choice of primitive are
> owned by [`contributing/ui-standards.md`](./contributing/ui-standards.md);
> this page covers what those rules leave open. Where the two disagree, the
> standards win. If a pattern below doesn't fit your case, propose an
> addition in the same PR.

---

## 1. Foundations

Theme, spacing, typography, radius and colour tokens are defined in the
standards (§1 to §5 there). Two things to add:

- Dark is the default theme, and the light theme remaps the same semantic
  tokens. Check every component in both before shipping it.
- Elevation stays light: `shadow-xs` or `shadow-sm` in chrome, never the
  heavy `shadow-lg` and up.

---

## 2. Components

This section is **prescriptive, not exhaustive**. Each entry names the
primitive for a case and the case where another one wins.

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

Where buttons sit in a card (one action row, last in the card, primary on
the right) is standards §12. Two additions:

- A Test button (Telegram test, AI ping and the like) sits in the same row
  as the Save or Apply control it belongs to.
- An irreversible action (delete account, revoke an API token, wipe data)
  asks in its own confirm dialog, with a type-to-confirm field where the loss
  is large.

**Disabled state.** A disabled button always comes with helper text that
says why. A tooltip is not enough: it never opens on a phone.

### 2.2 Inputs and forms

Forms keep a controlled draft in component state and validate it with the
Zod schemas from `src/lib/validations/`; the server's schema is the authority.
Every input has a visible `<Label>`, plus `aria-describedby` for helper text.

- **Text / number / email**: `<Input>`. Always set `autoComplete`. See §4.4.
- **Multi-line**: `<Textarea>`.
- **Single choice, up to four options**: `Segmented` (standards §6) or a
  radio group. A select for a tiny enum costs extra taps.
- **Single choice, more options**: `NativeSelect` or `Select`; a searchable
  popover once the list is long enough to need type-ahead.
- **Multi choice**: a `<Checkbox>` group.
- **Date and time**: `DateField`, `TimeField`, `DateTimeField` (standards §6).
- **Numeric range**: `SliderField` for a bounded scale with anchors (a 0 to
  10 self-rating). Thresholds and counts take a number input: a slider gives
  up precision there.
- **Boolean toggle**: `<Switch>` for settings. Exactly two persistence
  patterns are legal (see §2.2.1); pick one per card, never mix.
  `<Checkbox>` stays reserved for "applies on Save" _lists_ (e.g. select
  measurements to export) and for action parameters that are not
  persisted at all (export options).

#### 2.2.1 Settings persistence patterns

Every control under `/settings` follows exactly one of two save
patterns. The pattern is a property of the **card**, not of the
individual control:

1. **Immediate persist**: a standalone boolean that is the card's only
   mutable state. The `<Switch>` fires the mutation in
   `onCheckedChange`, disables itself while pending, updates
   optimistically with rollback, and toasts on success or error. No Save
   button anywhere on the card. Examples: hide-Coach, ntfy enable,
   cycle tracking, research mode, mood reminder, Coach nudges.
2. **Draft + Save**: the card edits a multi-field payload (or a list
   the server PUTs whole). All controls, `<Switch>` rows included,
   change a local draft only; a visible Save button sends the draft
   in one request and the card shows its dirty state. Examples:
   Coach preferences, Telegram (enable + bot token), provider fallback
   chain, dashboard layout, threshold editor.

A `<Switch>` inside a draft+Save card is legal **only** when the card
shows the Save button; a card with both an auto-persisting switch and
a Save-gated field is a bug. Every setting presented under `/settings`
persists server-side. `localStorage` is reserved for device-local UI
state that is not a setting (sidebar collapse, last-update-check
timestamp, tour progress): label such keys with a comment at the
declaration site and never render them with Save/Saved affordances.

**Validation.** Inline messages below the field. The field gets
`aria-invalid="true"` and a destructive border. A failed save shows inline
`role="alert"` text in the form. Never show a toast for a field-level error.

### 2.3 Dialog vs sheet

Pick by intent, not by hand-feel. Standards §6 maps the primitives.

| Use                                                         | Primitive                                         | Why                                                        |
| ----------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Confirm a destructive or irreversible action                | `AlertDialog`                                     | Blocks an accidental dismiss; the user has to read it.     |
| Inspect or edit one item, on any surface a phone reaches    | `ResponsiveSheet`                                 | A bottom sheet on a phone, a centred dialog on wider ones. |
| Sub-action from the bottom edge on a phone (filter, picker) | `SheetContent side="bottom"` or `ResponsiveSheet` | Grip, swipe to close, thumb reach.                         |
| Admin or desktop-only surface                               | `Dialog`                                          | No phone layout to serve.                                  |
| Side-by-side compare or trend deep-dive                     | Full route                                        | Charts need the viewport.                                  |

Never nest dialogs. If a sheet needs a confirmation, chain an
`AlertDialog` on top of it.

### 2.4 Cards and lists

- **Card**: anatomy, headers and density are standards §1.
- **Tile**: a _small_ card showing a single metric on the dashboard.
  Tiles carry the current value, its unit, an optional sparkline, and one
  tap target.
- **List row**: icon, primary text and meta on the left, trailing controls
  on the right. Never put a primary action in the trailing overflow menu,
  only secondary or destructive ones.
- **Empty state**: every list and tile that can be empty has one. See §4.2.

### 2.5 Tables

`<Table>` for tabular data only: the measurement list, the audit log, admin
views. Default to cards and list rows for everything else; tables collapse
poorly on a phone. When a table must exist on a phone, switch to a vertical
list below `sm`.

### 2.6 Filter bars over data lists

Every list surface with filters (measurements, mood, admin lists) uses the
shared `<FilterBar>` rail from `src/components/ui/filter-bar.tsx`, never a
per-page row of large labelled selects and date inputs.

- **Grammar**: `[icon] [date range] [type] [source] [extras…] [reset] … [count]`.
  The canonical dimension order is date range, type, source;
  surface-specific dimensions follow.
- **Pill = trigger + chip**: an inactive pill shows only the dimension
  name; an active one shows `Name: value`, takes the primary accent and
  grows a remove button. No separate chip row.
- **Reset** renders only while at least one dimension is active.
- **Mobile** (below `sm`): the rail is a horizontal scroll row (hidden
  scrollbar, edge bleed); the result count wraps to its own line.
- The component is presentation only: filter state, query keys and
  fetching stay in the owning page. Use `FilterBarSelect` for enum
  dimensions and `FilterBarDateRange` for the from/to pair.

### 2.7 Card headers

Standards §1 (header patterns and the icon colour rule) and §13 (Settings
and Admin card rhythm). The old `pl-7` body gutter in Settings is gone: the
body starts at the card edge.

### 2.8 Status indicators

One taxonomy across the app, on the semantic status tokens (standards §3):

| State     | Token                | Examples                                       |
| --------- | -------------------- | ---------------------------------------------- |
| Good      | `--success`          | Connected, in target, healthy                  |
| Info      | `--info`             | Up to date, neutral signal                     |
| Caution   | `--warning`          | Mildly out of range, expiring token, slow sync |
| Alert     | `--destructive`      | Out of range, sync failed, critical            |
| Pending   | `--muted-foreground` | Loading, indeterminate                         |
| Highlight | `--primary`          | New or featured                                |

Show a coloured dot **plus** a label. Never rely on colour alone.

---

## 3. Layouts

### 3.1 Page shell

`AuthShell` owns the page frame, the scroll container and its bottom
clearance (standards §2 and §9). Pages never re-implement it.

### 3.2 Settings: `/settings/[section]`

Every section is a route under `/settings/[section]` with its component
under `src/components/settings/`. The registry in
`src/components/settings/settings-shell.tsx` is authoritative for which
sections exist and how the navigation groups them. An address that moved
keeps working through a permanent redirect in `next.config.ts`.

### 3.3 Admin: `/admin/[section]`

Admin uses the Settings anatomy verbatim (standards §13). Status badges use
the §2.8 taxonomy.

---

## 4. Patterns

### 4.1 Loading states

- **Page-level**: a `<Skeleton>` matching the final layout, mounted inside
  the same shell the loaded page renders into. Never a full-screen spinner.
- **Card-level**: a loading state paints the card and its header
  (standards §13).
- **Inline**: a button in flight shows a spinner and a label change
  ("Saving…", "Testing…"). Disable the other form controls while pending.
- **Long-running**: background work (export, backup) reports through a
  toast or a status line instead of blocking the UI.

Skeletons respect `prefers-reduced-motion: reduce`.

### 4.2 Empty states

The shared `<EmptyState>`:

```tsx
<EmptyState
  icon={<Plus className="size-6" />}
  title={t("empty.measurements.title")}
  description={t("empty.measurements.description")}
  action={<Button>{t("empty.measurements.add")}</Button>}
/>
```

`variant="plain" size="compact"` is the in-card and in-field form, and
`ChartEmptyState` covers a chart body (standards §6). Every list, chart and
dashboard tile that can be empty has an explicit, translated empty state. A
failed read never falls through to "no data yet".

### 4.3 Error states

- **Form errors**: inline below the offending field, plus inline
  `role="alert"` text for a failed save.
- **Failed reads**: `QueryErrorCard`, `QueryErrorRow` or `ChartErrorState`
  by surface, with the query's `error` (standards §6).
- **Page errors**: Next.js `error.tsx` boundaries with a recovery action
  ("Retry", "Go home"). The error goes to GlitchTip through the existing
  client.

### 4.4 Forms and password managers

- Measurement, medication and mood fields set `autoComplete="off"` on every
  input that browsers keep guessing wrong.
- API-token and AI-provider key inputs use `autoComplete="new-password"`
  so the browser does not fill in the account password.
- Password-change and passkey screens carry a hidden
  `<input type="text" name="username" autoComplete="username" value={user.email} readOnly tabIndex={-1}>`
  so password managers attribute saved credentials correctly.

### 4.5 Test buttons (every integration)

Each configurable integration ships a Test button next to its Save
control.

- **Trigger**: a one-off call to the integration with a small,
  recognisable payload ("HealthLog test ping").
- **State**: the button shows a spinner with a translated "Testing…"
  label. The result lands inline directly below: the relevant detail on
  success (last sync, message id, response status), or the error, sanitised
  so it never names the upstream URL or the key.

### 4.6 Mutations

Mutations go through TanStack Query, never a raw fetch in a component. A
mutation invalidates every query it changes and toasts on success and on
error (translated). An optimistic cache update always carries a rollback.

### 4.7 Inline help

A small `?` `InfoPopover` next to the label is the default for a
non-trivial field (e.g. "Why does this default to ESH 2023?"). It opens on a
tap or a click and from the keyboard, so it works on a phone, where a hover
tooltip never opens. Its text is translated.

For a long explanation, link out to `https://docs.healthlog.dev/...`.
Never embed multi-paragraph help inline.

---

## 5. Accessibility

We aim for **WCAG 2.1 AA**, with the following non-negotiables:

- Colour contrast ≥ 4.5:1 for normal text, 3:1 for large text and UI
  components. `@axe-core/playwright` checks it in CI.
- Touch targets ≥ 44×44 CSS px on the bottom navigation and primary action
  buttons (WCAG 2.5.5). Two idioms implement the floor, and they are
  deliberate:
  - **Form controls** (`Input`, `NativeSelect`, `SelectTrigger` default
    size): `h-11 sm:h-10` is built into the primitives: 44 px on a phone,
    40 px on desktop. Never add `min-h-11` on top; it forces 44 px on
    desktop and breaks the row rhythm.
  - **Buttons on dense touch surfaces** (medication detail, dashboard
    quick actions): `min-h-11 sm:min-h-9`, a 44 px floor on a phone and the
    compact `sm` tier on desktop. Plain `min-h-11` without the `sm:` reset
    is legacy spelling; don't add new ones, and match a button to its
    direct neighbours when editing one.
- Focus is always visible: the primitives' `focus-visible:ring` stays on
  every customised component.
- Every interactive element has an accessible name. Icon-only buttons get
  an `aria-label`.
- `prefers-reduced-motion: reduce` disables animations beyond a 200 ms
  fade.
- Charts carry a text summary (`aria-describedby` on a `sr-only`
  paragraph) and expose their data through the visible legend or a table
  view.

CI fails on any `serious` or `critical` axe-core violation.

---

## 6. Sliders

A slider gives up precision, so it is the control only where the value is
a bounded scale or the sweep is the point: a self-rating with anchors
(`SliderField`, standards §6), scrubbing through history, a chart zoom
range. Thresholds, counts and times take a number, select or time field.

---

## 7. Internationalization

All user-facing strings come from `messages/en.json` (the default) plus the
`de`, `es`, `fr`, `it`, `pl`, `ko`, `nl`, `pt-BR` and `ru` bundles beside
it. Guard tests (`i18n-call-site-coverage`, `i18n-locale-integrity`) enforce
that every `t()` key resolves in English and exists, with the same
placeholders, in all ten locales. Use `useTranslations()` on the client and
`getServerTranslator()` (`src/lib/i18n/server-translator.ts`) on the
server. Numbers, dates and units always go through `useFormatters()`; never
hand-roll `Intl.NumberFormat(...)` with a fixed locale.

Server-rendered content (PDFs, notifications, server-issued category
labels) uses the locale of the user it is for, not the locale of the
request that triggered the job.

---

## 8. Motion

Default transitions: `transition-all duration-150 ease-out`. Heavier
animations (dialog enter and exit) use the primitives' defaults. Reduced
motion always wins.

Loading skeletons pulse via Tailwind `animate-pulse`. Don't add custom
keyframes without a `prefers-reduced-motion` fallback.

---

## 9. Component checklist (for new features)

Before opening a PR for a new component or page, walk through the PR
checklist in the standards (§7) and:

- [ ] Buttons follow §2.1.
- [ ] Inputs follow §2.2; correct `autoComplete`.
- [ ] Dialog or sheet per §2.3.
- [ ] Loading, empty and error states from §4.1 to §4.3.
- [ ] All strings via `t()`; numbers via the formatters.
- [ ] Tested at phone width (390 px) and on desktop.
- [ ] Light and dark theme checked.
- [ ] Keyboard: Tab order, Enter to submit, Esc to dismiss.
- [ ] axe-core clean (no serious or critical findings).
- [ ] A screenshot test added if the UI is non-trivial.
