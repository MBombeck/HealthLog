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
 * Domains served: `measurements`, `mood`, `intakes`, `cycleDays`,
 * `cycles` (the last two added v1.15.0; `cycleDays` tombstones key on
 * `externalId` when present else `id`, `cycles` on `id`). The iOS consumer
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
 *   - The `cycleDays` / `cycles` blocks are MODULE-GATED: an account with
 *     cycle tracking off gets both blocks empty (never a 403 — see the
 *     gate note in the handler) and their cursor watermarks untouched.
 *
 * `apiHandler` + `requireAuth` (cookie OR Bearer; iOS uses Bearer).
 * Read-only — no idempotency, no write side-effect (unlike the legacy
 * `/api/sync/state` checkpoint bump). The cursor is owned by the client.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { readNote } from "@/lib/crypto/note-cipher";
import { levelAForWire } from "@/lib/mood/level-a";
import { contextForWire, type MoodContextWire } from "@/lib/mood/context";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import {
  decodeCursor,
  encodeCursor,
  SYNC_DOMAINS,
  type DomainWatermark,
  type SyncCursor,
  type SyncDomain,
} from "@/lib/sync/cursor";
import {
  toCycleDayLogDTO,
  toMenstrualCycleDTO,
  dayLogSymptomInclude,
  type CycleDayLogDTO,
  type MenstrualCycleDTO,
} from "@/lib/cycle/dto";
import { isModuleEnabled } from "@/lib/modules/gate";

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
  /**
   * v1.38 — the five level-A self-state values, each 0-10 and each nullable.
   * `a2` is inverse-oriented: a higher number means more stress, and a client
   * that wants "up is better" flips the sign itself rather than the server
   * storing a flipped value.
   *
   * Server-authoritative: `a1` is derived from the five-point label on every
   * write, so a client that sends only `mood` still mirrors a complete row.
   */
  a1: number | null;
  a2: number | null;
  a3: number | null;
  a4: number | null;
  a5: number | null;
  /**
   * v1.38 — the day's context, or null when the entry carries none. Null and
   * an object of nulls are different answers and the feed keeps them apart.
   */
  context: MoodContextWire | null;
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

// v1.15.0 — cycle domains. cycleDays key tombstones on `externalId` when
// present (HealthKit-origin rows are externalId-keyed cross-device, like
// measurements) else the server `id`; cycles key on the server `id`
// (computed rows carry no externalId).
interface CycleDayTombstone {
  id: string;
  externalId: string | null;
  syncVersion: number;
  deletedAt: string;
  updatedAt: string;
}

interface CycleTombstone {
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
    return apiValidationError(
      "Invalid sync query",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }
  const limit = parsed.data.limit ?? DEFAULT_LIMIT;

  const serverNow = new Date();

