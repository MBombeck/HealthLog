/**
 * One pull of the multi-domain delta feed behind `GET /api/sync/changes`.
 *
 * The route authenticates, meters and parses the query; this module decides
 * whether the cursor can still be caught up, reads one page of every domain
 * past its watermark, and answers the blocks and the next cursor. The feed
 * contract is described on the route.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import {
  decodeCursor,
  decodeCursorIssuedAt,
  encodeCursor,
  SYNC_DOMAINS,
  type SyncCursor,
  type SyncDomain,
} from "@/lib/sync/cursor";
import { isModuleEnabled } from "@/lib/modules/gate";

import { readDomainRows } from "./read-rows";
import {
  cycleBlock,
  cycleDayBlock,
  intakeBlock,
  measurementBlock,
  measurementMirrorBlock,
  moodBlock,
  pageOf,
} from "./domain-pages";
import type { SyncChangesBody } from "./wire";

const DAY_MS = 86_400_000;

/**
 * Advance a domain's watermark to the last row of its page. A domain that
 * returned no rows keeps its prior watermark untouched so a future pull does
 * not re-scan from the start.
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

/**
 * Whether the cursor can no longer be caught up incrementally, and why.
 *
 * Past retention: ANY domain watermark older than the tombstone-retention
 * horizon. Tombstones older than that may have been pruned by the cleanup
 * job, so an incremental delta could silently miss a deletion.
 *
 * Before a reset: a cursor issued before the account's record was last
 * replaced (a backup restore, or the person deleting all their data) cannot
 * be caught up either: the restore wrote rows back with their original
 * `updatedAt`, behind the cursor's watermarks, and removed rows without
 * tombstones. Compared by the time the cursor was issued, not by its
 * watermarks, which a restore leaves meaningless; a cursor from before the
 * issue time was recorded counts as issued before any reset.
 */
async function expiry(
  userId: string,
  token: string | undefined,
  cursor: SyncCursor,
  serverNow: Date,
): Promise<"retention" | "sync_reset" | null> {
  const retentionHorizon = new Date(
    serverNow.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS,
  );
  // Not `measurementMirror`: its watermark is when a token's setting last
  // changed, which can be any age, and the domain re-delivers values, not
  // deletions, so no pruned tombstone can hide behind it.
  const pastRetention = SYNC_DOMAINS.some((domain) => {
    if (domain === "measurementMirror") return false;
    const wm = cursor[domain];
    return wm !== undefined && wm.updatedAtMs < retentionHorizon.getTime();
  });
  let beforeReset = false;
  if (token) {
    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: { syncResetAt: true },
    });
    if (account?.syncResetAt) {
      const issuedAt = decodeCursorIssuedAt(token);
      beforeReset =
        issuedAt === null || issuedAt < account.syncResetAt.getTime();
    }
  }
  if (!pastRetention && !beforeReset) return null;
  return beforeReset ? "sync_reset" : "retention";
}

function emptyChanges(): SyncChangesBody["changes"] {
  return {
    measurements: { upserts: [], tombstones: [] },
    mood: { upserts: [], tombstones: [] },
    intakes: { upserts: [], tombstones: [] },
    cycleDays: { upserts: [], tombstones: [] },
    cycles: { upserts: [], tombstones: [] },
    measurementMirror: { upserts: [], tombstones: [] },
  };
}

