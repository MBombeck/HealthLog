# Apple Health import

HealthLog accepts a full Apple Health `export.zip` upload and folds
the contents into the same timeline as every other ingest source.
The importer is streaming end-to-end — multi-gigabyte exports never
land in V8 heap — and idempotent on the upload's SHA-256 so
re-uploading the same archive merges instead of duplicating.

## What you need

- An iPhone with the Apple Health app and at least a few months of
  history (otherwise there is little to import).
- A HealthLog account on an instance you can reach from the device
  or from a workstation. The upload goes over your authenticated
  browser session — no separate API token to provision.
- Up to 1.5 GB of upload bandwidth. Apple's largest observed exports
  sit around 800 MB for a 10-year iCloud-synced account; the parser
  caps inbound bodies at 1.5 GB
  (`src/app/api/import/apple-health-export/route.ts:41`).

## 1. Generate `export.zip` on the iPhone

1. Open the **Health** app.
2. Tap the profile picture in the top-right.
3. Scroll to the bottom and tap **Export All Health Data**.
4. iOS spends a few minutes packaging the archive. When it finishes,
   share-sheet the resulting `export.zip` somewhere you can reach
   from your HealthLog instance — AirDrop to a workstation, save to
   iCloud Drive, send via email or any chat app you control.

The archive contains `apple_health_export/export.xml` (the canonical
record stream) plus a handful of auxiliary files (workout routes,
clinical records, electrocardiograms). The importer reads `export.xml`
and supported ECG CSVs under
`apple_health_export/electrocardiograms/`; unsupported auxiliary files
remain ignored.

## 2. Upload to HealthLog

Open **Settings → Export & Import** in the app and drop the
`export.zip` onto the Apple Health upload control (or click to pick the
file). The browser streams the body directly to the server; nothing is
buffered into memory on either side. A progress indicator polls the
job until it reports the imported / skipped counts.

The endpoint is `POST /api/import/apple-health-export`. The handler:

1. Rate-limits to **three uploads per minute per user** to protect
   against a flood of multi-gigabyte uploads
   (`src/app/api/import/apple-health-export/route.ts:43-46`).
2. Enforces the **1.5 GB cap** twice — once cheaply against the
   declared `Content-Length`, then a second time at the streaming
   sink so a missing/wrong header cannot bypass it.
3. Streams the body to a temp file at `/tmp/healthlog-apple-health-import-*`
   while computing a SHA-256 of the bytes inline.
4. Looks up any prior `ImportJob` row with the same `userId` +
   `uploadSha256`. **A re-upload of the same archive short-circuits to
   the previous job** instead of re-queueing — the response carries
   `idempotent: true` and the original `jobId`.
5. Otherwise creates a fresh `ImportJob` row in `queued`, enqueues
   the `apple-health-import` pg-boss job, and returns the new `jobId`.

The response body is `{ "jobId": "...", "status": "queued" }` with a
`202 Accepted`.

## 3. Poll the status endpoint

`GET /api/import/apple-health-export/{jobId}/status` returns the
canonical envelope:

```json
{
  "data": {
    "jobId": "clx123…",
    "status": "parsing",
    "startedAt": "2026-05-16T12:34:56.000Z",
    "completedAt": null,
    "uploadBytes": 412345678,
    "exportedAt": "2026-04-30T18:12:00.000Z",
    "progress": { "records_seen": 124000, "workouts_seen": 230 },
    "result": {
      "ecg": {
        "discovered": 2,
        "imported": 1,
        "updated": 0,
        "skipped": 0,
        "failed": 1
      }
    },
    "failureReason": null
  },
  "error": null
}
```

The lifecycle is `queued → unpacking → parsing → upserting → done`
with `failed` as a terminal-error branch
(`src/app/api/import/apple-health-export/[jobId]/status/route.ts:8-9`).
The iOS native client polls every two seconds while active and every
thirty seconds once the job is terminal; the web UI uses the same
cadence. Authorisation: only the job owner can read it. The admin
who kicked off an import via the admin variant can also read the row
they triggered.

## What gets imported

The parser folds four XML element types and supported auxiliary ECG
CSVs into the existing HealthLog schema (CHANGELOG v1.4.34):

