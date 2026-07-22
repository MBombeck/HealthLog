/**
 * v1.16.10 — per-intake inventory consumption + restore.
 *
 * The single write path between intake events and inventory items.
 * Every seam that flips an intake event to TAKEN calls
 * `consumeForIntake`; every seam that takes a row OUT of taken
 * (skip toggle, edit, delete, bulk delete, slot-dedup tombstone)
 * calls `restoreForIntake`. No other module may write
 * `medicationInventoryItem` rows outside the inventory CRUD routes —
 * a convention test pins that.
 *
 * Exactly-once semantics hang off the consumption STAMP — the
 * `MedicationIntakeEvent.inventoryConsumption` Json column holding
 * `[{itemId, units}]`:
 *
 *   - `consumeForIntake` is a no-op on a stamped row, so idempotent
 *     replays (iOS sync, Telegram redelivery, double taps) can call it
 *     freely and the stock only ever moves once per taken event.
 *   - `restoreForIntake` refunds exactly what the stamp recorded and
 *     clears it, so a later re-take consumes afresh. The stamp freezes
 *     history: editing `Medication.unitsPerDose` after the fact never
 *     changes what an already-taken dose consumed or refunds.
 *
 * Consumption is in UNITS (`Medication.unitsPerDose` per dose), pulled
 * from the open container first, then FEFO over unopened stock with
 * auto-open, spilling across containers, flooring at zero when the
 * tracked stock runs out (partial stamp — never negative, never an
 * error).
 *
 * Both functions are best-effort and NEVER throw: a failure annotates
 * (`medication.inventory.consume_error` / `.restore_error`) and
 * returns — the intake write is the source of truth, the inventory is
 * an opt-in companion that must never block a dose record.
 */

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { toJson } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { computeExpiresAt, computeInventoryState } from "./state-machine";

/** The Prisma surface the consumption hook needs. A bare transaction
 *  client satisfies it; the base client additionally carries
 *  `$transaction`, which the hook uses to keep the item updates and
 *  the stamp write atomic. */
type ConsumptionClient = Pick<
  PrismaClient,
  "medication" | "medicationIntakeEvent" | "medicationInventoryItem"
> &
  Partial<Pick<PrismaClient, "$transaction">>;

type TxClient = Pick<
  PrismaClient,
  "medication" | "medicationIntakeEvent" | "medicationInventoryItem"
> &
  Partial<Pick<PrismaClient, "$queryRaw">>;

/** One consumed slice of the stamp: `units` taken from `itemId`. */
export interface InventoryConsumptionEntry {
  itemId: string;
  units: number;
}

/**
 * Run `fn` atomically. When the caller hands us the base client we
 * open an interactive transaction; when it hands us a transaction
 * client (no `$transaction` on it) the caller's transaction already
 * provides the atomicity and we run inline.
 */
async function runAtomically<T>(
  client: ConsumptionClient,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  if (typeof client.$transaction === "function") {
    return client.$transaction((tx) => fn(tx as TxClient));
  }
  return fn(client);
}

