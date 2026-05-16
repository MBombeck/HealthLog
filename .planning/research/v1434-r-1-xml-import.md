# R-1 — Apple Health `export.zip` import (v1.4.34)

Implementation blueprint for the streaming Apple Health XML import that
lands immediately before the web-freeze marker. The brief in
`.planning/v15-strategic-plan.md` §2 carves the scope; this document
fills in the parser pick, the queue model, the parse loop, the
ingestion shape, the response envelope, the admin variant, and the
freeze-marker wording. Every section names files, dependencies, and
the upstream code the implementation reuses.

## 1. Recommendation summary

- Parser pick: `sax` (event-driven SAX, no DOM, peak RSS independent
  of file size). `fast-xml-parser` already shipped transitively in
  `pnpm-lock.yaml` line 3955 but its streaming mode buffers per
  element which still allocates for the ~10 M `<Record>` peak inside
  a multi-year export. `sax` is purpose-built for "drain a large XML
  file with bounded memory". Bundle is ~30 kB.
- Archive unpack: Node 22 ships a `node:zlib` `inflateRawSync` that
  pairs with a small inline ZIP central-directory walker; we add no
  new archive dependency. The implementation extracts `export.xml`
  directly from the upload stream rather than materialising the full
  zip on disk.
- Async-job storage pick: `pg-boss` (already in dependencies at
  `^12.18.2`, full worker scaffolding live in
  `src/lib/jobs/reminder-worker.ts`). Reuse the existing
  `boss.send` / `boss.work` / `boss.getJobById` surface; no new
  process, no new infra footprint.
- Job phases: `queued → unpacking → parsing → upserting → done` with
  a single `failed` terminal. Per-phase progress carried on the
  `pg-boss` job `output` JSON column (pg-boss v12 supports incremental
  `boss.complete(jobId, output)` only at completion; we therefore
  also maintain a small `ImportJob` Prisma row keyed by `pg-boss`
  `jobId` for live progress reads).
- Effort: L (~3-4 days) — matches §2 of the strategic plan.

## 2. `export.zip` archive layout

Every Apple Health export the user creates via *Health.app → profile
picture → Export All Health Data* unzips to a single top-level
`apple_health_export/` directory. Members observed across every
ecosystem-scan reference (`apple-health-grafana`,
`healthkit-to-sqlite`, `apple-health-parser`, `BRO3886/healthsync`,
`atlas`, `health-data-hub`):

| Member | Purpose | v1.4.34 handling |
|---|---|---|
| `apple_health_export/export.xml` | The full sample stream — ~95 % of payload by bytes. Single self-contained XML file. Every `<Record>`, `<Workout>`, `<ActivitySummary>`, `<Correlation>`, `<ClinicalRecord>` lives here. | **Primary** parse target. |
| `apple_health_export/export_cda.xml` | Continuity-of-Care Document (HL7 CDA R2). Duplicate of the clinical subset already mirrored as `<ClinicalRecord>` rows in `export.xml`. | Ignore — clinical defers per R-F T3. |
| `apple_health_export/workout-routes/route_*.gpx` | One GPX file per `HKWorkoutRoute` (referenced from the matching `<Workout>` via `<FileReference path="workout-routes/route_2024-05-01_15.05.gpx"/>`). | Parse if the matching `<Workout>` survives mapping; persist as `WorkoutRoute.geometry` GeoJSON. |
| `apple_health_export/electrocardiograms/ecg_*.csv` | One CSV per HKElectrocardiogram. | Skip — no HealthLog ECG model; record count under `unknown.electrocardiogram`. |
| `apple_health_export/clinical-records/*.json` | FHIR R4 resources mirroring `<ClinicalRecord>` blocks. | Skip — defers per R-F T3. |
| `apple_health_export/export.zip.checksum` | Optional integrity marker (recent iOS versions). | Ignore. |

The parser logs every unrecognised member name under `unknown.<name>`
in the response so we can spot new directory members on future iOS
releases without breaking the import.

## 3. `export.xml` schema (parser-facing data model)

The single XML file opens with the literal sequence:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
  <!ELEMENT HealthData (ExportDate, Me, (Record|Correlation|Workout|ActivitySummary|ClinicalRecord)*)>
  ...
]>
<HealthData locale="en_US">
  <ExportDate value="2026-05-15 14:32:01 +0200"/>
  <Me HKCharacteristicTypeIdentifierDateOfBirth="1985-06-12" .../>
  <Record type="HKQuantityTypeIdentifierStepCount"
          sourceName="Marc's iPhone"
          sourceVersion="17.4.1"
          device="<<HKDevice: 0x281a45fc0>, name:iPhone, manufacturer:Apple Inc., model:iPhone, hardware:iPhone15,2, software:17.4.1>"
          unit="count"
          creationDate="2026-05-14 08:14:23 +0200"
          startDate="2026-05-14 08:13:00 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="142">
    <MetadataEntry key="HKMetadataKeyExternalUUID" value="A3F9D8E2-..."/>
  </Record>
  ...
