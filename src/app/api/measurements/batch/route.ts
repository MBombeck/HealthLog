/**
 * `POST /api/measurements/batch` — Apple Health batch ingest.
 *
 * The iOS HealthLog app drains its HealthKit observer queue into this
 * endpoint. Each entry is a HealthKit sample dressed in a thin
 * envelope (identifier, value, unit, start/end dates, optional sleep
 * stage codepoint, opaque external id). The server maps each entry
 * through `mapAppleHealthEntry()`, inserts it as a `Measurement` row
 * with `source = APPLE_HEALTH`, and returns a per-entry status so the
 * client can advance its sync cursor accurately.
 *
 * Idempotency contract:
 *   - A single batch is dedupable end-to-end via `Idempotency-Key` —
 *     an HTTP-level retry replays the cached response.
 *   - Individual entries are dedupable via the
 *     `(user_id, type, source, external_id)` composite unique index —
 *     a partial-success retry, or two devices uploading the same
 *     HealthKit sample, surface as `duplicate` per entry instead of
 *     hard-failing the batch.
 *   - v1.5.0 issue #213 — entries whose `externalId` starts with
 *     `stats:` are aggregate rows the iOS HealthKit observer re-posts as
 *     the underlying window fills. Two granularities ride the same
 *     overwrite mechanism:
 *       · per-day cumulative totals — `stats:<HK>:<YYYY-MM-DD>` (Steps,
 *         Active Energy, Sleep Duration, Walking/Running Distance,
 *         Flights Climbed);
 *       · v1.19.0 (iOS #34) hourly heart-rate buckets —
 *         `stats:HKQuantityTypeIdentifierHeartRate:<bucket-start-hour>`
 *         carrying the hour's AVERAGE bpm as one PULSE row, so iOS stops
 *         uploading one row per raw HR sample.
 *     Both surface as `updated` (the row's value is overwritten) rather
 *     than `duplicate` (the new value dropped). Sample-class externalIds
 *     (every other prefix) keep the strict immutable `duplicate`
 *     contract.
 */
import { NextRequest } from "next/server";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import {
  mapAppleHealthEntry,
  isAggregatedBucketExternalId,
  targetsAggregatedBucket,
} from "@/lib/measurements/apple-health-mapping";
import {
  MEASURED_AT_TOLERANCE_MS,
  isMergeableSource,
  isSameReadingAcrossSource,
  oppositeMergeSource,
  type MergeCandidate,
} from "@/lib/measurements/cross-source-merge";
import { reconcileExternalMeasurement } from "@/lib/measurements/reconcile-external-measurement";
import { validateMeasurementRange } from "@/lib/validations/measurement";
import { deviceTypeEnum } from "@/lib/validations/source-priority";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { groupRowsByArrivalKind } from "@/lib/arrivals/measurement-kind";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import {
  recomputeBucketsForMeasurement,
  collapseToTypeDayKeys,
} from "@/lib/rollups/measurement-rollups";
import { Prisma, type MeasurementType } from "@/generated/prisma/client";

// v1.4.25 W16c — historical-backfill threshold for PR push
// suppression. A batch larger than this fires the detection job with
// `silent: true` so a multi-year Apple Health backfill writes records
// without spamming the user with hundreds of pushes. Tuned generously
// — a healthy daily-sync batch is typically well under 50 entries.
const PR_DETECTION_SILENT_THRESHOLD = 50;

const MAX_BATCH_ENTRIES = 500;

// Body-size ceiling backstopping the per-entry cap. A worst-case entry
// (max-length hkIdentifier + unit + externalId + two ISO dates + the
// numeric fields) serialises to well under 1 KB, so a legitimate
// 500-entry batch tops out a few hundred KB. 4 MB leaves an order of
// magnitude of headroom above any real batch while still rejecting a
// multi-megabyte payload before it reaches `JSON.parse` and the heap.
// The cap is a DoS ceiling, not a tight bound.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// v1.4.25 W10 reconcile (security H-2): cap batch ingest at 60
// batches per user per minute. Healthy iOS sync drains its
// HealthKit observer queue in well under one batch per minute (the
// observer pattern coalesces), so 60/min × 500 entries/batch =
// 30 000 rows/min headroom — generous for legitimate use, and a
// hard stop for a leaked wildcard token trying to saturate the
// write pipeline.
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// v1.8.6 W6 — the set of `source` values this client-facing ingest
// route accepts. Deliberately narrower than the full `MeasurementSource`
// enum: `WITHINGS` and `IMPORT` are server-owned (the Withings webhook
// and the CSV importer mint those rows respectively), so letting an iOS
// client forge rows attributed to them would let an authenticated client
// pollute the per-source canonical picker with rows the server never saw
// from those integrations. The standalone iOS client only needs to tag
// its own adopt-on-pair backfill as `MANUAL` vs the default
// `APPLE_HEALTH` passthrough, so we accept exactly that pair.
const batchSourceEnum = z.enum(["APPLE_HEALTH", "MANUAL"]);

