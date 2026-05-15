# R4 UI-conformity sweep — v1.4.27

Read-only walk of every same-class surface in the app on `develop` (HEAD
`617d4518`). Compares each concrete instance against its siblings and
flags visual / structural drift: heading weight, card chrome, form
rhythm, spacing scale, typography scale, button positions, icon sizes,
Dialog / Sheet chrome, table chrome, empty-state shape, loading
skeleton shape, colour tokens, dark-mode parity.

Maintainer framing: "no duplicates, everything looks the same,
everything is conform." Intentional variants (admin dense tables,
narrative copy in Coach) are noted and skipped from the drift list.

---

## Severity legend

- **P0** — same-class instances diverge enough that the surfaces no
  longer read as one app; fix before tagging v1.4.27.
- **P1** — token / weight / spacing drift the user notices when
  switching between two routes of the same family; queue inside the
  v1.4.27 polish bucket.
- **P2** — minor inconsistency that surveys cleanly under a single
  rule once codified; defer or roll into the next pass.
- **P3** — informational / convention note, no user-visible action.

---

## Headline drift (top of the sweep)

1. **P0** — Settings vs Admin section chrome diverge on heading
   element + page-header presence. Settings sections open with
   `<section aria-labelledby>` + `<h1 className="text-2xl
   font-semibold tracking-tight">` + a description `<p>`; admin
   sections open with `<div className="bg-card border-border
   rounded-xl border p-6">` directly and use `<div className="text-lg
   font-semibold">` (not an `<h2>`) for the card title. Result:
   semantic landmark + Marc-Voice page-header on `/settings/*`, no
   landmark + visual-only title on `/admin/*`. (See §3.)
2. **P0** — Two tab-strip implementations coexist. Insights tab
   strip is a custom `<nav>` of `min-h-11 rounded-full` `<Link>` pills
   with `bg-primary/10 text-primary` active state, sticky `top-0` +
   right-edge fade; Feedback inbox uses the shadcn `<Tabs>`
   primitive with `h-9 bg-muted` `TabsList`, `data-[state=active]:bg-background`
   pill. The two strips do not feel like the same control. (See §10.)
3. **P0** — Loader spinner palette + size + motion-reduce vocabulary
   is unconstrained. Eighteen distinct `Loader2 className="…"`
   signatures across the codebase: `text-primary h-6 w-6`,
   `text-muted-foreground h-5 w-5`, `text-dracula-purple h-5 w-5`,
   raw `h-3 w-3`, mixed inclusion of `motion-reduce:animate-none`.
   Two adjacent surfaces (insights mother page vs insight-status-card
   loading state) paint different colours for the same "loading"
   semantic. (See §8.)
4. **P1** — `<EmptyState>` size + variant choices read inconsistent.
   Insights sub-pages all pass `icon={<X className="size-6" />}`
   without an explicit `size` prop. Daily Briefing uses
   `variant="plain"` + `icon size-5`. Admin feedback inbox uses
   `size="compact"` + `icon size-5`. Admin recent-audit uses
   `size="compact" variant="plain" icon size-5`. Inside the seven
   insights sub-pages every empty-state CTA passes `<Button size="sm"
   asChild>` — but MB7 / CF-36 added `ctaSize="lg"` to the
   primitive and no consumer uses it. (See §7.)
5. **P1** — `bg-card border-border rounded-xl border p-6` is the
   de-facto "section card" chrome but it is hand-rolled in 21
   files (settings + admin) instead of being a shared primitive.
   Drift creeps in (`thresholds-editor-section.tsx` adds
   `scroll-mt-28`; account-section.tsx has 4 hand-rolled copies;
   admin sections add it inside the section root rather than
   wrapping the section). (See §3.)

---

## 1. Dashboard tiles (TrendCard / GLP-1 / Health Score / Briefing)

| Instance | Card chrome | Headline weight | Spacing | Flags |
|---|---|---|---|---|
| `<TrendCard>` (charts/trend-card.tsx:213) | `bg-card border-border flex h-full w-full min-w-0 flex-col rounded-xl border p-4 md:p-6` | label `text-xs font-medium`, value `text-3xl font-bold` | `mt-2 gap-x-1.5`, `pt-1` for sub-row | **P0** — only tile in the codebase that uses `font-bold` for its headline number; every other tile uses `font-semibold` (Glp1-Tile drug-line, Health-Score number, sub-page chart sticky values). |
| `<Glp1Tile>` (dashboard/glp1-tile.tsx:244) | `bg-card/65 relative overflow-hidden rounded-xl border px-4 py-4 shadow-sm backdrop-blur-sm` | title `text-sm font-semibold tracking-tight`, drug-line `text-lg font-semibold tabular-nums` | `pb-3` between rows, `space-y-2 pt-2` for chart pane | **P1** — `bg-card/65` + `backdrop-blur-sm` is unique to Glp1-Tile and Health-Score-Card; every other tile uses solid `bg-card`. Glp1 schedule pills use `border-dracula-green/30 bg-dracula-green/10` directly — only consumer of this exact green-pill recipe. |
| `<HealthScoreCard>` (insights/health-score-card.tsx:228) | `bg-card/65 rounded-xl border px-4 py-4 shadow-sm backdrop-blur-sm` | label `text-[10px] font-semibold tracking-[0.18em] uppercase`, number `text-5xl font-semibold sm:text-6xl` | `flex flex-col gap-3`, `flex items-baseline gap-1` | **P1** — only instance of `text-[10px]` + `tracking-[0.18em]` in the app. Trend-card labels use `text-xs leading-5 font-medium tracking-wide uppercase`. Both convey "metric label" semantically but the typography vocabulary diverges. |
| `<DailyBriefing>` (insights/daily-briefing.tsx:260) | `<Card>` primitive (`bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm`) | `CardTitle` `text-base font-semibold` | `CardHeader pb-3`, key-finding `space-y-2`, finding rows `border-border/60 bg-card/40 rounded-md p-3` | **P2** — only dashboard surface that uses the `<Card>` primitive; the other three tiles hand-roll their wrapper. Findings-title pad: `text-[11px] font-semibold tracking-wide uppercase` — yet another distinct meta-label typography stack (cf. health-score-card `[10px]` and trend-card `xs`). |

