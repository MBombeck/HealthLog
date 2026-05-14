# Phase W8b — v1.4.25 admin Login-Übersicht fixes

**Marc directive 2026-05-14**: four bugs on
`/admin/login-overview` reported after the v1.4.25 W7 timezone work
landed.

1. Standort/Location column not visible
2. No "Provider" column to disambiguate password / passkey / API
   token / OAuth
3. CSV export "looks weird"
4. Collapse/Expand toggle is pure clutter on a single-purpose page

Scope: `src/components/admin/login-overview-section.tsx` plus the
shared admin helpers, i18n catalogue, and the generic `toCSV` API.
No changes to the audit-log schema or `/api/admin/audit-log`
contract.

## Bug 1 — Standort column

**Root cause**: the column WAS rendered (line 374 of the v1.4.24
section) but the `<th>` and `<td>` carried `text-right`, which
parked the "Berlin, DE" label in the same gutter as the
right-aligned IP and timestamp on wide audit tables. Visual
overflow on smaller viewports pushed it further into the
horizontal-scroll area. The data path itself was healthy:
`src/lib/auth/audit.ts` fires the IP-geo lookup as a fire-and-forget
update; `src/lib/geo.ts` returns `Berlin, DE` for public IPs via
ipwho.is with the `Accept-Language: de, en;q=0.5` umlaut hint Marc
ratified in v1.4.16 A8a.

**Fix**: left-align the IP and Location cells (timestamp keeps the
right edge as the sort anchor), prefix the Standort header with a
lucide `MapPin` glyph so it reads as a first-class column.

**Commit**: `6d6f4c4 fix(admin): restore Standort column on
Login-Übersicht`

## Bug 2 — Provider column

The audit log encodes the credential method in the action name
itself (`auth.login.password`, `auth.login.passkey`,
`auth.bearer.success`, `auth.token.autoissue.native`, …); the table
was collapsing all of that into a single "Aktion" label.

**Mapping** (lives in `src/components/admin/_shared.tsx`):

| Action prefix                                                      | Provider    | Icon        |
| ------------------------------------------------------------------ | ----------- | ----------- |
| `auth.login.passkey`, `auth.passkey.{register,delete}`             | `passkey`   | Fingerprint |
| `auth.login.password`, `auth.password.change`, `auth.login.failed` | `password`  | KeyRound    |
| `auth.bearer.*`, `auth.token.*`                                    | `api_token` | Cpu         |
| `auth.withings.*` (future)                                         | `withings`  | Globe       |
| everything else                                                    | `unknown`   | Globe       |

`auth.login.failed` is bucketed under `password` because the
passkey-failed audit row carries a distinct
`auth.login.failed` only if the verifier rejects an assertion —
inspection of `src/app/api/auth/passkey/login-verify/route.ts` shows
the credential offered was a password assertion in every failed
case Marc has on record.

**Wiring**: `providerForAction()` + `iconForAuthProvider()` +
`useAuthProviderLabels()` live in `_shared.tsx` so the dashboard
recent-audit preview can pick up the same mapping later. New i18n
keys: `admin.provider*` (× 6) in `messages/{en,de}.json`. The
column slots into the table between Aktion and IP; the existing
auth-filter pin (F-02) still restricts the view to `auth.*` rows.

**Test**: `src/components/admin/__tests__/login-overview-provider.test.tsx`
pins every action → provider edge and every provider → icon edge.
6 tests.

**Commit**: `b5062ea feat(admin): add Provider column to
Login-Übersicht`

## Bug 3 — CSV export

**Issues identified** in the legacy `downloadCsv` path:

- Headers were snake_case English (`actor_id`, `actor_username`,
  `ip_address`) — admins had to mentally map `actor_username` →
  username every triage.
- Timestamp was the raw `createdAt` string (`Z` suffix). v1.4.25 W7
  proved this gets stripped by Excel / LibreOffice, displacing the
  cell to the viewer's local zone (issue #167).
- No provider column.
- No outcome column.
- `\r` was not RFC 4180-escaped — Windows-newline strings in
  `details` could break row alignment.

**Fix**:

