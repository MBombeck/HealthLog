/**
 * `GET /api/sync/changes` — multi-domain delta feed (v1.7.0).
 *
 * The incremental catch-up feed for paired clients. After the first-pair
 * backfill (which uses the batch endpoints), the client drains this feed
 * to pick up server-side changes — including deletions, which surface as
 * tombstones because the user-facing DELETE routes on every served
 * domain now soft-delete (set `deletedAt` + bump `syncVersion`) rather
 * than hard-delete.
 *
 * Domains served: `measurements`, `mood`, `intakes`. The iOS consumer
 * is measurements-only this cycle (iOS-coord
 * `v1.7.0-ios-offline-sync-answers.md` §7.1); mood + intakes are
 * forward-prep so the contract is complete + tested before the
 * multi-domain consumer lands.
 *
 * Contract:
 *   - One opaque multi-domain keyset cursor wrapping a per-domain
 *     `(updatedAt, id)` watermark; the client treats it as fully opaque
 *     (echo, never parse — iOS-coord §7.6). `limit` default 200, hard
 *     cap 500, applied PER DOMAIN.
 *   - Each domain block carries `tombstones` (soft-deleted rows) AND
 *     `upserts` (live rows). The client MUST apply tombstones before
 *     upserts within each domain to avoid resurrecting a row whose
 *     delete and a later re-insert both fall in the page.
 *   - Tombstone identity per the iOS §7.3 table: measurements key on
 *     `externalId` (the cross-device key); mood + intakes key on the
 *     server `id` (the client mirrors those by server id).
 *   - `hasMore` is true when ANY served domain still has rows past its
 *     page; the next `cursor` advances every domain that returned rows.
 *     When `hasMore` is false the client is caught up as of `serverNow`.
 *   - `cursorExpired: true` when ANY domain watermark predates the
 *     tombstone-retention horizon — the client drops its cursor and does
 *     a clean initial sync (a deletion older than retention may have
 *     been pruned, so an incremental delta could silently miss it).
 *   - `syncVersion` is echoed per row so the client can keep its mirror's
 *     version monotonic.
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
import {
  decodeCursor,
  encodeCursor,
  SYNC_DOMAINS,
  type DomainWatermark,
  type SyncCursor,
  type SyncDomain,
} from "@/lib/sync/cursor";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DAY_MS = 86_400_000;

const querySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
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

interface MoodUpsert {
  id: string;
  date: string;
  mood: string;
  score: number;
  tags: string | null;
  note: string | null;
  moodLoggedAt: string;
  source: string;
  syncVersion: number;
  updatedAt: string;
}

interface MoodTombstone {
  id: string;
  syncVersion: number;
  deletedAt: string;
  updatedAt: string;
}

interface IntakeUpsert {
  id: string;
  medicationId: string;
  scheduledFor: string;
  takenAt: string | null;
  skipped: boolean;
  source: string;
  syncVersion: number;
  updatedAt: string;
}

interface IntakeTombstone {
  id: string;
  syncVersion: number;
  deletedAt: string;
  updatedAt: string;
}

/**
 * Build the `(updatedAt, id)` keyset predicate for a domain's watermark.
 * Empty object (full scan) when the client has no watermark for it yet.
 */