### Drift summary (dashboard tiles)

- **P0** — headline weight inconsistency: TrendCard uses `font-bold`
  on the latest reading; every other tile in the strip uses
  `font-semibold` for the same role. Fix: align TrendCard headline
  to `font-semibold` (or migrate every tile to `font-bold`; pick one).
- **P1** — three "meta-label uppercase tracking" recipes live side
  by side: trend-card `text-xs tracking-wide`, health-score-card
  `text-[10px] tracking-[0.18em]`, daily-briefing key-findings-title
  `text-[11px] tracking-wide`. Codify a single
  `text-[11px] tracking-wide font-semibold uppercase` and migrate.
- **P1** — `bg-card/65 + backdrop-blur-sm` is used only by Glp1-Tile
  and HealthScoreCard. Either roll it into a shared
  `dashboard-tile.tsx` wrapper or drop the `/65 + blur` so every
  tile sits on solid `bg-card`.
- **P2** — Daily Briefing is the only dashboard surface that goes
  through the `<Card>` primitive (12 px header / 24 px body
  internal padding via `gap-6 py-6`). The other tiles use `px-4 py-4`
  hand-rolled chrome. Consider migrating every dashboard tile to a
  single primitive.

---

## 2. Insights sub-pages — 7 routed sub-pages + report

| Sub-page | Shell | Empty-state | Status card | Spacing flag |
|---|---|---|---|---|
| `/insights/blutdruck` | `<SubPageShell>` + description | `<EmptyState icon size-6>` + `<Button size="sm" asChild>` | `<InsightStatusCard>` | uses `BLOOD_PRESSURE_SYS` gate; CTA → `/measurements?add=BLOOD_PRESSURE` |
| `/insights/bmi` | `<SubPageShell>` + description | TWO branches: `BMI` empty + `heightCm` empty | `<InsightStatusCard>` | dual empty branches feel inconsistent (one points to `/measurements`, other to `/settings/account`) |
| `/insights/gewicht` | `<SubPageShell>` + description | `<EmptyState icon size-6>` | `<InsightStatusCard>` | matches blutdruck. |
| `/insights/medikamente` | `<SubPageShell>` + description | `<EmptyState icon size-6>` → `/medications` | `<InsightStatusCard>` + per-med `<Card>` grid | uses `<Loader2 text-primary h-6 w-6>` for primary loader (matches mother page); inner per-med loader is `text-primary h-4 w-4` |
| `/insights/puls` | `<SubPageShell>` + description | `<EmptyState icon size-6>` | `<InsightStatusCard>` + `<Vo2MaxChartRow>` | conforming |
| `/insights/schlaf` | `<SubPageShell>` + description | `<EmptyState icon size-6>` | NO `<InsightStatusCard>` — Sleep sub-page is the only one without the per-section assessment slot | **P1** — six sub-pages mount `<InsightStatusCard>` underneath the chart; Sleep does not. Either Sleep should pick up the assessment (matching the pattern) or the assessment slot should be documented as optional. |
| `/insights/stimmung` | `<SubPageShell>` + description | `<EmptyState icon size-6>` → `/mood` | `<InsightStatusCard>` | conforming |

### Drift summary (insights sub-pages)

- **P1** — Sleep is the only sub-page that omits the `<InsightStatusCard>`
  "assessment" slot. Either add the assessment for sleep (status text
  + cached badge + last-updated footer) or reframe the slot as
  optional in the SubPageShell contract.
- **P2** — BMI's two-branch empty-state is unique: every other
  sub-page has exactly one empty-state path. The BMI dual branch is
  legitimate (zero WEIGHT vs zero `heightCm`) but the second branch
  (`heightCm`) uses a different translation namespace
  (`insights.bmiEmpty*`) from the gated empty-state
  (`insights.emptyState.bmi.*`). Pick a single namespace.
- **P2** — Every empty-state in the seven sub-pages passes `<Button
  size="sm" asChild>` for the CTA. The `EmptyState` primitive added
  `ctaSize="lg"` (MB7 / CF-36) so the inner button lifts to
  `min-h-11 w-full sm:w-auto`. Zero current consumers — adopt or
  remove the prop.
- **P3** — `useQuery({ queryKey: ["analytics"] })` is hand-rolled
  inline in five sub-pages (blutdruck, bmi, gewicht, puls, schlaf)
  with identical `queryFn` + `staleTime` + `enabled` flags. The
  `<InsightsLayoutShell>` already mounts the same query (F19);
  consumers ride the dedup but the hand-rolled copy is dead code in
  spirit. Extract a `useAnalyticsQuery()` hook.

---

## 3. Settings vs admin sections cross-area

