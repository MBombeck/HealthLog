/**
 * `GET /api/sync/state` — iOS SyncMode handshake.
 *
 * The iOS SyncMode store reads this endpoint on pair / unpair, on
 * background-to-foreground, and before opening a fresh anchored
 * HealthKit query window. The response is a compact JSON shape iOS
 * compares against its local SwiftData state to decide whether to
 * (a) drain a pending outbox, (b) request a full refresh, or (c) sit
 * quiet.
 *
 * Response shape:
 *   {
 *     userId,
 *     timezone,
 *     lastSyncedAt,             — User.lastSyncedAt (ISO string or null).
 *                                 Set by the ingest boundaries, not here:
 *                                 this route is a read and writes nothing.
 *     serverNow,                — `new Date().toISOString()` for clock skew
 *     measurements: { lastUpdatedAt, liveCount, tombstonedCount },
 *     mood:         { lastUpdatedAt, liveCount, tombstonedCount },
 *     intakes:      { lastUpdatedAt, liveCount, tombstonedCount },
 *     sync:         { incrementalWindowDays, tombstoneRetentionDays }
 *   }
 *
 *   Per-domain block: `lastUpdatedAt` = MAX(updated_at) for live rows,
 *   `liveCount` = COUNT WHERE deleted_at IS NULL, `tombstonedCount` =
 *   COUNT WHERE deleted_at IS NOT NULL.
 *
 * No body. requireAuth() — cookie + Bearer both accepted (iOS uses
 * Bearer per `05-auth-flows.md`).
 *
 * Locked contract: see `.planning/v15-ios-handoff/08-locked-contracts.md`
 * §13 cross-reference. The shape is additive going forward.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  NATIVE_REFRESH_TOKEN_DAYS,
  TOMBSTONE_RETENTION_DAYS,
} from "@/lib/auth/native-client";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();

  // Per-domain aggregate reads. Each runs against indexed columns (userId,
  // deleted_at / updated_at) so it stays O(rows-for-user) and not
  // O(rows-across-tenants). v1.7.0 adds the mood + intake blocks now that
  // both carry the sync columns.
  const [
    measurementLatest,
    measurementLive,
    measurementTomb,
    moodLatest,
    moodLive,
    moodTomb,
    intakeLatest,
    intakeLive,
    intakeTomb,
    currentUser,
  ] = await Promise.all([
    prisma.measurement.findFirst({
      where: { userId: user.id, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    prisma.measurement.count({ where: { userId: user.id, deletedAt: null } }),
    prisma.measurement.count({
      where: { userId: user.id, deletedAt: { not: null } },
    }),
    prisma.moodEntry.findFirst({
      where: { userId: user.id, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    prisma.moodEntry.count({ where: { userId: user.id, deletedAt: null } }),
    prisma.moodEntry.count({
      where: { userId: user.id, deletedAt: { not: null } },
    }),
    prisma.medicationIntakeEvent.findFirst({
      where: { userId: user.id, deletedAt: null },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { updatedAt: true },
    }),
    prisma.medicationIntakeEvent.count({
      where: { userId: user.id, deletedAt: null },
    }),
    prisma.medicationIntakeEvent.count({
      where: { userId: user.id, deletedAt: { not: null } },
    }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { lastSyncedAt: true, timezone: true },
    }),
  ]);

  // The handshake reports the checkpoint; it does not set it. The column is
  // stamped by the ingest boundaries that actually move data (see
  // `markSyncCheckpoint`), so `lastSyncedAt` answers "when did this account
  // last push a batch" rather than "when did a client last ask". NULL still
  // means never synced, and the value can now only trail the truth — the
  // handshake used to advance it past a window the client had not drained.
  const lastSyncedAt = currentUser?.lastSyncedAt ?? null;
  const serverNow = new Date();

  annotate({
    action: { name: "sync.state" },
    meta: {
      liveCount: measurementLive,
      tombstonedCount: measurementTomb,
      moodLiveCount: moodLive,
      intakeLiveCount: intakeLive,
      lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    },
  });

  return apiSuccess({
    userId: user.id,
    timezone: currentUser?.timezone ?? DEFAULT_TIMEZONE,
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    serverNow: serverNow.toISOString(),
    measurements: {
      lastUpdatedAt: measurementLatest?.updatedAt?.toISOString() ?? null,
      liveCount: measurementLive,
      tombstonedCount: measurementTomb,
    },
    // v1.7.0 — mood + intake summaries, now that both carry the sync
    // columns. Same shape as `measurements` so the client reads them
    // uniformly.
    mood: {
      lastUpdatedAt: moodLatest?.updatedAt?.toISOString() ?? null,
      liveCount: moodLive,
      tombstonedCount: moodTomb,
    },
    intakes: {
      lastUpdatedAt: intakeLatest?.updatedAt?.toISOString() ?? null,
      liveCount: intakeLive,
      tombstonedCount: intakeTomb,
    },
    // v1.7.0 — the sync window iOS should derive its incremental-delta
    // horizon from, rather than hardcoding a constant. `incrementalWindowDays`
    // tracks the native refresh-token lifetime (a device offline longer
    // re-pairs with a full backfill); `tombstoneRetentionDays` is the
    // horizon past which `/api/sync/changes` returns `cursorExpired`.
    sync: {
      incrementalWindowDays: NATIVE_REFRESH_TOKEN_DAYS,
      tombstoneRetentionDays: TOMBSTONE_RETENTION_DAYS,
    },
  });
});
