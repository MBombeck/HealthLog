/**
 * v1.8.2 reconcile — medically-critical slot-upsert invariants.
 *
 * Pins the four reconcile guards the dose-tap write path depends on:
 *   - C1  a P2002 race on the create branch re-finds + updates the racing
 *         row instead of 500-ing or duplicating;
 *   - C2  a pending projection echo (no takenAt, no explicit skip) onto an
 *         already-taken slot is a NO-OP — never clears the recorded dose;
 *   - M2  inventory `consumedTransition` fires only on a genuine
 *         pending→taken move, not on a re-post of an already-taken slot;
 *   - H1  with pre-existing same-slot duplicates the upsert deterministically
 *         updates the ACTIONED row, not a DB-arbitrary one.
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyCanonicalSlotWrite,
  type SlotIntakeRow,
} from "../slot-upsert";

const SLOT = new Date("2026-06-15T05:00:00.000Z");

function row(overrides: Partial<SlotIntakeRow> = {}): SlotIntakeRow {
  return {
    id: "row-1",
    takenAt: null,
    skipped: false,
    idempotencyKey: null,
    scheduledFor: SLOT,
    source: "REMINDER",
    createdAt: new Date("2026-06-15T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * Minimal fake Prisma `medicationIntakeEvent` client. `findManyResult`
 * supplies the rows the slot find returns; `create` and `update` are
 * spy-able and can be made to throw a P2002.
 */
function makeClient(opts: {
  findManyResult?: SlotIntakeRow[][]; // queue of results per findMany call
  createImpl?: () => Promise<SlotIntakeRow>;
  updateImpl?: (id: string) => Promise<SlotIntakeRow>;
}) {
  const findManyQueue = [...(opts.findManyResult ?? [[]])];
  const findMany = vi.fn(async () =>
    findManyQueue.length > 1 ? findManyQueue.shift()! : findManyQueue[0],
  );
  const create = vi.fn(
    opts.createImpl ??
      (async () => row({ id: "created-1", source: "WEB" })),
  );
  const update = vi.fn(async ({ where }: { where: { id: string } }) =>
    (opts.updateImpl ? opts.updateImpl(where.id) : row({ id: where.id })),
  );
  return {
    medication: {},
    medicationIntakeEvent: { findMany, create, update },
  };
}

// Cast a fake client to the `client` field shape the upsert expects.
type UpsertClient = Parameters<typeof applyCanonicalSlotWrite>[0]["client"];

const BASE = {
  userId: "u1",
  medicationId: "m1",
  canonicalSlot: SLOT,
  idempotencyKey: null,
  createSource: "WEB" as const,
};

function p2002(): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

describe("applyCanonicalSlotWrite — C1 race-safe create", () => {
  it("re-finds and updates the racing row on a P2002 create collision", async () => {
    // First find: empty (no slot row). Create throws P2002 (a concurrent
    // insert won the race). Re-find returns the racing row → update it.
    const racing = row({ id: "raced-1", source: "REMINDER" });
    const client = makeClient({
      findManyResult: [[], [racing]],
      createImpl: async () => {
        throw p2002();
      },
      updateImpl: async (id) =>
        row({ id, takenAt: new Date("2026-06-15T05:01:00Z") }),
    });

    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: new Date("2026-06-15T05:01:00Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
    });

    expect(res.outcome).toBe("updated");
    expect(res.row.id).toBe("raced-1");
    expect(res.consumedTransition).toBe(true);
    expect(client.medicationIntakeEvent.update).toHaveBeenCalledTimes(1);
  });

  it("inserts when the slot is genuinely empty", async () => {
    const client = makeClient({
      findManyResult: [[]],
      createImpl: async () =>
        row({ id: "fresh-1", takenAt: new Date("2026-06-15T05:00:00Z") }),
    });
    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: new Date("2026-06-15T05:00:00Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
    });
    expect(res.outcome).toBe("inserted");
    expect(res.consumedTransition).toBe(true);
  });
});

