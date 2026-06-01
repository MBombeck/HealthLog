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
 *     `stats:` are per-day cumulative totals (Steps, Active Energy,
 *     Sleep Duration, Walking/Running Distance, Flights Climbed). The
 *     iOS HealthKit observer re-posts those throughout the day as the
 *     running total changes. They surface as `updated` (the row's
 *     value is overwritten) rather than `duplicate` (the new value
 *     dropped). Sample-class externalIds keep the strict immutable
 *     `duplicate` contract.
 */
import { NextRequest } from "next/server";
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
import { mapAppleHealthEntry } from "@/lib/measurements/apple-health-mapping";
import { validateMeasurementRange } from "@/lib/validations/measurement";
import { deviceTypeEnum } from "@/lib/validations/source-priority";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
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

// v1.4.25 W10 reconcile (security H-2): cap batch ingest at 60
// batches per user per minute. Healthy iOS sync drains its
// HealthKit observer queue in well under one batch per minute (the
// observer pattern coalesces), so 60/min × 500 entries/batch =
// 30 000 rows/min headroom — generous for legitimate use, and a
// hard stop for a leaked wildcard token trying to saturate the
// write pipeline.
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const batchEntrySchema = z.object({
  hkIdentifier: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.string().min(1).max(60),
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true }),
  sleepStage: z.number().int().min(0).max(20).optional(),
  externalId: z.string().min(1).max(120),
  externalSourceVersion: z.string().min(1).max(120).optional(),
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
 * sample is a canonical, immutable reading. `skipped` is the only case
 * where the client may want to surface a diagnostic — typically because
 * Apple introduced a new identifier the server doesn't know about yet.
 */
type EntryStatus = "inserted" | "updated" | "duplicate" | "skipped";

