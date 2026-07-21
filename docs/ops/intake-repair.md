# Medication intake repair

`scripts/repair-intake-anomalies.ts` repairs the known historic defects in
the medication intake ledger (`medication_intake_events`) and its schedule
metadata (`medication_schedules`):

1. **Duplicate dose-slot rows.** More than one live row on the same exact
   `(user, medication, scheduled_for)` tuple — cross-source duplicates the
   pre-v1.15.19 write path could mint (e.g. a pending REMINDER row plus a
   taken API row for the same slot). The duplicate inflates the per-day
   scheduled count and paints a phantom entry in the history view.
2. **Implausible `taken_at`.** Live rows whose `taken_at` lands more than
   7 days before `scheduled_for` or more than 1 day in the future —
   typically the residue of a mis-attributed edit before the v1.15.19
   `taken_at` validation landed.
3. **Window / times drift (v1.16.1).** Schedule rows whose legacy
   `window_start` / `window_end` no longer contains the canonical
   `times_of_day` — typically a degenerate `07:00 / 07:00` point window
   left behind by an old write path while the dose times moved on (e.g.
   to `09:00 / 21:00`). The dose-band model never reads the window once
   `times_of_day` exists, but the stale pair kept feeding every legacy
   read (the pre-v1.16.1 cards painted "next intake 07:00" from it).
4. **Stale-anchor pending rows (v1.16.1).** Live pending rows
   (`taken_at IS NULL`, not skipped, not auto-missed) whose
   `scheduled_for` wall-clock HH:mm — evaluated in the user's timezone —
   matches no current dose anchor of the medication (any schedule's
   `times_of_day` entry; `window_start` for legacy rows without times).
   These are reminder-minted slots on retired schedule times that linger
   as phantom open doses in the ledger.

## When to use it

- After upgrading to v1.15.19+, when a user reports a compliance rate above
  100 %, duplicate entries in the medication history, or a dose shown as
  taken days away from its slot.
- The compliance rollup counts DISTINCT slots since v1.15.19, so the
  percentages self-correct on recompute even without running this script.
  Running it additionally clears the phantom rows from the history view.
- The `intake-slot-dedup` worker already collapses canonical-slot
  duplicates at boot and on a daily cron; this script is the manual,
  immediately-observable fallback and the only path that surfaces the
  implausible-`taken_at` rows.

## Run a dry-run first

Always. The default mode only reports and never mutates:

```bash
# inside the production app container — DATABASE_URL is inherited
healthlog-tsx scripts/repair-intake-anomalies.ts

# scoped to one account
healthlog-tsx scripts/repair-intake-anomalies.ts --user <userId>

# source-checkout equivalent
pnpm dlx --package pg --package tsx tsx scripts/repair-intake-anomalies.ts
```

The script is self-contained: its only import is `pg` and it reads
`DATABASE_URL` straight from the environment (no dotenv, no `@/` path
alias, no `src/` imports). The production image provides the pinned
`healthlog-tsx` launcher and resolves `pg` from its standalone runtime tree
without retaining a package manager. In a source checkout, `pg` resolves from
the project `node_modules`; `pnpm dlx --package pg --package tsx ...` also
works in an environment where neither dependency is installed.

The dry-run prints every duplicate group (which row would be kept, which
would be tombstoned), a table of implausible rows (id, medication,
`scheduledFor`, `takenAt`, source, timestamps), every schedule whose
window has drifted off its `times_of_day` (with the reconciled bounds it
would write), and a table of stale-anchor pending rows.

## Applying the fix

```bash
healthlog-tsx scripts/repair-intake-anomalies.ts --fix
```

`--fix` does five things:

- **Duplicate groups** are collapsed to one winner per slot. Precedence:
  an actioned row (taken or skipped) beats a pending one; between two
  taken rows the earlier `taken_at` wins; ties break deterministically on
  `created_at`, then `id`. Losers are soft-deleted (`deleted_at` set,
  `sync_version` incremented) — the same tombstone shape the delete route
  writes, so connected clients drop the rows on their next delta-sync.
  Nothing is ever hard-deleted.
- **Implausible `taken_at` rows are NOT touched.** The recorded intent is
  unknowable, so the operator (or the user) corrects or deletes them in
  the medication history tab. To soft-delete them wholesale instead, opt
  in explicitly:

  ```bash
  healthlog-tsx scripts/repair-intake-anomalies.ts --fix --tombstone-implausible
  ```

  `--tombstone-implausible` is refused without `--fix`.

- **Drifted schedule windows are reconciled** to
  `min/max(times_of_day)` so the legacy pair stops contradicting the
  canonical dose times. Overnight windows (`window_end < window_start`)
  encode a deliberate wrap and are never touched.
- **Stale-anchor pending rows are tombstoned** (same soft-delete shape
  as the duplicate losers). A medication without any derivable anchor
  (PRN-only / unscheduled) is skipped — there is nothing to compare
  against.
- **Affected compliance rollups are recomputed** for every touched
  `(user, medication, day)`. The script executes the same DISTINCT-slot
  aggregation SQL the shared helper runs (a verbatim twin of
  `recomputeMedicationComplianceForDay` in
  `src/lib/rollups/medication-compliance-rollups.ts` — kept inline so
  the script needs no app imports), so the scheduled/taken counts and
  the rate self-correct immediately.

The script is idempotent: a second `--fix` run finds zero duplicate groups
and changes nothing. Exit code is 0 on success (including a clean
zero-findings run), non-zero on bad arguments or a fatal error.

## Era backfill (`--backfill-eras`, v1.16.3)

Schedule edits made before v1.16.3 replaced the schedule rows without
archiving the old state, so history reads past days against the current
times. Section 5 of the script infers the lost era from the recorded
slot anchors:

- A medication qualifies when its anchor-shaped rows (user-tz `HH:mm` on
  a 5-minute grid) deviate from the **current** `times_of_day` for at
  least 7 consecutive recorded days before the current times first
  appear, and it has **no** existing `medication_schedule_revisions`
  row (re-runs are idempotent).
- The proposal is one revision row: `valid_from` = the first deviating
  row's instant, `valid_until` = local midnight of the first day on the
  current times, payload = one `FREQ=DAILY` schedule carrying the
  observed old times.
- A `starts_on` that postdates the first recorded row is flagged and
  pulled back to that row's instant.

The default run only **reports** the proposals. Apply them explicitly:

```bash
healthlog-tsx scripts/repair-intake-anomalies.ts --backfill-eras
```

Review the dry-run table first — the inference is a heuristic. A wrongly
created revision can be deleted from `medication_schedule_revisions`
without side effects (the read paths fall back to live-only minting).
