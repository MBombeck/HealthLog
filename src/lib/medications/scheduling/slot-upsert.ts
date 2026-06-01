/**
 * v1.8.2 — shared slot resolution for the intake write paths.
 *
 * Both `POST /api/medications/[id]/intake` (source WEB) and
 * `POST /api/medications/intake/bulk` (source API) must resolve an
 * incoming dose write to the canonical scheduled-slot instant so the
 * write updates the pending REMINDER row the projector/worker minted
 * rather than inserting a second row that differs only by `source` (and
 * by a sub-minute `scheduledFor` drift). This module loads the
 * medication's schedules + the rolling-anchor `lastIntakeAt` and runs the
 * pure `resolveCanonicalSlotInstant` snap.
 *
 * Returns `null` when the dose does not map to a scheduled slot
 * (PRN / off-slot beyond tolerance / cyclic off-week / no schedules) —
 * the caller's signal to keep the unmodified insert behaviour.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { prisma as defaultPrisma } from "@/lib/db";
import { resolveCanonicalSlotInstant } from "@/lib/medications/scheduling/resolve-slot-instant";
import type { WorkerScheduleRow } from "@/lib/medications/scheduling/worker-helpers";

type PrismaLike = Pick<PrismaClient, "medication" | "medicationIntakeEvent">;

/** Narrow a thrown Prisma error to the P2002 unique-constraint code. */
function isP2002(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}

/** The minimal intake-row shape the slot upsert reads + returns. */
export interface SlotIntakeRow {
  id: string;
  takenAt: Date | null;
  skipped: boolean;
  idempotencyKey: string | null;
  scheduledFor: Date;
  source: string;
  createdAt: Date;
}

export interface ApplyCanonicalSlotWriteInput {
  client: PrismaLike;
  userId: string;
  medicationId: string;
  /** Canonical slot instant the write snaps to (never null here). */
  canonicalSlot: Date;
  /** Resolved takenAt for the write (null = pending or skipped). */
  takenAt: Date | null;
  skipped: boolean;
  /** Explicit user action vs an idempotent / offline projection echo. */
  isExplicitTaken: boolean;
  isExplicitSkip: boolean;
  idempotencyKey: string | null;
  /** Source to stamp on a freshly-created slot row. */
  createSource: "WEB" | "API";
}

export interface ApplyCanonicalSlotWriteResult {
  row: SlotIntakeRow;
  /** "updated" an existing slot row, or "inserted" a new one. */
  outcome: "updated" | "inserted";
  /**
   * True when this write moved the slot from pending (no `takenAt`) to
   * taken — the ONLY transition that should decrement pen inventory.
   * False for a fresh skip, an idempotent re-post of an already-taken
   * slot, or a no-op pending echo.
   */
  consumedTransition: boolean;
  /**
   * True when the incoming write was a pending projection echo onto an
   * already-actioned slot and was treated as a no-op (C2 no-downgrade).
   */
  noDowngradeNoOp: boolean;
}

const SLOT_ROW_SELECT = {
  id: true,
  takenAt: true,
  skipped: true,
  idempotencyKey: true,
  scheduledFor: true,
  source: true,
  createdAt: true,
} as const;

/**
 * Deterministically pick the slot row a write should converge onto when
 * the canonical instant carries more than one live row (pre-existing
 * same-slot duplicates that differ only by `source`).
 *
 * H1 ordering — prefer the row that should become the dose of record:
 *   1. an already-actioned row (takenAt set OR skipped) over a pending one
 *      — we update the REAL dose, never resurrect a phantom pending row;
 *   2. tie-break createdAt ASC, then id ASC (lexicographic) — fully
 *      deterministic across runs and DB orderings.
 *
 * Prisma `findFirst` cannot express the "actioned-first" preference in a
 * single `orderBy`, so the candidate set is fetched in the deterministic
 * `(createdAt asc, id asc)` order and the actioned-preference is applied
 * in memory. The set is tiny (one slot's rows), so the cost is nil.
 */
