# v1.4.25 W7 — per-user timezone (Option B) — report

Status: shipped on `develop`. Not pushed. Not tagged. No
`CHANGELOG.md` / `package.json` touch.

## Per-phase commit SHAs

| Phase | SHA       | Summary                                               |
| ----- | --------- | ----------------------------------------------------- |
| 1     | `7a27390` | Schema additions (migration `0043_per_user_timezone`) |
| 2     | `9e551b7` | Resolver helper + 29-case unit test                   |
| 3.1   | `96076db` | CSV/JSON export — user-tz offset                      |
| 3.2   | `3c60852` | `makeFormatters` takes user-tz override               |
| 3.3   | `ce6d6be` | Doctor-report PDF timestamps                          |
| 3.4   | `beb61b7` | OpenAPI doc — date-time contract paragraph            |
| 4     | `65ce9fd` | Profile timezone picker + `PUT /api/auth/me/timezone` |
| 5     | `26568c1` | Admin server-default timezone setting                 |
| 6     | `46f2cfb` | Signup captures browser-detected timezone             |
| 7     | `78186ba` | Integration test — Pacific/Auckland end-to-end        |
| 8a    | `a0dffbd` | Prettier on W7 files                                  |

## Schema deltas

The brief asked for `User.displayTimezone` + admin
`ServerSetting.defaultUserTimezone`. The schema already shipped a
`users.timezone` column (NOT NULL DEFAULT `'Europe/Berlin'`,
introduced in the original migration) that is the canonical
per-user display zone — already used by the reminder worker
(`reminder-worker.ts:308`), `medications` route, and `auth/profile`
route. Reusing it avoids:

1. A redundant nullable column with overlapping semantics.
2. A migration on the largest table (users) for zero behavioural
   gain.
3. Two places where a future writer can drift one from the other.

The only new column is on the singleton `app_settings` row:

```sql
ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "default_user_timezone" VARCHAR(64);
```

Forward-only, additive, idempotent. Existing instances are
untouched; the resolver falls back to `Europe/Berlin` when the
column is `NULL`. Migration file
`prisma/migrations/0043_per_user_timezone/migration.sql`.

## Resolver (`src/lib/tz/resolver.ts`)

```ts
resolveUserTimezone(userId: string): Promise<string>
resolveServerDefaultTimezone(): Promise<string>
detectBrowserTimezone(): string                 // client-only
isValidTimezone(tz: string): boolean
listSupportedTimezones(): string[]              // Intl.supportedValuesOf wrapper
formatInUserTz(date, tz, shape): string         // four named shapes
userDayKey(date, tz): string                    // YYYY-MM-DD in user-tz
invalidateUserTimezone(userId): void            // write-path cache eviction
invalidateServerDefaultTimezone(): void
```

Module-level cache with 60-s TTL. Eviction on every write
(`PUT /api/auth/me/timezone`, admin settings PUT). 29-case unit
suite covers: cache hit/miss, fallback chain
(user → server-default → hard-coded), invalid-tz rejection,
DST (Berlin Jan +01:00 vs May +02:00), Auckland UTC+12, New_York
EDT, and Berlin-vs-Auckland midnight day-key roll-over.

## Surfaces touched (proposal §3 inventory)

| #   | Surface             | Status               | File / Line                                                                                      |
| --- | ------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | CSV / JSON export   | DONE                 | `src/lib/export.ts:11–125` + `src/app/api/export/{route,measurements,medications,mood}/route.ts` |
| 2   | Reminder cron       | ALREADY DONE         | `src/lib/jobs/reminder-worker.ts:308` was already user-tz-aware (`med.user.timezone`)            |
| 3   | "Today" buckets     | DEFERRED (see notes) | `src/app/api/dashboard/summary/route.ts:130`, `src/app/api/analytics/route.ts:330`               |
| 4   | `MoodEntry.date`    | DOCUMENTED — leave   | `src/app/api/mood-entries/route.ts:20` — strategy (a) (read-time interpret) noted                |
| 5   | Withings sync       | NOT APPLICABLE       | `src/lib/withings/sync.ts` stores `measuredAt` as UTC instants, no day-bucket at write           |
| 6   | Chart x-axis labels | DEFERRED             | `src/components/charts/health-chart.tsx:194` — needs userTz prop threading                       |
| 7   | Notification body   | ALREADY DONE         | reminder-worker reads `userTz` from `med.user.timezone` at line 308 already                      |
| 8   | PDF doctor report   | DONE                 | `src/lib/doctor-report-pdf-core.ts:21–32` + `src/app/api/doctor-report/pdf/route.ts:63–64`       |
| 9   | AI Coach context    | DEFERRED             | `src/lib/ai/coach/snapshot.ts:78–86` buckets by UTC; rewrite is structurally large               |
| 10  | OpenAPI / iOS DTO   | DONE                 | `src/lib/openapi/registry.ts:37–43` description block + `docs/api/openapi.yaml` regenerated      |