| Surface | Root | Heading | Card chrome | Section title element |
|---|---|---|---|---|
| `settings/account-section.tsx` | `<section aria-labelledby … className="space-y-6">` | `<h1 text-2xl font-semibold tracking-tight>` + `<p text-muted-foreground text-sm>` | 4× hand-rolled `<div className="bg-card border-border rounded-xl border p-6">` | `<h2 text-lg font-semibold>` |
| `settings/api-section.tsx` | `<section aria-labelledby … className="space-y-6">` | matches account-section header | hand-rolled `bg-card border-border rounded-xl border p-6` | `<h2 text-lg font-semibold>` |
| `settings/integrations-section.tsx` | `<section aria-labelledby … className="space-y-6">` | matches | matches | `<h2 text-lg font-semibold>` |
| `settings/notifications-section.tsx` | `<section aria-labelledby … className="space-y-6">` | matches | matches | `<h2 text-lg font-semibold>` |
| every other `settings/*-section.tsx` | identical | identical | identical | identical |
| `admin/general-settings-section.tsx` | `<div className="bg-card border-border rounded-xl border p-6">` — **no `<section>`, no aria-labelledby**, no page-level h1 | NONE — title is the card title | inline | `<div className="text-lg font-semibold">` (NOT a heading element) |
| `admin/system-status-section.tsx` | `<div className="space-y-6">` then `<div className="bg-card …">` | NONE | inline | `<div className="text-lg font-semibold">` |
| `admin/api-token-overview-section.tsx` | direct card | NONE | inline | `<div className="text-lg font-semibold">` |
| `admin/recent-audit-preview.tsx` | `<section aria-labelledby …>` ✓ | ✓ but uses `<h2 className="text-lg font-semibold">` (not h1) | inline | matches the section heading itself |
| `admin/system-status-summary.tsx` | `<section aria-labelledby …>` ✓ | `<h2 text-lg font-semibold>` | inline | matches |
| `admin/host-metrics-chart.tsx` | `<section aria-labelledby …>` ✓ | `<h2 id text-sm font-semibold>` | inline | matches |
| `admin/bug-report-section.tsx` | `<div>` | `<h2 text-lg font-semibold>` | inline | h2 |
| `admin/glitchtip-section.tsx` | `<div>` | `<h2 text-lg font-semibold>` | inline | h2 |
| `admin/umami-section.tsx` | `<div>` | `<h2 text-lg font-semibold>` | inline | h2 |
| `admin/app-log-preview-section.tsx` | `<div>` | `<h2 text-lg font-semibold>` | inline | h2 |
| `admin/web-push-vapid-section.tsx` | `<div>` | `<h2 text-lg font-semibold>` | inline | h2 |
| `admin/general/services/system-status/api-token/login-overview/user-management/coach-feedback/ai-quality/reminders` | `<div>` | `<div className="text-lg font-semibold">` ← **NOT a heading** | inline | div |

### Drift summary (settings vs admin)

- **P0** — Two parallel "section" recipes coexist. Settings has a
  full landmark + page-header + body-card stack. Admin sections
  often skip the landmark + page header entirely and start at the
  card body. Either:
  - bring admin sections into line with settings (`<section
    aria-labelledby>` + page `<h1>` + body card), or
  - codify a shared `<AdminSection>` primitive that owns the
    landmark + heading + card chrome and migrate every admin
    section onto it.
- **P0** — Inside admin sections, 11 surfaces use `<div className="text-lg
  font-semibold">` for the card title (no heading element). This is
  both a semantic drift (no `<h2>`) and a visual drift against the
  6 admin sections that DO use `<h2 className="text-lg font-semibold">`.
  Pick one and migrate.
