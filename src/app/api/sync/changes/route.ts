/**
 * `GET /api/sync/changes` — measurements-only delta feed (v1.7.0).
 *
 * The incremental catch-up feed for paired clients. After the first-pair
 * backfill (which uses the batch endpoints), the client drains this feed
 * to pick up server-side changes — including deletions, which surface as
 * tombstones because the two measurement DELETE routes now soft-delete
 * (set `deletedAt` + bump `syncVersion`) rather than hard-delete.
 *
 * Contract (iOS-coord `v1.7.0-ios-offline-sync-answers.md`):
 *   - Measurements only this cycle. Single combined opaque keyset cursor
 *     wrapping `(updatedAt, id)`; the client treats it as fully opaque
 *     (echo, never parse). `limit` default 200, hard cap 500.
 *   - Each page carries `tombstones` (soft-deleted rows, keyed on
 *     `externalId`) AND `upserts` (live rows). The client MUST apply
 *     tombstones before upserts within a page to avoid resurrecting a
 *     row whose delete and a later re-insert both fall in the page.
 *   - `hasMore` + next `cursor` drive pagination; when `hasMore` is false
 *     the client is caught up as of `serverNow`.
 *   - `cursorExpired: true` when the supplied cursor predates the
 *     tombstone-retention horizon — the client drops its cursor and does
 *     a clean initial sync (a deletion older than retention may have been
 *     pruned, so an incremental delta could silently miss it).
 *   - `syncVersion` is echoed per upsert row so the client can keep its
 *     mirror's version monotonic.
 *
 * `apiHandler` + `requireAuth` (cookie OR Bearer; iOS uses Bearer).
 * Read-only — no idempotency, no write side-effect (unlike the legacy
 * `/api/sync/state` checkpoint bump). The cursor is owned by the client.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import { decodeCursor, encodeCursor } from "@/lib/sync/cursor";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DAY_MS = 86_400_000;

const querySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

interface MeasurementUpsert {
  id: string;
  externalId: string | null;
  type: string;
  value: number;
  unit: string;
  measuredAt: string;
  source: string;
  notes: string | null;
  syncVersion: number;
  updatedAt: string;
}

interface MeasurementTombstone {
  id: string;
  externalId: string | null;
  syncVersion: number;
  deletedAt: string;
  updatedAt: string;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  // Pull is cheap + idempotent; a generous per-user bucket caps a runaway
  // drain loop without throttling normal foreground catch-up.
  const rl = await checkRateLimit(
    `sync:changes:${user.id}`,
    120,
    60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Too many sync requests. Please retry later.", 429);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return apiError("Invalid sync query", 422);
  }
  const limit = parsed.data.limit ?? DEFAULT_LIMIT;

  const serverNow = new Date();

  // The retention horizon: tombstones older than this may have been
  // pruned by the cleanup job, so a cursor that predates it can no longer
  // be trusted to deliver every deletion incrementally.
  const retentionHorizon = new Date(
    serverNow.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS,
  );

  const cursor = parsed.data.cursor
    ? decodeCursor(parsed.data.cursor)
    : null;

  // A stale cursor (older than retention) forces a clean re-init. A
  // garbage/unparseable cursor is treated as a fresh initial sync (null).
  if (cursor && cursor.updatedAtMs < retentionHorizon.getTime()) {
    annotate({
      action: { name: "sync.changes.pull" },
      meta: { cursor_expired: true, returned: 0 },
    });
    return apiSuccess({
      serverNow: serverNow.toISOString(),
      cursor: parsed.data.cursor ?? null,
      hasMore: false,
      cursorExpired: true,
      changes: { measurements: { upserts: [], tombstones: [] } },
    });
  }

  // Keyset walk over `(updatedAt, id)` ascending. Both live and
  // soft-deleted rows are in the same scan — a soft-delete bumps
  // `updatedAt`, so a tombstone is just a row whose `deletedAt` is
  // non-null. Fetch limit+1 to detect `hasMore` without a count query.
  const cursorFilter = cursor
    ? {
        OR: [
          { updatedAt: { gt: new Date(cursor.updatedAtMs) } },
          {
            AND: [
              { updatedAt: new Date(cursor.updatedAtMs) },
              { id: { gt: cursor.id } },
            ],
          },
        ],
      }
    : {};

  const rows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      ...cursorFilter,
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      externalId: true,
      type: true,
      value: true,
      unit: true,
      measuredAt: true,
      source: true,
      notes: true,
      syncVersion: true,
      deletedAt: true,
      updatedAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const upserts: MeasurementUpsert[] = [];
  const tombstones: MeasurementTombstone[] = [];
  for (const row of page) {
    if (row.deletedAt) {
      tombstones.push({
        id: row.id,
        externalId: row.externalId,
        syncVersion: row.syncVersion,
        deletedAt: row.deletedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    } else {
      upserts.push({
        id: row.id,
        externalId: row.externalId,
        type: row.type,
        value: row.value,
        unit: row.unit,
        measuredAt: row.measuredAt.toISOString(),
        source: row.source,
        notes: row.notes,
        syncVersion: row.syncVersion,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
  }

  const last = page[page.length - 1];
  const nextCursor = last
    ? encodeCursor({ updatedAtMs: last.updatedAt.getTime(), id: last.id })
    : (parsed.data.cursor ?? null);

  annotate({
    action: { name: "sync.changes.pull" },
    meta: {
      upserts: upserts.length,
      tombstones: tombstones.length,
      has_more: hasMore,
      cursor_present: Boolean(cursor),
    },
  });

  return apiSuccess({
    serverNow: serverNow.toISOString(),
    cursor: nextCursor,
    hasMore,
    cursorExpired: false,
    changes: { measurements: { upserts, tombstones } },
  });
});