// v1.5.0 issue #213 — `stats:*` externalIds carry per-day cumulative
// totals that the iOS HealthKit observer re-posts as the day progresses.
// Treating those as immutable duplicates freezes the day's tile at the
// first-sync value. Sample-class externalIds (every other prefix) keep
// the strict insert-only contract.
const STATS_EXTERNAL_ID_PREFIX = "stats:";
function isStatsExternalId(externalId: string | null | undefined): boolean {
  return typeof externalId === "string" && externalId.startsWith(STATS_EXTERNAL_ID_PREFIX);
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

  const { data: rawBody, error: jsonError } = await safeJson<unknown>(request);
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

    prepared.push({
      index,
      entry,
      row: {
        userId: user.id,
        type: mapped.type,
        value: mapped.value,
        unit: mapped.unit,
        source: "APPLE_HEALTH",
        measuredAt: mapped.takenAt,
        externalId: entry.externalId,
        externalSourceVersion: entry.externalSourceVersion ?? null,
        sleepStage: mapped.sleepStage ?? null,
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

  if (prepared.length > 0) {
    // Pre-flight duplicate detection so we can return per-entry status
    // (createMany with skipDuplicates does the dedup but doesn't tell
    // us *which* rows it skipped). We look up existing rows under the
    // composite unique key first, then createMany the survivors.
    const incomingKeys = prepared.map((p) => ({
      type: p.row.type as Prisma.MeasurementCreateManyInput["type"],
      externalId: p.row.externalId as string,
    }));

    const existing = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        source: "APPLE_HEALTH",
        OR: incomingKeys.map((k) => ({
          type: k.type,
          externalId: k.externalId,
        })),
      },
      select: { type: true, externalId: true },
    });

    const existingSet = new Set(
      existing.map((row) => `${row.type}::${row.externalId}`),
    );

    const toInsert: Prisma.MeasurementCreateManyInput[] = [];
    const toOverwrite: Prepared[] = [];
    for (const p of prepared) {
      const key = `${p.row.type}::${p.row.externalId}`;
      if (existingSet.has(key)) {
        // v1.5.0 issue #213 — per-day cumulative `stats:*` rows are
        // intentionally overwritten on a re-post so today's tile reflects
        // the latest HealthKit total instead of freezing at the
        // first-sync value. Sample-class rows keep the immutable
        // duplicate contract.
        if (isStatsExternalId(p.row.externalId as string)) {
          toOverwrite.push(p);
        } else {
          results[p.index] = { index: p.index, status: "duplicate" };
          duplicateCount += 1;
        }
      } else {
        results[p.index] = { index: p.index, status: "inserted" };
        toInsert.push(p.row);
      }
    }

    if (toOverwrite.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const p of toOverwrite) {
          await tx.measurement.updateMany({
            where: {
              userId: user.id,
              source: "APPLE_HEALTH",
              type: p.row.type as MeasurementType,
              externalId: p.row.externalId as string,
            },
            data: {
              value: p.row.value as number,
              unit: p.row.unit as string,
              measuredAt: p.row.measuredAt as Date,
              externalSourceVersion: p.row.externalSourceVersion as
                | string
                | null,
              deviceType: p.row.deviceType as Prepared["row"]["deviceType"],
              sleepStage: p.row.sleepStage as Prepared["row"]["sleepStage"],
            },
          });
          results[p.index] = { index: p.index, status: "updated" };
          updatedCount += 1;
        }
      });
    }

    if (toInsert.length > 0) {
      // Chunk to keep individual SQL statements bounded — 200 rows per
      // chunk leaves headroom under Postgres' 65k-parameter cap even
      // with 9-column inserts. `skipDuplicates: true` guards against
      // races where two batch retries land in the same tick — the
      // composite unique index does the actual dedup; skipDuplicates
      // turns the duplicate-PG error into a no-op insert.
      const CHUNK = 200;
      const chunks: Prisma.MeasurementCreateManyInput[][] = [];
      for (let i = 0; i < toInsert.length; i += CHUNK) {
        chunks.push(toInsert.slice(i, i + CHUNK));
      }
      await prisma.$transaction(async (tx) => {
        for (const chunk of chunks) {
          const result = await tx.measurement.createMany({
            data: chunk,
            skipDuplicates: true,
          });
          insertedCount += result.count;
        }
      });

      // v1.4.25 W10 reconcile (senior-dev H-1): the previous "stored
      // vs not-stored" check was an effective no-op. Under standard
      // Postgres semantics, `skipDuplicates` absorbs duplicate-key
      // conflicts but the row is STILL present in the table (written
      // by the other batch that won the race). So every row we
      // attempted is in the DB after the call, and the
      // `!stored.has(...)` branch never fired — leaving the aggregate
      // `inserted` / `duplicate` counts inconsistent with the per-
      // entry statuses under contention.
      //
      // Pragmatic fix: trust the `createMany` return count. The DB
      // round-trip cannot distinguish a row this request wrote from
      // a row the racing request wrote (the unique index sees both
      // as the same key), so we cannot identify the SPECIFIC raced
      // rows. What we CAN do is preserve count integrity for the
      // iOS sync cursor: `insertedCount` is already the truth (it
      // came from `createMany.count`); we only need to downgrade
      // enough per-entry "inserted" statuses to "duplicate" so the
      // per-entry envelope sums match. Order doesn't matter — the
      // client checkpoints past both statuses, and the DB state for
      // either outcome is identical (the row is now stored,
      // single-copy).
      const racedDuplicates = toInsert.length - insertedCount;
      if (racedDuplicates > 0) {
        let downgraded = 0;
        for (const p of prepared) {
          if (downgraded >= racedDuplicates) break;
          if (results[p.index]?.status === "inserted") {
            results[p.index] = { index: p.index, status: "duplicate" };
            duplicateCount += 1;
            downgraded += 1;
          }
        }
      }
    }
  }

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
    invalidateUserMeasurements(user.id);

    // v1.5.0 — refresh the persistent rollup table for every distinct
    // (type, day) the batch touched. We use the `prepared` rows
    // because `createMany` does not return the inserted rows; the
    // (type, measuredAt) tuples on `prepared` are exactly the row
    // shape we need. Collapsed by day so a 500-row Apple Health
    // batch fires N recomputes (typically <30, one per type-day
    // pair) instead of one per row. Best-effort — a populator hiccup
    // never fails the user's ingest.
    try {
      const insertedKeys = collapseToTypeDayKeys(
        prepared.map((p) => ({
          type: p.row.type as MeasurementType,
          measuredAt:
            p.row.measuredAt instanceof Date
              ? p.row.measuredAt
              : new Date(p.row.measuredAt as string),
        })),
      );
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
  }

  return apiSuccess({
    processed: entries.length,
    inserted: insertedCount,
    updated: updatedCount,
    duplicates: duplicateCount,
    skipped,
    entries: results,
  });
}