| XML element        | Maps to                                | Notes                                                                                                                                                                         |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Record>`         | `Measurement` rows                     | One row per spot sample. Keyed by `HKMetadataKeyExternalUUID` when present, otherwise a deterministic `sample:<sha256-of-attributes>` fallback so re-imports stay idempotent. |
| `<Workout>`        | `Workout` rows                         | Activity type + duration + energy + distance.                                                                                                                                 |
| `<Correlation>`    | `Measurement` rows                     | Compound samples like blood pressure (systolic + diastolic) explode into their per-metric children.                                                                           |
| `<ClinicalRecord>` | `Measurement` rows where the type maps | Health-record FHIR snapshots; only the metric-typed fields are ingested.                                                                                                      |
| ECG CSV            | `EcgRecording` rows                    | The source-provided waveform is encrypted before persistence; descriptors and the device's classification are stored without diagnostic inference.                            |

The HK quantity types that map to HealthLog metric types live in
`src/lib/measurements/apple-health-mapping.ts`. Anything outside the
mapped set (for example workout routes) is counted as unsupported and
not stored.

Heart-rate variability comes in two measures, and they stay two types.
`HeartRateVariabilitySDNN` becomes `HEART_RATE_VARIABILITY`;
`HeartRateVariabilityRMSSD`, which iOS and watchOS 27 added, becomes
`HRV_RMSSD`, the same type WHOOP, Oura and Polar write. RMSSD readings
up to 300 ms are accepted. When both arrive, the HRV page charts each on
its own and the Coach reads them apart, because one is not a stand-in for
the other.

### ECG archive safety, privacy, and idempotency

ECG support is source-agnostic: if HealthKit includes a valid
`HKElectrocardiogram` CSV, HealthLog can import it regardless of which
compatible device originally wrote it. Archive member names are never
used as filesystem paths and ECGs are never extracted to plaintext
temporary files.

The auxiliary reader enforces limits before and during decompression:

- at most 20,000 total archive members and 2,000 ECG CSV members;
- at most 16 MiB per decompressed ECG CSV and 512 MiB across all ECG CSVs;
- at most a 200:1 declared compression ratio; and
- at most 2,000,000 waveform samples per recording.

Encrypted ZIP members, unsupported compression, unsafe or duplicate
paths, forged size metadata, malformed timestamps or samples, and
limit overruns are rejected. An ECG failure is fail-soft: valid
`export.xml` measurements and workouts still commit, while the
terminal result reports only
`discovered/imported/updated/skipped/failed` ECG counts. It never
returns filenames, source labels, sample values, or raw parser errors.

Waveforms are converted to integer microvolts and encrypted with the
existing AES-256-GCM ECG codec before the transaction writes an
`EcgRecording` with `source=APPLE_HEALTH`. Stable identity is derived
from normalized recording content rather than the CSV filename, so a
renamed re-export updates the same user-scoped row while distinct
recordings and different users remain independent. Known Apple
device classifications are preserved as source-reported facts;
unknown or localized classifications are stored as `null`. HealthLog
does not inspect the waveform to infer AFib or make a diagnosis.

### Cumulative HK type → daily aggregate

Cumulative quantity types — steps, active energy, walking/running
distance, flights climbed, time in daylight, and fall count — get
**collapsed into one estimated row per user-local day**. `export.xml`
contains source-specific records, not HealthKit's canonical daily
statistics, so the importer does not sum different devices or apps
into a source-blind total.

- Records are grouped by type, local day, and a SHA-256 hash of the
  available source name, source version, and device attributes.
  Values sum within each identified source-day; the largest
  source-day subtotal is selected deterministically. If every source
  attribute is absent, records remain separate rather than being
  trusted as one source. Raw source and device labels are not
  persisted.
- The row records `EXPORT_XML_SOURCE_MAX` provenance, its distinct
  contributor count, and the selected non-identifying source hash.
- External ID format: `stats:<HKType>:<YYYY-MM-DD>` (e.g.
  `stats:HKQuantityTypeIdentifierStepCount:2026-05-15`).
- The day boundary respects the user's timezone preference. The
  worker defaults to `Europe/Berlin` when no preference is set
  (`src/lib/jobs/apple-health-import-worker.ts`).
- XML intervals are not reconstructed or split. A record crossing
  midnight is assigned using its mapped timestamp and remains covered
  by the explicit estimate contract.
- A second import re-folds the same days onto the same external IDs.
  Equal-authority estimates update idempotently rather than duplicate.

The terminal job result exposes
`cumulativeEstimates: { days, rows }`; the web import card warns when
one or more cumulative days used this estimate path.

### Re-import idempotency

The two-axis idempotency story:

1. **File-level** — re-uploading the same `export.zip` (same SHA-256
   of bytes) short-circuits to the previous job only when that job
   used the current parser revision. Existing jobs may use revisions 1
   or 2; new jobs use revision 3, so an earlier successful archive can be
   deliberately processed again under the corrected aggregation.
2. **Record-level** — when an older `export.zip` is re-exported from
   iOS (same history, slightly newer device timestamps), every
   record's external ID stays stable. The serialized reconciliation
   path matches the canonical identity and updates instead of
   inserting.

Practically: a user who exports monthly and re-imports each archive
sees fresh data merged in without duplicates. The job result line
in the status response reports `recordsInserted` and
`recordsUpdated` separately.

### WHOOP records and current export limits

Supported measurements written into HealthKit by another app are
handled by HealthKit type, not by a raw writer label. For example, a
supported heart-rate record written by WHOOP is imported as an
Apple Health measurement and participates in the normal source
priority rules.

WHOOP currently exports neither ECG recordings nor Blood Pressure
Insights to Apple Health. Those two WHOOP data classes therefore
cannot arrive through an Apple Health `export.zip`; a WHOOP writer
label on some other HealthKit record is not evidence of a WHOOP ECG
export. HealthLog's direct WHOOP OAuth/API integration remains
supported for the WHOOP data the API exposes.

## Admin variant — import on behalf of another user

`POST /api/admin/import-apple-health-export` is the cookie-only admin
variant (Bearer tokens never elevate to admin). The multipart body
adds a `userId` text field naming the target user; everything else
is identical to the user-facing flow.

The `ImportJob` row carries `triggeredByAdminId = admin.id` so the
status endpoint admits both the target user and the triggering
admin. Idempotency is scoped by target user and parser revision — an
admin re-uploading the same archive for the same user resolves to the
previous current-revision job.

Typical use: migrating a friend's history into their HealthLog
account when they cannot run the import themselves, or backfilling
a household member's data after the admin received the `export.zip`
out of band.

## Aggregate authority and recovery

Native HealthKit daily statistics submitted by the iOS batch endpoint
are canonical and carry `HEALTHKIT_STATISTICS` provenance. XML
source-maximum estimates carry `EXPORT_XML_SOURCE_MAX`. Both use the
same serialized reconciler with this ordering:

`LEGACY_UNKNOWN < EXPORT_XML_SOURCE_MAX < HEALTHKIT_STATISTICS`

A later XML import cannot overwrite native statistics. Native
statistics repair an XML estimate or legacy row in either arrival
order, and every material reconciled update or resurrection increments
`syncVersion`. Existing Apple Health `stats:*` rows are migrated to
`LEGACY_UNKNOWN`; they are never guessed or heuristically promoted.
To recover an already-corrupted legacy total, the user must re-upload
the original archive under parser revision 2 or sync native HealthKit
statistics. Without either input, the correct per-source total cannot
be reconstructed from the stored aggregate.

## Source-priority interaction

HealthLog's source ladder is **APPLE_HEALTH ≻ WITHINGS ≻ MANUAL ≻
IMPORT** for cumulative metrics (steps, active energy, distance,
flights, sleep, HRV, resting HR) and **WITHINGS ≻ APPLE_HEALTH ≻
MANUAL** for point measurements where the Withings device is the
primary sensor (weight, BP, body fat, body temperature, SpO₂, VO₂
max). The defaults live in `DEFAULT_SOURCE_PRIORITY` in
`src/lib/validations/source-priority.ts`.

Concrete consequences:

- Native HealthKit cumulative statistics are the canonical Apple
  Health stream for a day and outrank both XML estimates and Withings
  cumulative rows. An XML upload chooses the largest source subtotal
  only; it never claims to reproduce HealthKit's device de-duplication.
  Lower-priority rows stay in the database as an audit trail but drop
  out of the displayed per-day aggregation.
- If you weigh yourself on a Withings scale and also import Apple
  Health (which received the same reading via the Health Mate iOS
  app), the Withings row wins for display. Apple Health is
  second-hand for that metric.
- Manual entries always rank below either device source. The IMPORT
  source tag — the lowest rank — is reserved for legacy CSV/JSON
  imports that pre-date the Apple Health passthrough.

RMSSD HRV has its own ladder, **WHOOP ≻ OURA ≻ POLAR ≻ APPLE_HEALTH**,
separate from the SDNN one.

Override per-user via Settings → Sources (`/settings/sources`).

## Failure modes

| Failure                                             | What you see                                                                    | Recovery                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archive is missing `apple_health_export/export.xml` | `failureReason: "Archive is missing the apple_health_export/export.xml member"` | Re-export from the iPhone; a partial AirDrop or a renamed archive can lose the canonical entry.                                                                      |
| Archive is encrypted                                | `failureReason: "Encrypted ZIP entries are not supported"`                      | Apple does not encrypt the export — this means the file was repacked by a third-party tool. Re-export from iOS directly.                                             |
| Unsupported compression method                      | `failureReason: "Unsupported ZIP compression method <n> for export.xml"`        | Same recovery — re-export from iOS, which always emits method 0 (stored) or method 8 (deflate).                                                                      |
| Worker is not running                               | `503 Background worker is not running` from the kick-off endpoint               | The worker process is down. Check `docker compose ps` for the `app-worker` container (or `HEALTHLOG_PROCESS_TYPE=all` mode on the main `app` container) and restart. |
| Rate-limited                                        | `429 Too many import uploads, try again later`                                  | Wait sixty seconds; the limit is three uploads per minute per user.                                                                                                  |

The wide-event log line `import.apple-health.kickoff` (or
`import.apple-health.kickoff.denied` on failure) captures every
attempt with the upload size, SHA-256, and the resolved `ImportJob`
id for debugging.

## Garmin owners

Garmin has no direct connector for a self-hosted instance. Garmin Connect writes
to Apple Health automatically, so the import path on this page is how Garmin data
reaches HealthLog on iOS. See [garmin.md](./garmin.md) for what comes through and
what Garmin withholds.
