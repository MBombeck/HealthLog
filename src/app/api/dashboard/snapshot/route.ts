/**
 * GET /api/dashboard/snapshot
 *
 * v1.7.0 — unified above-the-fold first-paint payload for the web
 * dashboard. One `apiHandler`-wrapped GET that assembles every tile
 * field in a single round-trip via `buildDashboardSnapshot` so the
 * whole strip shares one completion moment instead of the legacy
 * four-cell waterfall (slim analytics + thick analytics + mood + widget
 * layout, each gated behind `/api/auth/me`).
 *
 * Cookie OR Bearer auth via `requireAuth()`; the dashboard is a
 * cookie-session surface but the route does not gate on it. `userId`
 * is narrowed from the resolved session — never a body field.
 *
 * The body is read-through `caches.analytics` (stale-while-revalidate
 * via `cachedSwr`) keyed `${userId}|dashboard-snapshot`, with a per-key
 * TTL of `SNAPSHOT_CACHE_TTL_MS` (>= the client's 120 s refetch
 * interval) so a scheduled refetch lands on a warm entry instead of
 * re-running the full builder on every tick. It still rides the
 * analytics bucket so a measurement / mood / medication write covers it
 * (see `src/lib/cache/invalidate.ts`): a measurement write marks the
 * bucket stale (the high-frequency iOS-sync path serves the prior
 * snapshot + warms a background recompute), while a widget reorder still
 * hard-evicts so the layout change paints synchronously. Per-sub-query
 * timings surface under `meta.snapshot.sub_*_ms` on the cache-miss path
 * so a regression is attributable without re-instrumenting.
 *
 * No LLM is reachable from the builder — the daily briefing is lifted
 * read-only from `User.insightsCachedTextEncrypted`. The nightly
 * `insight-pregenerate` cron keeps that cache warm.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";
import { ownRecord } from "@/lib/own-key";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // The record's tile strip, and the reason `/` is a shared destination at
  // all. A delegate who cannot read this reads an empty dashboard under a
  // banner naming the person whose record they just opened.
  //
  // The aggregate objection — a summary can carry a finding from a module the
  // grant does not cover — is void while a grant is whole-record and
  // all-or-nothing: there is no module the delegate may not read directly.
  // This is the WIDEST aggregate in the product, so when per-module scope
  // lands it is the first route to re-examine, and the re-examination is about
  // the builder's inputs, not about this line. What the payload does not carry
  // is as much the point: no credential, no integration endpoint, no
  // notification channel, and the briefing prose is lifted read-only off the
  // owner's own row rather than generated, so no provider is reachable here.
  //
  // The cache cell keys on the resolved id, so the owner's snapshot lands in
  // the owner's cell and a delegated read neither reads nor poisons their own.
  const { user } = await requireRecordAuth("read", "record");
  annotate({ action: { name: "dashboard.snapshot" } });

  const timings = ownRecord<number>();
  const time = async <T>(
    label: string,
    builder: () => Promise<T>,
  ): Promise<T> => {
    const t0 = Date.now();
    const result = await builder();
    timings[`snapshot.sub_${label}_ms`] = Date.now() - t0;
    return result;
  };

  // The cached read (user-row mapping, locale resolution, SWR cell) is
  // shared with the dashboard RSC prefetch — see
  // `src/lib/dashboard/snapshot-read.ts` for the cache-key/TTL contract.
  const { body } = await readDashboardSnapshotCached(user, time);

  // Only surface timings on the cache-miss path (the hit path skips the
  // whole builder and leaves `timings` empty).
  if (Object.keys(timings).length > 0) {
    annotate({
      meta: { ...timings, snapshot_extras_present: body.extras !== null },
    });
  }

  return apiSuccess(body);
});