- **P1** — `bg-card border-border rounded-xl border p-6` is repeated
  21 times. Extract a `<SectionCard>` primitive so the chrome stays
  single-source-of-truth (and so a future radius / shadow tweak
  doesn't require 21 edits).
- **P2** — Settings page header is `text-2xl font-semibold tracking-tight`;
  admin recent-audit-preview / system-status-summary use `text-lg
  font-semibold` for their landmark heading. Different visual
  weight for what is semantically the same role on each route. Pick
  one and migrate.

---

## 4. Dialogs / Sheets / ResponsiveSheet

| Surface | Primitive | Header chrome | Max width / height | Close affordance |
|---|---|---|---|---|
| `dialog.tsx` (primitive) | Radix Dialog | `<DialogHeader pr-9>` | `max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] sm:max-w-lg` | absolute top-right `min-h-9 min-w-9` (MB2 — explicit 36px floor per Decision I) |
| `sheet.tsx` (primitive) | Radix Dialog (side) | `<SheetHeader p-4>` | `w-3/4 sm:max-w-sm` | absolute `top-4 right-4`, `opacity-70`, `rounded-xs` — **smaller, no `min-h-9` floor, no aria-label** |
| `responsive-sheet.tsx` | Sheet or Dialog | `<SheetHeader p-4 pr-12>` mobile, plain `<DialogHeader>` desktop | mobile: `max-h-[90dvh] rounded-t-2xl`; desktop: `sm:max-w-md` | inherits from underlying primitive |
| `coach-drawer.tsx` (`<Sheet>` direct) | Radix Sheet (custom) | hand-rolled `<SheetHeader flex-row items-center gap-2 border-b p-3 sm:gap-3 sm:p-4>` | mobile: `h-[95dvh] rounded-t-2xl`; desktop: `sm:max-w-[720px] lg:!max-w-[min(960px,75vw)] xl:!max-w-[1080px]` | `showCloseButton={false}` — header carries own `<SheetClose>` |
| `phase-config-dialog.tsx` | `<Dialog>` direct | DialogHeader | `sm:max-w-md` | primitive |
| `feedback-inbox-section.tsx` dialog | `<Dialog>` direct | DialogHeader | `max-h-[85vh] overflow-y-auto sm:max-w-2xl` | primitive |
| `doctor-report-dialog.tsx` | `<Dialog>` direct | DialogHeader | (see file) | primitive |
| `medications/intake-history-list.tsx` (2 sheets) | `<ResponsiveSheet>` | shared | inherits | inherits |
| `medications/inventory-section.tsx` | `<ResponsiveSheet>` | shared | inherits | inherits |
| `medications/SideEffectsSection.tsx` | `<ResponsiveSheet>` | shared | inherits | inherits |
| `mood/mood-list.tsx` edit | `<Dialog>` direct (NOT ResponsiveSheet) | DialogHeader | primitive default | primitive |
| `measurements/measurement-list.tsx` edit | `<Dialog>` direct (NOT ResponsiveSheet) | DialogHeader | primitive default | primitive |
| `targets/target-edit-sheet.tsx` | `<Dialog>` direct (file name implies Sheet, content is Dialog) | DialogHeader | primitive default | primitive |
| `medications/ResearchModeAcknowledgmentDialog.tsx` | `<Dialog>` direct | DialogHeader | primitive default | primitive |

### Drift summary (Dialogs / Sheets)

- **P0** — Sheet primitive's close-X is visibly smaller than the
  Dialog primitive's close-X. Sheet: `opacity-70 rounded-xs`
  (~16px hit target, no min-size, no aria-label). Dialog: `min-h-9
  min-w-9` with explicit hover/focus chrome and an aria-label. Same
  affordance, different size + accessibility floor. Bring sheet
  close-X up to dialog parity.
- **P0** — Edit dialogs on `measurements`, `mood`, `targets`,
  `phase-config`, `research-mode-acknowledgment`, and `feedback-inbox`
  all mount raw `<Dialog>` instead of `<ResponsiveSheet>`. On mobile
  these surfaces lose the bottom-sheet branch the medication editor,
  intake history, and side-effects flow already have. Either:
  - migrate every form-bearing dialog onto `<ResponsiveSheet>`, or
  - document an explicit "Dialog stays a Dialog when X" rule.
- **P1** — Coach drawer hand-rolls its `<Sheet>` chrome instead of
  riding `<ResponsiveSheet>`. The mobile / desktop branch logic, the
  close affordance, and the header layout duplicate
  `responsive-sheet.tsx` with slight differences (Coach uses
  `h-[95dvh]`, ResponsiveSheet uses `max-h-[90dvh]`). Consolidate.
- **P2** — `targets/target-edit-sheet.tsx` filename says "sheet" but
  the implementation imports `<Dialog>`. Either rename the file or
  swap the underlying primitive.

---

## 5. Forms — measurement / mood / medication / settings

| Form | Outer | Field group spacing | Label gap | Notes |
|---|---|---|---|---|
| `measurements/measurement-form.tsx:254` | `<form className="space-y-4">` | `<div className="space-y-2">` per label-input | `space-y-2` | Matches the documented convention. |
| `mood/mood-form.tsx:121` | `<form className="space-y-4">` | `<div className="space-y-2">` | `space-y-2` | Matches. |
| `mood/mood-list.tsx:527` (edit form) | `<form className="space-y-4">` | `<div className="space-y-2">` | `space-y-2` | Matches. |
| `medications/medication-form.tsx:526` | `<form className="space-y-4">` | `<div className="space-y-2">` | `space-y-2` | Matches. |
| `settings/account-section.tsx:350` profile form | `<form className="space-y-4">` | `<div className="space-y-2">` | `space-y-2` | Matches. |
| `settings/account-section.tsx:613` password form | `<form className="space-y-3">` | `<div className="space-y-2">` | `space-y-2` | **P1** — only form in the codebase using `space-y-3` for the outer rhythm; every other form uses `space-y-4`. |
| `settings/ntfy-card.tsx:142` | `<form className="space-y-4">` | `<div className="space-y-2">` | `space-y-2` | Matches. |
| `settings/api-section.tsx:248` (token creation) | `<form className="flex gap-2">` (inline) | — | — | Intentional — single-input + button. Skip. |

### Drift summary (forms)

- **P1** — `settings/account-section.tsx` password-change form uses
  `space-y-3` for the outer form rhythm. Every other form in the
  codebase uses `space-y-4`. Align to `space-y-4`.
- **P3** — Otherwise the `space-y-4` outer / `space-y-2` label-input
  convention is honoured across 9 forms. Solid.

---

## 6. Tables — settings + admin + new `/settings/api` mobile card-list

| Table | Primitive | Mobile behaviour | Row striping | Notes |
|---|---|---|---|---|
| `measurements/measurement-list.tsx:395` | shadcn `<Table>` primitive | `md:hidden` card list in `space-y-2` | `<TableRow>` (hover) | Matches the documented "dual-render" pattern. |
| `mood/mood-list.tsx` | shadcn `<Table>` primitive | `md:hidden` card list | `<TableRow>` (hover) | Matches. |
| `medications/intake-history-list.tsx` | shadcn `<Table>` primitive | `md:hidden` card list | `<TableRow>` (hover) | Matches. |
| `admin/feedback-inbox-section.tsx:132` | raw `<table>` | NO mobile fallback (single `overflow-x-auto` wrap) | `i % 2 === 0 ? "bg-muted/30" : ""` (zebra) | **P1** — only admin table without a mobile card list; the user gets a horizontal scroll. Marc's "no horizontal scroll on mobile" rule. |
| `admin/api-token-overview-section.tsx:191` | raw `<table table-fixed>` + `<colgroup>` | `md:hidden` card list (`bg-muted/30 border rounded-lg p-3`) | `i % 2 === 0 ? "bg-muted/30" : ""` zebra | Matches the MB5 pattern. |
| `admin/user-management-section.tsx` | raw `<table>` | `md:hidden` card list | zebra | Matches. |
| `admin/login-overview-section.tsx` | raw `<table>` | (see file) | zebra | (admin "dense" — intentional variant per dispatch brief; skip from drift) |
| `admin/coach-feedback-section.tsx` | raw `<table>` | (see file) | zebra | admin dense — skip |
| `admin/backups-section.tsx` | raw `<table>` | (see file) | zebra | admin dense — skip |
| `admin/app-log-preview-section.tsx` | raw `<table>` | (see file) | zebra | admin dense — skip |
| `admin/ai-quality-section.tsx` | raw `<table>` | (see file) | zebra | admin dense — skip |
| `settings/account-section.tsx` passkey list | raw `<table>` + `md:hidden` div list | dual-render | none | Matches the convention. |
| `settings/api-section.tsx:90` (endpoints) | raw `<table>` | `<ul className="md:hidden space-y-2">` | none | Matches MB5 mobile card-list. |
| `settings/api-section.tsx:290` (tokens) | raw `<table>` | `<ul className="md:hidden space-y-2">` | `index % 2 === 0 ? "bg-muted/20" : ""` zebra | Different zebra opacity (`bg-muted/20`) than admin (`bg-muted/30`). Minor. |

### Drift summary (tables)

- **P1** — `admin/feedback-inbox-section.tsx` is the only admin
  table that lacks a `md:hidden` mobile card-list fallback. On
  Pixel 5 the user gets horizontal scroll. Add a mobile branch
  matching the user-management / api-token pattern.
- **P1** — Settings `api-section` uses `bg-muted/20` zebra striping;
  every admin table uses `bg-muted/30`. Pick one and apply
  consistently.
- **P1** — Two table primitives coexist:
  - shadcn `<Table>` primitive (measurements / mood / intake-history)
  - raw `<table className="w-full text-sm">` (every admin + settings
    table) with hand-rolled headers (`<tr className="text-muted-foreground
    border-b text-xs">`).
  Either:
  - retrofit the raw tables onto the `<Table>` primitive, or
  - document the raw `<table>` recipe as the "dense" variant
    (admin / settings) and add a primitive for it.
- **P2** — Mobile card-list outer class drift:
  - admin api-tokens uses `bg-muted/30 border-border overflow-hidden rounded-lg border p-3`
  - settings api-tokens uses `bg-muted/30 border-border space-y-2 rounded-lg border p-3`
  - settings api-endpoints uses `bg-muted/30 border-border space-y-1.5 rounded-lg border p-3 text-xs`
  - measurement-list uses (see file)
  Pick one and codify a `<MobileListCard>` primitive.

---

## 7. Empty states — every `<EmptyState>` consumer

| Consumer | size | variant | icon size | CTA |
|---|---|---|---|---|
| insights mother page | default | default (card) | `size-6` | `<Button size="sm" asChild>` |
| insights/blutdruck | default | default | `size-6` | `<Button size="sm" asChild>` |
| insights/bmi (BMI gate) | default | default | `size-6` | `<Button size="sm" asChild>` |
| insights/bmi (heightCm gate) | default | default | `size-6` | `<Button size="sm" asChild>` |
| insights/gewicht | default | default | `size-6` | `<Button size="sm" asChild>` |
| insights/medikamente | default | default | `size-6` | `<Button size="sm" asChild>` |
| insights/puls | default | default | `size-6` | `<Button size="sm" asChild>` |
| insights/schlaf | default | default | `size-6` | `<Button size="sm" asChild>` |
| insights/stimmung | default | default | `size-6` | `<Button size="sm" asChild>` |
| insights/sleep-overview | default | default | `size-6` | (see file) |
| insights/correlation-card | default | default | `size-6` | none |
| insights/daily-briefing | default | `plain` | `size-5` | `<Button size="sm" variant="outline">` |
| settings/section-placeholder | default | default | `size-6` | (see file) |
| admin/api-token-overview | default | default | `size-6` | none |
| admin/app-log-preview | default | default | `size-6` | (see file) |
| admin/backups | default | default | `size-6` | (see file) |
| admin/feedback-inbox | **compact** | default | `size-5` | none |
| admin/login-overview | default | default | `size-6` | (see file) |
| admin/recent-audit-preview | **compact** | **plain** | `size-5` | none |
| admin/user-management | default | default | `size-6` | (see file) |
| charts/* (chart-empty-state.tsx) | n/a — own primitive | n/a | n/a | n/a — separate primitive; intentional |

### Drift summary (empty states)

- **P1** — `ctaSize="lg"` (MB7 / CF-36) is on the primitive but
  ZERO consumers pass it. Decide: adopt for every CTA-bearing
  empty-state (the seven insights sub-pages would benefit at
  mobile widths) or remove from the primitive.
- **P2** — `size="compact"` + `variant="plain"` is used by two
  admin previews (feedback-inbox tab body, recent-audit) and
  Daily Briefing. Three different combinations across three
  surfaces: default+default+icon-6 (most), compact+default+icon-5
  (feedback inbox), compact+plain+icon-5 (recent-audit), default+plain+icon-5
  (daily-briefing). The icon-5 + plain combination wants a single
  recipe ("inline preview empty"). Codify.
- **P3** — `correlation-card.tsx` empty-state never has a CTA; the
  consumer pages can act on the empty-row. Consider whether a
  passive empty (no action prop) is the same primitive or a
  separate inline message.

---

## 8. Loading skeletons + spinners

### Skeleton shapes

| Surface | Shape |
|---|---|
| `ui/skeleton.tsx` (primitive) | `bg-muted/60 animate-pulse rounded-md motion-reduce:animate-none` |
| `insights/daily-briefing.tsx` BriefingSkeleton | hand-rolled: `bg-muted/60 h-3 w-{ratio}/12 animate-pulse rounded` + `border-border/40 bg-card/30 h-16 rounded-md border` rows (does NOT use the `<Skeleton>` primitive). |
| `dashboard/glp1-tile.tsx` skeleton | hand-rolled `bg-muted/40 mb-3 h-4 w-24 animate-pulse rounded` + `bg-muted/40 h-32 w-full animate-pulse rounded` (uses `/40` opacity, NOT the primitive's `/60`). |
| `chart-skeleton.tsx` and friends | various |

### Spinner colour + size (Loader2)

Eighteen distinct class signatures observed; the meaningful
clusters:

| Cluster | Surfaces | Signature |
|---|---|---|
| **Primary loading (large)** | insights mother page, insights/medikamente, weekly-report-view | `text-primary h-6 w-6 animate-spin motion-reduce:animate-none` |
| Primary loading (large, no motion-reduce) | account-section | `text-primary h-8 w-8 animate-spin` |
| **Insight status card** | insight-status-card | `text-dracula-purple h-5 w-5 animate-spin motion-reduce:animate-none` |
| **Inline button** | settings/advanced-section, settings/about-section, settings/account-section, … | `mr-2 h-4 w-4 animate-spin motion-reduce:animate-none` (or `mr-1 h-3.5 w-3.5`) |
| **Inline + muted** | admin/api-token-overview-section, admin/feedback-inbox-section | `text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none` |
| **Inline (tiny, no colour)** | insight-advisor-card (7 instances) | `h-3.5 w-3.5 animate-spin` (no `motion-reduce`) |
| **Per-medication compliance row** | insights/medikamente inner | `text-primary h-4 w-4 animate-spin motion-reduce:animate-none` |

### Drift summary (skeletons + spinners)

- **P0** — Spinner colour drift inside the same conceptual surface.
  On `/insights`, the mother page paints `text-primary h-6 w-6`,
  but `<InsightStatusCard>` (which loads on the same page below the
  mother) paints `text-dracula-purple h-5 w-5`. Same loading
  semantic, two colours, two sizes. Codify a `<Spinner>` primitive
  with `size: "sm" | "md" | "lg"` and `tone: "primary" | "muted" |
  "accent"`, and migrate.
- **P0** — `motion-reduce:animate-none` inclusion is inconsistent.
  Of the 18 signatures, 9 include the override and 9 don't. The
  insight-advisor-card has SEVEN Loader2 instances and NOT ONE
  carries `motion-reduce:animate-none`. With the docs convention
  pointing at "honour `prefers-reduced-motion`", this is an a11y
  drift. Bake `motion-reduce:animate-none` into a `<Spinner>`
  primitive.
- **P1** — Two skeleton patterns coexist: the `<Skeleton>` primitive
  with `bg-muted/60` + auto `motion-reduce` vs hand-rolled
  `bg-muted/{40,60} animate-pulse` divs. Daily-Briefing's
  `<BriefingSkeleton>` and Glp1-Tile's skeleton never use the
  primitive. Migrate or document the hand-rolled exception.

---

## 9. Buttons + icon buttons (post-MB2 lift)

The Button primitive (`ui/button.tsx`) already encodes the size
contract: `default h-10`, `xs h-6`, `sm h-8`, `lg h-11`, `icon size-10`,
`icon-xs size-6`, `icon-sm size-8`, `icon-lg size-11`.

| Surface | Variant + size | Drift |
|---|---|---|
| Dashboard tiles — no inline buttons | — | n/a |
| GLP-1 tile tab strip / range strip | hand-rolled `<button>` with `min-h-11` + `rounded` | **P1** — does not use the `<Button>` primitive; bespoke pill styling. The Button primitive's `xs` (`h-6`) and `sm` (`h-8`) sizes don't fit but a new `pill` variant could. |
| Insights tab strip pills | hand-rolled `<Link className="inline-flex min-h-11 rounded-full border">` | **P0** — see §10. Bespoke. |
| Insights tab strip regenerate | hand-rolled `<button className="h-11 w-11 rounded-full">` (cf. Button `size="icon-lg"` which is `size-11`) | **P1** — could use `<Button size="icon-lg" variant="ghost">`. Hand-rolled hover state. |
| Daily Briefing regenerate CTA | `<Button type="button" size="sm" variant="outline">` | conform |
| Sub-page empty-state CTA | `<Button size="sm" asChild>` | conform (every one of the 7 sub-pages) |
| API token creation | `<Button type="submit" variant="outline" size="sm">` | conform |
| API token mobile revoke | `<Button variant="outline" size="sm" className="text-destructive border-destructive/30 min-h-11 w-full">` | **P2** — `min-h-11` overrides `size="sm"`'s `h-8`. Either use `size="lg"` (already `h-11`) or move the `min-h-11` to a documented "mobile revoke" variant. |
| API token desktop revoke | `<Button variant="ghost" size="icon" className="text-destructive h-8 w-8">` | **P2** — overrides `size="icon"` (`size-10`) with `h-8 w-8`. Either use `size="icon-sm"` (already `size-8`) or document the override. |
| Coach launch / drawer buttons | `<Button variant="ghost" size="icon">` etc. | conform |

### Drift summary (buttons)

- **P0** — Insights tab strip pills + regenerate button are
  hand-rolled outside the `<Button>` primitive. See §10.
- **P1** — Glp1-Tile pill-style tab + range strip mounts hand-rolled
  `<button>`s, not the `<Button>` primitive. Decide whether to add
  a `pill` variant or leave bespoke + document.
- **P2** — Several inline overrides of the size system: `size="icon"`
  + `h-8 w-8`, `size="sm"` + `min-h-11`. If the primitive's
  `icon-sm` (size-8) and `lg` (h-11) sizes do the job, use them.
  Otherwise expose a clean variant.

---

## 10. Tab strips (insights vs feedback-inbox)

| Strip | Mount | Visual | Active state | Right-edge fade | Tap target |
|---|---|---|---|---|---|
| `insights/insights-tab-strip.tsx` | hand-rolled `<nav>` with `<Link>` pills | `min-h-11 rounded-full border px-3 py-1 text-xs font-medium` | `border-primary bg-primary/10 text-primary` | yes (sm:hidden gradient) | `min-h-11` (WCAG 2.5.5 floor) |
| `ui/tabs.tsx` + `admin/feedback-inbox-section.tsx` | shadcn `<Tabs>` + `<TabsList>` (`bg-muted h-9 p-1`) + `<TabsTrigger>` | TabsTrigger: rectangular `rounded-md border border-transparent px-2 py-1 text-sm`, no `min-h-11` | `data-[state=active]:bg-background text-foreground` (light pill on muted track) | no | `h-9` strip — under 44 px |
| `ui/tabs.tsx` + `coach-panel/*` | shadcn `<Tabs>` (line variant) | line variant with `after:` underline | underline | n/a | n/a |

### Drift summary (tab strips)

- **P0** — Two completely different visual languages for "tab strip"
  exist. Insights tab strip = rounded-full pills with a 44 px tap
  target, sticky, right-edge fade. Feedback inbox + Coach use the
  shadcn `<Tabs>` primitive: muted-background pill track, 36 px
  tap target, no fade. The user reads "tab strip" on `/insights`
  and recognises one control; on `/admin/feedback` they see a
  different control. Pick a single convention and migrate.
- **P1** — Feedback inbox's `<TabsList>` is `h-9` and under the
  44 px WCAG 2.5.5 mobile target floor that the insights strip
  honours. Fix or document the exception.

---

## 11. Tooltips / Popovers

| Surface | Primitive | Notes |
|---|---|---|
| `ui/tooltip.tsx` | Radix Tooltip via shadcn | base recipe: `bg-popover text-popover-foreground border-border px-3 py-1.5 text-xs text-balance shadow-md` |
| `ui/popover.tsx` | Radix Popover (added MB3) | base: `bg-popover text-popover-foreground border-border max-w-xs rounded-md border p-3 text-xs shadow-md` |
| `charts/trend-card.tsx` | `<TooltipContent className="bg-muted border-border text-foreground">` | **P1** — overrides `bg-popover` with `bg-muted` and `text-popover-foreground` with `text-foreground`. Distinct visual treatment from every other tooltip. |
| `insights/personal-record-badge.tsx` | `<TooltipContent>` | uses primitive default — conform |
| `targets/target-card.tsx` (2× tooltips) | `<TooltipContent>` | uses primitive default — conform |
| `targets/range-bar.tsx` | `<TooltipContent>` | uses primitive default — conform |
| `layout/sidebar-nav.tsx` (5× tooltips) | `<TooltipContent side="right" sideOffset={8}>` | uses primitive default — conform |
| `admin/api-token-overview-section.tsx` | `<TooltipContent>{value}</TooltipContent>` | uses primitive default — conform |
| `insights/coach-panel/coach-input.tsx` | `<Popover>` (MB3 swap) | uses primitive default — conform |

### Drift summary (tooltips / popovers)

- **P1** — `trend-card.tsx` is the only consumer that overrides
  the tooltip surface tokens to `bg-muted text-foreground`. Either:
  - codify a `variant="filled"` on the primitive and migrate, or
  - drop the override so trend-card uses the same `bg-popover`
    surface as every other tooltip.
- **P3** — Otherwise tooltips + popovers ride the primitive cleanly.

---

## 12. Charts (width-fluidity, Y-axis ticks, x-axis tick formatting)

| Chart | XAxis tick fontSize / fill | YAxis tick width / mode | Container | Notes |
|---|---|---|---|---|
| `charts/health-chart.tsx` (canonical) | `{ fontSize: 11, fill: "var(--muted-foreground)" }`, `tickLine={false}`, `axisLine={false}`, `padding={{ left: 10, right: 10 }}`, `tickMargin={10}` | `tick fontSize 11 + muted-foreground`, `width={yAxisWidth}` (dynamic), `tickMargin={10}`, unit appended via `unit` prop | `<ResponsiveContainer width="100%" height="100%">`, margin `{ top: 10, right: 8, bottom: 8, left: 8 }` | reference shape |
| `charts/mood-chart.tsx` | identical XAxis recipe | YAxis: `domain={[1,5]} ticks={[1,2,3,4,5]} width={65} tickMargin={6}` — **`tickMargin=6` instead of `10`**, fixed `width=65` instead of dynamic | identical container | **P1** — mood chart tickMargin diverges (`6` vs `10`) so labels sit closer to axis than every other chart. |
| `charts/medication-compliance-chart.tsx` / `compliance-heatmap.tsx` | (see file) — heat-map style, intentional variant | n/a | (see file) | skip — different visualisation |
| `charts/sparkline-chart.tsx` | (see file) | (see file) | (see file) | skip — sparkline, intentional |
| `medications/DrugLevelChart.tsx` | (see file) | (see file) | (see file) | skip — domain-specific |

### Drift summary (charts)

- **P1** — Mood chart's YAxis uses `tickMargin={6}` while every
  other line chart uses `tickMargin={10}`. Tiny visual drift the
  eye catches when flipping between `/insights/blutdruck` (10) and
  `/insights/stimmung` (6). Align to 10.
- **P3** — Both charts share their tick fontSize (`11`), fill
  (`var(--muted-foreground)`), `tickLine={false}`, `axisLine={false}`
  recipes — solid. Use of `var(--muted-foreground)` over raw hex
  in axis chrome is correct (no token leak).

---

## Outliers summary (single grep, one place)

| Surface | Outlier | Severity |
|---|---|---|
| `charts/trend-card.tsx:243` | `font-bold` headline value (every other tile uses `font-semibold`) | P0 |
| `insights/insights-tab-strip.tsx` | custom rounded-full pills + sticky + fade — completely different shape from `<Tabs>` primitive | P0 |
| `admin/*-section.tsx` (11×) | `<div className="text-lg font-semibold">` card title (not a heading element); every other admin/settings section uses `<h2>` | P0 |
| `admin/general-settings-section.tsx` (and 10 siblings) | no `<section aria-labelledby>` landmark, no page `<h1>`; settings has both | P0 |
| `insights/insight-status-card.tsx:40` | `text-dracula-purple h-5 w-5` Loader2 (every other "primary loading" loader uses `text-primary h-6 w-6`) | P0 |
| `ui/sheet.tsx:78` | close-X smaller + no aria-label (Dialog close-X is `min-h-9 min-w-9` with label) | P0 |
| `mood/mood-list.tsx`, `measurements/measurement-list.tsx`, `targets/target-edit-sheet.tsx`, `feedback-inbox-section.tsx` dialog | raw `<Dialog>` mounts where `<ResponsiveSheet>` would give the mobile bottom-sheet branch | P0 |
| `admin/feedback-inbox-section.tsx` | only admin table without `md:hidden` mobile card-list fallback | P1 |
| `insights/schlaf/page.tsx` | only insights sub-page without `<InsightStatusCard>` | P1 |
| `settings/account-section.tsx:613` | only form using `space-y-3` outer rhythm (others use `space-y-4`) | P1 |
| `dashboard/glp1-tile.tsx`, `insights/health-score-card.tsx` | only `bg-card/65 backdrop-blur-sm` consumers; other tiles use solid `bg-card` | P1 |
| `charts/mood-chart.tsx` YAxis | `tickMargin={6}` (others `=10`) | P1 |
| `charts/trend-card.tsx:321` TooltipContent | `bg-muted text-foreground` override; every other tooltip uses primitive default | P1 |
| `settings/api-section.tsx` token table | zebra `bg-muted/20`; admin tables use `bg-muted/30` | P1 |
| `insights-tab-strip` regenerate button | hand-rolled `h-11 w-11 rounded-full`; Button `size="icon-lg"` would match | P1 |
| `Glp1Tile` tab strip + range strip | hand-rolled `<button>`s outside the `<Button>` primitive | P1 |
| Empty-state primitive `ctaSize="lg"` | added MB7/CF-36; zero consumers | P1 |
| Dashboard "meta-label uppercase tracking" recipes | three variants (`text-xs tracking-wide`, `text-[10px] tracking-[0.18em]`, `text-[11px] tracking-wide`) | P1 |
| `bg-card border-border rounded-xl border p-6` | repeated 21 times instead of a shared `<SectionCard>` | P1 |
| Daily-Briefing + Glp1-Tile skeletons | hand-rolled `bg-muted/{40,60} animate-pulse` divs instead of `<Skeleton>` primitive | P1 |
| Loader2 `motion-reduce:animate-none` inclusion | 9 of 18 signatures include it; insight-advisor-card has 7 instances and 0 include it | P1 |
| `insights/bmi/page.tsx` empty-state | two separate empty branches with different translation namespaces | P2 |
| `targets/target-edit-sheet.tsx` | filename ends in `-sheet` but imports `<Dialog>` | P2 |
| Mobile card-list outer class | three subtly different recipes across api-tokens / api-endpoints / measurements | P2 |
| Settings api-tokens revoke buttons | size overrides (`size="icon"` + `h-8 w-8`, `size="sm"` + `min-h-11`) | P2 |

---

## Intentional variants noted and skipped

- Admin "dense" tables (`login-overview`, `coach-feedback`,
  `backups`, `app-log-preview`, `ai-quality`) — raw `<table>` + zebra
  striping + tighter padding. Per the dispatch brief this is the
  documented admin density variant; skipped from the drift list.
- `<ChartEmptyState>` is a separate primitive from `<EmptyState>`
  by design (charts have different aspect-ratio + layout
  constraints).
- `<HeroStrip>` greeting is `text-2xl sm:text-[28px] font-semibold
  tracking-tight` — this is a page hero, not a card heading, so its
  scale legitimately diverges from card titles.
- Coach drawer's narrative copy density and the assistant
  message-bubble layout are domain-specific (Coach is a
  conversation surface, not a data surface); not compared against
  insights cards.

---

## Recommended top-down fixes (effort-ordered, for v1.4.27 polish)

1. **Settings/admin landmark + heading parity.** Pick one recipe
   (`<section aria-labelledby>` + page `<h1>` + body
   `<SectionCard>` with `<h2>` title) and migrate the 11 admin
   sections that use `<div>` shell + `<div>` title.
2. **Loader2 → `<Spinner>` primitive.** New file
   `src/components/ui/spinner.tsx` with `size + tone` props and
   built-in `motion-reduce:animate-none`. Replace the 18+
   signatures with `<Spinner size="lg" tone="primary" />` etc.
3. **`<SectionCard>` + `<DashboardTile>` primitives.** Roll the
   21 hand-rolled `bg-card border-border rounded-xl border p-6`
   wrappers into one primitive; roll the dashboard tile chrome
   (`bg-card/65 backdrop-blur-sm` vs solid; `px-4 py-4` vs Card's
   `gap-6 py-6`) into a second primitive. Decide once whether
   tiles use blur.
4. **TrendCard headline weight.** Drop `font-bold` → `font-semibold`
   to match every other tile.
5. **Tab strip consolidation.** Either:
   - migrate feedback-inbox + Coach onto the insights
     rounded-full sticky pill strip, or
   - migrate insights onto shadcn `<Tabs>` and tune `<TabsList>`
     to honour `min-h-11`.
   Pick one. Document.
6. **Dialog ↔ ResponsiveSheet migration.** Audit every `<Dialog>`
   that wraps an editable form (measurements, mood, target,
   phase-config, research-mode, feedback-inbox dialog) and
   migrate to `<ResponsiveSheet>` so mobile users land on a
   bottom-sheet.
7. **Sheet close-X parity with Dialog close-X.** Bring the Sheet
   primitive's absolute close-X up to `min-h-9 min-w-9` with an
   aria-label.
8. **Mood chart YAxis `tickMargin`.** `6` → `10` to align with
   every other line chart.
9. **Insights/schlaf assessment slot.** Either add
   `<InsightStatusCard>` for sleep or document the omission as a
   primitive contract change.
10. **Feedback-inbox mobile card-list.** Add the `md:hidden`
    branch matching the user-management / api-token pattern so
    `/admin/feedback` stops horizontal-scrolling on phones.
11. **Settings account-section password form `space-y-3` → `space-y-4`.**
12. **Empty-state `ctaSize="lg"` adoption.** Either roll out to
    every CTA-bearing empty-state on `<sm` viewports or remove
    from the primitive.
13. **TrendCard's bespoke tooltip surface.** Drop the
    `bg-muted text-foreground` override or codify as a primitive
    variant.

---

## Conformity by class — bullet headline

- Dashboard tiles: **two drifts** (headline `font-bold` outlier on
  TrendCard; `bg-card/65 + backdrop-blur-sm` on 2 of 4 tiles).
- Insights sub-pages: **one drift** (sleep skips the assessment
  slot every other sub-page mounts).
- Settings vs admin: **two drifts** (admin lacks landmarks + page
  headers; admin uses `<div>` not `<h2>` for card titles).
- Dialogs / Sheets: **three drifts** (Sheet close-X smaller than
  Dialog; six raw Dialogs that should be ResponsiveSheets; Coach
  drawer duplicates ResponsiveSheet).
- Forms: **one drift** (one `space-y-3` outlier).
- Tables: **three drifts** (feedback-inbox has no mobile card-list;
  zebra `/20` vs `/30`; two parallel table primitives).
- Empty states: **one drift** (unused `ctaSize="lg"` prop;
  inconsistent size/variant on inline previews).
- Loading: **two drifts** (spinner colour + size + motion-reduce;
  hand-rolled skeletons bypass the primitive).
- Buttons: **two drifts** (insights tab strip + glp1 tile bypass
  the Button primitive; size overrides on a few revoke buttons).
- Tab strips: **one big drift** (two completely different visual
  languages).
- Tooltips / Popovers: **one drift** (trend-card tooltip surface
  override).
- Charts: **one drift** (mood YAxis tickMargin).

The codebase is internally disciplined on form rhythm
(`space-y-4 / space-y-2`), chart axis chrome (var-tokens, no hex
in axis fills), and the EmptyState contract — but the
**dashboard-tile vocabulary, settings-vs-admin scaffolding,
spinner palette, and tab-strip primitive** are the four classes
that read least conform across the app.
