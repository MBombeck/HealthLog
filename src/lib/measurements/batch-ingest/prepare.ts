/**
 * First pass of the batch ingest: map each posted entry to the row it would
 * become, or to the per-entry refusal that keeps it out. Nothing is written
 * here; hourly sums are validated and set aside for their own write.
 */
import { EXTERNAL_SOURCE } from "@/lib/measurements/external-source";
import {
  isAggregatedBucketExternalId,
  mapAppleHealthEntry,
  targetsAggregatedBucket,
} from "@/lib/measurements/apple-health-mapping";
import {
  classifyHourBucket,
  HOUR_BUCKET_SKIP_REASONS,
  parseHourBucketId,
  type HourBucketEntry,
  type HourBucketId,
} from "@/lib/measurements/intraday-hour-buckets";
import { resolveStoredTimezone } from "@/lib/tz/resolver";
import { isPlausibleEntryInstant } from "@/lib/validations/entry-instant";
import {
  classifyExternalId,
  UNSTABLE_EXTERNAL_ID_REASON,
  type UnstableExternalIdShape,
} from "@/lib/validations/external-id";
import { validateMeasurementRange } from "@/lib/validations/measurement";

import {
  outOfRangeResult,
  type BatchIngestEntry,
  type BatchIngestInput,
  type EntryResult,
  type PreparedEntry,
} from "./entries";

export interface PreparedBatch {
  prepared: PreparedEntry[];
  results: EntryResult[];
  unstableShapes: UnstableExternalIdShape[];
  /** Hourly sums for the intraday profile, written after the measurements. */
  hourWrites: HourBucketEntry[];
  /** The zone the hours are cut in, resolved when the batch carried one. */
  accountTz: string | undefined;
}

export async function prepareBatch(
  input: Pick<
    BatchIngestInput,
    "user" | "scoped" | "ingestTokenId" | "entries"
  >,
): Promise<PreparedBatch> {
  const { user, scoped, entries } = input;
  const ingestTokenId = scoped ? input.ingestTokenId : null;
  const batch: PreparedBatch = {
    prepared: [],
    results: new Array(entries.length),
    unstableShapes: [],
    hourWrites: [],
    accountTz: undefined,
  };
  const batchNow = new Date();

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    // The `(user_id, type, source, external_id)` dedup key above is only
    // idempotent while the id is STABLE across client launches. An id
    // that rotates per process (an object description carrying a memory
    // address) never matches its own earlier row, so every sync sweep
    // mints a fresh measurement. Refused per entry, like the range and
    // timestamp guards below — one malformed row must not stop the other
    // 499 from landing.
    const unstable = classifyExternalId(entry.externalId);
    if (unstable) {
      batch.unstableShapes.push(unstable);
      batch.results[index] = {
        index,
        status: "skipped",
        reason: UNSTABLE_EXTERNAL_ID_REASON,
      };
      continue;
    }

    // An hourly sum of a summed type (`stats:<HK>:<YYYY-MM-DD>T<HH>`, ios #77)
    // is never a measurement: it lands in the intraday profile behind the
    // same-time baseline, and the day's total stays the day row. Validated
    // here, written after the measurements.
    const hourId = parseHourBucketId(entry.externalId);
    if (hourId) {
      await prepareHourEntry(batch, {
        index,
        entry,
        hourId,
        user,
        scoped,
        batchNow,
      });
      continue;
    }

    const prepared = prepareMeasurementEntry(
      index,
      entry,
      user.id,
      scoped,
      ingestTokenId,
    );
    if ("row" in prepared) batch.prepared.push(prepared);
    else batch.results[index] = prepared;
  }
  return batch;
}