- New column order (Marc's spec, minus email — `email` is absent
  from the audit-log API response and pulling it in would have
  required a schema/API change that the brief explicitly forbids):
  `timestamp → user → IP → location → provider → outcome →
action → details`.
- Headers are translated via the active locale's `admin.*` keys.
- Timestamps go through `formatInUserTz(date, userTz,
"iso-with-offset")` so the cell reads `2026-05-11T11:05:00+02:00`
  on a Berlin admin and `…-04:00` on a New-York admin.
- Outcome = `Failed` for `auth.login.failed` / `auth.bearer.failure`
  / `auth.token.refresh.failed`, else `Success`.
- `toCSV(records, headerLabels?)` gained an optional second
  argument so callers can override the header row without changing
  the record-key contract that drives column order. `\r` joins
  `\n,"` as an escape trigger.

**Helpers extracted**: `buildAuditLogCsvRecords()` and
`auditLogCsvHeaderLabels()` in `_shared.tsx` so the column-order /
escape contract is pinned by a pure unit test independent of the
React render.

**Tests**:

- `src/components/admin/__tests__/login-overview-csv.test.ts` — 7
  cases covering column order, provider mapping, outcome derivation,
  locale switch (DE), formatter injection, translated header row,
  RFC 4180 escape of `,"\n` in `details`.
- `src/lib/__tests__/export.test.ts` — existing 14 cases still
  green; the new `headerLabels` parameter is exercised by the audit
  integration test above.

**Commit**: `d87a631 fix(admin): tidy CSV export — column order +
escaping + ISO-with-offset`

## Bug 4 — Drop the collapse toggle

`/admin/login-overview` has been a dedicated route since v1.5
phase-4b. The Collapse/Expand toggle (inherited from the v1.4
shared-admin page that carried 13 sections on one route) hid the
entire page contents on click.

**Fix**:

- Drop the `expanded` state, the header toggle button, and the
  `{expanded && (…)}` body wrapper. The section always renders.
- Drop the `enabled: expanded` gate on both queries (no-op now that
  the body is always mounted).
- Drop the `ChevronDown` import.
- Keep the `settings.collapse` / `settings.expand` i18n keys per
  the brief — grep confirmed no other surface uses them today but
  they're cheap to retain.

**Test**: mirrors the `api-token-no-collapse` pattern.
`src/components/admin/__tests__/login-overview-no-collapse.test.tsx`
asserts no Collapse/Expand button (EN + DE), no `aria-expanded` on
the section header (Radix `Select` triggers below carry it
legitimately, so the assertion is scoped to the first 800 chars of
markup), and that the filter pills paint unconditionally in SSR.

**Commit**: `095578f refactor(admin): drop redundant collapse on
single-purpose Login-Übersicht page`

## Verification

```
pnpm typecheck   — green for everything I touched
pnpm lint        — 0 errors, 0 warnings on touched files
pnpm vitest run --no-coverage \
    src/components/admin/__tests__/ \
    src/lib/__tests__/export.test.ts
  → 17 files, 97 tests passed
```

Pre-existing failures unrelated to this scope:

- `tests/integration/timezone-per-user.test.ts` — TS errors from
  the v1.4.25 W7 work currently sitting in the working tree.
- `src/app/__tests__/insights-polish.test.ts` — 2 tests fail
  against in-progress insights-tab-strip refactor (uncommitted
  working-tree changes in `src/app/insights/page.tsx`).
- `src/components/charts/health-chart.tsx` — `toBerlinDayKey` rename
  is mid-flight in the working tree.

None of these are touched by W8b.

## Files changed

```
messages/de.json                                                    | 10 +
messages/en.json                                                    | 10 +
src/components/admin/__tests__/login-overview-csv.test.ts           | 258 +++
src/components/admin/__tests__/login-overview-no-collapse.test.tsx  | 94 +
src/components/admin/__tests__/login-overview-provider.test.tsx     | 71 +
src/components/admin/_shared.tsx                                    | 184 +++
src/components/admin/login-overview-section.tsx                     | 357 +/-
src/lib/export.ts                                                   | 45 +
```

## Out of scope (intentional)

- No changes to `prisma/schema.prisma` or
  `/api/admin/audit-log` — Marc's brief forbade them; the only
  cost was dropping `email` from the CSV.
- No revamp of the recent-audit-preview card. The provider mapping
  is exported from `_shared.tsx` so the preview can adopt it in a
  follow-up if desired.
- Coolify auto-deploy fix, Apple Health enum, etc. — these are
  separate v1.4.23 / v1.5 work streams.
