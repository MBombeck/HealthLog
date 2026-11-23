/**
 * The row one bulk intake entry lands on: the canonical slot write, the
 * idempotency replay, the convergence probe onto a row already on the named
 * instant, or the standalone insert, with the inventory hook each one owes.
 */
import { prisma } from "@/lib/db";
import {
  createAdHocIntake,
  findRowForExternalDoseAt,
} from "@/lib/medications/ad-hoc-intake";
import type { SessionUser } from "@/lib/auth/session-user";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";
import {
  applyCanonicalSlotWrite,
  mayConvergeOntoSuppliedSlot,
} from "@/lib/medications/scheduling/slot-upsert";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import type { BatchState, BulkIntakeEntry } from "./batch-state";
import type { EntryAttribution } from "./entry-attribution";

export interface EntryWrite {
  user: Pick<SessionUser, "id" | "timezone">;
  entry: BulkIntakeEntry;
  index: number;
  incomingScheduledFor: Date;
  isExplicitTaken: boolean;
  isExplicitSkip: boolean;
  attribution: EntryAttribution;
  resolvedInjectionSite: InjectionSiteKey | null;
}

/**
 * Converge onto the one slot row through the shared upsert: H1
 * deterministic selection, C2 no-downgrade guard, and a C1 race-safe create
 * that re-finds + updates on a P2002 collision rather than misclassifying it
 * as a duplicate and dropping the dose.
 */
async function writeOntoSlot(
  write: EntryWrite,
  state: BatchState,
  canonicalSlot: Date,
): Promise<void> {
  const { user, entry, index: i, isExplicitTaken, isExplicitSkip } = write;
  const applied = await applyCanonicalSlotWrite({
    client: prisma,
    userId: user.id,
    medicationId: entry.medicationId,
    canonicalSlot,
    takenAt: entry.takenAt ?? null,
    skipped: entry.skipped,
    isExplicitTaken,
    isExplicitSkip,
    idempotencyKey: entry.idempotencyKey ?? null,
    // An Apple dose-event import stamps its provenance on a
    // fresh row; every other caller keeps today's "API".
    createSource: entry.source ?? "API",
    injectionSite: write.resolvedInjectionSite,
    attributionSource: write.attribution.attributionSource,
    // Dose override only documents a consumed dose.
    doseTaken: (!entry.skipped && entry.doseTaken) || null,
    // External dose-event UUID rides onto the landed row.
    externalId: entry.externalId ?? null,
    takenVia: entry.source === "APPLE_HEALTH" ? "APPLE_HEALTH" : "APP",
  });
  const slotInstant = canonicalSlot.toISOString();
  if (applied.alreadyTaken) {
    // The slot already holds a take: nothing written, and the entry says
    // when and how that take was recorded so the app can warn before a
    // second dose. Advances the cursor like `duplicate`.
    state.duplicates += 1;
    state.results.push({
      index: i,
      status: "alreadyTaken",
      id: applied.row.id,
      intake: applied.row,
      takenAt: applied.row.takenAt?.toISOString() ?? null,
      takenVia: applied.row.takenVia ?? null,
      slotInstant,
    });
  } else if (applied.noDowngradeNoOp) {
    // Pending echo onto an already-actioned slot. Report it as a
    // duplicate so the iOS cursor advances WITHOUT downgrading the
    // recorded dose. A pending echo is never a taken write, so it
    // must never reach the inventory consume below.
    state.duplicates += 1;
    state.results.push({
      index: i,
      status: "duplicate",
      id: applied.row.id,
      slotInstant,
    });
  } else if (applied.outcome === "updated") {
    state.updated += 1;
    state.results.push({
      index: i,
      status: "updated",
      id: applied.row.id,
      slotInstant,
    });
  } else {
    state.inserted += 1;
    state.results.push({
      index: i,
      status: "inserted",
      id: applied.row.id,
      slotInstant,
    });
  }
  // Inventory: only the genuine pending→taken
  // transition consumes (the upsert's `consumedTransition` flag —
  // the ONLY transition that may move stock). The stamp keeps a
  // replayed batch exactly-once for stamped rows; the
  // transition gate additionally protects pre-stamp rows: a full
  // journal replay re-posting historical taken doses must not
  // drain today's stock through their NULL stamps. An explicit
  // skip refunds a previously-taken row's stamp. Pending echoes
  // carry neither flag and never touch stock.
  if (applied.consumedTransition && isExplicitTaken) {
    await consumeForIntake({
      client: prisma,
      userId: user.id,
      medicationId: entry.medicationId,
      eventId: applied.row.id,
      intakeAt: entry.takenAt as Date,
    });
  } else if (!applied.noDowngradeNoOp && isExplicitSkip) {
    await restoreForIntake({
      client: prisma,
      userId: user.id,
      eventId: applied.row.id,
    });
  }
}

/**
 * The idempotencyKey replay pre-check: a re-submission returns the existing
 * row as "duplicate" (previously reached via the P2002 catch; the explicit
 * probe keeps that contract now that a replay could otherwise converge as
 * "updated"). Scoped to the caller. The key is client-supplied, so an
 * unscoped read would resolve another user's row and hand its id back here
 * (migration 0273 made the unique per user).
 */
async function replayedRowId(write: EntryWrite): Promise<string | null> {
  const { user, entry } = write;
  if (!entry.idempotencyKey) return null;
  const replay = await prisma.medicationIntakeEvent.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: user.id,
        idempotencyKey: entry.idempotencyKey,
      },
    },
    select: { id: true },
  });
  return replay?.id ?? null;
}