function pickSlotRow(rows: SlotIntakeRow[]): SlotIntakeRow | null {
  if (rows.length === 0) return null;
  const actioned = rows.filter((r) => r.takenAt !== null || r.skipped);
  // `rows` already arrives in (createdAt asc, id asc) order, so the first
  // element of either partition is the deterministic winner.
  return (actioned.length > 0 ? actioned : rows)[0];
}

async function findSlotRows(
  client: PrismaLike,
  userId: string,
  medicationId: string,
  canonicalSlot: Date,
): Promise<SlotIntakeRow[]> {
  return (await client.medicationIntakeEvent.findMany({
    where: {
      userId,
      medicationId,
      scheduledFor: canonicalSlot,
      deletedAt: null,
    },
    select: SLOT_ROW_SELECT,
    // H1 — deterministic order; actioned-preference applied in
    // `pickSlotRow`.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as SlotIntakeRow[];
}

/**
 * Apply an intake write to the canonical scheduled slot, converging onto
 * one row per `(userId, medicationId, scheduledFor)` regardless of
 * `source`. Implements the medically-critical reconcile invariants:
 *
 *   - H1 deterministic row selection (actioned > pending; createdAt/id);
 *   - C2 no-downgrade — a pending projection echo onto an already-actioned
 *     slot is a no-op (never clears a recorded `takenAt`); explicit user
 *     taken / skip writes still apply (last-write-wins);
 *   - C1 race-safe create — a concurrent insert that wins the P2002 race
 *     is re-found and updated rather than 500-ing or duplicating;
 *   - M2 inventory gating — `consumedTransition` is true only on an actual
 *     pending→taken move.
 */
export async function applyCanonicalSlotWrite(
  input: ApplyCanonicalSlotWriteInput,
): Promise<ApplyCanonicalSlotWriteResult> {
  const {
    client,
    userId,
    medicationId,
    canonicalSlot,
    takenAt,
    skipped,
    idempotencyKey,
    createSource,
  } = input;

  const rows = await findSlotRows(client, userId, medicationId, canonicalSlot);
  const existing = pickSlotRow(rows);

  if (existing) {
    return applyToExisting(client, existing, input);
  }

  // No live slot row — create. C1: a concurrent insert (dashboard
  // projector `createMany`, double-tap, the reminder worker) can land a
  // row at the same canonical `(userId, medicationId, scheduledFor,
  // source)` between the find and this create, throwing P2002. Re-find
  // the slot (ignoring source) and update it so the write converges to
  // one row rather than 500-ing or duplicating.
  try {
    const created = (await client.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId,
        scheduledFor: canonicalSlot,
        takenAt,
        skipped,
        source: createSource,
        idempotencyKey,
      },
      select: SLOT_ROW_SELECT,
    })) as SlotIntakeRow;
    return {
      row: created,
      outcome: "inserted",
      // A fresh row that records a takenAt is a pending→taken transition
      // (there was no prior row), so inventory should decrement.
      consumedTransition: takenAt !== null,
      noDowngradeNoOp: false,
    };
  } catch (err) {
    if (!isP2002(err)) throw err;
    const raced = await findSlotRows(
      client,
      userId,
      medicationId,
      canonicalSlot,
    );
    const winner = pickSlotRow(raced);
    if (!winner) throw err; // genuinely gone — surface the original error.
    return applyToExisting(client, winner, {
      ...input,
      // The slot now has a row; the create's intended idempotencyKey
      // still applies to the converged row.
    });
  }
}

/**
 * Update an existing slot row, enforcing the C2 no-downgrade guard and
 * computing the M2 inventory-transition flag.
 */
