# SB-8 — Dashboard tile-visibility merge semantics

**Owner:** W-IOS-COORD (v1.4.41)
**Route:** `src/app/api/dashboard/widgets/route.ts`
**Resolver:** `src/lib/dashboard-layout.ts` (`resolveDashboardLayout` + `DEFAULT_DASHBOARD_LAYOUT`)
**Status:** investigation-only — no code change. Documents the contract a
future widget-introduction migration must honour.

## How the layout is stored

`User.dashboardWidgetsJson` (Prisma `Json?`, default `null`). A null /
missing value means "no user customisation, use defaults". A populated
value is a `DashboardLayout` blob shaped by the Zod schema in the PUT
route. The resolver in `src/lib/dashboard-layout.ts` is the single
read-side merge point.

## Merge semantics on read (`resolveDashboardLayout`)

1. **Null/empty input** → return `DEFAULT_DASHBOARD_LAYOUT` verbatim.
2. **Known widget ids** → keep the user's `visible` / `tileVisible` /
   `order` exactly as stored.
3. **Unknown widget ids** (stale entries from a removed widget) → dropped
   silently.
4. **New widgets present in `DASHBOARD_WIDGET_IDS` but absent from the
   user's blob** → appended at the end of `widgets[]` with the default
   layout's `visible`, `tileVisible`, and `order` values. This is the
   key behaviour any new-widget migration must rely on. The resolver
   does this on every read; no DB migration is required when a new
   widget id ships.
5. **`tileVisible` omitted** → mirrors `visible` for back-compat with
   pre-v1.4.15 saved layouts.
6. **Unknown `comparisonBaseline` / `chartOverlayPrefs` keys** → clamped
   to defaults so a stale client cannot poison the dashboard.

## Merge semantics on write (`PUT /api/dashboard/widgets`)

1. The Zod schema requires the **full** `widgets[]` array — the route
   does NOT support partial updates. Clients must read the current
   layout, mutate, and PUT the result.
2. `chartOverlayPrefs` is preserved automatically when omitted: the
   route re-reads the persisted blob and re-attaches the existing
   prefs before writing (see lines 137–151).
3. `comparisonBaseline` is **not** preserved-on-omit — an omitted
   field clamps to the default. Clients that want to keep an existing
   baseline must round-trip the value.
4. `DELETE` resets to defaults by writing `Prisma.JsonNull` (not
   `null` — Prisma's typed null sentinel).

## Future-migration guidance

Adding a new widget id is **migration-free** when these rules hold:

- Add the id to `DASHBOARD_WIDGET_IDS`.
- Add a default entry to `DEFAULT_DASHBOARD_LAYOUT.widgets[]` with the
  desired `visible`, `tileVisible`, and a unique `order`.
- That's it. Every existing user gets the new widget appended on next
  GET. No `prisma migrate` step is needed for the layout blob.

Removing a widget id is also migration-free:

- Drop the id from `DASHBOARD_WIDGET_IDS` and from
  `DEFAULT_DASHBOARD_LAYOUT`.
- The resolver drops the orphan entry on next read. A subsequent PUT
  rewrites the blob without it.

**Anti-pattern (do NOT do):** a "one-shot migration" that rewrites every
`User.dashboardWidgetsJson` to overlay a new tile-visibility default
will clobber every user's customisation. The resolver's append-only
merge is intentionally designed so we never need such a migration.

## Open audit gap closed

The original audit note flagged "what happens when a future migration
introduces a new tile and we want it visible by default for existing
users". Answer: do nothing — the resolver handles it. If a tile must
be visible-by-default for existing users, set `visible: true` in
`DEFAULT_DASHBOARD_LAYOUT`. The user's saved blob never has the new
id, so the resolver's append step uses the default.

## References

- `src/app/api/dashboard/widgets/route.ts` — PUT schema + chart-overlay
  preservation logic.
- `src/lib/dashboard-layout.ts` — `resolveDashboardLayout`,
  `serializeDashboardLayout`, `DEFAULT_DASHBOARD_LAYOUT`.
- `src/lib/__tests__/dashboard-layout.test.ts` — resolver coverage.
