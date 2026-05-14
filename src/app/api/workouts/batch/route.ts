/**
 * `POST /api/workouts/batch` — typed workout ingest with nested route.
 *
 * Consumers (v1.5):
 *   1. The native iOS app draining its HealthKit observer queue —
 *      maps `HKWorkout` + `HKWorkoutRoute` samples into the request
 *      shape locked by `createBatchWorkoutSchema` in
 *      `src/lib/validations/workout.ts`.
 *   2. The Withings activity sync (W17b, deferred) — server-to-server
 *      ingest with `source: "WITHINGS"` and `externalId` formatted as
 *      `"${withings.id}:${withings.model_id ?? "0"}:${withings.startdate}"`.
 *      Withings ships no route geometry, so the nested `route` is
 *      always absent for WITHINGS-sourced entries.
 *
 * Cross-cutting concerns mirror `/api/measurements/batch` so the iOS
 * sync engine can re-use the same retry / cursor plumbing:
 *   - `requireAuth()` — cookie + Bearer (narrow-scope-token safe per
 *     v1.4.25 W10 fix-C: when the route declares no scope, any
 *     authenticated token passes).
 *   - `withIdempotency` — `Idempotency-Key` header replays the cached
 *     response on retry (24h window).
 *   - `checkRateLimit("workouts:batch:${user.id}", 60, 60s)` — same
 *     window as the measurements batch. 60 batches/min × 100
 *     workouts/batch = 6 000 workouts/min headroom (orders of
 *     magnitude past any healthy iOS sync).
 *   - `Content-Length` ceiling at 5 MB before parsing — anything
 *     larger returns 413 so the iOS client falls back to one workout
 *     per call.
 *   - Per-entry status (`inserted | duplicate | skipped`) so the iOS
 *     sync cursor can checkpoint accurately.
 *
 * Idempotency contract:
 *   - HTTP-level via `Idempotency-Key` (replays cached envelope).
 *   - Per-entry via the `@@unique([userId, source, externalId])`
 *     composite index. Re-posting the same batch surfaces duplicates
 *     rather than failing the call.
 *
 * Race reconciliation (mirrors the measurements batch fix from
 * v1.4.25 W10): under contention, `createMany` with `skipDuplicates`
 * absorbs duplicate-key conflicts but cannot tell us WHICH rows it
 * absorbed. We trust the `createMany.count` return value and downgrade
 * enough per-entry "inserted" statuses to "duplicate" so the envelope
 * sums stay consistent with the aggregate counts. The iOS sync cursor
 * advances past both statuses identically.
 *
 * Prompt-injection surface: `Workout.metadata` is opaque — the Coach
 * pipeline reads typed columns only (`sportType`, `durationSec`,
 * distance, HR). A future change that pulls metadata into the Coach
 * prompt must add deliberate escaping; the ingest path stores it raw.
 */
import { NextRequest } from "next/server";

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
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import {
  createBatchWorkoutSchema,
  MAX_WORKOUTS_PER_BATCH,
} from "@/lib/validations/workout";
import { Prisma } from "@/generated/prisma/client";

// v1.4.25 W16c — push-suppression threshold for workout PRs. A batch
// larger than this fires the detection job with `silent: true` so a
// multi-year HKWorkout backfill doesn't spam the user with hundreds of
// pushes. Matches the measurements-batch threshold so behaviour stays
// uniform across both ingest paths.
const PR_DETECTION_SILENT_THRESHOLD = 50;