/**
 * Genuinely standalone. Anchor the row on the intake instant — the
 * documented ad-hoc contract (`scheduledFor = takenAt`) — so an unresolvable
 * client anchor (a future slot instant the taken guard rejected) can never
 * park a live row exactly on a slot the worker later mints a pending
 * REMINDER row for. A pending echo (no takenAt) keeps the incoming instant.
 * On the exact instant of a slot row it moves to the next free millisecond
 * (`ad-hoc-intake.ts`), so an extra dose on the minute of a held slot lands.
 * The idempotencyKey, when supplied, has a UNIQUE index; a racing
 * re-submission returns the existing row via P2002 → status: "duplicate".
 */
async function insertStandalone(
  write: EntryWrite,
  state: BatchState,
): Promise<Date> {
  const { user, entry, index: i, resolvedInjectionSite } = write;
  const row = await createAdHocIntake(prisma, {
    userId: user.id,
    medicationId: entry.medicationId,
    scheduledFor: entry.takenAt ?? write.incomingScheduledFor,
    takenAt: entry.takenAt ?? null,
    skipped: entry.skipped,
    // Apple provenance on a standalone (ad-hoc) row;
    // every other caller keeps today's "API".
    source: entry.source ?? "API",
    ...(entry.takenAt && {
      takenVia: entry.source === "APPLE_HEALTH" ? "APPLE_HEALTH" : "APP",
    }),
    idempotencyKey: entry.idempotencyKey ?? null,
    // External dose-event UUID for the idempotent
    // re-sync dedup.
    ...(entry.externalId !== undefined && {
      externalId: entry.externalId,
    }),
    // Site only on a resolved taken-injection entry.
    ...(resolvedInjectionSite !== null && {
      injectionSite: resolvedInjectionSite,
    }),
    // Dose override only on a taken entry carrying one.
    ...(!entry.skipped && entry.doseTaken && { doseTaken: entry.doseTaken }),
  });
  state.inserted += 1;
  // On no slot: the row is anchored on its own instant.
  state.results.push({
    index: i,
    status: "inserted",
    id: row.id,
    slotInstant: null,
  });
  // A fresh standalone taken row consumes inventory
  // units (a fresh skip / pending row has nothing to consume or
  // refund).
  if (write.isExplicitTaken) {
    await consumeForIntake({
      client: prisma,
      userId: user.id,
      medicationId: entry.medicationId,
      eventId: row.id,
      intakeAt: entry.takenAt as Date,
    });
  }
  return row.scheduledFor;
}

/**
 * Write the entry. The answer is the `scheduledFor` instant the row actually
 * lands on, so the dose-day refresh keys the same day the stored row anchors
 * to, or null when an idempotency replay answered the entry and nothing
 * after the write applies to it.
 */
export async function writeEntry(
  write: EntryWrite,
  state: BatchState,
): Promise<Date | null> {
  const { user, entry, index: i, incomingScheduledFor } = write;
  const { canonicalSlot, heldByAnotherDose } = write.attribution;
  if (canonicalSlot) {
    // Scheduled dose — converge onto the one canonical slot row.
    await writeOntoSlot(write, state, canonicalSlot);
    return canonicalSlot;
  }
  // Resolver-null: PRN / off-slot / future-slot-guarded. Before the
  // standalone insert, two guards keep the slot from forking into a
  // second live row:
  //
  //   1. idempotencyKey replay pre-check (see `replayedRowId`);
  //   2. source-agnostic convergence probe — when ANY live row already
  //      sits on the incoming instant (e.g. the pending REMINDER row
  //      the worker pre-minted on a slot the taken-write future guard
  //      refused to snap to), converge onto THAT row through the shared
  //      slot upsert instead of inserting a sibling that differs only
  //      by `source`. The partial unique index carries `source`, so it
  //      cannot catch this duplicate; the probe must. A row recording
  //      another Apple dose event is not the slot: two events on one
  //      minute are two doses (`findRowForExternalDoseAt`).
  const replayId = await replayedRowId(write);
  if (replayId !== null) {
    state.duplicates += 1;
    state.results.push({ index: i, status: "duplicate", id: replayId });
    return null;
  }
  // Only an explicit client `scheduledFor` names a slot a row could
  // already sit on; a defaulted anchor (takenAt / now) never does, so
  // the probe is skipped on that path.
  //
  // Dose-safety guard: a TAKEN entry must not converge onto a slot
  // whose anchor is in the future relative to the take. The resolver's
  // forward guard already refused to snap a late take onto a future
  // slot; the probe must honour the same invariant rather than binding
  // the take forward onto that slot's pending REMINDER row (a
  // late-morning dose consuming the evening slot). It records
  // standalone (ad-hoc) instead.
  const existingSlotRow =
    !heldByAnotherDose &&
    entry.scheduledFor !== undefined &&
    mayConvergeOntoSuppliedSlot({
      skipped: entry.skipped,
      takenAt: entry.takenAt ?? null,
      suppliedSlot: incomingScheduledFor,
    })
      ? await findRowForExternalDoseAt({
          userId: user.id,
          medicationId: entry.medicationId,
          instant: incomingScheduledFor,
          externalId: entry.externalId ?? null,
        })
      : null;
  if (existingSlotRow) {
    await writeOntoSlot(write, state, incomingScheduledFor);
    return incomingScheduledFor;
  }
  return insertStandalone(write, state);
}
