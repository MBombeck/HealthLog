/**
 * `POST /api/workouts/batch` — typed workout ingest with nested route.
 *
 * Consumers:
 *   1. The native iOS app draining its HealthKit observer queue —
 *      maps `HKWorkout` + `HKWorkoutRoute` samples into the request
 *      shape locked by `createBatchWorkoutSchema` in
 *      `src/lib/validations/workout.ts`.
 *   2. The Withings activity sync (W17b, deferred) — server-to-server
 *      ingest with `externalId` formatted as
 *      `"${withings.id}:${withings.model_id ?? "0"}:${withings.startdate}"`.
 *      Withings ships no route geometry, so the nested `route` is
 *      always absent for WITHINGS-sourced entries. NOTE: the request
 *      schema's `source` is narrowed to the client-writable set
 *      (MANUAL / APPLE_HEALTH), so this server path must write its
 *      `WITHINGS`-sourced rows directly via `prisma.workout.upsert`
 *      (as the WHOOP / Fitbit syncs already do), not through this route.
 *   3. A third-party bridge holding a narrow `workouts:write` token
 *      (#1054) — a watch vendor's sync relayed by a small service. Its
 *      rows are attributed `EXTERNAL`, resolved from the credential; see
 *      the source guard in the handler.
 *
 * Cross-cutting concerns mirror `/api/measurements/batch` so the iOS
 * sync engine can re-use the same retry / cursor plumbing:
 *   - `requireAuth` naming `WORKOUTS_WRITE_SCOPE` — a cookie session, a
 *     wildcard (`["*"]`) token, or a narrow `workouts:write` token. Every
 *     other narrow token is refused 403: under the fail-closed default a
 *     route admits exactly the scope it names, so a `measurements:write`
 *     credential does not reach this route.
 *   - `withIdempotency` — `Idempotency-Key` header replays the cached
 *     response on retry (24h window).
 *   - `checkRateLimit("workouts:batch:${user.id}", 60, 60s)` — same
 *     window as the measurements batch. 60 batches/min × 100
 *     workouts/batch = 6 000 workouts/min headroom (orders of
 *     magnitude past any healthy iOS sync).
 *   - `Content-Length` ceiling at 5 MB before parsing — anything
 *     larger returns 413 so the iOS client falls back to one workout
 *     per call.
 *   - Per-entry status (`inserted | duplicate | enriched | skipped`) so
 *     the iOS sync cursor can checkpoint accurately.
 *
 * Idempotency contract:
 *   - HTTP-level via `Idempotency-Key` (replays cached envelope).
 *   - Per-entry via the `@@unique([userId, source, externalId])`
 *     composite index. Re-posting the same batch surfaces duplicates
 *     rather than failing the call.
 *
 * Heart-rate series enrichment: a re-post that matches a stored
 * workout and carries a `samples` array attaches that series when the
 * workout has none. The workout row itself stays first-write-wins —
 * nothing on it is written, not one column — and a workout that already
 * holds a series is a no-op, so the client's history sweep is repeatable
 * as often as it likes. See `src/lib/workouts/batch-ingest/plan.ts`.
 *
 * Race reconciliation uses PostgreSQL's `INSERT ... RETURNING` through
 * Prisma's `createManyAndReturn`. The returned composite keys identify the
 * exact rows this request inserted, so per-entry statuses, child rows, and
 * arrival references cannot drift to a racing or same-external-id workout.
 *
 * Prompt-injection surface: `Workout.metadata` is opaque — the Coach
 * pipeline reads typed columns only (`sportType`, `durationSec`,
 * distance, HR). A future change that pulls metadata into the Coach
 * prompt must add deliberate escaping; the ingest path stores it raw.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, isScopedCredential, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { MAX_WORKOUTS_PER_BATCH } from "@/lib/validations/workout";
import { parseWorkoutBatch } from "@/lib/workouts/batch-ingest-parse";
import { ingestWorkoutBatch } from "@/lib/workouts/batch-ingest/ingest";
import { WORKOUTS_WRITE_SCOPE } from "@/lib/workouts/scopes";

// v1.4.25 (security H-2 parity): cap batch ingest at 60
// batches per user per minute. Healthy iOS sync drains its HealthKit
// observer queue in well under one batch per minute (the observer
// pattern coalesces); 60/min × 100 workouts/batch = 6 000 workouts/
// min headroom — generous for legitimate use, and a hard stop for a
// leaked wildcard token trying to saturate the write pipeline.
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// 5 MB request-body ceiling (pre-existing). The route geometry is the
// largest tail in a workout payload; a typical batch sits comfortably
// under this, but the 20 000-point LineString cap combined with the
// 100-workout batch cap allows a theoretical tens-of-MB body for an
// extreme GPS-heavy backlog. Such a body returns 413 so the iOS client
// falls back to smaller / one-workout-per-call batches — which is also
// the correct response to a misbehaving client or an attempted DoS.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBatch));

async function postBatch(request: NextRequest): Promise<Response> {
  // Declares the workout-ingest scope, so a narrow `workouts:write` token
  // reaches this route alongside cookie sessions and the wildcard tokens a
  // native login mints. The only route that names it. `requireAuth` refuses
  // any acting-account carrier for every credential shape, so the scoped token
  // is confined to its owner's own record without an arm of its own here.
  // Metered by this route's own bulk bucket below, not the shared per-account
  // write bucket: the native client syncs through here in bursts (see
  // `meterAccountWrite`).
  const auth = await requireAuth(WORKOUTS_WRITE_SCOPE, {
    writeBucket: "own",
  });
  const { user } = auth;

  // A scoped credential is a bridge, not the native client: the source of
  // its rows is resolved from the credential below rather than from the body.
  const scoped = isScopedCredential(auth);

  // v1.4.43 — resolve the per-user source-priority blob once at
  // the start of the handler so the write-time canonical-row picker
  // walks the SAME ladder the read-time picker walks. Without this
  // lookup a user who customised Settings → Sources (e.g. MANUAL >
  // APPLE_HEALTH) would see their preferred row dropped at write-
  // time before the read-time picker ever ran. One indexed
  // findUnique per batch — well under the cost of letting the
  // duplicate persist and carrying it forward on every read.
  // The same read carries the route opt-in: a GPS track is kept only when
  // the person turned `storeWorkoutRoutes` on. While it is off the workout
  // is stored and the track dropped, with the same per-entry status, so a
  // client cannot tell the two apart and needs no new branch.
  const userPriority = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sourcePriorityJson: true, storeWorkoutRoutes: true },
  });
  const keepRoutes = userPriority?.storeWorkoutRoutes === true;

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

  // v1.4.25 (security H-2 parity): per-user rate limit.
  // Without it, a leaked wildcard iOS token can sustain unbounded
  // writes (100 workouts/batch × N batches/sec) and degrade the
  // database for every other user on the host. 60 batches/min/user is
  // generous for healthy iOS sync and tight enough that a misbehaving
  // client bottoms out within a minute.
  //
  // A scoped `workouts:write` token is a bridge, not the phone, so it counts
  // in a bucket of its own: a bridge stuck in a retry loop must not use up
  // the allowance the iPhone app needs to sync the same account's workouts.
  // All bridge tokens of one account share that bucket, so minting more
  // tokens does not multiply the allowance.
  const rl = await checkRateLimit(
    scoped ? `workouts:batch:bridge:${user.id}` : `workouts:batch:${user.id}`,
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

  // The Content-Length pre-flight above bounds the common case, but a
  // chunked upload carries no Content-Length. The `safeJson` body cap
  // backstops that gap: the raw text is measured before `JSON.parse`,
  // so an over-limit chunked body returns a clean 413 before the parse
  // cost. Reuses the same 5 MB ceiling — a typical iOS batch sits under
  // it; an extreme GPS-heavy backlog that exceeds it falls back to
  // smaller batches client-side.
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

  // Strict on every field, per-entry on `samples` alone — see
  // `parseWorkoutBatch` for why the series is the one field whose
  // failure must not take the rest of a history sweep down with it.
  const parsed = parseWorkoutBatch(rawBody);
  if (!parsed.ok) {
    return apiError(parsed.message, 400, {
      errorCode: "workout.batch.invalid",
    });
  }

  // A scoped credential may attribute nothing: its rows are `EXTERNAL`,
  // resolved from the credential. Refused loudly rather than relabelled, the
  // measurement batch's rule and for its reasons. `APPLE_HEALTH` is half the
  // `(userId, source, externalId)` dedup key the phone writes into and ranks
  // first in the cross-source picker, so a bridge naming it would land in the
  // phone's namespace and could shadow the phone's own copy of a session;
  // `MANUAL` would make a bridged workout indistinguishable from one entered
  // by hand. Checked on the raw body because the schema defaults an absent
  // `source` to `MANUAL`, which would make "named" and "omitted" look alike.
  if (scoped && namesAnySource(rawBody)) {
    annotate({
      action: { name: "workout.batch.ingest" },
      meta: { outcome: "source_not_permitted" },
    });
    return apiError(
      "This credential resolves the source itself; omit the field",
      422,
      { errorCode: "workout.batch.source_not_permitted" },
    );
  }

  const { workouts } = parsed.data;
  const result = await ingestWorkoutBatch({
    userId: user.id,
    scoped,
    keepRoutes,
    sourcePriorityJson: userPriority?.sourcePriorityJson ?? null,
    workouts,
    refusedSampleIndices: new Set(parsed.refusedSampleIndices),
    ipAddress: getClientIp(request),
  });

  return apiSuccess(result);
}

/** Whether any entry of a raw batch body names a `source` at all. */
function namesAnySource(rawBody: unknown): boolean {
  if (typeof rawBody !== "object" || rawBody === null) return false;
  const workouts = (rawBody as { workouts?: unknown }).workouts;
  if (!Array.isArray(workouts)) return false;
  return workouts.some(
    (w) =>
      typeof w === "object" &&
      w !== null &&
      (w as { source?: unknown }).source !== undefined,
  );
}