const batchEntrySchema = z.object({
  hkIdentifier: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.string().min(1).max(60),
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true }),
  sleepStage: z.number().int().min(0).max(20).optional(),
  // v1.10.0 — categorical events (WX-B). The integer `HKCategoryValue`
  // codepoint for an EVENT-class category sample (irregular-rhythm,
  // high/low-HR, walking-steadiness, breathing-disturbance). Carries the
  // device's own verdict / severity; resolved to a `rhythmClassification`
  // by `mapAppleHealthEntry`. Ignored for every non-event identifier.
  categoryValue: z.number().int().min(0).max(20).optional(),
  // v1.19.2 (iOS #34 extension) — per-bucket spread for the hourly
  // heart-rate bucket. `value` carries the hour's AVERAGE bpm; these carry
  // the hour's MIN / MAX so a client renders the intra-hour band without
  // re-uploading raw samples. Persisted ONLY on a well-formed
  // `stats:HKQuantityTypeIdentifierHeartRate:<hour>` row; ignored (stored
  // NULL) for every other entry. Optional + backward-compatible: a pre-W192
  // iOS build omits them and the bucket keeps the avg-only contract.
  valueMin: z.number().finite().optional(),
  valueMax: z.number().finite().optional(),
  externalId: z.string().min(1).max(120),
  externalSourceVersion: z.string().min(1).max(120).optional(),
  // v1.8.6 W6 — optional per-entry source tag. Defaults to
  // `APPLE_HEALTH` so every pre-W6 caller (web + current iOS) stays
  // byte-for-byte unchanged. The iOS standalone adopt-on-pair backfill
  // sends `MANUAL` for rows the user entered by hand on-device so they
  // are not mis-attributed to HealthKit. `source` is part of the
  // `(userId, type, source, externalId)` dedup key, so a `MANUAL` row
  // and an `APPLE_HEALTH` row sharing an externalId are distinct rows.
  source: batchSourceEnum.optional(),
  // v1.4.25 W8c — optional device-type tag. The iOS client maps the
  // `HKDevice.model` of each sample to one of the canonical device
  // classes (watch | band | ring | phone | scale | other | unknown).
  // Backward-compatible: every pre-W8c iOS build skips the field and
  // the row is stored with `deviceType = null`; the canonical picker
  // treats null as `unknown` and only uses it as a tiebreaker when a
  // ranked device-type coexists in the same daily bucket.
  deviceType: deviceTypeEnum.nullable().optional(),
});

const batchPayloadSchema = z.object({
  entries: z.array(batchEntrySchema).min(1),
});

type BatchEntry = z.infer<typeof batchEntrySchema>;

/**
 * Per-entry outcome the iOS client uses to advance its sync cursor.
 * `inserted` and `duplicate` both indicate the row landed (or was
 * already present), so the client can checkpoint past them. `updated`
 * is the per-day-aggregate overwrite path: when the iOS client re-posts
 * a `stats:*` cumulative row (Steps, Active Energy, Sleep Duration,
 * Walking/Running Distance, Flights Climbed — see issue #213) for a day
 * we already have, the server overwrites the row's `value` rather than
 * dropping the new payload as a duplicate. Sample-class rows (every
 * other HK metric) keep the strict `duplicate` semantics because each
 * sample is a canonical, immutable reading. `skipped` is a validation no-op;
 * `failed` is a hard database verdict and must not be checkpointed as landed.
 */
type EntryStatus = "inserted" | "updated" | "duplicate" | "skipped" | "failed";