// v1.4.25 W10 reconcile (security H-2 parity): cap batch ingest at 60
// batches per user per minute. Healthy iOS sync drains its HealthKit
// observer queue in well under one batch per minute (the observer
// pattern coalesces); 60/min × 100 workouts/batch = 6 000 workouts/
// min headroom — generous for legitimate use, and a hard stop for a
// leaked wildcard token trying to saturate the write pipeline.
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// 5 MB request-body ceiling. The route geometry is the largest tail in
// a workout payload; with the 20 000-point cap on a single LineString
// AND the 100-workout cap per batch, the worst-case body is bounded
// well below this ceiling for typical lon/lat encodings. A request
// above this ceiling almost certainly indicates a misbehaving client
// or an attempted DoS — return 413 so the iOS client falls back to
// one-workout-per-call.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Per-entry outcome the iOS client uses to advance its sync cursor.
 * `inserted` and `duplicate` both indicate the row landed (or was
 * already present); the client can checkpoint past them identically.
 * `skipped` covers entries the server cannot durably store — currently
 * unused by this endpoint (the Zod schema rejects malformed entries
 * with a 422 before we reach the per-entry pass), but reserved on the
 * envelope so the response shape parallels the measurements batch and
 * future server-side validation can surface fine-grained skips without
 * breaking the iOS DTO.
 */
type EntryStatus = "inserted" | "duplicate" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBatch));