describe("applyCanonicalSlotWrite — C2 no-downgrade", () => {
  it("pending echo onto a TAKEN slot is a no-op (never clears takenAt)", async () => {
    const taken = row({
      id: "taken-1",
      takenAt: new Date("2026-06-15T05:02:00Z"),
      source: "WEB",
    });
    const client = makeClient({ findManyResult: [[taken]] });

    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: null, // pending echo — no takenAt
      skipped: false, // not an explicit skip
      isExplicitTaken: false,
      isExplicitSkip: false,
    });

    expect(res.noDowngradeNoOp).toBe(true);
    expect(res.row.takenAt).toEqual(taken.takenAt); // unchanged
    expect(res.consumedTransition).toBe(false);
    expect(client.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });

  it("pending echo onto a SKIPPED slot is a no-op", async () => {
    const skippedRow = row({ id: "skip-1", skipped: true, source: "WEB" });
    const client = makeClient({ findManyResult: [[skippedRow]] });
    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: null,
      skipped: false,
      isExplicitTaken: false,
      isExplicitSkip: false,
    });
    expect(res.noDowngradeNoOp).toBe(true);
    expect(client.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });

  it("an EXPLICIT taken write still applies onto a pending slot", async () => {
    const pending = row({ id: "pend-1", source: "REMINDER" });
    const client = makeClient({
      findManyResult: [[pending]],
      updateImpl: async (id) =>
        row({ id, takenAt: new Date("2026-06-15T05:03:00Z") }),
    });
    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: new Date("2026-06-15T05:03:00Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
    });
    expect(res.noDowngradeNoOp).toBe(false);
    expect(res.consumedTransition).toBe(true);
    expect(res.row.takenAt).not.toBeNull();
  });

  it("an EXPLICIT skip still applies (last-write-wins) onto a taken slot", async () => {
    const taken = row({
      id: "taken-2",
      takenAt: new Date("2026-06-15T05:00:00Z"),
      source: "WEB",
    });
    const client = makeClient({
      findManyResult: [[taken]],
      updateImpl: async (id) => row({ id, takenAt: null, skipped: true }),
    });
    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: null,
      skipped: true,
      isExplicitTaken: false,
      isExplicitSkip: true,
    });
    expect(res.noDowngradeNoOp).toBe(false);
    expect(client.medicationIntakeEvent.update).toHaveBeenCalledTimes(1);
  });
});

describe("applyCanonicalSlotWrite — M2 inventory transition", () => {
  it("does NOT consume on a re-post of an already-taken slot", async () => {
    const taken = row({
      id: "taken-3",
      takenAt: new Date("2026-06-15T05:00:00Z"),
      source: "WEB",
    });
    const client = makeClient({
      findManyResult: [[taken]],
      updateImpl: async (id) =>
        row({ id, takenAt: new Date("2026-06-15T05:00:30Z") }),
    });
    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: new Date("2026-06-15T05:00:30Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
    });
    // Existing row already had takenAt → no pending→taken transition.
    expect(res.consumedTransition).toBe(false);
  });

  it("consumes on a genuine pending→taken move", async () => {
    const pending = row({ id: "pend-2", source: "REMINDER" });
    const client = makeClient({
      findManyResult: [[pending]],
      updateImpl: async (id) =>
        row({ id, takenAt: new Date("2026-06-15T05:00:00Z") }),
    });
    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: new Date("2026-06-15T05:00:00Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
    });
    expect(res.consumedTransition).toBe(true);
  });
});

describe("applyCanonicalSlotWrite — H1 deterministic selection", () => {
  it("updates the ACTIONED row, not the pending one, when both exist", async () => {
    // Pending REMINDER row created first, taken WEB row created later. The
    // upsert must converge onto the actioned (taken) row.
    const pending = row({
      id: "pending-old",
      source: "REMINDER",
      createdAt: new Date("2026-06-15T00:00:00Z"),
    });
    const actioned = row({
      id: "taken-new",
      source: "WEB",
      takenAt: new Date("2026-06-15T05:02:00Z"),
      createdAt: new Date("2026-06-15T05:02:00Z"),
    });
    // findMany returns in (createdAt asc, id asc) order: pending first.
    const client = makeClient({
      findManyResult: [[pending, actioned]],
      updateImpl: async (id) =>
        row({ id, takenAt: new Date("2026-06-15T05:05:00Z") }),
    });
    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: new Date("2026-06-15T05:05:00Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
    });
    expect(res.row.id).toBe("taken-new");
    const updateArg = vi.mocked(client.medicationIntakeEvent.update).mock
      .calls[0][0] as { where: { id: string } };
    expect(updateArg.where.id).toBe("taken-new");
  });

  it("prefers the first row in (createdAt asc, id asc) order when none actioned", async () => {
    // The route issues findMany with orderBy [{createdAt asc},{id asc}];
    // the fake returns the array as supplied, so pass it already ordered.
    // `pickSlotRow` must select the first (deterministic winner).
    const first = row({
      id: "a-row",
      createdAt: new Date("2026-06-15T01:00:00Z"),
    });
    const second = row({
      id: "b-row",
      createdAt: new Date("2026-06-15T01:00:00Z"),
    });
    const client = makeClient({
      findManyResult: [[first, second]],
      updateImpl: async (id) => row({ id }),
    });
    const res = await applyCanonicalSlotWrite({
      ...BASE,
      client: client as unknown as UpsertClient,
      takenAt: null,
      skipped: true,
      isExplicitTaken: false,
      isExplicitSkip: true,
    });
    expect(res.row.id).toBe("a-row");
  });
});
