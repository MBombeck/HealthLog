/**
 * v1.4.25 W19b — inventory persistence helpers.
 *
 * Thin layer on top of Prisma that the route handlers and the
 * intake hook compose. Keeps the state-machine math (pure) separate
 * from the I/O (here), so unit tests on the math don't need a DB.
 */

import { prisma } from "@/lib/db";
import {
  computeExpiresAt,
  decrementDose,
  type DecrementOutcome,
} from "./state-machine";

/**
 * Consume one dose from the user's active in-use pen for the given
 * medication. Called from the intake POST handler after the intake
 * event has been created.
 *
 * Selection policy:
 *   1. Prefer the IN_USE pen with the earliest `expiresAt` — that's
 *      the pen the user is currently working through.
 *   2. Fall back to the oldest ACTIVE pen (FIFO consumption — the
 *      pen that was purchased first gets opened first). The intake
 *      flips it ACTIVE → IN_USE and sets firstUseAt.
 *   3. If no eligible pen exists, this is a no-op. The user just
 *      logged an intake without a tracked pen — perfectly valid
 *      since inventory is opt-in per the W19a doses-per-unit
 *      design.
 *
 * The function intentionally only updates one pen per intake — if a
 * user double-doses (rare), they need to record two intake events
 * and the second one will pick up the same or a new pen.
 */
export async function consumeOneDose(input: {
  userId: string;
  medicationId: string;
  intakeAt: Date;
}): Promise<{
  itemId: string;
  change: DecrementOutcome;
} | null> {
  const { userId, medicationId, intakeAt } = input;

  // Prefer the IN_USE pen with the earliest expiry; tie-break by
  // createdAt ascending.
  const inUsePen = await prisma.medicationInventoryItem.findFirst({
    where: {
      userId,
      medicationId,
      state: "IN_USE",
      dosesRemaining: { gt: 0 },
    },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
  });

  const target =
    inUsePen ??
    (await prisma.medicationInventoryItem.findFirst({
      where: {
        userId,
        medicationId,
        state: "ACTIVE",
        dosesRemaining: { gt: 0 },
      },
      orderBy: [{ purchasedAt: "asc" }, { createdAt: "asc" }],
    }));

  if (!target) return null;

  const { item: nextValues, change } = decrementDose(
    {
      state: target.state,
      dosesTotal: target.dosesTotal,
      dosesRemaining: target.dosesRemaining,
      firstUseAt: target.firstUseAt,
      printedExpiry: target.printedExpiry,
    },
    intakeAt,
  );

  await prisma.medicationInventoryItem.update({
    where: { id: target.id },
    data: {
      state: nextValues.state,
      dosesRemaining: nextValues.dosesRemaining,
      firstUseAt: nextValues.firstUseAt,
      expiresAt: nextValues.expiresAt,
    },
  });

  return { itemId: target.id, change };
}

/**
 * Daily cron pass — flip any IN_USE rows whose 30-day window has
 * elapsed into EXPIRED. Returns the count of transitions for logging.
 *
 * Optionally scoped to a single user — useful for the per-user
 * trigger path. Cron with `userId: null` sweeps every user.
 */
export async function expireStaleInUseItems(input: {
  userId?: string;
  nowMs: number;
}): Promise<number> {
  const { userId, nowMs } = input;
  const now = new Date(nowMs);

  // Candidates: IN_USE rows whose `expiresAt` has lapsed. The
  // selector + state-machine semantics line up here — every row that
  // matches `state = IN_USE AND expiresAt < now` is also a row that
  // `computeInventoryState` would classify EXPIRED (clause 2 or 3),
  // because IN_USE implies `dosesRemaining > 0` (decrementDose flips
  // an empty pen to USED_UP) and the `expiresAt` filter already
  // proves the printed-expiry-or-window deadline has lapsed. EXPIRED
  // rows are already terminal; USED_UP rows are off-window by
  // definition. Use a single `updateMany` instead of one update per
  // row — the daily cron sweep ran N round-trips for nothing.
  const result = await prisma.medicationInventoryItem.updateMany({
    where: {
      state: "IN_USE",
      expiresAt: { lt: now },
      ...(userId ? { userId } : {}),
    },
    data: { state: "EXPIRED" },
  });
  return result.count;
}

/**
 * Helper for the POST /[medId]/inventory route. Composes the
 * Prisma-create with the computed `expiresAt` so the caller doesn't
 * have to re-derive it.
 */
export function buildCreateInventoryInput(input: {
  userId: string;
  medicationId: string;
  dosesTotal: number;
  printedExpiry: Date | null;
  purchasedAt: Date | null;
  notes: string | null;
}) {
  return {
    userId: input.userId,
    medicationId: input.medicationId,
    state: "ACTIVE" as const,
    dosesTotal: input.dosesTotal,
    dosesRemaining: input.dosesTotal,
    firstUseAt: null,
    printedExpiry: input.printedExpiry,
    purchasedAt: input.purchasedAt,
    expiresAt: computeExpiresAt(null, input.printedExpiry),
    notes: input.notes,
  };
}