async function applyToExisting(
  client: PrismaLike,
  existing: SlotIntakeRow,
  input: ApplyCanonicalSlotWriteInput,
): Promise<ApplyCanonicalSlotWriteResult> {
  const { takenAt, skipped, isExplicitTaken, isExplicitSkip, idempotencyKey } =
    input;

  const existingActioned = existing.takenAt !== null || existing.skipped;
  const incomingIsPendingEcho = !isExplicitTaken && !isExplicitSkip;

  // C2 — never clear a recorded dose with a pending projection echo. An
  // iOS offline re-sync replays a PENDING projection (no takenAt,
  // skipped=false) for a slot the user already actioned; applying it
  // would overwrite `takenAt` to null and convert a recorded dose into a
  // missed one. A taken dose is an immutable fact. Treat the echo as a
  // no-op and return the existing row unchanged so the sync cursor
  // advances. Explicit taken / skip writes still apply (last-write-wins,
  // matching the status-toggle route).
  if (incomingIsPendingEcho && existingActioned) {
    return {
      row: existing,
      outcome: "updated",
      consumedTransition: false,
      noDowngradeNoOp: true,
    };
  }

  // M2 — only a genuine pending→taken move consumes inventory. Re-posting
  // an already-taken slot must not decrement again.
  const consumedTransition = existing.takenAt === null && takenAt !== null;

  const row = (await client.medicationIntakeEvent.update({
    where: { id: existing.id },
    data: {
      takenAt,
      skipped,
      syncVersion: { increment: 1 },
      idempotencyKey: idempotencyKey ?? existing.idempotencyKey ?? null,
    },
    select: SLOT_ROW_SELECT,
  })) as SlotIntakeRow;

  return {
    row,
    outcome: "updated",
    consumedTransition,
    noDowngradeNoOp: false,
  };
}

const SCHEDULE_SELECT = {
  id: true,
  windowStart: true,
  windowEnd: true,
  daysOfWeek: true,
  timesOfDay: true,
  reminderGraceMinutes: true,
  rrule: true,
  rollingIntervalDays: true,
  scheduleType: true,
  cyclicOnWeeks: true,
  cyclicOffWeeks: true,
} as const;

const MEDICATION_SELECT = {
  id: true,
  startsOn: true,
  endsOn: true,
  oneShot: true,
  createdAt: true,
  schedules: { select: SCHEDULE_SELECT },
} as const;

export interface ResolveSlotForWriteInput {
  userId: string;
  medicationId: string;
  userTz: string;
  /**
   * The write's `scheduledFor`, or `takenAt` as the fallback when the
   * client omitted `scheduledFor`.
   */
  incoming: Date;
  /** Inject a Prisma client/tx in tests; defaults to the app client. */
  client?: PrismaLike;
}

/**
 * Resolve the canonical scheduled-slot instant for an intake write, or
 * `null` when the dose is unscheduled (PRN / off-slot / no schedules).
 *
 * Loads the medication's schedule rows (and, when any schedule is
 * rolling, the latest non-tombstoned `takenAt` to anchor the next-due
 * computation byte-identically to the projector + worker).
 */
export async function resolveSlotInstantForWrite(
  input: ResolveSlotForWriteInput,
): Promise<Date | null> {
  const client = input.client ?? defaultPrisma;

  const medication = await client.medication.findFirst({
    where: { id: input.medicationId, userId: input.userId },
    select: MEDICATION_SELECT,
  });
  if (!medication || medication.schedules.length === 0) return null;

  // Rolling cadence anchors off the last logged intake — fetch it only
  // when a schedule actually needs it (mirrors the projector's gate).
  let lastIntakeAt: Date | null = null;
  if (medication.schedules.some((s) => s.rollingIntervalDays !== null)) {
    const lastIntake = await client.medicationIntakeEvent.findFirst({
      where: {
        userId: input.userId,
        medicationId: input.medicationId,
        deletedAt: null,
        takenAt: { not: null },
      },
      orderBy: { takenAt: "desc" },
      select: { takenAt: true },
    });
    lastIntakeAt = lastIntake?.takenAt ?? null;
  }

  return resolveCanonicalSlotInstant({
    medication: {
      id: medication.id,
      startsOn: medication.startsOn,
      endsOn: medication.endsOn,
      oneShot: medication.oneShot,
      createdAt: medication.createdAt,
      schedules: medication.schedules as WorkerScheduleRow[],
    },
    userTz: input.userTz,
    incoming: input.incoming,
    lastIntakeAt,
  });
}