/** Validate one hourly sum and set it aside, or record why it is refused. */
async function prepareHourEntry(
  batch: PreparedBatch,
  args: {
    index: number;
    entry: BatchIngestEntry;
    hourId: HourBucketId;
    user: BatchIngestInput["user"];
    scoped: boolean;
    batchNow: Date;
  },
): Promise<void> {
  const { index, entry, hourId, user, scoped, batchNow } = args;
  const skip = (reason: string) => {
    batch.results[index] = { index, status: "skipped", reason };
  };
  // The profile has no source dimension and is the phone's: a bridge or a
  // hand-entered row cannot post hours into it.
  if (scoped || (entry.source ?? "APPLE_HEALTH") !== "APPLE_HEALTH") {
    skip(HOUR_BUCKET_SKIP_REASONS.unsupportedType);
    return;
  }
  batch.accountTz ??= await resolveStoredTimezone(user.timezone);
  const startDate = new Date(entry.startDate);
  const verdict = classifyHourBucket(
    hourId,
    startDate,
    batch.accountTz,
    batchNow,
  );
  if (!verdict.ok) {
    skip(verdict.reason);
    return;
  }
  if (!isPlausibleEntryInstant(startDate)) {
    skip("implausible_timestamp");
    return;
  }
  const hourMapped = mapAppleHealthEntry({
    hkIdentifier: entry.hkIdentifier,
    value: entry.value,
    unit: entry.unit,
    startDate: entry.startDate,
    endDate: entry.endDate,
  });
  if (!hourMapped || hourMapped.type !== verdict.type) {
    // The entry's identifier must be the one its id names.
    skip(
      hourMapped
        ? HOUR_BUCKET_SKIP_REASONS.unsupportedType
        : "unmappable_identifier",
    );
    return;
  }
  if (
    hourMapped.value < 0 ||
    validateMeasurementRange(hourMapped.type, hourMapped.value) !== null
  ) {
    batch.results[index] = outOfRangeResult(
      index,
      hourMapped.type,
      hourMapped.value,
    );
    return;
  }
  batch.hourWrites.push({
    index,
    type: verdict.type,
    hkIdentifier: hourId.hkIdentifier,
    dateKey: hourId.dateKey,
    hour: hourId.hour,
    value: hourMapped.value,
    startMs: startDate.getTime(),
  });
}