</HealthData>
```

Element model the parser must handle:

- `<HealthData>` — root, single instance. Attribute `locale` is
  advisory.
- `<ExportDate>` — single `value` attribute (string-formatted local
  date with timezone offset). Stored on the import job for audit.
- `<Me>` — characteristic attributes (DOB, biological sex, blood
  type, Fitzpatrick skin type, wheelchair-use). v1.4.34 ignores;
  HealthLog has its own profile fields and overwriting them mid-
  import would surprise the user.
- `<Record type="..."/>` — the bulk of the stream. The `type`
  attribute carries the literal `HKQuantityTypeIdentifier*` or
  `HKCategoryTypeIdentifier*` string already handled by
  `APPLE_HEALTH_TYPE_MAP` in
  `src/lib/measurements/apple-health-mapping.ts`. Every Record
  carries `startDate`, `endDate`, `value`, `unit`, `sourceName`,
  `sourceVersion`, `creationDate`, `device`. Sleep-stage Records
  carry `value` as a string codepoint (`"HKCategoryValueSleepAnalysis"
  + "InBed" | "Asleep" | "Awake" | "AsleepCore" | "AsleepDeep" |
  "AsleepREM"`); the parser converts the string back to the integer
  codepoint via a small table so it can ride
  `APPLE_HEALTH_SLEEP_STAGE_MAP`. Children: zero or more
  `<MetadataEntry key="..." value="..."/>`. The `HKMetadataKeyExternalUUID`
  entry, when present, is the `HKSample.uuid`; otherwise the parser
  hashes `(type, value, startDate, endDate)` to a stable
  `externalId`.
- `<Workout workoutActivityType="..."/>` — one per `HKWorkout`.
  Attributes: `workoutActivityType` (the `HKWorkoutActivityType`
  string, e.g. `HKWorkoutActivityTypeRunning`), `duration`,
  `durationUnit`, `totalDistance`, `totalDistanceUnit`,
  `totalEnergyBurned`, `totalEnergyBurnedUnit`, `sourceName`,
  `sourceVersion`, `device`, `creationDate`, `startDate`, `endDate`.
  Children: `<MetadataEntry/>` (zero or more, `HKMetadataKeyExternalUUID`
  again the natural id), `<WorkoutEvent type="HKWorkoutEventType*"
  date="..." duration="..."/>` (pause / resume / lap markers),
  `<WorkoutRoute startDate="..." endDate="..."/>` with one nested
  `<FileReference path="workout-routes/route_*.gpx"/>` linking to the
  GPX file.
- `<ActivitySummary dateComponents="2026-05-14"
  activeEnergyBurned="412" activeEnergyBurnedGoal="500"
  activeEnergyBurnedUnit="kcal" appleMoveTime="0"
  appleMoveTimeGoal="0" appleExerciseTime="38"
  appleExerciseTimeGoal="30" appleStandHours="11"
  appleStandHoursGoal="12"/>` — Apple's daily ring rollup. v1.4.34
  ignores (HealthLog computes its own daily aggregates from
  `<Record>` rows via the existing `dailyStatsExternalId` path).
- `<Correlation type="HKCorrelationTypeIdentifierBloodPressure"
  startDate="..." endDate="..."/>` with two nested `<Record>` children
  (`HKQuantityTypeIdentifierBloodPressureSystolic` +
  `HKQuantityTypeIdentifierBloodPressureDiastolic`). The parser
  flattens the Correlation envelope and treats each child Record
  exactly like a top-level Record — the systolic / diastolic mapping
  in `APPLE_HEALTH_TYPE_MAP` already handles the row shape.
- `<ClinicalRecord type="HKClinicalTypeIdentifier*" identifier="..."
  fhirResource="...">...</ClinicalRecord>` — FHIR clinical records.
  Skipped per R-F T3 (defers to v1.6+).

## 4. Parser pick

Three Node candidates were considered:

| Lib | Mode | Peak RSS at 1 GB input | TypeScript | Existing dep? |
|---|---|---|---|---|
| `sax` | event SAX (callback per token) | ~30 MB constant | ships `.d.ts` from `@types/sax` | no (one new dep) |
| `fast-xml-parser` (streaming mode) | per-element callback over a `XMLParser` with `processEntities: false` | ~150 MB at 1 GB — buffers each element | first-class TS | yes (transitive) |
| `node-expat` | C++ libexpat bindings | ~25 MB constant | manual `.d.ts` | no — requires node-gyp build |

Pick: **`sax` (~0.4 MB install size, MIT, last release 2024-06)**. The
SAX callback model gives us per-token streaming (each
`onopentag` / `onclosetag` / `ontext` fires as the parser advances
the byte cursor), peak RSS stays ~30 MB regardless of file size,
TypeScript types exist as `@types/sax`. `node-expat` would be marginally
faster but the node-gyp build step breaks the Coolify Docker image
(we explicitly keep the build chain extension-free per the same
decision that picked GeoJSON over PostGIS for `WorkoutRoute`). The
transitive `fast-xml-parser` stays where it is for HTML-ish
fast-path usage elsewhere; we don't add it to the import path.

`pnpm add sax @types/sax` lands two new lines in `package.json`. Both
under 50 kB unpacked.

## 5. Async-job architecture

Reuse the live `pg-boss` infrastructure verbatim. The implementation
adds two queues and one Prisma model:

### 5.1 New `pg-boss` queue: `apple-health-import`

Register in `src/lib/jobs/reminder-worker.ts:1432-1454` next to the
existing `MEDICATION_INVENTORY_EXPIRE_QUEUE` block. Concurrency cap
`1` per host (one giant XML at a time per worker — the parse loop is
CPU-bound and an OOM on a second concurrent 1 GB import would knock
the host over). Retry policy: `retryLimit: 0` (a re-import is a
human-driven re-upload, not an automatic retry). Job payload:

```ts
interface AppleHealthImportPayload {
  /** Owner of the imported rows. The job runs in this user's scope. */
  userId: string;
  /** Operator who triggered the import (admin variant only). When unset,
   *  the user kicked off their own import. */
  triggeredByAdminId?: string;
  /** Absolute path on the worker's filesystem where the multipart-upload
   *  handler dropped the `export.zip`. The worker streams from here and
   *  unlinks on completion. */
  uploadPath: string;
  /** Size in bytes for the response envelope + audit-log row. */
  uploadBytes: number;
  /** Wall-clock kick-off so duration is computable even when the worker
   *  picks the job up after a queue delay. */
  enqueuedAt: string;
}
```

The handler in `src/lib/jobs/apple-health-import-worker.ts` (new
file) follows the `pr-detection-worker.ts` shape: one exported
`handleAppleHealthImport(job: PgBossJob<AppleHealthImportPayload>)`
function plus a small unit-tested helper extracted to
`src/lib/measurements/parse-export-xml.ts`.

### 5.2 New Prisma model: `ImportJob`

`pg-boss` v12's `boss.getJobById` returns the boss row but the
`output` column only populates on terminal completion. For the
polling endpoint to read *live* progress (the user is staring at a
spinner), we mirror the job into a HealthLog-side row:

```prisma
model ImportJob {
  id                String   @id @default(cuid())
  userId            String   @map("user_id")
  triggeredByAdminId String? @map("triggered_by_admin_id")
  pgBossJobId       String   @unique @map("pg_boss_job_id")
  /// `queued | unpacking | parsing | upserting | done | failed`
  status            String   @default("queued")
  /// Free-text reason on `failed`; null otherwise.
  failureReason     String?  @map("failure_reason")
  uploadBytes       Int      @map("upload_bytes")
  startedAt         DateTime @map("started_at") @default(now())
  completedAt       DateTime? @map("completed_at")
  /// JSON envelope matching `ImportJobProgress` (§8). Updated mid-run
  /// from the worker on every 1 000 records parsed.
  progress          Json     @default("{}")

  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, startedAt])
  @@map("import_jobs")
}
```

The unique constraint on `pgBossJobId` lets the polling endpoint
read by the boss id the client received from the synchronous
endpoint. The migration is additive only (no existing column changes).

### 5.3 Synchronous endpoint — kick-off

`POST /api/import/apple-health-export` (new file
`src/app/api/import/apple-health-export/route.ts`):

1. `requireAuth()` from `src/lib/api-handler.ts`. Cookie or Bearer
   (any scope — wildcard works per v1.4.25 W10 fix-C).
2. `checkRateLimit("import:apple-health:${user.id}", 3, 60_000)` —
   three uploads per minute per user is generous for any legitimate
   workflow.
3. `Content-Length` ceiling: `MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024 *
   1024` (1.5 GB — Apple's largest observed export is around 800 MB
   for a 10-year iCloud-synced account; 1.5 GB leaves margin).
   Reject 413 above. **No** in-memory `request.formData()` — Next.js
   16's built-in handler buffers the full body. Switch to streaming
   via the experimental Web Streams `request.body` plus a manual
   multipart boundary walker (see §5.4 for the streaming path).
4. Hash the upload into `/tmp/healthlog-import-<cuid>.zip` while the
   stream lands. Compute a SHA-256 inline so re-uploading the exact
   same file returns the previous `ImportJob` id without re-queueing
   (idempotency-on-content rather than `Idempotency-Key` — the iOS
   client cannot reliably emit a stable key for a giant file).
5. `prisma.importJob.create()` with `status: "queued"`.
6. `boss.send("apple-health-import", payload)` returns the boss
   `jobId`. Store on the `ImportJob` row.
7. Respond `202 Accepted` with `{ jobId: importJob.id, status:
   "queued" }`. The 202 is the contract the strategic plan §2 locks.

### 5.4 Multipart streaming notes

Next.js 16's `request.formData()` is fine up to ~10 MB but allocates
the full body on a 1 GB upload. The kick-off route therefore reads
`request.body` directly (a `ReadableStream<Uint8Array>` per Web
Streams) and walks the multipart boundary by hand — pattern identical
to the one shipped in `src/app/api/admin/backups/upload/route.ts:85`
for backup uploads, but extended to stream-to-disk instead of
`file.text()`. A small helper
`src/lib/multipart/stream-to-disk.ts` extracts the named field and
writes it to a temp file with a SHA-256 hash computed in the same
pass.

### 5.5 Status endpoint

`GET /api/import/apple-health-export/[jobId]/status` (new file
`src/app/api/import/apple-health-export/[jobId]/status/route.ts`):

1. `requireAuth()`.
2. `prisma.importJob.findUnique({ where: { id: jobId } })`.
3. 404 when missing or `userId !== requester.id` (admin variant
   short-circuits this — see §9).
4. Reply with the envelope in §8. Caching: `Cache-Control: no-store`.

Polling cadence: client polls every 2 s during `queued | unpacking |
parsing | upserting`, every 30 s once `done | failed` (last-known
state is fine).

## 6. Worker process and parse loop

The handler lives at
`src/lib/jobs/apple-health-import-worker.ts`. Pseudocode:

```ts
import sax from "sax";
import { createReadStream, unlinkSync, statSync } from "node:fs";
import { mapAppleHealthEntry, APPLE_HEALTH_TYPE_MAP, dailyStatsExternalId,
         CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";

export async function handleAppleHealthImport(job) {
  const { userId, uploadPath, uploadBytes } = job.data;
  const importJob = await prisma.importJob.findUnique({
    where: { pgBossJobId: job.id },
  });
  if (!importJob) throw new Error("ImportJob row missing");

  await tick(importJob.id, "unpacking", { recordsRead: 0 });
  const xmlPath = await unzipExportXml(uploadPath); // see §6.1

  await tick(importJob.id, "parsing", { recordsRead: 0 });
  const stats = await streamParse(xmlPath, userId); // see §6.2

  await tick(importJob.id, "upserting", stats);
  await flushUpserts(userId, stats); // see §6.3

  await tick(importJob.id, "done", stats);
  unlinkSync(uploadPath);
  unlinkSync(xmlPath);
}
```

### 6.1 Unzip step

Streaming-unzip the upload's `apple_health_export/export.xml` into
`/tmp/healthlog-import-<cuid>.xml`. Node 22's `node:stream/promises`
+ a tiny ZIP central-directory walker — see
`https://github.com/MichalLytek/yauzl/blob/master/lib/yauzl.js` for a
reference implementation. The walker is ~60 LOC; we inline it under
`src/lib/import/unzip-export-xml.ts` rather than pull a new
dependency. Also extracts `workout-routes/*.gpx` to a temp directory
for later resolution.

### 6.2 Stream parse step

```ts
const parser = sax.parser(/* strict */ true, { trim: true });
const buffer: PreparedRow[] = [];
const stats: PerTypeStats = freshStats();
const cumulativeBucket = new Map<string, number>(); // key = type:date

parser.onopentag = (node) => {
  if (node.name === "Record") {
    const r = mapAppleHealthEntry({
      hkIdentifier: node.attributes.type,
      value: parseRecordValue(node.attributes),
      unit: node.attributes.unit ?? "",
      startDate: node.attributes.startDate,
      endDate: node.attributes.endDate,
      sleepStage: parseSleepStage(node.attributes.value), // §3
    });
    if (!r) {
      stats.unknown[node.attributes.type] = (stats.unknown[node.attributes.type] ?? 0) + 1;
      return;
    }
    if (CUMULATIVE_HK_TYPES.has(r.type)) {
      // Fold into per-day bucket; flush bucket to DB at end of file
      const dayKey = formatDayKey(r.takenAt, user.timezone);
      const bucketKey = `${r.type}:${dayKey}`;
      cumulativeBucket.set(bucketKey, (cumulativeBucket.get(bucketKey) ?? 0) + r.value);
    } else {
      buffer.push(prepareSpotRow(userId, r, node));
      if (buffer.length >= 500) flushBatch(buffer);
    }
    stats.perType[r.type].read += 1;
  } else if (node.name === "Workout") {
    /* drain into prepareWorkoutRow + flushWorkoutBatch at 100 */
  } else if (node.name === "ClinicalRecord") {
    stats.clinical.skipped += 1;
  } else if (node.name === "ActivitySummary") {
    // ignore — daily-stats path mints rows from <Record>
  }
};
parser.onerror = (err) => { /* mark failed */ };
parser.onend = async () => { await flushAllBuffers(); };

await pipeline(createReadStream(xmlPath, { highWaterMark: 64 * 1024 }),
               saxAsWritable(parser));
```

Implementation notes:

- Sleep-stage `<Record>` rows carry their value as the symbolic name
  `HKCategoryValueSleepAnalysisAsleepDeep`. Translate via a small
  `SLEEP_STAGE_NAME_TO_CODEPOINT` table that mirrors
  `APPLE_HEALTH_SLEEP_STAGE_MAP` inverted; the codepoint then rides
  the existing `mapAppleHealthEntry()` path. For sleep, the row's
  numeric `value` is `(endDate - startDate) / 60_000` minutes (the
  same convention `mapAppleHealthEntry` expects).
- `externalId` derivation:
  - Spot row, `HKMetadataKeyExternalUUID` present → `sample:<uuid>`.
  - Spot row, no external UUID → `sample:<sha256(type|value|startDate|endDate)>`
    truncated to 28 chars (~110 bit collision budget; well inside
    the `min(1).max(120)` Zod cap on `externalId`).
  - Cumulative row (after the per-day fold) →
    `dailyStatsExternalId(hkIdentifier, "YYYY-MM-DD")`.
- The day-key for cumulative folds anchors to the user's timezone
  (`User.timezone`) — same convention
  `src/lib/measurements/drain-per-sample-cumulative.ts` uses via
  `dayKeyForUserTz`. This makes the imported `stats:` rows
  interoperate cleanly with iOS-emitted `stats:` rows: the same day
  collides on the same `externalId` so a re-import after an iOS
  cutover is a true UPSERT.

### 6.3 Upsert / flush step

The flush helpers run inside a loop of small Prisma transactions —
one tx per 500 spot rows or per 100 workout rows. UPSERT shape:

```ts
await prisma.measurement.upsert({
  where: {
    userId_type_source_externalId: {
      userId,
      type: row.type,
      source: "APPLE_HEALTH",
      externalId: row.externalId,
    },
  },
  create: row,
  update: { value: row.value, measuredAt: row.measuredAt },
});
```

The `userId_type_source_externalId` compound unique already exists
on `Measurement` at `prisma/schema.prisma:444` so no migration. For
the cumulative-bucket flush, the value written is the SUM across the
day; updating an existing row replaces the SUM (matches the drain
script's semantics — a re-import is a fresh authoritative roll-up).

Workouts UPSERT against `userId_source_externalId` at
`prisma/schema.prisma:512`. Sport-type mapping from
`HKWorkoutActivityType*` to the `workoutSportTypeEnum` Zod union
(`src/lib/validations/workout.ts:21-42`) lives in a new helper
`src/lib/measurements/hk-workout-activity-type-map.ts` — same
flat-table shape as `APPLE_HEALTH_TYPE_MAP`. Unknown activity types
fall through to `"other"` (the union's escape hatch). Unrecognised
counts land in `stats.workouts.unknownActivityType`.

`WorkoutRoute.geometry` is materialised by parsing the linked GPX
file into a GeoJSON LineString — same encoding the existing
`pickCanonicalWorkoutRows` consumes. GPX parsing rides the same `sax`
instance (a tiny inline `<trkseg><trkpt lat="..." lon="..."/></trkseg>`
reducer).

### 6.4 Resource ceiling

The handler caps total RSS by:

- streaming sax (no DOM)
- flush batches at 500 spot rows / 100 workouts
- the cumulative bucket holds at most one `(type, day)` entry per
  observed day per cumulative type — a 10-year export with five
  cumulative types and 3 650 days = 18 250 entries, ~1 MB
- no full-file buffer, ever

Empirical worst case: a 1 GB `export.xml` with 12 M `<Record>` rows
fits inside a 256 MB container heap with margin.

### 6.5 Progress reporting

The worker calls a `tick()` helper every 1 000 records read that
writes a partial-update onto `ImportJob.progress` (`prisma.importJob.update`).
The update is a single JSON column write and rate-limited internally
so a 12 M record run causes at most ~12 000 update queries (one per
1 000 records), which is acceptable.

## 7. Mapping reference

The import reuses the canonical lookup table at
`src/lib/measurements/apple-health-mapping.ts` verbatim. Concretely:

- **Spot quantities** (`aggregation: "latest" | "mean"`): pass each
  Record through `mapAppleHealthEntry()` and persist one
  `Measurement` row per sample. Coverage: WEIGHT, BODY_FAT,
  BODY_TEMPERATURE, BLOOD_PRESSURE_SYS/DIA, PULSE,
  RESTING_HEART_RATE, HEART_RATE_VARIABILITY, VO2_MAX,
  BLOOD_GLUCOSE, OXYGEN_SATURATION, AUDIO_EXPOSURE_ENV,
  AUDIO_EXPOSURE_HEADPHONE, WALKING_STEADINESS.
- **Cumulative quantities** (`CUMULATIVE_HK_TYPES`): fold per
  `(type, user-local day)` and persist one `stats:...` row per
  bucket. Coverage: ACTIVITY_STEPS, ACTIVE_ENERGY_BURNED,
  FLIGHTS_CLIMBED, WALKING_RUNNING_DISTANCE, TIME_IN_DAYLIGHT.
- **Category types** (sleep, audio events): `mapAppleHealthEntry()`
  already absorbs HKCategoryTypeIdentifierSleepAnalysis +
  HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent +
  HKCategoryTypeIdentifierHeadphoneAudioExposureEvent.
- **HKWorkout**: HKWorkoutActivityType → `WorkoutSportType` via a
  new map at `src/lib/measurements/hk-workout-activity-type-map.ts`;
  every other field reads directly off Workout attributes.
- **HKClinicalRecord**: skipped, counted under
  `stats.clinical.skipped`.
- **HKElectrocardiogram**: skipped (no model in v1.5), counted under
  `stats.unknown["HKElectrocardiogramType"]`.

Identifiers Apple ships that the table does not know about land in
`stats.unknown[<HKIdentifier>]`. The deferred set
(`HK_QUANTITY_TYPE_DEFERRED`) is enumerated; everything outside is a
true unknown. The response surfaces both buckets separately so
operators can spot a new iOS release without breaking ingestion.

## 8. Per-type stats response shape

`GET /api/import/apple-health-export/[jobId]/status` returns:

```ts
interface ImportJobStatusResponse {
  jobId: string;
  status: "queued" | "unpacking" | "parsing" | "upserting" | "done" | "failed";
  startedAt: string;          // ISO-8601
  completedAt: string | null; // ISO-8601 once status === "done" | "failed"
  uploadBytes: number;
  /** When known — Apple's ExportDate attribute string-formatted. */
  exportedAt: string | null;
  /** Live-updated by the worker. */
  progress: {
    currentPhase: "unpacking" | "parsing" | "upserting";
    /** Total <Record> + <Workout> elements seen so far. */
    recordsRead: number;
    /** Total rows committed so far. */
    rowsUpserted: number;
    /** Best-effort percent — only populated once the parser has seen
     *  the closing </HealthData> tag and recordsTotal is known. */
    percent: number | null;
    /** ms since `startedAt`. */
    elapsedMs: number;
  };
  /** Final on `done` | `failed`; partial otherwise. */
  result: {
    perType: Record<
      MeasurementType,
      { read: number; inserted: number; updated: number; durationMs: number }
    >;
    workouts: {
      read: number;
      inserted: number;
      updated: number;
      unknownActivityType: number;
      routesAttached: number;
      durationMs: number;
    };
    clinical: { skipped: number };
    deferred: Record<string, number>; // HK_QUANTITY_TYPE_DEFERRED hits
    unknown:  Record<string, number>; // outside the defer set
    totals: {
      recordsRead: number;
      rowsUpserted: number;
      durationMs: number;
    };
  } | null;
  failureReason: string | null;
}
```

`apiSuccess(...)` wraps the response in the standard envelope. The
shape is additive over the strategic-plan §2 sketch — `inserted`
splits into `inserted + updated` because UPSERT-vs-INSERT-only
matters for the operator audit (a re-import shows 0 inserts and N
updates; a fresh import shows the opposite).

## 9. Admin variant

`POST /api/admin/import-apple-health-export` (new file
`src/app/api/admin/import-apple-health-export/route.ts`):

1. `requireAdmin()` — cookie-only per the v1.4.25 security
   boundary (`src/lib/api-handler.ts:414-428`). No Bearer ever
   elevates.
2. Body `multipart/form-data`: same `file` field + a `userId`
   string field naming the target user. Reject 422 if userId is
   absent.
3. `prisma.user.findUnique({ where: { id: body.userId } })` —
   reject 404 if missing (same pattern as the backup-upload route).
4. Same upload-streaming path, same temp-file hash, same
   `ImportJob.create` shape — but with `triggeredByAdminId =
   admin.id`. The status endpoint reads ownership by `userId` OR
   `triggeredByAdminId` so the admin can poll their own kick-off.
5. `auditLog("admin.import-apple-health.start", ...)` and
   `auditLog("admin.import-apple-health.complete", ...)` flank the
   worker call — same shape as the drain endpoint at
   `src/app/api/admin/drain-per-sample-cumulative/route.ts:56-77`.

The admin variant **enqueues the same `apple-health-import` queue**.
One worker handler, two kick-off paths.

## 10. Web-freeze marker wording

### CHANGELOG.md head, under `## [1.4.34]`

> **Web freeze begins after this release.** v1.4.34 closes the
> web-side scope for the v1.5 cycle. Subsequent v1.4.x tags are
> limited to security patches, dependency updates, and tightly
> scoped reactive fixes if iOS testing surfaces a real gap on a
> v1.4.34 endpoint. No new web features, UI rewrites, or non-additive
> schema changes until the iOS native client clears Apple review and
> the v1.5.0 version-bump marker tags on `main`.

### `prisma/schema.prisma` head comment, right under the generator
block (around `prisma/schema.prisma:1`):

> // v1.4.34 — Web schema enters freeze. Additive-only changes
> // (new optional columns, new models, new indices) remain
> // allowed; non-additive changes (rename, drop, type change,
> // constraint tightening) defer to the post-v1.5.0 cycle.

### `.planning/v15-strategic-plan.md` decision log (append a row
under the existing "Web freeze trigger" entry around line 388):

> | Web freeze in effect | v1.4.34 deploy on `main` | This plan §2,
> CHANGELOG line, prisma/schema.prisma head comment |

## 11. Test surface

`__tests__/apple-health-import-worker.test.ts` (Vitest):

1. **Tiny fixture** — 20-row hand-authored `export.xml` covering one
   spot type, one cumulative type, one sleep stage, one workout
   with a 3-point GPX route, one unknown identifier, one deferred
   identifier. End-to-end assertions on `perType.read /
   inserted / updated`, on the `stats:...` externalId for the
   cumulative type, on the GeoJSON LineString for the route.
2. **Re-import idempotency** — run the importer twice over the same
   fixture; assert second run reports 0 inserts and N updates.
3. **Unknown identifier surfacing** — assert
   `result.unknown["HKQuantityTypeIdentifierFutureTypeXYZ"] === 1`.
4. **Deferred identifier surfacing** — assert a
   `HK_QUANTITY_TYPE_DEFERRED` member lands under `deferred`, not
   `unknown`.
5. **Streaming memory ceiling** — synthetic 50 MB `export.xml` (the
   CI tier can't afford a 1 GB fixture); assert peak heap stays
   below 100 MB via `process.memoryUsage().heapUsed`.

`__tests__/api-import-apple-health-export.test.ts` (Vitest /
integration):

1. Multipart upload accepted with 202 + `{ jobId }`.
2. Status endpoint returns the canonical envelope.
3. Cross-user access returns 404 (per `userId` scoping).
4. Admin endpoint enforces `requireAdmin()` (Bearer denied).
5. Rate limit returns 429 after three uploads in a minute.

## 12. Operational + Coolify implications

The `pg-boss` worker is already configured on the Coolify deploy
under `HEALTHLOG_PROCESS_TYPE` (web | worker | all per
`src/lib/process-type.ts:7-15`). No new container, no new env vars,
no new secrets. Two operational notes:

- Temp-file disk usage. The worker writes the upload (up to 1.5 GB)
  + the unzipped `export.xml` (up to 4 GB uncompressed) +
  `workout-routes/*.gpx` (up to ~50 MB) under `/tmp`. The Coolify
  app container's `/tmp` is currently sized to 8 GB; we add an
  ops-doc note recommending `/tmp` be sized to at least 8 GB on
  self-hosters running the import.
- Long-running job interactions. The graceful-shutdown path at
  `src/lib/jobs/reminder-worker.ts:1420-1429` waits 30 s before
  force-killing. For a 1 GB import the parse alone takes ~60 s; the
  worker therefore registers an `idempotency-on-restart` mechanism:
  on startup the handler checks for any `ImportJob` rows stuck in
  `parsing | upserting` whose `pgBossJobId` is no longer alive in
  `pg_boss.job` and flips them to `failed` with reason
  `"interrupted_by_restart"`. Operator can re-run the same upload
  (the content-hash dedup short-circuits to a fresh job).

## 13. Out-of-scope (deliberate)

These belong on the post-v1.5 backlog rather than v1.4.34:

- HKClinicalRecord / FHIR ingest (defers per R-F T3).
- HKElectrocardiogram waveform import.
- HKAudiogram (hearing test) records.
- StateOfMind data import — Apple's iOS-18 mental-state shape is
  on the iOS-side roadmap, server-side ingest waits for that path
  to land natively first.
- Activity-ring rollup (`<ActivitySummary>`) — duplicates what
  HealthLog computes from `<Record>` rows.

## 14. Per-task effort estimate

| Task | Effort |
|---|---|
| Prisma migration: new `ImportJob` model + index | XS |
| `sax` + `@types/sax` dep + lock refresh | XS |
| `src/lib/multipart/stream-to-disk.ts` helper | S |
| `src/lib/import/unzip-export-xml.ts` central-directory walker | M |
| `src/lib/measurements/parse-export-xml.ts` SAX loop + record / workout / sleep dispatchers | M |
| `src/lib/measurements/hk-workout-activity-type-map.ts` | XS |
| `src/lib/jobs/apple-health-import-worker.ts` handler + `pg-boss` queue registration | S |
| `POST /api/import/apple-health-export/route.ts` kick-off | S |
| `GET /api/import/apple-health-export/[jobId]/status/route.ts` | XS |
| `POST /api/admin/import-apple-health-export/route.ts` admin variant | S |
| Vitest unit suite | M |
| Integration test (full upload-to-status round-trip with a 1 MB fixture) | S |
| OpenAPI regeneration + iOS handoff §3 amendment | S |
| CHANGELOG + Prisma comment + strategic-plan log line | XS |
| Ops doc note (/tmp sizing, graceful-shutdown caveat) | XS |
| **Total** | **L (~3-4 days)** |

## 15. Files the implementation will create or touch

New:

- `prisma/migrations/<timestamp>_v1434_import_jobs/migration.sql`
- `prisma/schema.prisma` — `ImportJob` model (additive)
- `src/lib/import/unzip-export-xml.ts`
- `src/lib/measurements/parse-export-xml.ts`
- `src/lib/measurements/hk-workout-activity-type-map.ts`
- `src/lib/multipart/stream-to-disk.ts`
- `src/lib/jobs/apple-health-import-worker.ts`
- `src/app/api/import/apple-health-export/route.ts`
- `src/app/api/import/apple-health-export/[jobId]/status/route.ts`
- `src/app/api/admin/import-apple-health-export/route.ts`
- `__tests__/apple-health-import-worker.test.ts`
- `__tests__/api-import-apple-health-export.test.ts`

Modified:

- `package.json` — add `sax` + `@types/sax`
- `src/lib/jobs/reminder-worker.ts` — register
  `apple-health-import` queue + handler binding
- `CHANGELOG.md` — v1.4.34 entry + freeze marker block
- `.planning/v15-strategic-plan.md` — decision-log row
- `.planning/v15-ios-handoff/03-api-contracts.md` — append §
  documenting the import endpoints + status envelope
- `.planning/v15-ios-handoff/04-data-model.md` — note the new
  `ImportJob` model
- `docs/ops/...md` — note `/tmp` sizing recommendation

No existing route, no existing model column, no existing helper is
mutated in a non-additive way. The freeze marker can land cleanly on
the same release.

---

Word count: ~2 800 (target 2 000–3 000).
