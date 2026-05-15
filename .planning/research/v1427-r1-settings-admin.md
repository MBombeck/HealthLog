---
file: .planning/research/v1427-r1-settings-admin.md
slot: R1.2 — Settings + Admin UX audit
target_tag: v1.4.27
findings_covered: [9, 10, 11, 12, 13, 22, 23]
surfaces_surveyed: 26
created: 2026-05-14
---

# R1.2 — Settings and Admin UX audit (v1.4.27)

## Headline

Findings 9–13 fall out of three concrete causes inside the account form and the two shells: the profile form uses a free-running `space-y-4` rhythm instead of the same paired-grid the rest of the form uses, the language field never moved into the `sm:grid-cols-2` row that should host it, and the `TimezonePicker` introduces a tighter inner `gap-2` that does not match the outer `space-y-4` cadence. Findings 22 and 23 share one server-side surface: `src/lib/geo.ts`. Today it returns only `"City, CC"` and fires only on `auth.*` actions — the dash that lands in the table is the legitimate provider miss for private and recently-cached IPs, plus a `null` payload for any non-`auth.*` event that lands in the same viewer. ASN is never resolved. The recommended fix bundles the offline GeoLite2-City and GeoLite2-ASN MMDBs, swaps the runtime lookup to local DB reads, and adds a `carrier` field to the audit row so the Provider column can grow a `Telekom DE` chip next to `API-Token`.

Surfaces surveyed: 11 settings sub-pages + 14 admin sub-pages + 1 admin overview = 26.

## Surface roster (for traceability)

Settings (`/settings/<slug>`): `account`, `integrations`, `notifications`, `dashboard`, `thresholds`, `sources`, `ai`, `api`, `export`, `advanced`, `about`.

Admin (`/admin` + `/admin/<slug>`): overview, `system-status`, `general`, `services`, `integrations`, `ai-quality`, `coach-feedback`, `feedback`, `reminders`, `users`, `api-tokens`, `login-overview`, `app-logs`, `backups`, `danger-zone`.

## Per-finding analysis

### Finding 9 — Profile field arrangement is asymmetric

**Current state.** `account-section.tsx` lines 354–446. The form uses `<form className="space-y-4">` and then alternates between two-column `grid gap-4 sm:grid-cols-2` rows (Username + Email, Gender + Height) and single-cell rows (Date of birth on its own, Timezone via `TimezonePicker`, Language on its own). Field widths within the same grid cell vary because three different field primitives are interleaved:

- `<Input>` (h-9, full width of cell)
- Native `<select>` with `NATIVE_SELECT_CLASS` (h-9, full width via `flex h-9 w-full`)
- `<DateInput>` (matches `Input` height)

The two-column grid rows look symmetric in isolation. The three single-cell rows (`dob`, `timezone`, `language`) break the rhythm because their cell expands to full-width while the row above keeps a two-column layout. The eye reads a column boundary that suddenly vanishes.

**Problem.** Mixed row geometries (`sm:grid-cols-2` vs full-width single cell) inside the same form. The four "biological profile" fields (gender, height, date of birth, **birthplace would go here in v1.5**) sit awkwardly: gender + height are paired in one grid row, date of birth is alone in another.

**Proposed approach.** Place date of birth next to a sibling so every "profile" field shares one paired grid row. Two viable pairings:

- Pair A (preferred): Date of birth + Language → one row near the bottom of the form. Solves finding 11 in the same edit.
- Pair B: Date of birth + Timezone select trigger (without the "use my browser zone" button) → one row, with the detect-button on a second row underneath. Slightly more disruptive to `TimezonePicker`.

Recommend Pair A. Hint text (`settings.dateOfBirthHint`, `settings.languageDescription`) stays inside each cell so the row height is consistent.

**Files touched.**
- `src/components/settings/account-section.tsx` (move language `<select>` into the same `grid gap-4 sm:grid-cols-2` row as date of birth; drop the standalone language wrapper).

**LOC estimate.** ≈ 25 lines moved + 5 lines deleted.

**Risk.** Low. Touches only one form's JSX. The `<TimezonePicker>` keeps its own layout so the detect-button gap (finding 10) is fixable independently.

### Finding 10 — Zeitzone Berlin gap to its neighbour button is smaller than the top-row gaps

**Current state.** `timezone-picker.tsx` lines 91–119. The picker renders:

```tsx
<div className="space-y-2">
  <Label …>{t("settings.timezone")}</Label>
  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
    <select … />
    <Button …><Compass …/>{t("settings.timezoneDetect", …)}</Button>
  </div>
  <p className="text-muted-foreground text-xs">{labelHint}</p>
</div>
```

