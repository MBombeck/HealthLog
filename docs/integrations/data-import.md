# Data import

HealthLog has four ways to bring data in, all reachable from
**Settings → Export & Import**:

1. An **Apple Health `export.zip`** upload — the full archive from the
   iPhone Health app, parsed server-side. See
   [`apple-health.md`](./apple-health.md) for the end-to-end walkthrough,
   the HealthKit type mapping, and the streaming / idempotency model.
2. A **generic JSON import** — a small, explicit payload of measurements
   and mood entries, useful for restoring a partial export or migrating
   from another tracker. This page documents that format.
3. A **CSV import** — one measurement per row, for a spreadsheet or a
   meter / sensor export. Documented in section 3 below.
4. A **medication dose-history import** — its own card in the same
   panel, posting to `POST /api/medications/intake/dose-history-import`
   with its own `?dryRun=1` preview.

All paths skip rows that already exist, so re-running an import is
safe — it merges rather than duplicating.

Documents (letters, lab reports, scans) from Paperless-ngx or Papra come in
through a document token and an import script instead; see
[`document-import.md`](./document-import.md).

Every import reports what it actually wrote. A file where nothing was
written is shown as a failure, a file where some rows landed and some
were refused is shown as a partial result, and the refused rows are
grouped by reason so one bad column reads as one line rather than a
scroll.

## 1. Apple Health `export.zip`

On the iPhone: **Health app → profile picture → Export All Health
Data**, then move the resulting `export.zip` somewhere you can reach
from a browser. In HealthLog open **Settings → Export & Import** and drop
the archive onto the Apple Health control (or click to pick it). The
upload streams to the server — a multi-gigabyte archive never buffers in
the browser — and a background job parses it while a progress indicator
polls for the imported / skipped counts.

Re-uploading the same archive resolves to the same job by content hash,
so it merges instead of creating duplicates. ECG CSVs and metric-typed
clinical records are imported too; see
[`apple-health.md`](./apple-health.md) for the details and the full
type mapping.

## 2. Generic JSON import

`POST /api/import` accepts a single JSON object with two optional
arrays:

```json
{
  "measurements": [/* … */],
  "moodEntries": [/* … */]
}
```

Each array holds at most **10 000** entries. The endpoint is rate-limited
to **5 imports per hour per account**. Existing rows (matched on the
type + timestamp uniqueness, or on `externalId` for mood entries) are
skipped and counted under `skipped` in the response.

### Measurement entry

| Field            | Required | Type   | Notes                                                                                                                                                           |
| ---------------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`           | yes      | enum   | One of the `MeasurementType` values in the table below.                                                                                                         |
| `value`          | yes      | number | Plausibility-checked per type; out-of-range values are rejected.                                                                                                |
| `unit`           | yes      | string | The canonical unit for the type (see the table).                                                                                                                |
| `measuredAt`     | yes      | string | ISO-8601 datetime, e.g. `2026-05-01T08:00:00.000Z`.                                                                                                             |
| `source`         | no       | string | Free-text origin label. Imported rows are tagged `IMPORT` server-side regardless.                                                                               |
| `notes`          | no       | string | Optional free text.                                                                                                                                             |
| `glucoseContext` | no       | enum   | Only for `BLOOD_GLUCOSE`. See [Glucose context](#glucose-context).                                                                                              |
| `externalId`     | no       | string | A source-stable id (1–120 chars). When present, a re-import upserts on `(user, type, source, externalId)` so an edit upstream is reflected rather than skipped. |

### Glucose context

`glucoseContext` is one of `FASTING`, `POSTPRANDIAL`, `RANDOM`,
`BEDTIME`, and it is genuinely optional on a `BLOOD_GLUCOSE` row. Leave
it out (JSON) or leave the cell blank (CSV) and the reading is stored
with no context.

That is the normal case for a continuous sensor or meter export, which
records a value and a timestamp per reading and classifies nothing. A
reading with no context still counts everywhere a reading counts: the
chart, the all-time summary, and the trailing-30-day clinical panel
(time in range, GMI, CV%, estimated A1c) are all context-agnostic. It is
left out only of the per-context breakdowns — the doctor report's
fasting / post-meal rows, the matching FHIR observations, the per-context
targets — because no classification was recorded and none is invented.

Setting the column on any type other than `BLOOD_GLUCOSE` is rejected.
Setting it to a value outside the four above is rejected. Entering a
reading by hand in the app still asks for a context, because at that
moment you know it.

### Mood entry

| Field        | Required | Type    | Notes                                                                                                                                                     |
| ------------ | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date`       | yes      | string  | `YYYY-MM-DD`.                                                                                                                                             |
| `mood`       | yes      | enum    | One of `SUPER_GUT`, `GUT`, `OKAY`, `SCHLECHT`, `LAUSIG`.                                                                                                  |
| `score`      | yes      | integer | `1`–`5`.                                                                                                                                                  |
| `tags`       | no       | string  | Comma-separated tags.                                                                                                                                     |
| `loggedAt`   | no       | string  | ISO-8601 datetime; defaults to the start of the given `date` in the default timezone.                                                                     |
| `externalId` | no       | string  | A source-stable id (1–120 chars). When present, a re-import upserts on `(user, source, externalId)` so an edit upstream is reflected rather than skipped. |

