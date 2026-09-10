/**
 * OpenAPI route table — offline sync state + changes feed.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { measurementResource } from "./measurements";
import { moodContextWire } from "./mood";
import { cycleDayLogDto, menstrualCycleDto } from "./cycle";
import { dataEnvelope, stdResponses } from "./shared";

// ── Sync (v1.7.0 offline / server-optional) ─────────────────────────

const syncStateResponse = z
  .object({
    userId: z.string(),
    timezone: z.string(),
    lastSyncedAt: z.iso.datetime({ offset: true }).nullable(),
    serverNow: z.iso.datetime({ offset: true }),
    measurements: z.object({
      lastUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
      liveCount: z.number().int().nonnegative(),
      tombstonedCount: z.number().int().nonnegative(),
    }),
    mood: z.object({
      lastUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
      liveCount: z.number().int().nonnegative(),
      tombstonedCount: z.number().int().nonnegative(),
    }),
    intakes: z.object({
      lastUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
      liveCount: z.number().int().nonnegative(),
      tombstonedCount: z.number().int().nonnegative(),
    }),
    sync: z
      .object({
        incrementalWindowDays: z
          .number()
          .int()
          .positive()
          .describe(
            "Days an incremental delta stays valid; tracks the native refresh-token lifetime. Beyond it a device re-pairs with a full backfill. iOS derives its window from this rather than hardcoding 60.",
          ),
        tombstoneRetentionDays: z
          .number()
          .int()
          .positive()
          .describe(
            "Horizon past which tombstones may be pruned. A cursor older than this gets `cursorExpired` on `/api/sync/changes`.",
          ),
      })
      .describe("Sync-window metadata the client reads instead of hardcoding."),
  })
  .meta({
    id: "SyncStateResponse",
    description:
      "iOS SyncMode handshake. Reports the server-side `lastSyncedAt` checkpoint, which the batch ingest endpoints set when a client push lands; the handshake itself writes nothing. The cheap 'should I sync?' summary; the durable delta cursor lives on `/api/sync/changes`.",
  });

const syncMeasurementUpsert = measurementResource
  .extend({
    externalId: z
      .string()
      .nullable()
      .describe("Cross-device dedup key (UUID string or `stats:<id>:<date>`)."),
    syncVersion: z
      .number()
      .int()
      .positive()
      .describe(
        "LWW reconciliation counter; echo to keep the mirror monotonic.",
      ),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "SyncMeasurementUpsert" });

const syncMeasurementTombstone = z
  .object({
    id: z.string(),
    externalId: z
      .string()
      .nullable()
      .describe("The identity key the client dedups on for measurements."),
    syncVersion: z.number().int().positive(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncMeasurementTombstone",
    description:
      "A soft-deleted measurement. Apply tombstones BEFORE upserts within a page to avoid resurrecting a row.",
  });

const syncMoodUpsert = z
  .object({
    id: z.string(),
    date: z.string().describe("YYYY-MM-DD anchored to the row's `tz`."),
    mood: z.string(),
    score: z.number().int().describe("The legacy 1-5 axis. Unchanged."),
    a1: z
      .number()
      .int()
      .nullable()
      .describe(
        "Pleasantness, 0-10. Server-derived from `mood` on every write, so this is populated even for rows a client posted without it. Consume the value; do not re-derive it.",
      ),
    a2: z
      .number()
      .int()
      .nullable()
      .describe(
        "Stress, 0-10, INVERSE-oriented: a higher value is more stress. NULL when nobody answered it.",
      ),
    a3: z.number().int().nullable().describe("Energy, 0-10, or null."),
    a4: z.number().int().nullable().describe("Connectedness, 0-10, or null."),
    a5: z.number().int().nullable().describe("Stability, 0-10, or null."),
    context: moodContextWire
      .nullable()
      .describe(
        "The day's context, or null when the entry carries none. Null and an object of nulls are different answers.",
      ),
    tags: z.string().nullable().describe("JSON array of tag keys, or null."),
    note: z.string().nullable(),
    moodLoggedAt: z.iso.datetime({ offset: true }),
    source: z.string(),
    syncVersion: z
      .number()
      .int()
      .nonnegative()
      .describe("LWW reconciliation counter; mood is last-writer-wins by it."),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "SyncMoodUpsert" });

const syncMoodTombstone = z
  .object({
    id: z
      .string()
      .describe("Server id — the identity key the client dedups on for mood."),
    syncVersion: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncMoodTombstone",
    description:
      "A soft-deleted mood entry, keyed on server `id`. Apply before upserts within the domain page.",
  });

const syncIntakeUpsert = z
  .object({
    id: z.string(),
    medicationId: z.string(),
    scheduledFor: z.iso.datetime({ offset: true }),
    takenAt: z.iso.datetime({ offset: true }).nullable(),
    skipped: z.boolean(),
    source: z.string(),
    syncVersion: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Reconciliation counter. An intake is immutable; a correction is a tombstone + re-insert.",
      ),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "SyncIntakeUpsert" });

const syncIntakeTombstone = z
  .object({
    id: z
      .string()
      .describe(
        "Server id — the identity key the client dedups on for intakes.",
      ),
    syncVersion: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncIntakeTombstone",
    description:
      "A soft-deleted medication intake, keyed on server `id`. Apply before upserts within the domain page.",
  });

const syncCycleDayTombstone = z
  .object({
    id: z.string(),
    externalId: z
      .string()
      .nullable()
      .describe("The client's own key for the day log, when it set one."),
    syncVersion: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncCycleDayTombstone",
    description:
      "A soft-deleted cycle day log, keyed on server `id`. Apply before upserts within the domain page.",
  });

const syncCycleTombstone = z
  .object({
    id: z.string(),
    syncVersion: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncCycleTombstone",
    description:
      "A soft-deleted menstrual cycle, keyed on server `id`. Apply before upserts within the domain page.",
  });

const syncChangesQuery = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        "Opaque multi-domain keyset cursor from the previous page. Treat as fully opaque — echo, never parse. Omit for the initial sync.",
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Page size, default 200, hard cap 500."),
  })
  .meta({ id: "SyncChangesQuery" });

const syncChangesResponse = z
  .object({
    serverNow: z.iso.datetime({ offset: true }),
    cursor: z
      .string()
      .nullable()
      .describe("Opaque cursor to echo into the next request."),
    hasMore: z
      .boolean()
      .describe("False once the client is caught up as of `serverNow`."),
    cursorExpired: z
      .boolean()
      .describe(
        "True when the supplied cursor predates tombstone retention — drop the cursor and do a clean initial sync.",
      ),
    changes: z.object({
      measurements: z.object({
        upserts: z.array(syncMeasurementUpsert),
        tombstones: z.array(syncMeasurementTombstone),
      }),
      mood: z.object({
        upserts: z.array(syncMoodUpsert),
        tombstones: z.array(syncMoodTombstone),
      }),
      intakes: z.object({
        upserts: z.array(syncIntakeUpsert),
        tombstones: z.array(syncIntakeTombstone),
      }),
      cycleDays: z
        .object({
          upserts: z.array(cycleDayLogDto),
          tombstones: z.array(syncCycleDayTombstone),
        })
        .describe(
          "Cycle day logs. Present on every page, empty arrays when the account has the cycle module off.",
        ),
      cycles: z
        .object({
          upserts: z.array(menstrualCycleDto),
          tombstones: z.array(syncCycleTombstone),
        })
        .describe(
          "Menstrual cycles, observed and forward-predicted. Present on every page, empty arrays when the account has the cycle module off.",
        ),
    }),
  })
  .meta({
    id: "SyncChangesResponse",
    description:
      "Multi-domain delta page: measurements, mood, intakes, cycle day logs and cycles. One opaque multi-domain keyset cursor; tombstones apply before upserts within each domain. Tombstone identity: measurements key on externalId, every other domain on server id. All five keys are present on every response, including the `cursorExpired` short-circuit — a domain with nothing to report sends empty arrays rather than being omitted.",
  });

export const syncPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/sync/state": {
    get: {
      tags: ["Sync"],
      summary: "Sync handshake + window metadata",
      description:
        "Cheap 'should I sync?' summary. Returns the `lastSyncedAt` checkpoint, which the batch ingest endpoints advance when a client push lands; this route is a read and writes nothing. The `sync` block carries the incremental-delta window + tombstone retention so the client reads them rather than hardcoding.",
      responses: {
        "200": {
          description: "Sync state summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(syncStateResponse, "SyncStateEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/sync/changes": {
    get: {
      tags: ["Sync"],
      summary: "Multi-domain delta feed",
      description:
        "Incremental catch-up after the first-pair backfill (never a replacement for it). Pages over one opaque keyset cursor spanning five domains — measurements, mood, medication intakes, cycle day logs and cycles. Each domain carries `tombstones` (soft-deleted rows) and `upserts` (live rows); apply tombstones before upserts within a domain. Tombstone identity is `externalId` for measurements and the server `id` everywhere else. `cursorExpired: true` forces a clean re-init and the page is empty in every domain.",
      requestParams: {
        query: syncChangesQuery,
      },
      responses: {
        "200": {
          description: "Delta page.",
          content: {
            "application/json": {
              schema: dataEnvelope(syncChangesResponse, "SyncChangesEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