async function postBatch(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  // Content-Length pre-flight. The body cap exists to bound the
  // request-pipeline cost BEFORE Node has to read the full payload —
  // a misbehaving client shipping a 50 MB body shouldn't tie up the
  // worker for a parse it'd reject anyway. We trust the header here
  // because Next.js / undici populates it for any client that sets a
  // body length; for chunked uploads (no Content-Length) we fall
  // through and rely on the schema-level point / workout caps to keep
  // memory bounded.
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_BODY_BYTES) {
      annotate({
        action: { name: "workout.batch.ingest" },
        meta: { outcome: "payload_too_large", bytes: parsedLength },
      });
      return apiError(
        `Request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
        413,
        { errorCode: "workout.batch.payload_too_large" },
      );
    }
  }

  // v1.4.25 W10 reconcile (security H-2 parity): per-user rate limit.
  // Without it, a leaked wildcard iOS token can sustain unbounded
  // writes (100 workouts/batch × N batches/sec) and degrade the
  // database for every other user on the host. 60 batches/min/user is
  // generous for healthy iOS sync and tight enough that a misbehaving
  // client bottoms out within a minute.
  const rl = await checkRateLimit(
    `workouts:batch:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "workout.batch.ingest" },
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
    "workouts" in rawBody &&
    Array.isArray((rawBody as { workouts: unknown }).workouts) &&
    (rawBody as { workouts: unknown[] }).workouts.length >
      MAX_WORKOUTS_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_WORKOUTS_PER_BATCH}-workout limit`,
      400,
      { errorCode: "workout.batch.too_large" },
    );
  }

  const parsed = createBatchWorkoutSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return apiError(issue?.message ?? "Invalid batch", 400, {
      errorCode: "workout.batch.invalid",
    });
  }

  const { workouts } = parsed.data;

  // Pre-flight duplicate detection so we can return per-entry status.
  // The composite unique index is `(userId, source, externalId)` —
  // entries without an `externalId` cannot collide on the key (NULL-
  // distinct semantics), so they always insert as new rows.
  type Prepared = {
    index: number;
    row: Prisma.WorkoutCreateManyInput;
    route: {
      geometry: unknown;
      sampleTimestamps: unknown;
    } | null;
    /** Composite-key probe for the pre-flight findMany. NULL when
     *  the entry has no externalId — those rows always pass through
     *  as "inserted" because the NULL-distinct unique index can never
     *  collide them. */
    dedupKey: { source: string; externalId: string } | null;
  };

  const results: EntryResult[] = new Array(workouts.length);
  const prepared: Prepared[] = workouts.map((w, index) => {
    const durationSec = Math.max(
      0,
      Math.round((w.endedAt.getTime() - w.startedAt.getTime()) / 1000),
    );
    const route = w.route
      ? {
          geometry: w.route.geometry as unknown,
          sampleTimestamps: (w.route.sampleTimestamps ?? null) as unknown,
        }
      : null;
    const row: Prisma.WorkoutCreateManyInput = {
      userId: user.id,
      sportType: w.sportType,
      startedAt: w.startedAt,
      endedAt: w.endedAt,
      durationSec,
      totalEnergyKcal: w.totalEnergyKcal ?? null,
      totalDistanceM: w.totalDistanceM ?? null,
      avgHeartRate: w.avgHeartRate ?? null,
      maxHeartRate: w.maxHeartRate ?? null,
      minHeartRate: w.minHeartRate ?? null,
      stepCount: w.stepCount ?? null,
      elevationM: w.elevationM ?? null,
      pauseDurationSec: w.pauseDurationSec ?? null,
      source: w.source,
      externalId: w.externalId ?? null,
      externalSourceVersion: w.externalSourceVersion ?? null,
      metadata: w.metadata
        ? (w.metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    };
    return {
      index,
      row,
      route,
      dedupKey: w.externalId
        ? { source: w.source, externalId: w.externalId }
        : null,
    };
  });

  let insertedCount = 0;
  let duplicateCount = 0;

  if (prepared.length > 0) {
    const dedupCandidates = prepared
      .map((p) => p.dedupKey)
      .filter((k): k is { source: string; externalId: string } => k !== null);

    const existing = dedupCandidates.length
      ? await prisma.workout.findMany({
          where: {
            userId: user.id,
            OR: dedupCandidates.map((k) => ({
              source: k.source as Prisma.WorkoutCreateManyInput["source"],
              externalId: k.externalId,
            })),
          },
          select: { source: true, externalId: true },
        })
      : [];

    const existingSet = new Set(
      existing.map((row) => `${row.source}::${row.externalId}`),
    );

    const toInsert: Prepared[] = [];
    for (const p of prepared) {
      const keyTuple = p.dedupKey
        ? `${p.dedupKey.source}::${p.dedupKey.externalId}`
        : null;
      if (keyTuple !== null && existingSet.has(keyTuple)) {
        results[p.index] = { index: p.index, status: "duplicate" };
        duplicateCount += 1;
      } else {
        results[p.index] = { index: p.index, status: "inserted" };
        toInsert.push(p);
      }
    }

    if (toInsert.length > 0) {
      // Two-step write: createMany the workout rows, then findMany the
      // freshly-inserted rows to recover their ids so the route table
      // can be populated by FK. We chunk both steps for parity with the
      // measurements path and to keep individual SQL statements bounded
      // under Postgres's 65k-parameter cap.
      const CHUNK = 100;

      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < toInsert.length; i += CHUNK) {
          const slice = toInsert.slice(i, i + CHUNK);
          const result = await tx.workout.createMany({
            data: slice.map((p) => p.row),
            skipDuplicates: true,
          });
          insertedCount += result.count;
        }

        // Look up the workouts we just wrote (or that the racing batch
        // wrote) so we can attach routes by FK. We probe by the
        // composite unique key for entries that have one, and by the
        // `(userId, source, startedAt, sportType)` tuple as a fallback
        // for manual entries (where externalId is null). The fallback
        // is best-effort — manual entries from the iOS client always
        // carry an HK uuid, so the null-externalId case is exercised
        // only by future surface (manual workout entry).
        const routeAttachable = toInsert.filter((p) => p.route !== null);
        if (routeAttachable.length > 0) {
          const withExternal = routeAttachable.filter(
            (p) => p.dedupKey !== null,
          );
          const withoutExternal = routeAttachable.filter(
            (p) => p.dedupKey === null,
          );

          const lookedUp = withExternal.length
            ? await tx.workout.findMany({
                where: {
                  userId: user.id,
                  OR: withExternal.map((p) => ({
                    source: p.dedupKey!
                      .source as Prisma.WorkoutCreateManyInput["source"],
                    externalId: p.dedupKey!.externalId,
                  })),
                },
                select: {
                  id: true,
                  source: true,
                  externalId: true,
                },
              })
            : [];

          const idBySourceExt = new Map<string, string>();
          for (const row of lookedUp) {
            if (row.externalId !== null) {
              idBySourceExt.set(`${row.source}::${row.externalId}`, row.id);
            }
          }

          // Manual entries — `externalId` is null and the unique index
          // is NULL-distinct, so two manual entries on the same instant
          // would both insert. We look these up by the deterministic
          // (userId, source, startedAt, sportType) tuple for each row.
          const manualMatches = await Promise.all(
            withoutExternal.map((p) =>
              tx.workout.findFirst({
                where: {
                  userId: user.id,
                  source: p.row.source,
                  startedAt: p.row.startedAt as Date,
                  sportType: p.row.sportType,
                  route: null,
                },
                select: { id: true },
                orderBy: { createdAt: "desc" },
              }),
            ),
          );

          const routesToInsert: Prisma.WorkoutRouteCreateManyInput[] = [];
          for (let i = 0; i < withExternal.length; i++) {
            const p = withExternal[i];
            const id = idBySourceExt.get(
              `${p.dedupKey!.source}::${p.dedupKey!.externalId}`,
            );
            if (id && p.route) {
              routesToInsert.push({
                workoutId: id,
                geometry: p.route.geometry as Prisma.InputJsonValue,
                sampleTimestamps:
                  p.route.sampleTimestamps === null
                    ? Prisma.JsonNull
                    : (p.route.sampleTimestamps as Prisma.InputJsonValue),
              });
            }
          }
          for (let i = 0; i < withoutExternal.length; i++) {
            const p = withoutExternal[i];
            const match = manualMatches[i];
            if (match?.id && p.route) {
              routesToInsert.push({
                workoutId: match.id,
                geometry: p.route.geometry as Prisma.InputJsonValue,
                sampleTimestamps:
                  p.route.sampleTimestamps === null
                    ? Prisma.JsonNull
                    : (p.route.sampleTimestamps as Prisma.InputJsonValue),
              });
            }
          }

          if (routesToInsert.length > 0) {
            for (let i = 0; i < routesToInsert.length; i += CHUNK) {
              await tx.workoutRoute.createMany({
                data: routesToInsert.slice(i, i + CHUNK),
                // 1:1 FK — `workoutId` has a UNIQUE index, so the
                // composite unique guards routes too. `skipDuplicates`
                // means a re-submitted batch that wins the race on the
                // workout row but loses on the route is a no-op rather
                // than a hard error.
                skipDuplicates: true,
              });
            }
          }
        }
      });

      // v1.4.25 W10 reconcile (senior-dev H-1 parity): when two batches
      // race on overlapping externalIds, only one row lands per key.
      // `createMany.count` is the source of truth for how many rows
      // THIS request wrote; downgrade enough per-entry "inserted"
      // statuses to "duplicate" so the per-entry envelope sums match
      // the aggregate counts. Order doesn't matter — the iOS sync
      // cursor advances past both statuses identically.
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

  await auditLog("workout.batch.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: workouts.length,
      inserted: insertedCount,
      duplicates: duplicateCount,
      skipped: skipped.length,
    },
  });

  // v1.4.25 W16c — kick off PR detection for this user. Suppress push
  // notifications for historical-backfill batches so a multi-year
  // HKWorkout import doesn't fire hundreds of pushes during initial
  // sync. The detector also scans Measurement history on the same
  // pass, so a workout-only batch still surfaces measurement-side PRs
  // the user may have racked up since the last detection.
  if (insertedCount > 0 || duplicateCount > 0) {
    const silent = workouts.length > PR_DETECTION_SILENT_THRESHOLD;
    try {
      await enqueuePrDetection(user.id, { silent });
      await auditLog("personal_records.detection_enqueued", {
        userId: user.id,
        details: {
          source: "workout.batch",
          batchSize: workouts.length,
          silent,
        },
      });
    } catch (err) {
      annotate({
        action: { name: "personal_records.detection_enqueue_failed" },
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  annotate({
    action: { name: "workout.batch.ingest" },
    meta: {
      processed: workouts.length,
      inserted: insertedCount,
      duplicates: duplicateCount,
      skipped: skipped.length,
    },
  });

  return apiSuccess({
    processed: workouts.length,
    inserted: insertedCount,
    duplicates: duplicateCount,
    skipped,
    entries: results,
  });
}
