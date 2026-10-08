# Health Connect import

HealthLog reads the export file of Android's Health Connect and folds
it into the same timeline as every other source. There is no Android
app and no live sync: you export from the phone, upload the file, and
a background job imports it. Rows from this path carry the source
`HEALTH_CONNECT`.

## What you need

- An Android phone with Health Connect and its export feature. The
  export arrived with Android 15 and reaches Android 14 through a
  system update; if you do not see it, update Health Connect first.
- A cloud storage app on the phone (Google Drive, Dropbox, Nextcloud
  or any other app that offers itself as a storage location). Health
  Connect refuses to save its export to the phone's own storage or the
  Downloads folder, so the file always goes through a cloud first.
- A HealthLog account in a browser. The upload uses your normal
  session; there is no token to create.

## 1. Export on the phone

1. Open Health Connect (in the system settings, or the Health Connect
   app).
2. Go to **Manage data**, then **Export and import**, then
   **Scheduled export** or **Export now**, depending on the version.
3. Pick the cloud storage app as the destination. You can choose how
   often Health Connect exports again; HealthLog only ever reads the
   file you upload.

The result is a ZIP file named `Health Connect.zip` with a single
entry, `health_connect_export.db`. That entry is a copy of the phone's
Health Connect database (a SQLite file). Health Connect does not
encrypt it, so treat the file like any other export of your health
data.

## 2. Upload to HealthLog

Download the ZIP from the cloud to the computer or phone you use
HealthLog on, open **Settings → Export & Import** and drop the file
onto the **Health Connect export** card.

The endpoint is `POST /api/import/health-connect-export`
(`multipart/form-data`, field `file`). It:

1. Allows three uploads per minute per account.
2. Refuses anything above **1 GiB**, once against the declared
   `Content-Length` and again while the body streams to disk.
3. Streams the body to a temp file and hashes it with SHA-256 on the
   way. Uploading the same bytes again returns the earlier job
   (`idempotent: true`) instead of importing twice; a failed job never
   blocks a retry.
4. Runs one import per account at a time, Apple Health and Health
   Connect together. A second upload while one runs answers `409` and
   the file is discarded.
5. Records the upload's size and hash in the audit log, and nothing
   from inside the file.

`GET /api/import/health-connect-export/status` answers the account's
latest Health Connect job, or `null`. The card polls it while a job
runs.

## 3. What the import does

The worker extracts `health_connect_export.db` (at most 4 GiB, with
the same zip-bomb checks as the Apple Health importer) and opens it
read-only. The file is treated as untrusted input:

- It is opened with SQLite's `immutable` flag, so a database last
  written in WAL mode opens without its `-wal` and `-shm` files, and
  nothing is ever written next to it.
- Views, triggers and generated columns in the file cannot call
  functions with side effects (`trusted_schema=OFF`), and a view in
  place of one of the record tables refuses the whole file.
- Columns are looked up by name. Health Connect adds columns as its
  schema version moves, so their order differs between phones.
  Database versions below 9 are refused; versions above 27 (the newest
  known when this was written) are read, with a warning on the job.
  A table that lacks a column the importer needs is skipped and named
  in the job's `warnings`.

### What becomes what

| Health Connect                                                 | HealthLog                                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Weight, lean body mass (grams)                                 | `WEIGHT`, `LEAN_BODY_MASS` in kg                                                                                           |
| Body fat                                                       | `BODY_FAT` in %                                                                                                            |
| Blood pressure                                                 | `BLOOD_PRESSURE_SYS` and `BLOOD_PRESSURE_DIA`, one pair per reading                                                        |
| Resting heart rate, heart-rate variability (RMSSD)             | `RESTING_HEART_RATE`, `HRV_RMSSD`                                                                                          |
| Oxygen saturation, respiratory rate, body temperature, VO2 max | the matching types                                                                                                         |
| Blood glucose (mmol/L)                                         | `BLOOD_GLUCOSE` in mg/dL, fasting and after-meal context kept                                                              |
| Heart rate                                                     | per minute for the last 90 days; older history as hourly means with the hour's minimum and maximum                         |
| Steps, active calories, distance                               | one total per day                                                                                                          |
| Sleep sessions and stages                                      | one row per stage; light sleep becomes core sleep, both awake stages awake time; a session without stages counts as asleep |
| Exercise sessions                                              | workouts, with the Health Connect exercise type kept on the workout                                                        |
| Menstruation flow and periods                                  | cycle day logs (needs cycle tracking switched on)                                                                          |
| Hydration and vitamins and minerals                            | daily nutrient totals (needs the Nutrients module)                                                                         |

Left out on purpose: food energy and macronutrients, exercise routes,
planned workouts, Health Connect's access logs, the "out of bed" sleep
stage, and an "unknown" sleep stage inside a session that also has real
stages.

### When several apps write the same thing

The export holds every app's data side by side. Summing them would
count a step the phone and the watch both saw twice, so:

- A day total (steps, calories, distance, water, nutrients) comes from
  one app per day: the first one your Health Connect app priority
  list names for that category, otherwise the app with the largest
  total.
- Heart rate comes from one app per hour, by the same rule.
- Of two overlapping sleep sessions or workouts from different apps,
  the one from the higher-ranked app is kept.
- Two apps writing the same type at the same instant keep the
  higher-ranked app's value.

### Apps HealthLog already connects to

If your account has the Withings, Fitbit, Google Health, Oura, Polar
or WHOOP integration connected, that app's records in the export are
left out: HealthLog already receives them directly, and importing them
again would put every reading in twice. As a further safety net, a
reading that matches one already stored under another source (same
type and value within two seconds) is left out too. The job result
lists how many records each app contributed and which apps were left
out.

### Importing again

Every row is keyed by the record's Health Connect ID (`hc:<uuid>`),
day totals and hourly means by their `stats:` ID. Importing the same
export again writes nothing; a newer export that overlaps an older one
adds only what is new. A value that changed on the phone is updated;
a value you deleted in HealthLog stays deleted.

Heart rate imported per minute ages the way Apple Health heart rate
does: once a minute is older than 90 days, the nightly pass folds its
hour into one hourly mean and removes the minutes. A later import of
an export that still holds those minutes leaves them out, so an hour
is never counted twice.

## Privacy

- The uploaded ZIP and the extracted database are deleted as soon as
  the job ends, whether it succeeded or failed. A periodic sweep
  removes anything a crash left behind.
- The job result holds counts only: per measurement type and per app.
  No value, no timestamp and no text from the file (notes, titles)
  is stored on the job.

## Operator notes

- The worker uses Node's built-in `node:sqlite` module. It needs no
  flag on Node 22 and prints one `ExperimentalWarning` per process.
- Memory stays bounded: the database is read in batches of 500 rows
  and aggregated inside SQLite, so what the import keeps alive does not
  grow with the length of the history. Measured under a 792 MB heap,
  one and three years of minute-by-minute heart rate peaked at about
  160 MB of heap in total.
- Split web and worker containers need a shared staging directory,
  exactly as for the Apple Health import.
- The status of a running job shows up under **Settings → Export &
  Import**; a job interrupted by a restart is marked failed by the
  same reconcile pass that watches Apple Health imports.