async function lockMedicationInventory(
  tx: TxClient,
  medicationId: string,
): Promise<void> {
  if (typeof tx.$queryRaw !== "function") return;
  await tx.$queryRaw(
    Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${medicationId}, 0))) AS lock`,
  );
}

/** Parse a stamp column value defensively — a malformed stamp refunds
 *  nothing rather than throwing. */
function parseStamp(
  value: Prisma.JsonValue | null,
): InventoryConsumptionEntry[] | null {
  if (value === null || !Array.isArray(value)) return null;
  const entries: InventoryConsumptionEntry[] = [];
  for (const raw of value) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      typeof (raw as { itemId?: unknown }).itemId === "string" &&
      typeof (raw as { units?: unknown }).units === "number" &&
      Number.isFinite((raw as { units: number }).units) &&
      (raw as { units: number }).units > 0
    ) {
      entries.push({
        itemId: (raw as { itemId: string }).itemId,
        // v1.16.12 — the stamp carries FRACTIONAL units (½ tablet per
        // dose), so it is no longer floored: refunding a split-pill dose
        // must return the exact 0.5 it consumed.
        units: (raw as { units: number }).units,
      });
    }
  }
  return entries;
}

/**
 * Consume the medication's `unitsPerDose` units for one taken intake
 * event and stamp the event with what was consumed.
 *
 * No-op unless the event row is live (`deletedAt: null`), taken
 * (`takenAt` set), non-skipped, and UNSTAMPED — the stamp is the
 * exactly-once gate, so replays and re-posts never double-decrement.
 *
 * Container selection:
 *   1. the open container — IN_USE with `unitsRemaining > 0`, earliest
 *      `expiresAt` first (createdAt tiebreak);
 *   2. then FEFO over unopened ACTIVE stock — `printedExpiry` asc with
 *      nulls last, then `purchasedAt` asc (nulls last), then
 *      `createdAt` asc. Pulling from an ACTIVE container auto-opens it
 *      (`firstUseAt = intakeAt`, state via the state machine — a
 *      backdated intake can land it straight in EXPIRED when the
 *      30-day window has already lapsed; that is correct).
 *
 * Consumption spills: when the current container holds fewer units
 * than still owed, it drains to zero and the next container covers the
 * rest. When the tracked stock runs out the consumption floors at
 * zero overall — the stamp records the partial amount, no error, no
 * negative counts.
 */
export async function consumeForIntake(input: {
  client: ConsumptionClient;
  userId: string;
  medicationId: string;
  eventId: string;
  intakeAt: Date;
}): Promise<void> {
  const { client, userId, medicationId, eventId, intakeAt } = input;
  try {
    await runAtomically(client, async (tx) => {
      await lockMedicationInventory(tx, medicationId);
      // Atomic claim — gate check and stamp reservation in ONE
      // conditional UPDATE. A plain read-then-write gate is not safe
      // under READ COMMITTED: two concurrent consume calls for the same
      // event (a double tap racing an iOS sync replay) both read the
      // NULL stamp and both decrement. The claim takes the event's row
      // lock and re-evaluates the predicate after a blocking peer
      // commits, so exactly one caller wins; the loser sees count 0 and
      // returns. The placeholder `[]` is overwritten with the real
      // stamp below inside the same transaction — and rolls back with
      // it if the consumption fails, so a failed consume never leaves a
      // row stamped.
      const claimed = await tx.medicationIntakeEvent.updateMany({
        where: {
          id: eventId,
          userId,
          medicationId,
          deletedAt: null,
          takenAt: { not: null },
          skipped: false,
          inventoryConsumption: { equals: Prisma.AnyNull },
        },
        data: { inventoryConsumption: [] },
      });
      if (claimed.count === 0) return;

      const medication = await tx.medication.findFirst({
        where: { id: medicationId, userId },
        select: { unitsPerDose: true },
      });
      if (!medication) return;
      // v1.16.12 — Decimal column; a dose may consume a FRACTION of a
      // unit (½ / ¼ tablet for a split pill). Convert to a JS number for
      // the arithmetic below (unit counts stay well within double
      // precision) and gate at > 0, NOT at ≥ 1 — the old `Math.max(1, …)`
      // clamp would silently turn a half-tablet dose back into a whole one.
      const unitsPerDose = Number(medication.unitsPerDose);
      if (!(unitsPerDose > 0)) return;

      // Candidate containers, in consumption order: the open container
      // first (earliest in-use deadline), then FEFO over unopened
      // stock. Both lists are loaded inside the transaction so the
      // updates apply to the rows just read.
      const inUse = await tx.medicationInventoryItem.findMany({
        where: {
          userId,
          medicationId,
          state: "IN_USE",
          unitsRemaining: { gt: 0 },
        },
        orderBy: [
          { expiresAt: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
      });
      const active = await tx.medicationInventoryItem.findMany({
        where: {
          userId,
          medicationId,
          state: "ACTIVE",
          unitsRemaining: { gt: 0 },
        },
        orderBy: [
          { printedExpiry: { sort: "asc", nulls: "last" } },
          { purchasedAt: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
      });

      const stamp: InventoryConsumptionEntry[] = [];
      const itemIds: string[] = [];
      let autoOpened = 0;
      let owed = unitsPerDose;
      // State derives at the WALL clock, not the intake instant: a
      // backdated take that auto-opens a container starts its in-use
      // window at the (past) intakeAt, so the container can land
      // straight in EXPIRED when that window has already lapsed by now
      // — correct, the daily cron would flip it on the next sweep
      // anyway.
      const nowMs = Date.now();

      for (const item of [...inUse, ...active]) {
        if (owed <= 0) break;
        const take = Math.min(owed, Number(item.unitsRemaining));
        if (take <= 0) continue;

        const wasUnopened = item.firstUseAt === null;
        const nextFirstUseAt = item.firstUseAt ?? intakeAt;
        const nextUnitsRemaining = Number(item.unitsRemaining) - take;
        const nextExpiresAt = computeExpiresAt(
          nextFirstUseAt,
          item.printedExpiry,
        );
        const nextState = computeInventoryState(
          {
            state: item.state,
            unitsTotal: Number(item.unitsTotal),
            unitsRemaining: nextUnitsRemaining,
            firstUseAt: nextFirstUseAt,
            printedExpiry: item.printedExpiry,
          },
          nowMs,
        );

        await tx.medicationInventoryItem.update({
          where: { id: item.id },
          data: {
            state: nextState,
            unitsRemaining: nextUnitsRemaining,
            firstUseAt: nextFirstUseAt,
            expiresAt: nextExpiresAt,
          },
        });

        stamp.push({ itemId: item.id, units: take });
        itemIds.push(item.id);
        if (wasUnopened) autoOpened += 1;
        owed -= take;
      }

      // Stamp the event even when nothing (or only part) could be
      // consumed: the stamp is the exactly-once gate, and a dose taken
      // with no tracked stock must not retro-consume containers
      // registered later when a sync replay revisits the row.
      await tx.medicationIntakeEvent.update({
        where: { id: eventId },
        data: { inventoryConsumption: toJson(stamp) },
      });

      annotate({
        action: { name: "medication.inventory.consumed" },
        meta: {
          medication_id: medicationId,
          units: unitsPerDose - owed,
          item_ids: itemIds,
          auto_opened: autoOpened,
        },
      });
    });
  } catch (err) {
    annotate({
      action: { name: "medication.inventory.consume_error" },
      meta: {
        medication_id: medicationId,
        event_id: eventId,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export interface ImportedIntakeConsumption {
  eventId: string;
  intakeAt: Date;
}

/**
 * Consume inventory for one bounded import chunk.
 *
 * The caller passes only rows returned by `createManyAndReturn`, so every event
 * is fresh and invisible outside the caller's transaction. One medication
 * advisory lock serializes chunks for the same medication, one inventory read
 * feeds the entire chunk, and each touched item is written once. Event stamps
 * keep a retry observable exactly once.
 *
 * Unlike the request-time single-event hook, this strict batch variant throws:
 * the import worker owns the surrounding transaction and must roll the event
 * inserts back when inventory bookkeeping cannot complete.
 */
export async function consumeImportedIntakesBatch(input: {
  client: ConsumptionClient;
  userId: string;
  medicationId: string;
  events: readonly ImportedIntakeConsumption[];
}): Promise<void> {
  const { client, userId, medicationId, events } = input;
  if (events.length === 0) return;

  await runAtomically(client, async (tx) => {
    await lockMedicationInventory(tx, medicationId);

    const claimed = await tx.medicationIntakeEvent.updateMany({
      where: {
        id: { in: events.map(({ eventId }) => eventId) },
        userId,
        medicationId,
        deletedAt: null,
        takenAt: { not: null },
        skipped: false,
        inventoryConsumption: { equals: Prisma.AnyNull },
      },
      data: { inventoryConsumption: [] },
    });
    if (claimed.count !== events.length) {
      throw new Error("Imported intake inventory claim was not exclusive");
    }

    const medication = await tx.medication.findFirst({
      where: { id: medicationId, userId },
      select: { unitsPerDose: true },
    });
    if (!medication) {
      throw new Error("Imported intake medication no longer exists");
    }
    const unitsPerDose = Number(medication.unitsPerDose);
    if (!(unitsPerDose > 0)) {
      throw new Error("Imported intake medication has an invalid dose size");
    }

    const [inUse, active] = await Promise.all([
      tx.medicationInventoryItem.findMany({
        where: {
          userId,
          medicationId,
          state: "IN_USE",
          unitsRemaining: { gt: 0 },
        },
        orderBy: [
          { expiresAt: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
      }),
      tx.medicationInventoryItem.findMany({
        where: {
          userId,
          medicationId,
          state: "ACTIVE",
          unitsRemaining: { gt: 0 },
        },
        orderBy: [
          { printedExpiry: { sort: "asc", nulls: "last" } },
          { purchasedAt: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
      }),
    ]);

    const items = [...inUse, ...active].map((item) => ({
      ...item,
      unitsRemaining: Number(item.unitsRemaining),
    }));
    const changedItems = new Map<string, (typeof items)[number]>();
    const stamps = new Map<string, InventoryConsumptionEntry[]>();
    const nowMs = Date.now();
    let totalConsumed = 0;
    let autoOpened = 0;

    for (const event of events) {
      let owed = unitsPerDose;
      const stamp: InventoryConsumptionEntry[] = [];
      for (const item of items) {
        if (owed <= 0) break;
        if (item.unitsRemaining <= 0) continue;
        if (item.state !== "IN_USE" && item.state !== "ACTIVE") continue;

        const take = Math.min(owed, item.unitsRemaining);
        const wasUnopened = item.firstUseAt === null;
        const nextFirstUseAt = item.firstUseAt ?? event.intakeAt;
        item.unitsRemaining -= take;
        item.firstUseAt = nextFirstUseAt;
        item.expiresAt = computeExpiresAt(nextFirstUseAt, item.printedExpiry);
        item.state = computeInventoryState(
          {
            state: item.state,
            unitsTotal: Number(item.unitsTotal),
            unitsRemaining: item.unitsRemaining,
            firstUseAt: nextFirstUseAt,
            printedExpiry: item.printedExpiry,
          },
          nowMs,
        );
        changedItems.set(item.id, item);
        stamp.push({ itemId: item.id, units: take });
        totalConsumed += take;
        owed -= take;
        if (wasUnopened) autoOpened += 1;
      }
      stamps.set(event.eventId, stamp);
    }

    await Promise.all([
      ...[...changedItems.values()].map((item) =>
        tx.medicationInventoryItem.update({
          where: { id: item.id },
          data: {
            state: item.state,
            unitsRemaining: item.unitsRemaining,
            firstUseAt: item.firstUseAt,
            expiresAt: item.expiresAt,
          },
        }),
      ),
      ...events.map(({ eventId }) =>
        tx.medicationIntakeEvent.update({
          where: { id: eventId },
          data: { inventoryConsumption: toJson(stamps.get(eventId) ?? []) },
        }),
      ),
    ]);

    annotate({
      action: { name: "medication.inventory.consumed" },
      meta: {
        medication_id: medicationId,
        units: totalConsumed,
        item_ids: [...changedItems.keys()],
        auto_opened: autoOpened,
        event_count: events.length,
      },
    });
  });
}

/**
 * Refund the consumption a stamped intake event recorded and clear
 * the stamp.
 *
 * No stamp = no-op (the row never consumed, or was already restored).
 * Each refund is clamped to the item's `unitsTotal` so a stock
 * correction in between can never overfill a container; the state
 * re-derives through the state machine, so a USED_UP container whose
 * units come back flips to IN_USE (or EXPIRED when its clock has
 * lapsed meanwhile). A stamped item that was deleted since is skipped.
 */
export async function restoreForIntake(input: {
  client: ConsumptionClient;
  userId: string;
  eventId: string;
}): Promise<void> {
  const { client, userId, eventId } = input;
  try {
    await runAtomically(client, async (tx) => {
      const event = await tx.medicationIntakeEvent.findFirst({
        where: { id: eventId, userId },
        select: {
          id: true,
          medicationId: true,
          inventoryConsumption: true,
        },
      });
      if (!event || event.inventoryConsumption === null) return;
      await lockMedicationInventory(tx, event.medicationId);
      const stampValue = event.inventoryConsumption;

      // Atomic claim — clear the stamp ONLY while it still holds the
      // exact value just read (jsonb structural equality). The claim
      // takes the event's row lock, so two concurrent restores cannot
      // both refund: the loser blocks, re-evaluates against the
      // now-NULL stamp, sees count 0 and returns. The refund below then
      // applies the captured stamp inside the same transaction; a
      // mid-refund failure rolls the clear back with it.
      const claimed = await tx.medicationIntakeEvent.updateMany({
        where: {
          id: eventId,
          userId,
          inventoryConsumption: {
            equals: stampValue as Prisma.InputJsonValue,
          },
        },
        data: { inventoryConsumption: Prisma.DbNull },
      });
      if (claimed.count === 0) return;

      const stamp = parseStamp(stampValue);
      if (stamp === null || stamp.length === 0) {
        // Empty / malformed stamp — the claim already cleared it so a
        // later re-take can consume afresh; nothing to refund.
        return;
      }

      const nowMs = Date.now();
      let refunded = 0;
      const itemIds: string[] = [];
      for (const entry of stamp) {
        const item = await tx.medicationInventoryItem.findFirst({
          where: { id: entry.itemId, userId },
        });
        if (!item) continue; // container deleted since — nothing to refund.

        const nextUnitsRemaining = Math.min(
          Number(item.unitsTotal),
          Number(item.unitsRemaining) + entry.units,
        );
        const refundedHere = nextUnitsRemaining - Number(item.unitsRemaining);
        const nextState = computeInventoryState(
          {
            state: item.state,
            unitsTotal: Number(item.unitsTotal),
            unitsRemaining: nextUnitsRemaining,
            firstUseAt: item.firstUseAt,
            printedExpiry: item.printedExpiry,
          },
          nowMs,
        );
        await tx.medicationInventoryItem.update({
          where: { id: item.id },
          data: {
            state: nextState,
            unitsRemaining: nextUnitsRemaining,
          },
        });
        refunded += refundedHere;
        itemIds.push(item.id);
      }

      annotate({
        action: { name: "medication.inventory.restored" },
        meta: {
          medication_id: event.medicationId,
          units: refunded,
          item_ids: itemIds,
        },
      });
    });
  } catch (err) {
    annotate({
      action: { name: "medication.inventory.restore_error" },
      meta: {
        event_id: eventId,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