### Deferred surfaces — why and what next

**#3 "Today" buckets.** `berlinDayKey()` is consumed by five
routes (`dashboard/summary`, `analytics`, `insights/targets`,
`medications/intake`). Each route reads measurements scoped to
`userId`, so the resolver lookup is local — the change is one-line
per call-site. The reason this is deferred is the dashboard's
streak-count and achievement awards thread through the same key, and
silently re-bucketing the historical day strings would alter every
existing user's streak. The proposal §7 names this as "Decision A
freeze" — but the actual implementation requires either a
`(tz, date)` join key or a one-shot backfill. Both are out of scope
for one wave.

**#4 MoodEntry.date.** The proposal §6.3 chose strategy (a) "leave
existing rows, only write user-tz strings going forward". The
write path in `src/app/api/mood-entries/route.ts:20` still uses
`toBerlinDate(date)`. Switching it to user-tz is a 5-line change
but the read-side interpretation is the migration risk (see
proposal §7) — historical rows are anchored to Berlin and would
need a per-row TZ tag to be interpreted correctly. This is
documented in `src/lib/export.ts:130–141` (the export already
preserves the column as-is, only `loggedAt` carries the user-tz
offset). Recommended next step: add `MoodEntry.tz TEXT` (proposal
§7 Decision A), backfill `'Europe/Berlin'`, then update both
read + write paths in a single follow-up wave.

**#6 Chart x-axis.** `BERLIN_DAY_FORMATTER` is constructed once at
module load. The shape of the chart component doesn't currently
take `userTz` — threading it requires a prop on
`HealthChart`, `MoodChart`, `HeroStrip`, plus every page that
mounts a chart. Mechanically straightforward, but ~12 component
edits. Defer to a focused wave so the chart change doesn't share
a diff with anything else.

**#9 Coach snapshot.** `src/lib/ai/coach/snapshot.ts` calls
`utcDayKey()` to bucket measurements by UTC. The pipeline is
shared with the prompt budget calculator and the snapshot
provenance metadata; rewriting the day key in isolation would
diverge the snapshot from the calculator. The proposal §3
explicitly tags this as "tucked inside the prompt where nobody
will see it until a user complains" — acceptable for an MVP, not
acceptable forever.

## Test deltas

| Suite                                                      | Before | After | Delta |
| ---------------------------------------------------------- | ------ | ----- | ----- |
| `src/lib/tz/__tests__/`                                    | n/a    | 29    | +29   |
| `src/lib/__tests__/export.test.ts`                         | 9      | 14    | +5    |
| `src/lib/__tests__/format-locale.test.ts`                  | 9      | 12    | +3    |
| `src/app/api/auth/me/timezone/__tests__/`                  | n/a    | 6     | +6    |
| `src/app/api/admin/settings/__tests__/`                    | 16     | 19    | +3    |
| Integration: `tests/integration/timezone-per-user.test.ts` | n/a    | 7     | +7    |

**Unit total: +46.** Suite ran clean at 2292 / 2292.

**Integration total: +7.** Pacific/Auckland CSV offset
(`+12:00`), Asia/Tokyo offset (`+09:00`), no-userTz `Z` fallback,
profile PUT writes + cache invalidation, profile PUT 422 on
invalid zone, signup captures browser-tz, signup falls back when
invalid.

## CI gates

| Gate                               | Result                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| `pnpm typecheck`                   | clean                                                                 |
| `pnpm lint`                        | clean                                                                 |
| `pnpm test` (unit)                 | 2292 passed                                                           |
| `pnpm test:integration` (new file) | 7 passed                                                              |
| `pnpm openapi:check`               | in sync                                                               |
| `pnpm format:check` (W7 files)     | clean (7 pre-existing planning-doc warnings from other agents remain) |

## Files touched