/** Map one entry to its measurement row, or to the refusal that keeps it out. */
function prepareMeasurementEntry(
  index: number,
  entry: BatchIngestEntry,
  userId: string,
  scoped: boolean,
  ingestTokenId: string | null,
): PreparedEntry | EntryResult {
  const mapped = mapAppleHealthEntry({
    hkIdentifier: entry.hkIdentifier,
    value: entry.value,
    unit: entry.unit,
    startDate: entry.startDate,
    endDate: entry.endDate,
    sleepStage: entry.sleepStage,
    categoryValue: entry.categoryValue,
    valueMin: entry.valueMin,
    valueMax: entry.valueMax,
  });

  if (!mapped) {
    return {
      index,
      status: "skipped",
      reason: "unmappable_identifier",
    };
  }

  // Plausibility-range guard. We tolerate "out of plausible range"
  // by skipping rather than failing the batch — a single bogus
  // sensor reading shouldn't poison an otherwise clean ingest.
  const rangeError = validateMeasurementRange(mapped.type, mapped.value);
  if (rangeError !== null) {
    return outOfRangeResult(index, mapped.type, mapped.value);
  }

  // Time-plausibility guard, the bound the single-entry twin already applies
  // through `validateEntryInstant` on `createMeasurementSchema.measuredAt`.
  // Without it a future-dated row permanently won "latest reading" on every
  // dashboard and poisoned the rollup buckets and the canonical picker. The
  // past floor stays at 1900 (no `maxAgeMs`) because a historical Apple
  // Health backfill is a legitimate, expected shape on this route; only the
  // future side is a bug. Skipped per entry, like the range guard above.
  if (!isPlausibleEntryInstant(mapped.takenAt)) {
    return {
      index,
      status: "skipped",
      reason: "implausible_timestamp",
    };
  }

  // The go-forward aggregated heart-rate wire contract (iOS #34). A
  // `stats:HKQuantityTypeIdentifierHeartRate:<10-min-ISO-Z>` row is the
  // 10-minute-average PULSE bucket; it rides the generic `stats:` overwrite
  // path so a within-bucket re-post (the running mean shifts) replaces the
  // value instead of duplicating. Reject a row that targets a bucket prefix
  // but carries a malformed suffix — a garbage suffix would mint an
  // un-overwriteable row the next re-post can't collapse onto. A well-formed
  // bucket (and every non-bucket `stats:` / per-sample `uuid` externalId)
  // passes through unchanged.
  if (
    targetsAggregatedBucket(entry.externalId) &&
    !isAggregatedBucketExternalId(entry.externalId)
  ) {
    return {
      index,
      status: "skipped",
      reason: "malformed_hr_bucket_id",
    };
  }

  // The per-bucket MIN / MAX are persisted ONLY on a well-formed 10-min
  // aggregated bucket row. A per-sample reading, a per-day cumulative
  // `stats:` total, or a manual entry never carries a spread, so we pin them
  // to null there even if a client mis-sends the fields — `value` stays the
  // single source of truth for those rows.
  //
  // The spread is validated the same way `value` is guarded (above): it
  // drives the DAY min/max band + the intraday envelope, so an out-of-range
  // or mis-ordered spread (a spurious `discreteMin` of 0, a sensor glitch)
  // would poison the aggregate exactly like a bogus `value` would. Persist
  // the spread ONLY when both extremes are present, in range, and correctly
  // ordered around `value`; otherwise drop to null and keep the trustworthy
  // average. Partial or invalid spread → avg-only, still valid.
  const isHrBucket = isAggregatedBucketExternalId(entry.externalId);
  const spreadValid =
    isHrBucket &&
    typeof mapped.valueMin === "number" &&
    typeof mapped.valueMax === "number" &&
    validateMeasurementRange(mapped.type, mapped.valueMin) === null &&
    validateMeasurementRange(mapped.type, mapped.valueMax) === null &&
    mapped.valueMin <= mapped.value &&
    mapped.value <= mapped.valueMax;
  const valueMin = spreadValid ? mapped.valueMin : null;
  const valueMax = spreadValid ? mapped.valueMax : null;

  return {
    index,
    entry,
    row: {
      userId,
      type: mapped.type,
      value: mapped.value,
      valueMin,
      valueMax,
      unit: mapped.unit,
      // Honour the per-entry source tag, defaulting to `APPLE_HEALTH` when
      // absent so legacy callers are unchanged.
      //
      // A scoped credential gets `EXTERNAL`, and can hold no other value: the
      // route refused any body that named one, so nothing asserted is being
      // discarded here. The value has to move with the credential rather
      // than with the route, because the route serves both the phone and a
      // third-party bridge. It also moves the dedup key to
      // `(userId, type, EXTERNAL, externalId)`, which is the isolated
      // namespace this source exists to give.
      source: scoped ? EXTERNAL_SOURCE : (entry.source ?? "APPLE_HEALTH"),
      // The token an EXTERNAL row came from (#1272); null for the phone.
      ingestTokenId,
      measuredAt: mapped.takenAt,
      externalId: entry.externalId,
      externalSourceVersion: entry.externalSourceVersion ?? null,
      sleepStage: mapped.sleepStage ?? null,
      // Categorical events: the device's own verdict / severity for an EVENT
      // row; null for every continuous reading.
      rhythmClassification: mapped.rhythmClassification ?? null,
      // The iOS-supplied device-type, passed through to the row. Stays null
      // for builds that do not send it; the canonical picker treats null as
      // `unknown` so legacy ingest keeps working without a server-side
      // default.
      deviceType: entry.deviceType ?? null,
    },
  };
}