### `MeasurementType` values and canonical units

Storage is always in the canonical unit listed here; the UI converts for
display per the user's preference. Event-class types record a single
fired event (`value` is `1`) and are normally produced by a device, not
hand-authored.

| Type                            | Canonical unit       |
| ------------------------------- | -------------------- |
| `WEIGHT`                        | kg                   |
| `BLOOD_PRESSURE_SYS`            | mmHg                 |
| `BLOOD_PRESSURE_DIA`            | mmHg                 |
| `PULSE`                         | bpm                  |
| `RESTING_HEART_RATE`            | bpm                  |
| `WALKING_HEART_RATE_AVERAGE`    | bpm                  |
| `AVERAGE_HEART_RATE`            | bpm                  |
| `MAX_HEART_RATE`                | bpm                  |
| `CARDIO_RECOVERY`               | bpm                  |
| `HEART_RATE_VARIABILITY`        | ms (SDNN)            |
| `HRV_RMSSD`                     | ms (RMSSD)           |
| `RESPIRATORY_RATE`              | count/min            |
| `OXYGEN_SATURATION`             | percent (0–100)      |
| `BLOOD_GLUCOSE`                 | mg/dL                |
| `BODY_FAT`                      | percent (0–100)      |
| `FAT_MASS`                      | kg                   |
| `FAT_FREE_MASS`                 | kg                   |
| `LEAN_BODY_MASS`                | kg                   |
| `MUSCLE_MASS`                   | kg                   |
| `BONE_MASS`                     | kg                   |
| `TOTAL_BODY_WATER`              | kg                   |
| `VISCERAL_FAT`                  | rating               |
| `BODY_MASS_INDEX`               | kg/m²                |
| `BODY_TEMPERATURE`              | °C (core)            |
| `SKIN_TEMPERATURE`              | °C (dermal spot)     |
| `WRIST_TEMPERATURE`             | °C (overnight wrist) |
| `SLEEP_DURATION`                | minutes              |
| `SLEEP_NEED`                    | minutes              |
| `SLEEP_PERFORMANCE`             | percent (0–100)      |
| `SLEEP_EFFICIENCY`              | percent (0–100)      |
| `SLEEP_CONSISTENCY`             | percent (0–100)      |
| `SLEEP_DISTURBANCE_COUNT`       | count                |
| `BREATHING_DISTURBANCES`        | count                |
| `ACTIVITY_STEPS`                | count                |
| `FLIGHTS_CLIMBED`               | count                |
| `WALKING_RUNNING_DISTANCE`      | metres               |
| `SIX_MINUTE_WALK_DISTANCE`      | metres               |
| `WALKING_STEP_LENGTH`           | metres               |
| `WALKING_SPEED`                 | m/s                  |
| `STAIR_ASCENT_SPEED`            | m/s                  |
| `STAIR_DESCENT_SPEED`           | m/s                  |
| `WALKING_STEADINESS`            | percent (0–100)      |
| `WALKING_ASYMMETRY`             | percent (0–100)      |
| `WALKING_DOUBLE_SUPPORT`        | percent (0–100)      |
| `ACTIVE_ENERGY_BURNED`          | kcal                 |
| `ENERGY_EXPENDITURE_KJ`         | kJ                   |
| `VO2_MAX`                       | mL/(kg·min)          |
| `PULSE_WAVE_VELOCITY`           | m/s                  |
| `VASCULAR_AGE`                  | years                |
| `FALL_COUNT`                    | count                |
| `AUDIO_EXPOSURE_ENV`            | dBA                  |
| `AUDIO_EXPOSURE_HEADPHONE`      | dBA                  |
| `TIME_IN_DAYLIGHT`              | minutes              |
| `RECOVERY_SCORE`                | score (0–100)        |
| `STRESS_SCORE`                  | score (0–100)        |
| `STRAIN_SCORE`                  | score (0–100)        |
| `DAY_STRAIN`                    | score (0–21)         |
| `WORKOUT_STRAIN`                | score (0–21)         |
| `AUDIO_EXPOSURE_EVENT`          | count (event)        |
| `IRREGULAR_RHYTHM_NOTIFICATION` | event                |
| `HIGH_HEART_RATE_EVENT`         | event                |
| `LOW_HEART_RATE_EVENT`          | event                |
| `WALKING_STEADINESS_EVENT`      | event                |
| `BREATHING_DISTURBANCE_EVENT`   | event                |