export async function pullSyncChanges(input: {
  userId: string;
  /** The opaque cursor the client echoed, if any. */
  token: string | undefined;
  limit: number;
  serverNow: Date;
}): Promise<SyncChangesBody> {
  const { userId, token, limit, serverNow } = input;

  // Module gate: cycle. The `cycleDays` / `cycles` domains carry period
  // days and per-day symptom rows, the same data every `/api/cycle` route
  // refuses with a 403 when the module is off. Without this the delta feed
  // re-served them ungated to the very same token.
  //
  // OMIT, NOT 403, deliberately, and unlike the whole-record FHIR export.
  // This feed multiplexes five domains over one cursor: refusing the whole
  // request would wedge measurement / mood / intake catch-up for every
  // account with cycle tracking off, which (the gate delegates to
  // `isCycleEnabled`) is the default for most accounts. A partial payload is
  // the only outcome that keeps the client syncing while still honouring the
  // promise that a disabled module hands out nothing.
  //
  // The two cycle watermarks are deliberately NOT advanced while the module
  // is off (the queries are skipped, so `advanceCursor` sees an empty page
  // and leaves the prior watermark untouched). Re-enabling therefore resumes
  // from where the client actually left off instead of silently skipping the
  // rows that changed while the module was hidden.
  //
  // KNOWN GAP, out of scope here: a client that synced cycle rows BEFORE the
  // module was turned off keeps its stale local mirror. Emitting tombstones
  // for them would be wrong (a tombstone means deleted, and disabling a
  // module must leave the rows intact so re-enabling finds a complete
  // history). Purging a paired client's mirror needs an explicit "module went
  // dark" signal in the feed contract plus client support for it; that is an
  // additive wire change and an iOS-client change, not a server-side gate
  // fix, so it is left for a coordinated contract cycle.
  const cycleEnabled = await isModuleEnabled(userId, "cycle");

  // A garbage / unparseable / old-format cursor decodes to null → fresh
  // initial sync (every domain scans from the start).
  const cursor: SyncCursor = token ? (decodeCursor(token) ?? {}) : {};

  const expired = await expiry(userId, token, cursor, serverNow);
  if (expired) {
    annotate({
      action: { name: "sync.changes.pull" },
      meta: {
        cursor_expired: true,
        cursor_expired_reason: expired,
        returned: 0,
      },
    });
    return {
      serverNow: serverNow.toISOString(),
      cursor: token ?? null,
      hasMore: false,
      cursorExpired: true,
      changes: emptyChanges(),
    };
  }

  const rows = await readDomainRows(userId, cursor, limit, cycleEnabled);
  const nextCursor: SyncCursor = { ...cursor };

  const m = pageOf(rows.measurements, limit);
  const measurements = await measurementBlock(userId, m.page);
  advanceCursor(nextCursor, "measurements", m.page);

  const md = pageOf(rows.mood, limit);
  const mood = moodBlock(md.page);
  advanceCursor(nextCursor, "mood", md.page);

  const ik = pageOf(rows.intakes, limit);
  const intakes = intakeBlock(ik.page);
  advanceCursor(nextCursor, "intakes", ik.page);

  const cd = pageOf(rows.cycleDays, limit);
  const cycleDays = cycleDayBlock(cd.page);
  advanceCursor(nextCursor, "cycleDays", cd.page);

  const cy = pageOf(rows.cycles, limit);
  const cycles = cycleBlock(cy.page);
  advanceCursor(nextCursor, "cycles", cy.page);

  const mm = pageOf(rows.measurementMirror, limit);
  const measurementMirror = measurementMirrorBlock(mm.page);
  advanceCursor(
    nextCursor,
    "measurementMirror",
    mm.page.map((row) => ({
      // The walk only returns rows whose token carries a change stamp.
      updatedAt: row.ingestToken!.mirrorChangedAt!,
      id: row.id,
    })),
  );

  const hasMore =
    m.hasMore ||
    md.hasMore ||
    ik.hasMore ||
    cd.hasMore ||
    cy.hasMore ||
    mm.hasMore;

  annotate({
    action: { name: "sync.changes.pull" },
    meta: {
      measurement_upserts: measurements.upserts.length,
      measurement_tombstones: measurements.tombstones.length,
      mood_upserts: mood.upserts.length,
      mood_tombstones: mood.tombstones.length,
      intake_upserts: intakes.upserts.length,
      intake_tombstones: intakes.tombstones.length,
      cycle_day_upserts: cycleDays.upserts.length,
      cycle_day_tombstones: cycleDays.tombstones.length,
      cycle_upserts: cycles.upserts.length,
      cycle_tombstones: cycles.tombstones.length,
      measurement_mirror_upserts: measurementMirror.upserts.length,
      cycle_module_enabled: cycleEnabled,
      has_more: hasMore,
      cursor_present: Boolean(token),
    },
  });

  return {
    serverNow: serverNow.toISOString(),
    cursor: encodeCursor(nextCursor, serverNow.getTime()),
    hasMore,
    cursorExpired: false,
    changes: {
      measurements,
      mood,
      intakes,
      cycleDays,
      cycles,
      measurementMirror,
    },
  };
}