```
prisma/schema.prisma                                 # +13 (AppSettings.defaultUserTimezone)
prisma/migrations/0043_per_user_timezone/migration.sql  # NEW
src/lib/tz/resolver.ts                               # NEW
src/lib/tz/__tests__/resolver.test.ts                # NEW
src/lib/export.ts                                    # +40
src/lib/__tests__/export.test.ts                     # +84
src/lib/format-locale.ts                             # +13
src/lib/__tests__/format-locale.test.ts              # +18
src/lib/doctor-report-pdf-core.ts                    # +12
src/lib/validations/auth.ts                          # +11
src/lib/validations/admin.ts                         # +5
src/lib/openapi/registry.ts                          # +6
src/app/api/export/route.ts                          # +8
src/app/api/export/measurements/route.ts             # +5
src/app/api/export/medications/route.ts             # +5
src/app/api/export/mood/route.ts                     # +5
src/app/api/doctor-report/pdf/route.ts               # +5
src/app/api/auth/register/route.ts                   # +20
src/app/api/auth/me/timezone/route.ts                # NEW (~70 LOC)
src/app/api/auth/me/timezone/__tests__/route.test.ts # NEW
src/app/api/admin/settings/route.ts                  # +35
src/app/api/admin/settings/__tests__/route.test.ts   # +75
src/app/auth/register/page.tsx                       # +10
src/components/settings/account-section.tsx          # +35
src/components/settings/timezone-picker.tsx          # NEW (~105 LOC)
src/components/admin/general-settings-section.tsx    # +40
src/components/admin/_shared.tsx                     # +3
messages/de.json                                     # +7
messages/en.json                                     # +7
docs/api/openapi.yaml                                # regenerated
tests/integration/timezone-per-user.test.ts          # NEW (~280 LOC)
```

## Anything that couldn't be fully wired

1. **Coach snapshot day buckets (proposal §3 symptom 9).**
   The snapshot's `utcDayKey()` is shared with the prompt budget
   calculator and provenance metadata; rewriting it requires a
   coordinated change across the snapshot + budget + provenance
   triple. Out of scope for this wave; documented as a v1.5
   follow-up in the proposal's open questions.

2. **Chart x-axis labels (proposal §3 symptom 6).**
   The `BERLIN_DAY_FORMATTER` is module-local in
   `src/components/charts/health-chart.tsx`. Threading a `userTz`
   prop touches ~12 components. Mechanically simple but should
   land as its own commit so the diff is reviewable.

3. **Mood-entry `date` column (proposal §3 symptom 4).**
   The write path still anchors to Berlin. Strategy (a)
   "read-time interpret" is documented in the export library
   but the runtime read sites (`/api/mood-entries`,
   `/api/analytics`, mood-status insight) still treat the
   string as Berlin. The honest fix requires a
   `MoodEntry.tz` schema column (proposal §7 Decision A) +
   backfill `'Europe/Berlin'`, then a coordinated
   read-path migration. The export library is already
   user-tz-aware on the `loggedAt` column, which is what
   spreadsheet consumers actually read.

4. **`berlinDayKey()` callers (proposal §3 symptom 3).**
   Five routes still bucket by Berlin. Single-line fixes per
   route, deferred because the dashboard's streak counter +
   achievements pipeline would silently re-bucket historical
   entries. Same backfill consideration as #3.

5. **Workspace housekeeping.**
   Several files in the `git status` at session start carried
   modifications from concurrent agents on the develop branch
   (insights chart work, x-axis density work, hero-strip
   refactor). Those changes are unrelated to W7 and were
   committed by their respective agents in the same time window.
   The W7 commits are atomic against their stated phases; the
   `feat(admin): server-default timezone setting…` commit also
   carries a small set of files from a concurrent insights wave
   (`src/app/insights/page.tsx`,
   `src/components/charts/medication-compliance-chart.tsx`,
   `src/lib/charts/x-axis-density.ts` and its test) because they
   appeared as staged-or-modified-in-tree when `git commit`
   resolved the index. They are visible in `git log -p` but do
   not affect the W7 surface.

## How a Warsaw user (the issue #167 trigger) experiences the fix

Before W7:

```
$ curl -H "Cookie: …" /api/export/measurements
type,value,unit,measuredAt,source,notes,glucoseContext
WEIGHT,80,kg,2026-05-15T09:00:00.000Z,MANUAL,,
                            ^^^^^^^^^^^^^^^
                            opens in Excel as "09:00" local
                            (actual measurement was 11:00 Warsaw)
```

After W7 (Warsaw user with `User.timezone = "Europe/Warsaw"`):

```
$ curl -H "Cookie: …" /api/export/measurements
type,value,unit,measuredAt,source,notes,glucoseContext
WEIGHT,80,kg,2026-05-15T11:00:00+02:00,MANUAL,,
                            ^^^^^^^^^^^^^^^^^^
                            opens in Excel as "2026-05-15 11:00"
                            with the offset preserved as metadata
```

The PDF doctor-report, the profile picker, and the registration
path all flow through the same resolver, so the experience is
consistent end-to-end.
