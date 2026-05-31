/**
 * GET /api/dashboard/snapshot
 *
 * v1.7.0 W6 — unified above-the-fold first-paint payload for the web
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
 * The body is read-through `caches.analytics` keyed
 * `${userId}|dashboard-snapshot` (60 s TTL — same bucket family the
 * slim/thick analytics + mood reads use, so a single eviction sweep
 * covers it; see `src/lib/cache/invalidate.ts`). Per-sub-query timings
 * surface under `meta.snapshot.sub_*_ms` on the cache-miss path so a
 * regression is attributable without re-instrumenting.
 *
 * No LLM is reachable from the builder — the daily briefing is lifted
 * read-only from `User.insightsCachedText`. The nightly
 * `insight-pregenerate` cron keeps that cache warm.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  buildDashboardSnapshot,
  type DashboardSnapshot,
  type SnapshotUserInput,
} from "@/lib/dashboard/snapshot";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "dashboard.snapshot" } });

  const timings: Record<string, number> = {};
  const time = async <T>(
    label: string,
    builder: () => Promise<T>,
  ): Promise<T> => {
    const t0 = Date.now();
    const result = await builder();
    timings[`snapshot.sub_${label}_ms`] = Date.now() - t0;
    return result;
  };

  // `requireAuth().user` is the full Prisma `User` row, so every field
  // the builder needs is already present — no extra round-trip.
  const snapshotUser: SnapshotUserInput = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    timezone: user.timezone,
    heightCm: user.heightCm,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    glucoseUnit: user.glucoseUnit,
    onboardingTourCompleted: user.onboardingTourCompleted,
    disableCoach: user.disableCoach,
    insightsCachedText: user.insightsCachedText,
    insightsCachedAt: user.insightsCachedAt,
    dashboardWidgetsJson: user.dashboardWidgetsJson,
  };

  const body = await cached(
    caches.analytics as ServerCache<DashboardSnapshot>,
    `${user.id}|dashboard-snapshot`,
    () => buildDashboardSnapshot(prisma, snapshotUser, { time }),
    annotate,
  );

  // Only surface timings on the cache-miss path (the hit path skips the
  // whole builder and leaves `timings` empty).
  if (Object.keys(timings).length > 0) {
    annotate({ meta: { ...timings, snapshot_extras_present: body.extras !== null } });
  }

  const response = apiSuccess(body);
  response.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
  return response;
});