  // ── module gate: cycle ────────────────────────────────────────────
  // The `cycleDays` / `cycles` domains carry period days and per-day
  // symptom rows — the same data every `/api/cycle/*` route refuses with a
  // 403 when the module is off. Without this the delta feed re-served them
  // ungated to the very same token.
  //
  // OMIT, NOT 403 — deliberately, and unlike the whole-record FHIR export.
  // This feed multiplexes five domains over one cursor: refusing the whole
  // request would wedge measurement / mood / intake catch-up for every
  // account with cycle tracking off, which (the gate delegates to
  // `isCycleEnabled`) is the default for most accounts. A partial payload
  // is the only outcome that keeps the client syncing while still honouring
  // the promise that a disabled module hands out nothing.
  //
  // The two cycle watermarks are deliberately NOT advanced while the module
  // is off (the queries are skipped, so `advanceCursor` sees an empty page
  // and leaves the prior watermark untouched). Re-enabling therefore resumes
  // from where the client actually left off instead of silently skipping the
  // rows that changed while the module was hidden.
  //
  // KNOWN GAP, out of scope here: a client that synced cycle rows BEFORE the
  // module was turned off keeps its stale local mirror. Emitting tombstones
  // for them would be wrong — a tombstone means deleted, and disabling a
  // module must leave the rows intact so re-enabling finds a complete
  // history. Purging a paired client's mirror needs an explicit
  // "module went dark" signal in the feed contract plus client support for
  // it; that is an additive wire change and an iOS-client change, not a
  // server-side gate fix, so it is left for a coordinated contract cycle.
  const cycleEnabled = await isModuleEnabled(user.id, "cycle");

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
        cycleDays: { upserts: [], tombstones: [] },
        cycles: { upserts: [], tombstones: [] },
      },
    });
  }

  // Per-domain keyset walks. Both live and soft-deleted rows are in the
  // same scan — a soft-delete bumps `updatedAt`, so a tombstone is just a
  // row whose `deletedAt` is non-null. Fetch limit+1 to detect `hasMore`
  // without a count query.
  const [measurementRows, moodRows, intakeRows, cycleDayRows, cycleRows] =
    await Promise.all([
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
          notesEncrypted: true,
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
          moodA1: true,
          stressA2: true,
          energyA3: true,
          connectionA4: true,
          stabilityA5: true,
          context: true,
          tags: true,
          note: true,
          noteEncrypted: true,
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
      // Skipped outright when the module is off — not filtered after the
      // fact — so the disabled rows are never read out of Postgres at all.
      cycleEnabled
        ? prisma.cycleDayLog.findMany({
            where: { userId: user.id, ...keysetFilter(cursor.cycleDays) },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            take: limit + 1,
            include: dayLogSymptomInclude,
          })
        : [],
      cycleEnabled
        ? prisma.menstrualCycle.findMany({
            where: { userId: user.id, ...keysetFilter(cursor.cycles) },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            take: limit + 1,
          })
        : [],
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
      // Every row carries its `source`. RECOVERY_SCORE is written by BOTH the
      // WHOOP-native sync (`source = WHOOP`) and the COMPUTED proxy job
      // (`source = COMPUTED`) for the same day; the client must resolve to ONE
      // canonical recovery series — WHOOP wins when present, COMPUTED is the
      // fallback — and never chart the proxy and the native value as two
      // competing series. The feed faithfully mirrors both rows (a delta-sync
      // mirror cannot drop a row mid-keyset without a tombstone); the
      // canonical pick is the same WHOOP-over-COMPUTED rule the server's
      // wellness tile + doctor PDF apply (`resolveCanonicalRecovery`).
      measurementUpserts.push({
        id: row.id,
        externalId: row.externalId,
        type: row.type,
        value: row.value,
        unit: row.unit,
        measuredAt: row.measuredAt.toISOString(),
        source: row.source,
        notes: readNote(row.notesEncrypted, row.notes),
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
        // Under the same wire keys the write path accepts, so a client reads
        // back exactly what it can post.
        ...levelAForWire(row),
        context: row.context ? contextForWire(row.context) : null,
        tags: row.tags,
        note: readNote(row.noteEncrypted, row.note),
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

  // ── cycleDays ─────────────────────────────────────────────
  const cycleDayHasMore = cycleDayRows.length > limit;
  const cycleDayPage = cycleDayHasMore
    ? cycleDayRows.slice(0, limit)
    : cycleDayRows;
  const cycleDayUpserts: CycleDayLogDTO[] = [];
  const cycleDayTombstones: CycleDayTombstone[] = [];
  for (const row of cycleDayPage) {
    if (row.deletedAt) {
      cycleDayTombstones.push({
        id: row.id,
        externalId: row.externalId,
        syncVersion: row.syncVersion,
        deletedAt: row.deletedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    } else {
      cycleDayUpserts.push(toCycleDayLogDTO(row));
    }
  }
  advanceCursor(nextCursor, "cycleDays", cycleDayPage);
  hasMore = hasMore || cycleDayHasMore;

  // ── cycles ────────────────────────────────────────────────
  const cycleHasMore = cycleRows.length > limit;
  const cyclePage = cycleHasMore ? cycleRows.slice(0, limit) : cycleRows;
  const cycleUpserts: MenstrualCycleDTO[] = [];
  const cycleTombstones: CycleTombstone[] = [];
  for (const row of cyclePage) {
    if (row.deletedAt) {
      cycleTombstones.push({
        id: row.id,
        syncVersion: row.syncVersion,
        deletedAt: row.deletedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    } else {
      cycleUpserts.push(toMenstrualCycleDTO(row));
    }
  }
  advanceCursor(nextCursor, "cycles", cyclePage);
  hasMore = hasMore || cycleHasMore;

  annotate({
    action: { name: "sync.changes.pull" },
    meta: {
      measurement_upserts: measurementUpserts.length,
      measurement_tombstones: measurementTombstones.length,
      mood_upserts: moodUpserts.length,
      mood_tombstones: moodTombstones.length,
      intake_upserts: intakeUpserts.length,
      intake_tombstones: intakeTombstones.length,
      cycle_day_upserts: cycleDayUpserts.length,
      cycle_day_tombstones: cycleDayTombstones.length,
      cycle_upserts: cycleUpserts.length,
      cycle_tombstones: cycleTombstones.length,
      cycle_module_enabled: cycleEnabled,
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
      cycleDays: {
        upserts: cycleDayUpserts,
        tombstones: cycleDayTombstones,
      },
      cycles: { upserts: cycleUpserts, tombstones: cycleTombstones },
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
