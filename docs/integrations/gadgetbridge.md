# Gadgetbridge import

[Gadgetbridge](https://gadgetbridge.org) runs fitness bands and watches on
Android without the vendor's cloud. HealthLog reads the database
Gadgetbridge exports and folds it into the same timeline as every other
source. Rows from this path carry the source `IMPORT`.

## 1. Export on the phone

In Gadgetbridge open **Settings → Data management → Export database**.
Gadgetbridge writes one file named `Gadgetbridge` (a SQLite database, no
extension) into its export folder. Move it to the computer or phone you use
HealthLog on. The file is not encrypted, so treat it like any other export
of your health data.

## 2. Upload to HealthLog

Open **Settings → Export & Import** and choose the file on the
**Gadgetbridge database** card. The endpoint is
`POST /api/import/gadgetbridge` (`multipart/form-data`, field `file`):

- at most **512 MB**, checked against the declared length and again while
  the body streams to disk;
- five uploads a minute per account, one import per account at a time
  (any kind);
- uploading the same bytes again returns the earlier job instead of
  importing twice. A failed job never blocks a retry.

`GET /api/import/gadgetbridge/status` answers the latest job. The card
polls it while the import runs.

## 3. What is read

Gadgetbridge generates one table per device family and adds tables and
columns with each release, so the importer does not rely on a fixed list.
It finds tables by the shape of their name and looks columns up by name:

| Gadgetbridge table                         | HealthLog                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `*_ACTIVITY_SAMPLE` (`TIMESTAMP`, `STEPS`) | `ACTIVITY_STEPS`, one total per local day. With two devices on one day the device with the most steps counts. |
| the same, `HEART_RATE`                     | `PULSE`, one mean per local hour, from readings between 30 and 220 bpm (0, -1 and 255 mean "no reading").     |
| `*_SPO2_SAMPLE` (`SPO2`)                   | `OXYGEN_SATURATION`, one row per reading                                                                      |
| `*HEART_RATE_RESTING*` (`HEART_RATE`)      | `RESTING_HEART_RATE`                                                                                          |
| `*HEART_RATE_MANUAL*` (`HEART_RATE`)       | `PULSE`, one row per spot reading                                                                             |
| `*SLEEP*` (`TIMESTAMP`, `WAKEUP_TIME`)     | `SLEEP_DURATION` in minutes, one row per night at wake-up                                                     |
| `*WEIGHT*` (`WEIGHT_KG`)                   | `WEIGHT`                                                                                                      |

Timestamps in seconds and in milliseconds are both read; the importer
tells them apart per table. Values outside HealthLog's plausible range for a
type are refused and counted.

Every other table that holds rows (stress, PAI, workouts, battery, the
device's own bookkeeping) is listed under **Not imported** with its row
count, so you can see what the file had that HealthLog did not read.

## 4. Running it again

Each row is written under a stable identity: the day or hour for a total,
the table, device and instant for a single reading. Importing the same file
again writes nothing new. A later export of the same phone replaces a day's
step total or an hour's mean when it holds a different value (it has seen
more of that day); a reading you deleted in HealthLog stays deleted.

## 5. Limits and safety

- The file is opened read-only, as untrusted input: SQLite's `immutable`
  flag, `trusted_schema=OFF`, `query_only`, no memory map. A view in place of
  a sample table refuses the whole file.
- A run has a ten-minute budget. A run that reaches it keeps what it wrote,
  and the job fails with "time limit": upload the same file again and the
  import continues where the identities already landed.
- The uploaded file is deleted when the job ends, whatever the outcome. The
  audit log records the upload's size and hash and nothing from inside it.
- A ZIP export ("Export data" with files) is not read. Upload the database
  file on its own.