// v1.5.0 issue #213 — `stats:*` externalIds carry per-day cumulative
// totals that the iOS HealthKit observer re-posts as the day progresses.
// Treating those as immutable duplicates freezes the day's tile at the
// first-sync value. Sample-class externalIds (every other prefix) keep
// the strict insert-only contract.
const STATS_EXTERNAL_ID_PREFIX = "stats:";
function isStatsExternalId(externalId: string | null | undefined): boolean {
  return (
    typeof externalId === "string" &&
    externalId.startsWith(STATS_EXTERNAL_ID_PREFIX)
  );
}
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBatch));

async function postBatch(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  // v1.4.25 W10 reconcile (security H-2): per-user rate limit. Without
  // it, a leaked wildcard iOS token can sustain unbounded writes
  // (500 rows/batch × N batches/sec) and degrade the database for
  // every other user on the host. 60 batches/min/user is generous
  // for healthy iOS sync and tight enough that a misbehaving client
  // bottoms out within a minute.
  const rl = await checkRateLimit(
    `measurements:batch:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "measurement.batch.ingest" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many batch submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson<unknown>(request, {
    maxBytes: MAX_BODY_BYTES,
  });
  if (jsonError) return jsonError;

  // Distinguish "too many entries" from "validation failed" so the
  // client surfaces a useful diagnostic. The cap stops a buggy client
  // from saturating the request pipeline; the iOS app paginates above
  // this threshold.
  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_BATCH_ENTRIES
  ) {
    return apiError(`Batch exceeds the ${MAX_BATCH_ENTRIES}-entry limit`, 422, {
      errorCode: "measurement.batch.too_large",
    });
  }

  const parsed = batchPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid batch", 422);
  }

  const { entries } = parsed.data;

  // First pass — map each inbound entry; record skipped entries.
  type Prepared = {
    index: number;
    entry: BatchEntry;
    row: Prisma.MeasurementCreateManyInput;
  };
  const prepared: Prepared[] = [];
  const results: EntryResult[] = new Array(entries.length);

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
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
      results[index] = {
        index,
        status: "skipped",
        reason: "unmappable_identifier",
      };
      continue;
    }

    // Plausibility-range guard. We tolerate "out of plausible range"
    // by skipping rather than failing the batch — a single bogus
    // sensor reading shouldn't poison an otherwise clean ingest.
    const rangeError = validateMeasurementRange(mapped.type, mapped.value);
    if (rangeError !== null) {
      results[index] = {
        index,
        status: "skipped",
        reason: "value_out_of_range",
      };
      continue;
    }

    // v1.30.7 (iOS #34) — go-forward aggregated heart-rate wire
    // contract. A `stats:HKQuantityTypeIdentifierHeartRate:<10-min-ISO-Z>`
    // row is the 10-minute-average PULSE bucket; it rides the generic
    // `stats:` overwrite path below so a within-bucket re-post (the running
    // mean shifts) replaces the value instead of duplicating. Reject a row
    // that targets a bucket prefix but carries a malformed suffix — a
    // garbage suffix would mint an un-overwriteable row the next re-post
    // can't collapse onto. A well-formed bucket (and every non-bucket
    // `stats:` / per-sample `uuid` externalId) passes through unchanged.
    if (
      targetsAggregatedBucket(entry.externalId) &&
      !isAggregatedBucketExternalId(entry.externalId)
    ) {
      results[index] = {
        index,
        status: "skipped",
        reason: "malformed_hr_bucket_id",
      };
      continue;
    }

    // v1.30.7 (iOS #34) — the per-bucket MIN / MAX are persisted ONLY on a
    // well-formed 10-min aggregated bucket row. A per-sample reading, a
    // per-day cumulative `stats:` total, or a manual entry never carries a
    // spread, so we pin them to null there even if a client mis-sends the
    // fields — `value` stays the single source of truth for those rows.
    //
    // v1.30.8 — validate the spread the same way `value` is guarded (above):
    // it now drives the DAY min/max band + the intraday envelope, so an
    // out-of-range or mis-ordered spread (a spurious `discreteMin` of 0, a
    // sensor glitch) would poison the aggregate exactly like a bogus `value`
    // would. Persist the spread ONLY when both extremes are present, in range,
    // and correctly ordered around `value`; otherwise drop to null and keep the
    // trustworthy average. Partial or invalid spread → avg-only, still valid.
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

    prepared.push({
      index,
      entry,
      row: {
        userId: user.id,
        type: mapped.type,
        value: mapped.value,
        valueMin,
        valueMax,
        unit: mapped.unit,
        // v1.8.6 W6 — honour the per-entry source tag, defaulting to
        // `APPLE_HEALTH` when absent so legacy callers are unchanged.
        source: entry.source ?? "APPLE_HEALTH",
        measuredAt: mapped.takenAt,
        externalId: entry.externalId,
        externalSourceVersion: entry.externalSourceVersion ?? null,
        sleepStage: mapped.sleepStage ?? null,
        // v1.10.0 — categorical events (WX-B). The device's own verdict /
        // severity for an EVENT row; null for every continuous reading.
        rhythmClassification: mapped.rhythmClassification ?? null,
        // v1.4.25 W8c — pass the iOS-supplied device-type through to
        // the row. Stays null for pre-W8c iOS builds; the canonical
        // picker treats null as `unknown` so legacy ingest keeps
        // working without a server-side default.
        deviceType: entry.deviceType ?? null,
      },
    });
  }

  let insertedCount = 0;
  let updatedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;
  // v1.11.4 (iOS #2) — subset of `duplicateCount` collapsed by the
  // MANUAL↔APPLE_HEALTH same-reading merge (as opposed to a plain
  // composite-key duplicate). Surfaced as a dedicated wide-event count so
  // an operator can see how often the standalone-pair mirror collapses.
  let crossSourceMergedCount = 0;
  // Only rows the reconciler actually inserted drive arrival side effects.
  const insertedPrepared: Prepared[] = [];
  const writtenIdentities: Array<{
    type: MeasurementType;
    measuredAt: Date;
  }> = [];

  if (prepared.length > 0) {
    // v1.11.4 (iOS #2) — same-reading merge for the MANUAL ↔ APPLE_HEALTH
    // mirror duplicate. When the iOS app logs a manual reading offline it
    // mirrors that reading into HealthKit; on pairing, adopt-on-pair
    // uploads it as MANUAL and HealthKit background sync independently
    // re-ingests the mirrored sample as APPLE_HEALTH. The two carry
    // different externalIds + sources, so the composite unique index lets
    // both land — duplicating the whole hand-logged history on first pair.
    // We collapse them at ingest: an incoming MANUAL / APPLE_HEALTH row is
    // dropped as a `duplicate` when a same-reading row of the OPPOSITE
    // source already exists (same type + value + measuredAt within a tight
    // ±2 s window). `stats:*` cumulative rows are excluded — those are
    // per-day aggregates the observer overwrites in place, never
    // hand-entered point readings. See `cross-source-merge.ts` for the
    // full rule + why first-physical-reading-wins (the value is identical
    // between the two rows, so only the source label differs).
    //
    // Pull the opposite-source candidate rows in one widened query: for
    // every mergeable, non-`stats:*` incoming row, look for an opposite-
    // source row of the same type whose measuredAt falls inside the
    // tolerance window. Compared in JS because the value match needs a
    // float epsilon the SQL `IN` can't express.
    const mergeProbes = prepared.filter(
      (p) =>
        isMergeableSource(p.row.source as string) &&
        !isStatsExternalId(p.row.externalId as string),
    );
    const crossSourceCandidates: MergeCandidate[] = [];
    if (mergeProbes.length > 0) {
      const candidateRows = await prisma.measurement.findMany({
        where: {
          userId: user.id,
          deletedAt: null,
          OR: mergeProbes.map((p) => {
            const measuredAt = p.row.measuredAt as Date;
            return {
              type: p.row.type as MeasurementType,
              source: oppositeMergeSource(
                p.row.source as "MANUAL" | "APPLE_HEALTH",
              ),
              measuredAt: {
                gte: new Date(measuredAt.getTime() - MEASURED_AT_TOLERANCE_MS),
                lte: new Date(measuredAt.getTime() + MEASURED_AT_TOLERANCE_MS),
              },
            };
          }),
        },
        select: { type: true, source: true, value: true, measuredAt: true },
      });
      crossSourceCandidates.push(...candidateRows);
    }

    // Rows already chosen for insert earlier in THIS batch — so a MANUAL
    // and an APPLE_HEALTH same-reading arriving in the SAME batch also
    // collapse (the DB probe above only sees rows from prior batches).
    const inBatchCandidates: MergeCandidate[] = [];
    function hasSameReadingSibling(p: Prepared): boolean {
      const incoming = {
        type: p.row.type as MeasurementType,
        source: p.row.source as string,
        value: p.row.value as number,
        measuredAt: p.row.measuredAt as Date,
      };
      if (!isMergeableSource(incoming.source)) return false;
      for (const candidate of crossSourceCandidates) {
        if (isSameReadingAcrossSource(incoming, candidate)) return true;
      }
      for (const candidate of inBatchCandidates) {
        if (isSameReadingAcrossSource(incoming, candidate)) return true;
      }
      return false;
    }

    // `stats:` rows carry overwrite semantics and the last entry in one batch
    // is authoritative. Earlier snapshots are safe duplicates.
    const lastStatsIndexByKey = new Map<string, number>();
    for (const p of prepared) {
      if (!isStatsExternalId(p.row.externalId as string)) continue;
      lastStatsIndexByKey.set(
        `${p.row.type}::${p.row.source}::${p.row.externalId}`,
        p.index,
      );
    }

    for (const p of prepared) {
      const externalId = p.row.externalId as string;
      const statsRow = isStatsExternalId(externalId);
      const key = `${p.row.type}::${p.row.source}::${externalId}`;
      if (statsRow && lastStatsIndexByKey.get(key) !== p.index) {
        results[p.index] = {
          index: p.index,
          status: "duplicate",
          reason: "superseded_in_batch",
        };
        duplicateCount++;
        continue;
      }

      if (!statsRow && hasSameReadingSibling(p)) {
        results[p.index] = {
          index: p.index,
          status: "duplicate",
          reason: "cross_source_merge",
        };
        duplicateCount++;
        crossSourceMergedCount++;
        continue;
      }

      const verdict = await prisma.$transaction((tx) =>
        reconcileExternalMeasurement(
          tx,
          {
            userId: user.id,
            type: p.row.type as MeasurementType,
            value: p.row.value as number,
            valueMin: p.row.valueMin as number | null,
            valueMax: p.row.valueMax as number | null,
            unit: p.row.unit as string,
            source: p.row
              .source as Prisma.MeasurementUncheckedCreateInput["source"],
            measuredAt: p.row.measuredAt as Date,
            externalId,
            externalSourceVersion: p.row.externalSourceVersion as string | null,
            glucoseContext: p.row
              .glucoseContext as Prisma.MeasurementUncheckedCreateInput["glucoseContext"],
            sleepStage: p.row
              .sleepStage as Prisma.MeasurementUncheckedCreateInput["sleepStage"],
            rhythmClassification: p.row
              .rhythmClassification as Prisma.MeasurementUncheckedCreateInput["rhythmClassification"],
            deviceType: p.row.deviceType as string | null,
            aggregationProvenance: statsRow ? "HEALTHKIT_STATISTICS" : null,
            aggregationContributorCount: null,
            aggregationSelectedSourceHash: null,
          },
          { exactExternalMatch: statsRow ? "update" : "duplicate" },
        ),
      );

      switch (verdict.status) {
        case "inserted":
          results[p.index] = { index: p.index, status: "inserted" };
          insertedCount++;
          insertedPrepared.push(p);
          writtenIdentities.push({
            type: p.row.type as MeasurementType,
            measuredAt: p.row.measuredAt as Date,
          });
          break;
        case "updated":
        case "resurrected":
          results[p.index] = { index: p.index, status: "updated" };
          updatedCount++;
          writtenIdentities.push(
            {
              type: p.row.type as MeasurementType,
              measuredAt: p.row.measuredAt as Date,
            },
            ...(verdict.dirtyIdentities ?? []),
          );
          break;
        case "duplicate":
          results[p.index] = { index: p.index, status: "duplicate" };
          duplicateCount++;
          break;
        case "failed":
          results[p.index] = {
            index: p.index,
            status: "failed",
            reason: verdict.error.code ?? "write_failed",
          };
          failedCount++;
          continue;
      }

      if (isMergeableSource(p.row.source as string)) {
        inBatchCandidates.push({
          type: p.row.type as MeasurementType,
          source: p.row.source as string,
          value: p.row.value as number,
          measuredAt: p.row.measuredAt as Date,
        });
      }
    }
  }

  const healthKitSyncSucceeded =
    failedCount === 0 &&
    prepared.some((p) => {
      if ((p.entry.source ?? "APPLE_HEALTH") !== "APPLE_HEALTH") return false;
      const status = results[p.index]?.status;
      return (
        status === "inserted" || status === "updated" || status === "duplicate"
      );
    });

  // This batch route is the native HealthKit ingestion boundary. Stamp only
  // after every attempted write has reached a durable, non-failed verdict;
  // MANUAL-only and skipped-only batches are not HealthKit syncs.
  if (healthKitSyncSucceeded) {
    await prisma.user.update({
      where: { id: user.id },
      data: { healthKitLastSyncedAt: new Date() },
    });
  }

  const freshlyInsertedRows = insertedPrepared.map((p) => ({
    type: p.row.type as MeasurementType,
    measuredAt:
      p.row.measuredAt instanceof Date
        ? p.row.measuredAt
        : new Date(p.row.measuredAt as string),
  }));

  const skipped = results
    .filter((r) => r.status === "skipped")
    .map((r) => ({ index: r.index, reason: r.reason ?? "unknown" }));

  await auditLog("measurement.batch.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: entries.length,
      inserted: insertedCount,
      updated: updatedCount,
      duplicates: duplicateCount,
      skipped: skipped.length,
      failed: failedCount,
    },
  });

  // v1.5.0 issue #213 — dedicated wide-event annotation so an operator
  // can grep `measurement.batch.stats-overwrite` to see how often
  // per-day cumulative rows are getting re-posted (a healthy ingest
  // flow). Only fires when at least one row was overwritten so the
  // baseline ingest trace is unchanged for batches with no `stats:*`
  // duplicates.
  if (updatedCount > 0) {
    annotate({
      action: { name: "measurement.batch.stats-overwrite" },
      meta: {
        updated: updatedCount,
        processed: entries.length,
      },
    });
  }

  // v1.11.4 (iOS #2) — dedicated annotation for the MANUAL↔APPLE_HEALTH
  // same-reading collapse so an operator can grep
  // `measurement.batch.cross-source-merge` to confirm the standalone-pair
  // mirror duplicate is being absorbed (a healthy first-pair flow). Only
  // fires when at least one row was merged so the baseline ingest trace
  // is unchanged for the common case.
  if (crossSourceMergedCount > 0) {
    annotate({
      action: { name: "measurement.batch.cross-source-merge" },
      meta: {
        merged: crossSourceMergedCount,
        processed: entries.length,
      },
    });
  }

  // v1.4.25 W16c — kick off PR detection for this user. We always
  // enqueue when at least one row was written (or the batch had any
  // measurements to consider) so a single off-day reading still gets
  // evaluated; the warm-up gate inside the detector decides whether
  // it's a record. Suppress push notifications for historical
  // backfills above the silent threshold. Updated `stats:*` rows also
  // count — a per-day-total overwrite can flip the day's value past a
  // personal record.
  if (insertedCount > 0 || updatedCount > 0 || duplicateCount > 0) {
    const silent = entries.length > PR_DETECTION_SILENT_THRESHOLD;
    // v1.18.1 — eventful Vorsorge satisfaction. A matching reading just
    // landed; resolve the user's reminders now rather than waiting on the
    // 15-min cron. Fire-and-forget — the cron reconciles on enqueue miss.
    fireAndForget(enqueueReminderSatisfy(user.id), {
      action: "reminder.satisfy.enqueue",
    });
    try {
      await enqueuePrDetection(user.id, { silent });
      await auditLog("personal_records.detection_enqueued", {
        userId: user.id,
        details: {
          source: "measurement.batch",
          batchSize: entries.length,
          silent,
        },
      });
    } catch (err) {
      // Enqueue failure is non-fatal — the 30-minute fallback cron
      // picks the user up in the next slot. Log so the operator
      // notices repeated failures in Wide-Event traffic.
      annotate({
        action: { name: "personal_records.detection_enqueue_failed" },
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  annotate({
    action: { name: "measurement.batch.ingest" },
    meta: {
      processed: entries.length,
      inserted: insertedCount,
      updated: updatedCount,
      duplicates: duplicateCount,
      skipped: skipped.length,
      failed: failedCount,
    },
  });

  // v1.4.34 IW-G — bust per-user analytics + achievements + workouts
  // caches when at least one row landed so the next read picks up the
  // ingested batch. Skipped-only ingests don't change state, so we
  // gate the invalidation on `insertedCount > 0 || updatedCount > 0`
  // — overwriting a per-day `stats:*` row changes the day's reading
  // and must invalidate every consumer that reads through this user's
  // measurements.
  if (insertedCount > 0 || updatedCount > 0) {
    // v1.18.9 (#38) — hard-evict so a focus-refetch after a background
    // iOS / Apple-Health batch sync returns post-sync data. A mark-stale
    // would let the `cachedSwr` snapshot serve the pre-batch body on the
    // very next read, leaving the dashboard up to ~180 s stale; the manual
    // measurement routes already pass `{ evict: true }` for the same reason.
    invalidateUserMeasurements(user.id, { evict: true });

    // v1.5.0 — refresh the persistent rollup table for every distinct
    // (type, day) the batch touched. Updates must participate as well as
    // inserts, so this deliberately retains the prepared-row scope. Collapsed
    // by day so a 500-row Apple Health batch fires only one recompute per
    // type/day pair. Best-effort — a populator hiccup never fails ingest.
    try {
      const insertedKeys = collapseToTypeDayKeys(writtenIdentities);
      for (const k of insertedKeys) {
        await recomputeBucketsForMeasurement(user.id, k.type, k.measuredAt);
      }

      // v1.8.0 — drop the cached per-metric assessment rows the ingested
      // types dirty so the next mount / nightly warm pass regenerates
      // them against the new data instead of serving stale text.
      // Fire-and-forget: never a blocker on the user's ingest.
      invalidateStatusInsightsForTypes(
        user.id,
        insertedKeys.map((k) => k.type),
      ).catch((err) => {
        console.warn("[measurements] status-insight invalidate failed", err);
      });
    } catch (err) {
      console.warn("[measurements] rollup recompute failed", err);
    }

    // S4 — Apple-Health sleep is the third sleep transport. If any SLEEP_DURATION
    // row for last night just landed, kick the debounced morning refresh so the
    // digest/score finalise with the current sleep. The trigger judges "last
    // night" in the user's profile tz, so a historical Apple export replaying
    // months of nights never re-triggers for an old night. Fire-and-forget.
    void maybeEnqueueMorningRefresh(
      user.id,
      freshlyInsertedRows
        .filter((row) => row.type === "SLEEP_DURATION")
        .map((row) => row.measuredAt),
    ).catch(() => {});

    // v1.31.0 — the measurement arm of the data-arrival spine.
    //
    // ONE emit per kind per request, never one per row. The batch route is the
    // Apple-Health / iOS ingest path, so it is also the single biggest backfill
    // path in the product: a ten-year export arrives here in 500-row batches.
    // Emitting per row would put thousands of classifier calls (and thousands
    // of dropped-event annotations) on the hot path for no gain, since the
    // day-scoped singleton key collapses them to one job anyway.
    //
    // Blood pressure is deliberately one arrival, not two: it is stored as two
    // rows (SYS + DIA) sharing a `measuredAt`, and a reader cares about the
    // reading, not the arms.
    //
    // Only rows the write actually INSERTED count — `updatedCount` rows are the
    // `stats:` overwrite contract re-stating a value the record already had,
    // which is not news. If nothing was inserted the classifier returns `noop`
    // and nothing is enqueued.
    for (const [kind, group] of groupRowsByArrivalKind(freshlyInsertedRows)) {
      void emitDataArrival({
        userId: user.id,
        kind,
        newestSampleAt: group.newestAt,
        insertedCount: group.count,
        source: "batch",
      }).catch(() => {});
    }
  }

  const response = apiSuccess({
    processed: entries.length,
    inserted: insertedCount,
    updated: updatedCount,
    duplicates: duplicateCount,
    failed: failedCount,
    skipped,
    entries: results,
  });
  if (failedCount > 0) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
