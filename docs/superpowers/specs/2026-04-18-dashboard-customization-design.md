# Dashboard Customization — Design Spec

**Status:** Proposed (v1.2+)
**Date:** 2026-04-18
**Owner:** TBD

## Why

- Users have different health focus areas. Someone not tracking blood pressure shouldn't see an empty BP card.
- Current "hide if no data" rule (`showBodyFatCard = (bf?.count ?? 0) > 0`, etc. in `src/app/page.tsx`) is implicit — users can't pin the cards they care about, and a card vanishes the moment they delete the last entry.
- This is for a v1.2+ release, not part of the current bugfix push.

## 1. Problem Statement

The dashboard at `src/app/page.tsx` renders a fixed set of trend cards and charts (weight, BP sys/dia, pulse, body fat, mood, BMI) in a hard-coded order. Visibility is implicit (derived from data presence), ordering is non-negotiable. Narrowly-focused users carry visual noise; users with strong preferences cannot reorder. We need explicit, server-persisted, per-user control over which widgets appear and in what order.

## 2. Requirements

- **Per-user widget visibility.** Each chart and trend card is a "widget" that the user can show or hide independently.
- **Widget ordering — list-based reorder with up/down buttons + numeric position.** Defended below.
- **"Reset to defaults" action** that restores the v1.0 behavior (everything visible, default order).
- **Server-persisted** so settings follow the user across devices (web + PWA on phone). localStorage only acts as an optimistic cache.
- **i18n-friendly.** Widget IDs are stable English keys; display labels resolve through existing `dashboard.*` translation keys (`messages/en.json`, `messages/de.json`).

**Reorder UX choice:** list-based (up/down arrows) over drag-and-drop. Reasons: (a) mobile-first PWA — drag-on-touch with scroll containers is fragile; (b) keyboard/screen-reader accessible by default; (c) no extra dep (`@dnd-kit` ~30 KB). DnD can be added later behind a flag.

## 3. Data Model

**Decision: extend `User` with a `dashboardWidgets Json?` column.** No new table.

```prisma
model User {
  // ...
  dashboardWidgets Json? @map("dashboard_widgets")
}
```

Shape (validated by Zod on read/write):
```ts
type DashboardWidgetState = {
  version: 1;
  widgets: Array<{ id: WidgetId; visible: boolean; order: number }>;
};
```

`WidgetId` is a string-literal union seeded from a server-side registry (`src/lib/dashboard/widgets.ts`):
`"weight" | "bp" | "pulse" | "body_fat" | "mood" | "bmi"`.

**Tradeoffs vs. dedicated `DashboardWidget` model:** JSON wins because the widget set is small (<20 forecast), state is read once per dashboard load, and we never need to query "which users hide widget X." A table would cost a migration + FK + N writes per reorder for ~6 rows, with no queryability payoff. Cost: schema drift risk — mitigated by the Zod gate and the `version` field, which lets us evolve the shape without a SQL migration.

## 4. API

Two routes under `src/app/api/dashboard/widgets/route.ts`, both wrapped in `apiHandler` and `requireAuth()`.

**`GET /api/dashboard/widgets`** — returns merged state (stored values overlaid on the registry; new widgets appear at the end with `visible: true`):
```json
{ "data": { "version": 1, "widgets": [
  { "id": "weight", "visible": true, "order": 0 },
  { "id": "mood",   "visible": false, "order": 5 }
]}, "error": null, "meta": {...} }
```

**`PUT /api/dashboard/widgets`** — replaces full state. Zod schema in `src/lib/validations/dashboard.ts`:
```ts
const dashboardWidgetsSchema = z.object({
  version: z.literal(1),
  widgets: z.array(z.object({
    id: z.enum(WIDGET_REGISTRY.map(w => w.id)),
    visible: z.boolean(),
    order: z.int().min(0),
  })).min(1),
}).refine(s => new Set(s.widgets.map(w => w.id)).size === s.widgets.length);
```
Unknown IDs and duplicates are rejected. Mutations invalidate `queryKeys.dashboardLayout()`.

**`DELETE /api/dashboard/widgets`** — clears the column → user gets defaults again ("Reset to defaults").

## 5. UI

**Location:** new section in `/settings` named **"Dashboard"** (matches existing settings architecture: Profile, Notifications, Integrations, etc.). Plus a small **"Customize"** icon button on the dashboard header next to the "Add" dropdown that deep-links to `/settings/dashboard`.

**Flow** (settings page):
1. Header "Dashboard widgets" + subhead "Choose which cards and charts appear on your dashboard."
2. Ordered list of shadcn `Card` rows — translated label (`t("dashboard.weight")`), short description, `Switch` for visibility, `ChevronUp`/`ChevronDown` reorder buttons (disabled at list ends).
3. Sticky footer: outline "Reset to defaults" (confirm via `AlertDialog`) + primary "Save" (disabled until dirty).
4. Optimistic update via TanStack Query mutation; on error, rollback + toast.

**Dashboard read path:** `src/app/page.tsx` becomes a thin orchestrator — fetch layout via `useQuery(queryKeys.dashboardLayout())`, sort by `order`, filter `visible`, render through a `<DashboardWidget id="…" />` switch. Existing data-presence guards stay as a safety net.

## 6. Migration

- Prisma migration: `ALTER TABLE users ADD COLUMN dashboard_widgets jsonb`.
- No backfill. Null = "use defaults" = the v1.0 behavior frozen as `DEFAULT_LAYOUT` constant in `src/lib/dashboard/widgets.ts`. The `GET` endpoint synthesizes this on the fly.
- First save writes the full normalized blob.
- Existing users see no change until they open settings.

## 7. Nyquist Validation Criteria

- **Vitest:** Zod rejects duplicate IDs, unknown IDs, negative order, missing version.
- **Vitest:** layout merger appends new registry widgets with `visible: true` when user state predates them.
- **Vitest:** `DELETE` then `GET` returns `DEFAULT_LAYOUT`.
- **API integration:** unauth `PUT` → 401; valid `PUT` → 200 + persisted; payload >50 KB → 413.
- **Manual UAT:** hide BP on desktop → reload on phone PWA → BP gone. Reorder weight to last → reload → still last. Reset → defaults restored.
- **A11y:** keyboard nav on reorder buttons, `aria-label` on Up/Down, screen-reader announces position changes.
- **Perf:** dashboard initial render does not regress (React Profiler check).

## 8. Out of Scope

- Custom user-defined widgets / per-widget chart config (color, range, time window).
- Widgets for future measurement types (blood glucose, SpO2, sleep stages, steps) — added to registry when those features ship.
- Multiple dashboards or tabs; sharing layouts between users.
- Drag-and-drop reorder (revisit if list UX gets complaints).
- Per-widget grid size (1x/2x spans).

## 9. Estimated Effort

**M** — roughly 1–2 days. Schema + Zod + registry ~2h, API + tests ~3h, Settings UI ~4h, dashboard refactor ~3h, i18n + polish + UAT ~2h.
