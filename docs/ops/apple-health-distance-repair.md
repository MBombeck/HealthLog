# Apple Health walking-distance repair

`scripts/repair-apple-health-distance.ts` heals walking distances that the
`export.zip` import stored a thousand times too small.

## The defect

Apple stamps every quantity `<Record>` in an `export.xml` with the account's
own display unit: a metric archive reports `HKQuantityTypeIdentifierDistance-
WalkingRunning` in `km`, an imperial one in `mi`. Until this release the record
mapping accepted that attribute and never read it, so the day's total was
folded as if the number were already metres. A 2.484 km day landed as
`2.484 m`, and an imported decade reads as a couple of metres walked. The
workout path was never affected — it converted its own distance unit.

The code fix converts the record's unit before storage, so every import from
this release on is correct. This script is for the rows already in the
database.

## Prefer a re-import

If the account still has its `export.zip`, **re-import it**. The archive fold
UPSERTs the same `stats:<identifier>:<day>` rows, so a re-import on the fixed
build rewrites every affected day with the right number, needs no flags, and
also repairs rows this script deliberately leaves alone (see the criterion
below). The script exists for accounts that no longer have the archive.

**An account that has been re-imported must not then be repaired.** The
re-import already fixed it. Its rows keep the same `EXPORT_XML_SOURCE_MAX`
stamp and the same `stats:` external id, and they carry no audit row, so the
criterion selects them exactly as it selects a broken account — the stamp
proves where a row came from, not which build imported it. Multiplying them
again turns a 2.484 km day into 2484 km. The script refuses such an account on
its own (any day whose value would leave the plausible range after the
multiply stops the whole account), but that guard fires on the big days: keep
the two apart yourself before you type `--apply`.

## Which rows it touches

Only rows carrying the stamp the archive importer itself writes:

| Column                   | Value                                                        |
| ------------------------ | ------------------------------------------------------------ |
| `type`                   | `WALKING_RUNNING_DISTANCE`                                   |
| `source`                 | `APPLE_HEALTH`                                               |
| `aggregation_provenance` | `EXPORT_XML_SOURCE_MAX`                                      |
| `external_id`            | `stats:HKQuantityTypeIdentifierDistanceWalkingRunning:<day>` |
| `deleted_at`             | `NULL`                                                       |

`EXPORT_XML_SOURCE_MAX` is written in exactly one place in the tree — the
archive fold — and the `stats:` external id is minted for that same fold, so
the pair is a proof of origin rather than a guess. Nothing is ever selected
because a value "looks too small".

Deliberately out of scope:

- Rows a native iOS sync has since overwritten (`HEALTHKIT_STATISTICS`): their
  value came from HealthKit's own statistics query and is correct.
- Rows whose provenance is `LEGACY_UNKNOWN` or NULL: an archive origin cannot
  be proven for them. Re-import the archive to repair those.

## Run a dry-run first

Always, and read it. The dry run is where the decision is made, not a
formality in front of a decision already taken: it is the only place the
script shows you real numbers from the account before it changes them. If the
worked example does not match what that person's Health app shows for that day,
the run is wrong and `--apply` will make it permanent.

The default mode reports and never writes:

```bash
# from a source checkout, with DATABASE_URL pointing at the instance
pnpm dlx tsx scripts/repair-apple-health-distance.ts
```

It prints one line per account: how many rows would be repaired, the date span
they cover, one worked example (`2.484 m -> 2484 m`), and any row whose
repaired value would leave the plausibility range.

This script imports the application dependency graph, so it runs from a source
checkout, not through the production image's `healthlog-tsx` launcher.

## Name the archive's unit

The stored row keeps no record of the unit its archive was written in — that
is the defect — so the operator names it. `--unit=km` is the default and is
what the Health app writes in every metric locale; pass `--unit=mi` for an
imperial archive:

```bash
pnpm dlx tsx scripts/repair-apple-health-distance.ts --unit=mi
```

Check the dry-run's worked example against what the account's Health app shows
for that day before applying. If the two units are mixed across accounts, run
the script once per unit with `--apply` and confirm each account's example
first.

## Apply

Take a backup first — `docs/ops/backup-restore.md`. The multiply is in place
and has no reverse operation: once an account is written wrong, the database
copy you took beforehand is the only way back.

```bash
pnpm dlx tsx scripts/repair-apple-health-distance.ts --apply
```

Per account, in one transaction: every selected row multiplied by the unit's
metre factor, `sync_version` incremented and `updated_at` bumped so paired iOS
clients pick the rows up on their next delta sync, and an audit row
(`measurement.apple_health_distance.repaired`) recording the unit, the factor
and the row count. The DAY/WEEK/MONTH/YEAR rollups and the cached status
insights for the touched days are recomputed afterwards.

A row whose repaired value would leave the plausible range (0–200 000 m)
refuses the **whole account**: nothing is written, the offending rows and the
reason are printed, and the run moves on to the next account. One such row is
evidence the account is not the 1000x class — a re-imported account looks
exactly like this — and repairing the rest of it would multiply days that were
already right.

## It runs once per account

The audit row is written inside the same transaction as the update, and an
account that carries it is skipped. A second run reports the account as already
repaired and changes nothing, so the multiplier can never be applied twice.

## Verify

```sql
SELECT date_trunc('year', measured_at) AS year,
       round(avg(value)) AS avg_metres_per_day
  FROM measurements
 WHERE user_id = '<userId>'
   AND type = 'WALKING_RUNNING_DISTANCE'
   AND aggregation_provenance = 'EXPORT_XML_SOURCE_MAX'
 GROUP BY 1 ORDER BY 1;
```

A plausible daily average is thousands of metres. Single digits mean the rows
were not repaired; millions mean a factor was applied twice, which the audit
row is there to prevent.