The table is a curated subset and lags the enum by a few
device-derived types. The live, machine-readable list of writable
types and their units is served by `GET /api/meta/capabilities` under
`ingest.quantityTypes` and is the authoritative source.

### Worked example

The **Download example** button in **Settings → Export & Import** mints
exactly this payload, which is a valid import body:

```json
{
  "measurements": [
    {
      "type": "WEIGHT",
      "value": 80.5,
      "unit": "kg",
      "measuredAt": "2026-05-01T08:00:00.000Z",
      "source": "manual",
      "notes": "morning"
    },
    {
      "type": "BLOOD_PRESSURE_SYS",
      "value": 120,
      "unit": "mmHg",
      "measuredAt": "2026-05-01T08:05:00.000Z"
    },
    {
      "type": "BLOOD_PRESSURE_DIA",
      "value": 80,
      "unit": "mmHg",
      "measuredAt": "2026-05-01T08:05:00.000Z"
    }
  ],
  "moodEntries": [
    {
      "date": "2026-05-01",
      "mood": "GUT",
      "score": 4,
      "tags": "work,exercise"
    }
  ]
}
```

The response is a count envelope:

```json
{
  "data": { "measurements": 3, "moodEntries": 1, "skipped": 0 }
}
```

## 3. CSV import

`POST /api/import/csv` takes the raw file as `text/csv` — one measurement
per row, no JSON wrapper. The **CSV file** control in
**Settings → Export & Import** posts to it, and **Download example**
mints a file with the right header.

A header row is required; column order does not matter and header
matching is case-insensitive.

| Column           | Required | Notes                                                                                                                                                                                            |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`           | yes      | A `MeasurementType` from the table above.                                                                                                                                                        |
| `value`          | yes      | A number, in the row's `unit`.                                                                                                                                                                   |
| `unit`           | yes      | The canonical unit, or a recognised alias: `mmol/L` → `mg/dL`, `lb` → `kg`, `in` → `cm`, `°F` → `°C`.                                                                                            |
| `measuredAt`     | yes      | ISO-8601 **with an explicit offset** (`Z` or `±HH:MM`, and `±HHMM` is accepted). No offset, no import.                                                                                           |
| `glucoseContext` | no       | Only for `BLOOD_GLUCOSE`; blank means no context. See [Glucose context](#glucose-context).                                                                                                       |
| `notes`          | no       | Free text, up to 200 characters.                                                                                                                                                                 |
| `externalId`     | no       | A source-stable id. With it, a re-upload updates the same row even when the value changed; without it, an identical re-upload is skipped via the natural key `(user, type, measuredAt, source)`. |

A sensor export therefore needs no glucose column at all:

```csv
type,value,unit,measuredAt,glucoseContext,notes,externalId
BLOOD_GLUCOSE,5.3,mmol/L,2024-04-03T13:15:00+1100,,,sensor-1
BLOOD_GLUCOSE,5.9,mmol/L,2024-04-03T13:30:00+1100,,,sensor-2
```

Limits: 16 MB per upload, 10 000 valid rows per import, 5 imports per
hour (shared with the JSON import). `?dryRun=1` validates and previews
without writing anything — the **Preview** button uses it.

The response carries per-row outcomes alongside the counts, and the card
renders the counts, not the status code: rows written and none skipped is
a success, a mixed result is a warning, and nothing written is a failure
with the reasons grouped by count.

## Converting a CSV into the import JSON

The CSV import above covers measurements. Mood entries have no CSV
route, so a mood history still goes through the JSON payload.

A spreadsheet export is the most common starting point. The shape is
small enough to convert by hand for a few rows, or with a one-off script
for many. The steps are the same either way:

1. **One CSV per concept.** Keep measurements and mood in separate
   sheets — they map to the two arrays. A blood-pressure reading is two
   measurement rows (`BLOOD_PRESSURE_SYS` and `BLOOD_PRESSURE_DIA`) that
   share a `measuredAt`.
2. **Pick the `type`.** Map each CSV column to a `MeasurementType` from
   the table above. A "Weight (kg)" column becomes `type: "WEIGHT"`,
   `unit: "kg"`.
3. **Normalise the unit.** Convert each value into the canonical unit
   before writing it — e.g. pounds → kg, hours of sleep → minutes,
   `mmol/L` glucose → `mg/dL`. The importer rejects values outside the
   plausible range for the type, which catches most unit mistakes.
4. **Format the timestamp.** Turn the CSV date/time column into an
   ISO-8601 `measuredAt` (mood uses a `YYYY-MM-DD` `date`). Include the
   timezone offset (`Z` for UTC) so the reading lands on the right day.
5. **Emit the two arrays.** Collect the rows into `measurements` and
   `moodEntries` as shown above and paste the result into the JSON
   import control, or upload it as a `.json` file. Keep each array under
   10 000 entries; split a larger history across runs (5 per hour).

Because the import is idempotent on the unique constraints, you can
re-run a corrected file over a partial one without creating duplicates.