function keysetFilter(wm: DomainWatermark | undefined) {
  if (!wm) return {};
  const at = new Date(wm.updatedAtMs);
  return {
    OR: [
      { updatedAt: { gt: at } },
      { AND: [{ updatedAt: at }, { id: { gt: wm.id } }] },
    ],
  };
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  // Pull is cheap + idempotent; a generous per-user bucket caps a runaway
  // drain loop without throttling normal foreground catch-up.
  const rl = await checkRateLimit(`sync:changes:${user.id}`, 120, 60 * 1000);
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

  // A garbage / unparseable / old-format cursor decodes to null → fresh
  // initial sync (every domain scans from the start).
  const cursor: SyncCursor = parsed.data.cursor
    ? (decodeCursor(parsed.data.cursor) ?? {})
    : {};

  // A stale cursor (ANY domain watermark older than retention) forces a
  // clean re-init: a deletion older than retention may already be pruned.
  const expired = SYNC_DOMAINS.some((domain) => {
    const wm = cursor[domain];
    return wm !== undefined && wm.updatedAtMs < retentionHorizon.getTime();
  });
  if (expired) {
    annotate({
      action: { name: "sync.changes.pull" },
      meta: { cursor_expired: true, returned: 0 },
    });
    return apiSuccess({
      serverNow: serverNow.toISOString(),
      cursor: parsed.data.cursor ?? null,
      hasMore: false,
      cursorExpired: true,
      changes: {
        measurements: { upserts: [], tombstones: [] },
        mood: { upserts: [], tombstones: [] },
        intakes: { upserts: [], tombstones: [] },
      },
    });
  }

  // Per-domain keyset walks. Both live and soft-deleted rows are in the
  // same scan — a soft-delete bumps `updatedAt`, so a tombstone is just a
  // row whose `deletedAt` is non-null. Fetch limit+1 to detect `hasMore`
  // without a count query.
  const [measurementRows, moodRows, intakeRows] = await Promise.all([
    prisma.measurement.findMany({
      where: { userId: user.id, ...keysetFilter(cursor.measurements) },
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
    }),
    prisma.moodEntry.findMany({
      where: { userId: user.id, ...keysetFilter(cursor.mood) },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        date: true,
        mood: true,
        score: true,
        tags: true,
        note: true,
        moodLoggedAt: true,
        source: true,
        syncVersion: true,
        deletedAt: true,
        updatedAt: true,
      },
    }),
    prisma.medicationIntakeEvent.findMany({
      where: { userId: user.id, ...keysetFilter(cursor.intakes) },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
        source: true,
        syncVersion: true,
        deletedAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const nextCursor: SyncCursor = { ...cursor };
  let hasMore = false;

  // ── measurements ──────────────────────────────────────────
  const mHasMore = measurementRows.length > limit;
  const mPage = mHasMore ? measurementRows.slice(0, limit) : measurementRows;
  const measurementUpserts: MeasurementUpsert[] = [];
  const measurementTombstones: MeasurementTombstone[] = [];
  for (const row of mPage) {
    if (row.deletedAt) {
      measurementTombstones.push({
        id: row.id,
        externalId: row.externalId,
        syncVersion: row.syncVersion,
        deletedAt: row.deletedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    } else {
      measurementUpserts.push({
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
  advanceCursor(nextCursor, "measurements", mPage);
  hasMore = hasMore || mHasMore;

  // ── mood ──────────────────────────────────────────────────
  const moodHasMore = moodRows.length > limit;
  const moodPage = moodHasMore ? moodRows.slice(0, limit) : moodRows;
  const moodUpserts: MoodUpsert[] = [];
  const moodTombstones: MoodTombstone[] = [];
  for (const row of moodPage) {
    if (row.deletedAt) {
      moodTombstones.push({
        id: row.id,
        syncVersion: row.syncVersion,
        deletedAt: row.deletedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    } else {
      moodUpserts.push({
        id: row.id,
        date: row.date,
        mood: row.mood,
        score: row.score,
        tags: row.tags,
        note: row.note,
        moodLoggedAt: row.moodLoggedAt.toISOString(),
        source: row.source,
        syncVersion: row.syncVersion,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
  }
  advanceCursor(nextCursor, "mood", moodPage);
  hasMore = hasMore || moodHasMore;

  // ── intakes ───────────────────────────────────────────────
  const intakeHasMore = intakeRows.length > limit;
  const intakePage = intakeHasMore ? intakeRows.slice(0, limit) : intakeRows;
  const intakeUpserts: IntakeUpsert[] = [];
  const intakeTombstones: IntakeTombstone[] = [];
  for (const row of intakePage) {
    if (row.deletedAt) {
      intakeTombstones.push({
        id: row.id,
        syncVersion: row.syncVersion,
        deletedAt: row.deletedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    } else {
      intakeUpserts.push({
        id: row.id,
        medicationId: row.medicationId,
        scheduledFor: row.scheduledFor.toISOString(),
        takenAt: row.takenAt?.toISOString() ?? null,
        skipped: row.skipped,
        source: row.source,
        syncVersion: row.syncVersion,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
  }
  advanceCursor(nextCursor, "intakes", intakePage);
  hasMore = hasMore || intakeHasMore;

  annotate({
    action: { name: "sync.changes.pull" },
    meta: {
      measurement_upserts: measurementUpserts.length,
      measurement_tombstones: measurementTombstones.length,
      mood_upserts: moodUpserts.length,
      mood_tombstones: moodTombstones.length,
      intake_upserts: intakeUpserts.length,
      intake_tombstones: intakeTombstones.length,
      has_more: hasMore,
      cursor_present: Boolean(parsed.data.cursor),
    },
  });

  return apiSuccess({
    serverNow: serverNow.toISOString(),
    cursor: encodeCursor(nextCursor),
    hasMore,
    cursorExpired: false,
    changes: {
      measurements: {
        upserts: measurementUpserts,
        tombstones: measurementTombstones,
      },
      mood: { upserts: moodUpserts, tombstones: moodTombstones },
      intakes: { upserts: intakeUpserts, tombstones: intakeTombstones },
    },
  });
});

/**
 * Advance a domain's watermark to the last row of its page. A domain
 * that returned no rows keeps its prior watermark untouched so a future
 * pull does not re-scan from the start.
 */
function advanceCursor(
  cursor: SyncCursor,
  domain: SyncDomain,
  page: Array<{ updatedAt: Date; id: string }>,
): void {
  const last = page[page.length - 1];
  if (last) {
    cursor[domain] = { updatedAtMs: last.updatedAt.getTime(), id: last.id };
  }
}