The inner `gap-2` (8 px) between the select and the detect button is tighter than the outer `space-y-4` rhythm (16 px) used by the form's row stack. On desktop the visual reads as: top-row gap 16 px → picker row 8 px to its neighbour → bottom-row gap 16 px. That asymmetry is what Marc flagged.

**Problem.** Two scales of horizontal gap in the same rhythm (`gap-2` inside the picker, `gap-4` everywhere else inside the form's grid rows).

**Proposed approach.** Raise the picker's inner gap from `gap-2` to `gap-3` (12 px). Tailwind's 3-step interpolates correctly between the form's row rhythm and the chip-pill spacing used on the integration cards. Alternative: switch to `gap-4` to match the grid rhythm exactly. Marc-Voice rule: the detect button is a hugged action (icon + 2-word label), keeping it visually closer to the select reads as "attached", so `gap-3` is the safer pick.

**Files touched.**
- `src/components/settings/timezone-picker.tsx` (one className change).

**LOC estimate.** 1 line.

**Risk.** Trivial. Visual snapshot test covers the picker — re-baseline.

### Finding 11 — Language Deutsch sits alone at the bottom

**Current state.** `account-section.tsx` lines 429–446. Language is a single-cell row beneath the Timezone picker. The cell pinches to `sm:max-w-xs`, leaving a wide gutter on its right that wastes a full row of vertical space.

**Problem.** Pure layout waste + asymmetry with the rest of the profile form.

**Proposed approach.** See finding 9 — pair language with date of birth in one `grid gap-4 sm:grid-cols-2` row. Drop `sm:max-w-xs` because the grid cell is already a half-width column.

**Files touched.**
- `src/components/settings/account-section.tsx`.

**LOC estimate.** Same edit as finding 9 — no extra cost.

**Risk.** Low.

### Finding 12 — Page-height shift on click for `thresholds` and `sources`

**Current state.** Both shells render:

```tsx
<div className="grid gap-6 md:grid-cols-[220px_1fr]">
  <aside className="hidden md:block">
    <div className="sticky top-20">…</div>
  </aside>
  <main className="min-w-0">{children}</main>
</div>
```

`settings-shell.tsx` line 184, `admin-shell.tsx` line 218. The sidebar is `position: sticky; top: 5rem`, anchored to the page scroll, not to the main column. When the user clicks "persönliche Zielwerte" or "Quellen", the route swaps the `<main>` body for a section whose initial render height is taller than the previous section — `<ThresholdsEditorSection>` lazy-loads `/api/user/thresholds` and `<SourcesSection>` lazy-loads `/api/auth/me/source-priority`. While the queries are in flight both sections render their `Loader2` spinner stub (height ≈ 64 px) and then expand to ≈ 1400 px when the data arrives. The grid's row height is computed from the taller column → the entire page reflows when the spinner replaces with the full list.

The sidebar itself does NOT change width — the `md:grid-cols-[220px_1fr]` template pins the sidebar at 220 px. What shifts is the main column's height, which through the sticky sidebar's `top: 5rem` anchor changes where the active link sits on screen. Marc reads this as "sidebar and main reflow".

**Suspected root causes (cross-checked).**

1. **No min-height on the main column.** Every section renders its own height from zero. A click swaps a 64 px spinner for a 1400 px list and the viewport jumps.
2. **`<TimezonePicker>` runs `listSupportedTimezones()` inside a `useMemo` that returns ~400 entries the first time** — minor but contributes to a paint flicker on `/settings/account` first load.
3. **`/settings/sources` runs three independent network roundtrips synchronously** (`source-priority`, then derived `overriddenMetrics`, then `deviceTypeOverrideCount`) before the lay­out settles.
4. **`<ThresholdsEditorSection>` mounts a 14-row list with no skeleton placeholder** — the loading state is a single Loader, then 14 rows pop in.

**Proposed approach.**

a. Add a `min-h-[calc(100dvh-12rem)]` (or equivalent) to the `<main>` element in both shells. The header (`top-20` ≈ 5 rem) + the section header (≈ 5 rem) reserve 12 rem; the remainder gets reserved so the spinner-to-content transition does not change the page's overall height. This alone removes the "jump" Marc described.
b. Replace the single-spinner loading state in `<ThresholdsEditorSection>` and `<SourcesSection>` with a skeleton list whose row count matches the expected content (14 rows for thresholds, 14 metric tiles for sources). The skeleton heights match the loaded heights so the post-fetch swap is in-place.
c. Hoist the static enum maps (`METRIC_ORDER`, `SOURCE_PRIORITY_METRIC_KEYS`) out of the render closure so the first paint is faster.

**Files touched.**
- `src/components/settings/settings-shell.tsx` (one className change on `<main>`)
- `src/components/admin/admin-shell.tsx` (same change)
- `src/components/settings/thresholds-editor-section.tsx` (skeleton list)
- `src/components/settings/sources-section.tsx` (skeleton list)

**LOC estimate.** ≈ 60 lines (2 className edits + 2 skeleton placeholder helpers).

**Risk.** Low–medium. The `min-h-[calc(100dvh-12rem)]` reserve must not interfere with short sections like `/settings/about` (which is intentionally short). Use `min-h` rather than `h` so short content stays short while tall content does not jump.

**Investigation note.** No dev server is running in this audit — confirmed read-only. The cause analysis comes from reading the four files above. Playwright timing test should be added in implementation: load `/settings/account`, click `/settings/thresholds`, measure the scroll-position delta during the first 500 ms; assert it stays under 50 px. The same loop for `/settings/sources` and `/admin/login-overview`.

### Finding 13 — Symmetry audit overall

Cross-page review of all 26 surfaces against six rhythm dimensions:

**A. Section header pattern.** Two formats currently coexist:

1. `settings/[section]/page.tsx` route components emit their own `<header>` with `<h1 className="text-2xl font-semibold tracking-tight">` + `<p className="text-muted-foreground text-sm">`.
2. `admin/[section]/renderer.tsx` wraps every section in `<SectionFrame title subtitle>` which emits `<h1 className="text-2xl font-bold tracking-tight">` + `<p className="text-muted-foreground text-sm">`.

Different weights: settings uses `font-semibold`, admin uses `font-bold`. Same size token. Marc-flagged previously; the v1.4.25 W8 pass aligned shell padding but not heading weight. Recommendation: pick one — `font-semibold` reads as the calmer, app-wide default (matches `/measurements`, `/insights`, `/coach`). Land on `font-semibold` everywhere.

**B. Card paddings.** Every settings + admin card uses `bg-card border-border rounded-xl border p-6`. Consistent. Keep as-is.

**C. Card-internal vertical rhythm.** Settings cards use `space-y-4`, admin cards mix `space-y-3`, `space-y-4`, and (in `login-overview-section.tsx`) `mt-4 space-y-3`. Recommendation: standardise on `space-y-4` for inter-element cadence inside cards, `space-y-6` for inter-card cadence inside a section. Today this is honoured at the section level but not the card level.

**D. Sidebar entry padding.** Settings + Admin shells both emit `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium`. Consistent.

**E. Form-action footer alignment.** Settings forms place the save button right-aligned at the end of the form (`<div className="flex justify-end"><Button>`). Admin `general-settings-section.tsx` does not (it uses an inline save row). Acceptable for admin; documented divergence.

**F. Label–input gap.** Every form uses `space-y-2` between `<Label>` and `<Input>`. Consistent. EXCEPT the password-change dialog inside `account-section.tsx` which uses `space-y-1.5` — divergent. Standardise to `space-y-2`.

**Files touched.** All settings + admin section components — but each is a one-line change. A grep-and-replace pass.

**LOC estimate.** ≈ 30 lines across ~10 files.

**Risk.** Low — purely cosmetic. Visual snapshot tests need to be re-baselined.

### Finding 22 — Standort cell shows a dash

**Current state.** `login-overview-section.tsx` line 444: `{entry.location ?? "—"}`. The dash is the explicit `??` fallback. `entry.location` is populated by `src/lib/auth/audit.ts` lines 21–39 which fires `lookupIpLocation()` only when `action.startsWith("auth.")` AND `opts.ipAddress` is truthy.

Three classes of row will show "—":

1. **Private IPs.** `lib/geo.ts` line 76: `if (!ip || PRIVATE_IP.test(ip)) return null`. Cloudflare-fronted deployments forward `127.0.0.1` for internal probes; local dev shows "—" for every login.
2. **Failed `ipwho.is` lookups.** Lines 80–94: 3-second timeout, then `null`. The provider rate-limits aggressively when the audit table fills with login retries during a credential-stuffing burst.
3. **Cached failures never retried.** The lookup is fire-and-forget and runs only at audit-creation time. If `ipwho.is` was down when the row was inserted, the `location` column stays `NULL` forever.

The provider itself works — `lib/__tests__/geo.test.ts` exercises both response shapes and the umlaut path. The dash in production rows is real provider misses, not a code bug.

**Problem.** No retry path, no offline fallback, and the public-IP egress contract (`IP_GEO_LOOKUP_DISABLED=1`) means privacy-conscious deployments accept "—" forever.

**Proposed approach.** Two-tier strategy:

1. **Primary (offline):** Bundle the MaxMind GeoLite2-City MMDB. The `mmdb-lib` npm package (zero-deps, MIT) reads it at request time. ~70 MB DB on disk but the lookup is microsecond-scale and gives city + country offline. License: GeoLite2 Creative Commons Attribution-ShareAlike 4.0 — requires attribution in a docs page. Refresh schedule: monthly DB update, baked into the Docker image at build time.
2. **Fallback (online):** Keep the current `ipwho.is` path for IPs the offline DB cannot resolve (the GeoLite2 free tier coverage is ~99 % for IPv4 but lags on freshly-allocated ranges).
3. **Backfill job:** A one-shot cron (`src/lib/jobs/`) that walks `auditLog` rows where `location IS NULL` AND `ipAddress IS NOT NULL` AND `createdAt > now() - 30 days` and re-resolves them through the offline DB. Caps at 5k rows per pass to stay polite.

**Files touched.**
- `src/lib/geo.ts` (add offline-first resolver path).
- `package.json` (add `mmdb-lib`).
- `Dockerfile` (copy GeoLite2-City.mmdb into `/opt/geolite2/`).
- `src/lib/jobs/geo-backfill.ts` (new — backfill helper).
- `src/lib/jobs/__tests__/geo-backfill.test.ts` (new — TDD).
- `docs/audit/v1427-summary.md` (GeoLite2 attribution paragraph).

**LOC estimate.** ≈ 200 LOC (resolver fork + job + tests). Lookup helper: ~40 LOC; backfill job: ~60 LOC; tests: ~100 LOC.

**Risk.** Medium. Docker image grows by ~70 MB. Need to verify multi-arch GHCR build still fits the 2 GB image-size budget enforced in `.github/workflows/release.yml`. License attribution must land in `/about` and `docs/audit/`. Per-row offline cache means rows resolved while the DB was version-X stay at version-X — fine for "city, country" since neither moves often, but the backfill job should re-resolve when the DB roll is detected.

### Finding 23 — Provider column lists API-Token / Passkey but not the carrier

**Current state.** `_shared.tsx` lines 314–348: `providerForAction()` maps action names to `password | passkey | api_token | withings | unknown`. That's the auth-mechanism axis. The carrier axis is missing entirely. No ASN data lives in the schema.

**Problem.** Marc wants the carrier (Telekom / Vodafone / 1&1) visible next to the auth mechanism. The two axes serve different forensic questions: "how did they sign in?" (provider) vs "where are they coming from?" (carrier).

**Research — MaxMind GeoLite2-ASN.**

- License: same CC BY-SA 4.0 as GeoLite2-City. Attribution mandatory.
- Size: ~7 MB compressed, ~10 MB uncompressed.
- Lookup performance: same MMDB layout as GeoLite2-City. Microsecond-scale local read.
- Coverage: full IPv4 + IPv6 ASN map. Known DACH carriers it resolves correctly:
  - `AS3320` → Deutsche Telekom AG
  - `AS3209` → Vodafone GmbH
  - `AS8881` → 1&1 Versatel
  - `AS6805` → Telefónica Germany (O2)
  - `AS31334` → Vodafone Kabel Deutschland
  - `AS3215` → Orange S.A. (for Marc's roaming events)
- Returns: `{ autonomous_system_number, autonomous_system_organization }`. We persist both — number for forensic precision, organization for human-readable display.

**Proposed schema change.**

Add two nullable columns to `AuditLog`:

```prisma
asn         Int?    @map("asn")
carrier     String? // e.g. "Deutsche Telekom AG"
```

Both populated at audit-creation time via the same fire-and-forget pattern that fills `location` today. Both nullable so older rows + private-IP rows + provider-miss rows stay valid.

**Proposed UI change.**

`login-overview-section.tsx`: split the Provider column into two visual chips. The auth-provider chip (`API-Token`, `Passkey`) stays where it is; the carrier chip renders beneath in a smaller font, gated on `entry.carrier !== null`. The action vocabulary in `_shared.tsx` does NOT change — Marc's "Provider" column header now means "credential + carrier" which is the natural reading.

Alternative: add a dedicated "Netz" column to the right of "Standort". More tabular but uses a column slot in an already-busy 7-column table. The chip-stack approach below the auth provider is the recommended pick.

**Files touched.**
- `prisma/schema.prisma` (additive migration: 2 nullable columns).
- `prisma/migrations/<timestamp>_audit_log_carrier/` (new — additive).
- `src/lib/geo.ts` (add `lookupIpAsn()` that returns `{ asn, carrier } | null`).
- `src/lib/auth/audit.ts` (resolve carrier in parallel with location, single `update()` carries both).
- `src/lib/__tests__/geo-asn.test.ts` (TDD).
- `src/components/admin/login-overview-section.tsx` (carrier chip below provider chip).
- `src/components/admin/_shared.tsx` (CSV: add `carrier` column to export).
- `src/components/admin/__tests__/login-overview-csv.test.ts` (extend).
- `src/lib/i18n/locales/{en,de}.json` (add `admin.carrier` + `admin.carrierUnknown`).

**LOC estimate.** ≈ 250 LOC including tests.

**Risk.** Medium. Prisma migration is additive + nullable so the `IF NOT EXISTS` guard pattern documented in `.planning/v1427-plan.md` applies. Docker image grows another ~10 MB for the ASN DB. Combined with the GeoLite2-City DB (finding 22), total Docker image growth ≈ 80 MB. Verify image-size budget before merge.

## Cross-finding patterns

1. **Two findings share `src/lib/geo.ts`.** 22 and 23 both want offline-first lookups against MaxMind GeoLite2 DBs. Ship them in one fix-surface bucket — the resolver refactor that introduces the offline path will hold both `lookupIpLocation()` and `lookupIpAsn()`. Otherwise two contributors will conflict on the same file.
2. **Three findings share `src/components/settings/account-section.tsx`.** 9, 10 (partial — shared form ergonomics), 11 all touch the profile form. Ship in one commit so the visual rhythm is reviewed once.
3. **Finding 12 ALSO touches the shells.** It shares `settings-shell.tsx` with no other R1.2 finding but it shares `admin-shell.tsx` with the R1.6 backlog sweep (which may pull forward another shell-related item). Coordinate with the R2 reconcile pass.
4. **Finding 13 is a polish-pass that touches every section component.** Because each edit is one line, this is genuinely a sweep — assign to a single contributor at the end of the implementation round so visual snapshots are re-baselined exactly once.

## Recommended sequencing

| Order | Bucket | Contains | Disjoint from |
|---|---|---|---|
| 1 | Profile form rhythm | 9, 10, 11 | All others |
| 2 | Shell layout-shift fix | 12 | Profile form |
| 3 | Geo offline-first + ASN | 22, 23 | UI changes |
| 4 | Symmetry sweep | 13 | All others — run last |

Bucket 1 + 2 + 4 are pure front-end; bucket 3 is back-end + migration + a tiny UI delta. Run buckets 1–3 in parallel, then bucket 4 as a serial cleanup on top.

## Deferrals

None recommended. All seven findings fit inside v1.4.27. Bucket 3 is the heaviest (Docker image growth + Prisma migration) but the additive-nullable migration approach keeps it safe.

## Implementation notes

- **Mock the MMDB reader in tests.** The actual DB file is too large for the test fixtures dir; stub `mmdb-lib`'s `Reader` in `vitest.config` so `lookupIpAsn` tests run without the DB on disk.
- **GeoLite2 attribution.** Add a paragraph to the `/about` page and `docs/audit/v1427-summary.md` once it exists. The license is CC BY-SA 4.0 — silent inclusion would breach it.
- **Backfill job lives in `lib/jobs/`.** Reuse the existing pg-boss scheduler. Cap concurrency at 1 so the DB update does not collide with a live login burst.
- **Image-size budget.** Re-run the multi-arch publish CI (`.github/workflows/release.yml`) with the two MMDB files in place before merging. Reject the change if the image grows past 1.9 GB compressed.
- **Carrier display copy.** Marc-Voice English short labels: "Telekom", "Vodafone", "1&1", "O2" — fold the GeoLite2 `autonomous_system_organization` strings ("Deutsche Telekom AG") down to these via a small lookup table inside `_shared.tsx`. Unknown ASNs fall through to the raw organization string.
- **Hide carrier on private IPs.** The chip renders only when `entry.carrier !== null`. Same gate that already governs `entry.location`.

## Verification checklist (post-implementation)

- Profile form visually balanced on Pixel 5 (393 px) and a 1440 px desktop.
- Click `/settings/account` → `/settings/thresholds` → `/settings/sources`: viewport scroll delta < 50 px during the first 500 ms.
- `entry.carrier` populates on a fresh password login from a public German IP.
- Admin login-overview CSV export contains a `carrier` column with the correct DACH carriers for the test fixture set.
- `docs/audit/v1427-summary.md` includes the GeoLite2 attribution.
- Docker image growth < 90 MB combined.
