/**
 * v1.16.10 — consumption hook contract tests.
 *
 * Pins the exactly-once stamp semantics, the multi-unit FEFO selection
 * with spillover + auto-open, the floor-at-zero partial stamp, and the
 * symmetric restore (clamped refund, state re-derivation, stamp clear).
 * The fake client mirrors the Prisma surface the hook touches and
 * honours the orderBy specs the hook passes, so the selection order the
 * tests assert is the order production gets from Postgres.
 *
 * Timezone-stable: every instant is an explicit UTC ISO string and the
 * wall clock is pinned with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { Prisma } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import {
  consumeForIntake,
  consumeImportedIntakesBatch,
  restoreForIntake,
} from "../consumption";

const NOW = new Date("2026-06-10T12:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface FakeEvent {
  id: string;
  userId: string;
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  deletedAt: Date | null;
  inventoryConsumption: unknown;
}

/** #219 — a schedule row the per-slot units resolver reads. */
interface FakeSchedule {
  timesOfDay: string[];
  windowStart: string;
  unitsPerDose: number | null;
}

interface FakeItem {
  id: string;
  userId: string;
  medicationId: string;
  state: "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";
  containerType: "PEN" | "AMPOULE" | "BLISTER" | "INHALER" | "BOTTLE" | "OTHER";
  unitsTotal: number;
  unitsRemaining: number;
  firstUseAt: Date | null;
  expiresAt: Date | null;
  printedExpiry: Date | null;
  purchasedAt: Date | null;
  createdAt: Date;
}

interface FakeState {
  events: FakeEvent[];
  items: FakeItem[];
  unitsPerDose: number;
  // #219 — per-slot resolver inputs. Default to no schedules + UTC so every
  // pre-existing scenario inherits the medication-level `unitsPerDose`.
  schedules?: FakeSchedule[];
  timezone?: string;
}

type OrderSpec = Record<
  string,
  "asc" | "desc" | { sort: "asc" | "desc"; nulls?: "first" | "last" }
>;

/** Honour the hook's orderBy the way Postgres would. */
function sortRows(rows: FakeItem[], orderBy: OrderSpec[]): FakeItem[] {
  return [...rows].sort((a, b) => {
    for (const spec of orderBy) {
      const [field, raw] = Object.entries(spec)[0];
      const dir = typeof raw === "string" ? raw : raw.sort;
      const nulls = typeof raw === "object" ? raw.nulls : undefined;
      const av = a[field as keyof FakeItem] as Date | null;
      const bv = b[field as keyof FakeItem] as Date | null;
      if (av === null && bv === null) continue;
      if (av === null) return nulls === "last" ? 1 : -1;
      if (bv === null) return nulls === "last" ? -1 : 1;
      const diff = av.getTime() - bv.getTime();
      if (diff !== 0) return dir === "asc" ? diff : -diff;
    }
    return 0;
  });
}

function makeClient(state: FakeState) {
  return {
    medication: {
      findFirst: vi.fn(async () => ({
        unitsPerDose: state.unitsPerDose,
        // #219 — the per-slot resolver reads the user's zone + the schedules.
        user: { timezone: state.timezone ?? "UTC" },
        schedules: state.schedules ?? [],
      })),
    },
    medicationIntakeEvent: {
      findFirst: vi.fn(
        async (args: { where: { id: string; userId: string } }) =>
          state.events.find(
            (e) => e.id === args.where.id && e.userId === args.where.userId,
          ) ?? null,
      ),
      // #219 — the import-batch path loads each event's scheduledFor anchor.
      findMany: vi.fn(
        async (args: { where: { id: { in: string[] }; userId: string } }) =>
          state.events.filter(
            (e) =>
              args.where.id.in.includes(e.id) && e.userId === args.where.userId,
          ),
      ),
      // The hooks' atomic claim — evaluate the conditional WHERE the way
      // Postgres would (the gate fields plus the stamp predicate:
      // `Prisma.AnyNull` matches a NULL stamp, a JSON value matches by
      // structural equality) and apply the data to every matching row.
      updateMany: vi.fn(
        async (args: {
          where: {
            // The single-event hook narrows by one id; the import batch
            // claims a whole chunk with `id: { in: [...] }`.
            id?: string | { in: string[] };
            userId?: string;
            medicationId?: string;
            deletedAt?: null;
            takenAt?: { not: null };
            skipped?: boolean;
            inventoryConsumption?: { equals: unknown };
          };
          data: Record<string, unknown>;
        }) => {
          const w = args.where;
          const matches = state.events.filter((e) => {
            if (typeof w.id === "string" && e.id !== w.id) return false;
            if (
              w.id !== undefined &&
              typeof w.id === "object" &&
              !w.id.in.includes(e.id)
            )
              return false;
            if (w.userId !== undefined && e.userId !== w.userId) return false;
            if (
              w.medicationId !== undefined &&
              e.medicationId !== w.medicationId
            )
              return false;
            if ("deletedAt" in w && e.deletedAt !== null) return false;
            if (w.takenAt !== undefined && e.takenAt === null) return false;
            if (w.skipped !== undefined && e.skipped !== w.skipped)
              return false;
            if (w.inventoryConsumption !== undefined) {
              const eq = w.inventoryConsumption.equals;
              if (eq === Prisma.AnyNull) {
                if (e.inventoryConsumption !== null) return false;
              } else if (
                JSON.stringify(e.inventoryConsumption) !== JSON.stringify(eq)
              ) {
                return false;
              }
            }
            return true;
          });
          for (const event of matches) {
            if ("inventoryConsumption" in args.data) {
              event.inventoryConsumption =
                args.data.inventoryConsumption === Prisma.DbNull
                  ? null
                  : args.data.inventoryConsumption;
            }
          }
          return { count: matches.length };
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const event = state.events.find((e) => e.id === args.where.id)!;
          if ("inventoryConsumption" in args.data) {
            event.inventoryConsumption =
              args.data.inventoryConsumption === Prisma.DbNull
                ? null
                : args.data.inventoryConsumption;
          }
          return event;
        },
      ),
    },
    medicationInventoryItem: {
      findMany: vi.fn(
        async (args: {
          where: {
            userId: string;
            medicationId: string;
            state: FakeItem["state"];
            unitsRemaining: { gt: number };
          };
          orderBy: OrderSpec[];
        }) =>
          sortRows(
            state.items.filter(
              (i) =>
                i.userId === args.where.userId &&
                i.medicationId === args.where.medicationId &&
                i.state === args.where.state &&
                i.unitsRemaining > args.where.unitsRemaining.gt,
            ),
            args.orderBy,
          ),
      ),
      findFirst: vi.fn(
        async (args: { where: { id: string; userId: string } }) =>
          state.items.find(
            (i) => i.id === args.where.id && i.userId === args.where.userId,
          ) ?? null,
      ),
      update: vi.fn(
        async (args: { where: { id: string }; data: Partial<FakeItem> }) => {
          const item = state.items.find((i) => i.id === args.where.id)!;
          Object.assign(item, args.data);
          return item;
        },
      ),
    },
  };
}

function takenEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    id: "evt-1",
    userId: "user-1",
    medicationId: "med-1",
    scheduledFor: NOW,
    takenAt: NOW,
    skipped: false,
    deletedAt: null,
    inventoryConsumption: null,
    ...overrides,
  };
}

function item(overrides: Partial<FakeItem> = {}): FakeItem {
  return {
    id: "item-1",
    userId: "user-1",
    medicationId: "med-1",
    state: "ACTIVE",
    // These fixtures model the pen case — the kind that carries the
    // post-opening clock. The clock-less kinds get their own scenarios.
    containerType: "PEN",
    unitsTotal: 10,
    unitsRemaining: 10,
    firstUseAt: null,
    expiresAt: null,
    printedExpiry: null,
    purchasedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

function consumeArgs(client: ReturnType<typeof makeClient>) {
  return {
    client: client as never,
    userId: "user-1",
    medicationId: "med-1",
    eventId: "evt-1",
    intakeAt: NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("consumeForIntake", () => {
  it("consumes unitsPerDose units from the open container and stamps the event", async () => {
    const state: FakeState = {
      unitsPerDose: 2,
      events: [takenEvent()],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 5,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 27 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    expect(state.items[0].unitsRemaining).toBe(3);
    expect(state.items[0].state).toBe("IN_USE");
    expect(state.events[0].inventoryConsumption).toEqual([
      { itemId: "open", units: 2 },
    ]);
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "medication.inventory.consumed" },
        meta: expect.objectContaining({
          medication_id: "med-1",
          units: 2,
          item_ids: ["open"],
          auto_opened: 0,
        }),
      }),
    );
  });

  it("consumes a FRACTION of a unit for a split-pill dose, stamps the fraction, and refunds it exactly on undo (v1.16.12 #316)", async () => {
    const state: FakeState = {
      unitsPerDose: 0.5,
      events: [takenEvent()],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsTotal: 30,
          unitsRemaining: 30,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 27 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    // 30 tablets dosed at ½ each leaves 29.5 — the fraction is NOT floored.
    expect(state.items[0].unitsRemaining).toBe(29.5);
    expect(state.items[0].state).toBe("IN_USE");
    expect(state.events[0].inventoryConsumption).toEqual([
      { itemId: "open", units: 0.5 },
    ]);

    // Undo refunds exactly the 0.5 it consumed and clears the stamp.
    await restoreForIntake({
      client: client as never,
      userId: "user-1",
      eventId: "evt-1",
    });
    expect(state.items[0].unitsRemaining).toBe(30);
    expect(state.events[0].inventoryConsumption).toBeNull();
  });

  it("consumes 1½ units per dose across two containers and refunds both exactly (#1034)", async () => {
    const state: FakeState = {
      unitsPerDose: 1.5,
      events: [takenEvent()],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsTotal: 30,
          unitsRemaining: 1,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 27 * MS_PER_DAY),
        }),
        item({ id: "next", unitsTotal: 30, unitsRemaining: 30 }),
      ],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    // The open container gives its last unit, the next one the half.
    expect(state.items.find((i) => i.id === "open")?.unitsRemaining).toBe(0);
    expect(state.items.find((i) => i.id === "next")?.unitsRemaining).toBe(29.5);
    expect(state.events[0].inventoryConsumption).toEqual([
      { itemId: "open", units: 1 },
      { itemId: "next", units: 0.5 },
    ]);

    await restoreForIntake({
      client: client as never,
      userId: "user-1",
      eventId: "evt-1",
    });
    expect(state.items.find((i) => i.id === "open")?.unitsRemaining).toBe(1);
    expect(state.items.find((i) => i.id === "next")?.unitsRemaining).toBe(30);
  });

  it("prefers the IN_USE container over fresher ACTIVE stock", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent()],
      items: [
        item({ id: "sealed", state: "ACTIVE", unitsRemaining: 10 }),
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 2,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 27 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    expect(state.items.find((i) => i.id === "open")!.unitsRemaining).toBe(1);
    expect(state.items.find((i) => i.id === "sealed")!.unitsRemaining).toBe(10);
  });

  it("opens unopened stock first-expiry-first-out, null printed expiry last", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent()],
      items: [
        item({
          id: "no-expiry",
          printedExpiry: null,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        }),
        item({
          id: "later-expiry",
          // Now-anchored so the fixture can never age into an expired
          // container and flip the state assertions.
          printedExpiry: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000),
        }),
        item({
          id: "sooner-expiry",
          printedExpiry: new Date("2026-09-01T00:00:00.000Z"),
        }),
      ],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    expect(
      state.items.find((i) => i.id === "sooner-expiry")!.unitsRemaining,
    ).toBe(9);
    expect(state.items.find((i) => i.id === "no-expiry")!.unitsRemaining).toBe(
      10,
    );
    expect(
      state.items.find((i) => i.id === "later-expiry")!.unitsRemaining,
    ).toBe(10);
  });

  it("auto-opens an ACTIVE container: firstUseAt = intakeAt, state IN_USE, expiresAt derived", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent()],
      items: [item({ id: "sealed" })],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    const opened = state.items[0];
    expect(opened.firstUseAt).toEqual(NOW);
    expect(opened.state).toBe("IN_USE");
    expect(opened.expiresAt?.getTime()).toBe(NOW.getTime() + 30 * MS_PER_DAY);
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ auto_opened: 1 }),
      }),
    );
  });

  it("lands a backdated auto-open straight in EXPIRED when its window has already lapsed", async () => {
    const backdated = new Date(NOW.getTime() - 40 * MS_PER_DAY);
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent({ takenAt: backdated })],
      items: [item({ id: "sealed" })],
    };
    const client = makeClient(state);
    await consumeForIntake({
      ...consumeArgs(client),
      intakeAt: backdated,
    });

    const opened = state.items[0];
    expect(opened.firstUseAt).toEqual(backdated);
    // firstUseAt + 30 days lies in the past — the state machine says
    // EXPIRED at the wall clock, and that is the honest answer.
    expect(opened.state).toBe("EXPIRED");
    expect(opened.unitsRemaining).toBe(9);
    expect(state.events[0].inventoryConsumption).toEqual([
      { itemId: "sealed", units: 1 },
    ]);
  });

  it("leaves a backdated auto-open of a blister IN_USE with no expiresAt", async () => {
    // Same backdated take against a tablet pack: every remaining
    // tablet is still in its own sealed cavity, so opening the pack
    // starts no clock and the cron gets no deadline to scan for.
    const backdated = new Date(NOW.getTime() - 40 * MS_PER_DAY);
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent({ takenAt: backdated })],
      items: [item({ id: "sealed", containerType: "BLISTER" })],
    };
    const client = makeClient(state);
    await consumeForIntake({
      ...consumeArgs(client),
      intakeAt: backdated,
    });

    const opened = state.items[0];
    expect(opened.firstUseAt).toEqual(backdated);
    expect(opened.state).toBe("IN_USE");
    expect(opened.expiresAt).toBeNull();
    expect(opened.unitsRemaining).toBe(9);
  });

  it("spills across containers when the open one runs dry", async () => {
    const state: FakeState = {
      unitsPerDose: 3,
      events: [takenEvent()],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 1,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 27 * MS_PER_DAY),
        }),
        item({ id: "sealed", unitsRemaining: 4, unitsTotal: 4 }),
      ],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    const open = state.items.find((i) => i.id === "open")!;
    const sealed = state.items.find((i) => i.id === "sealed")!;
    expect(open.unitsRemaining).toBe(0);
    expect(open.state).toBe("USED_UP");
    expect(sealed.unitsRemaining).toBe(2);
    expect(sealed.state).toBe("IN_USE");
    expect(state.events[0].inventoryConsumption).toEqual([
      { itemId: "open", units: 1 },
      { itemId: "sealed", units: 2 },
    ]);
  });

  it("floors at zero with a partial stamp when stock runs out — never negative, never an error", async () => {
    const state: FakeState = {
      unitsPerDose: 4,
      events: [takenEvent()],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 1,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 27 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    expect(state.items[0].unitsRemaining).toBe(0);
    expect(state.items[0].state).toBe("USED_UP");
    expect(state.events[0].inventoryConsumption).toEqual([
      { itemId: "open", units: 1 },
    ]);
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ units: 1 }),
      }),
    );
  });

  it("consumes for an as-needed (schedule-less) medication exactly like a scheduled one (v1.16.11 #316)", async () => {
    // The consumption seam is MEDICATION-level: its only inputs are the
    // event row, the medication's `unitsPerDose`, and the container
    // pool — no schedule is read anywhere on the path (the fake client
    // doesn't even model one). An ad-hoc PRN intake therefore decrements
    // stock byte-identically to a slot-attributed dose.
    const state: FakeState = {
      unitsPerDose: 2,
      events: [takenEvent()],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 6,
          firstUseAt: new Date(NOW.getTime() - 2 * MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 28 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    expect(state.items[0].unitsRemaining).toBe(4);
    expect(state.events[0].inventoryConsumption).toEqual([
      { itemId: "open", units: 2 },
    ]);
    // The hook never asked for a schedule — the medication read covers
    // `unitsPerDose` only.
    expect(client.medication.findFirst).toHaveBeenCalledTimes(1);
  });

  it("stamps an empty consumption when no tracked stock exists (exactly-once gate)", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent()],
      items: [],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    expect(state.events[0].inventoryConsumption).toEqual([]);
    expect(client.medicationInventoryItem.update).not.toHaveBeenCalled();
  });

  it("is a no-op on an already-stamped row (replay never double-decrements)", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [
        takenEvent({ inventoryConsumption: [{ itemId: "open", units: 1 }] }),
      ],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 3,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));
    await consumeForIntake(consumeArgs(client));

    expect(state.items[0].unitsRemaining).toBe(3);
    expect(client.medicationInventoryItem.update).not.toHaveBeenCalled();
    expect(client.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", { takenAt: null }],
    ["skipped", { skipped: true }],
    ["tombstoned", { deletedAt: NOW }],
  ])("never consumes for a %s row", async (_label, overrides) => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent(overrides as Partial<FakeEvent>)],
      items: [item({ id: "sealed" })],
    };
    const client = makeClient(state);
    await consumeForIntake(consumeArgs(client));

    expect(state.items[0].unitsRemaining).toBe(10);
    expect(state.events[0].inventoryConsumption).toBeNull();
  });

  it("swallows unexpected failures and annotates consume_error", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent()],
      items: [item({ id: "sealed" })],
    };
    const client = makeClient(state);
    client.medicationInventoryItem.findMany.mockRejectedValue(
      new Error("connection lost"),
    );

    await expect(
      consumeForIntake(consumeArgs(client)),
    ).resolves.toBeUndefined();
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "medication.inventory.consume_error" },
      }),
    );
  });

  it("uses the caller's interactive transaction when the client carries one", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent()],
      items: [item({ id: "sealed" })],
    };
    const inner = makeClient(state);
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) =>
      fn(inner),
    );
    await consumeForIntake({
      client: { ...inner, $transaction } as never,
      userId: "user-1",
      medicationId: "med-1",
      eventId: "evt-1",
      intakeAt: NOW,
    });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(state.items[0].unitsRemaining).toBe(9);
  });
});

describe("consumeImportedIntakesBatch", () => {
  // The import worker's batch path derives state through the same state
  // machine as the request-time hook, so it has to read the container
  // kind too — a back-dated import chunk against a tablet pack must not
  // write the pack off.
  it("leaves a back-dated import auto-open of a blister IN_USE", async () => {
    const backdated = new Date(NOW.getTime() - 40 * MS_PER_DAY);
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent({ takenAt: backdated })],
      items: [item({ id: "sealed", containerType: "BLISTER" })],
    };
    const client = makeClient(state);
    await consumeImportedIntakesBatch({
      client: client as never,
      userId: "user-1",
      medicationId: "med-1",
      events: [{ eventId: "evt-1", intakeAt: backdated }],
    });

    const opened = state.items[0];
    expect(opened.firstUseAt).toEqual(backdated);
    expect(opened.state).toBe("IN_USE");
    expect(opened.expiresAt).toBeNull();
    expect(opened.unitsRemaining).toBe(9);
  });

  it("still expires a back-dated import auto-open of a pen", async () => {
    const backdated = new Date(NOW.getTime() - 40 * MS_PER_DAY);
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent({ takenAt: backdated })],
      items: [item({ id: "sealed", containerType: "PEN" })],
    };
    const client = makeClient(state);
    await consumeImportedIntakesBatch({
      client: client as never,
      userId: "user-1",
      medicationId: "med-1",
      events: [{ eventId: "evt-1", intakeAt: backdated }],
    });

    const opened = state.items[0];
    expect(opened.state).toBe("EXPIRED");
    expect(opened.expiresAt).toEqual(
      new Date(backdated.getTime() + 30 * MS_PER_DAY),
    );
  });
});

describe("restoreForIntake", () => {
  function restoreArgs(client: ReturnType<typeof makeClient>) {
    return { client: client as never, userId: "user-1", eventId: "evt-1" };
  }

  it("refunds per stamp entry, re-derives the state and clears the stamp", async () => {
    const state: FakeState = {
      unitsPerDose: 2,
      events: [
        takenEvent({
          inventoryConsumption: [{ itemId: "open", units: 2 }],
        }),
      ],
      items: [
        item({
          id: "open",
          state: "USED_UP",
          unitsTotal: 4,
          unitsRemaining: 0,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await restoreForIntake(restoreArgs(client));

    expect(state.items[0].unitsRemaining).toBe(2);
    // USED_UP flips back to IN_USE — the window is still open.
    expect(state.items[0].state).toBe("IN_USE");
    expect(state.events[0].inventoryConsumption).toBeNull();
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "medication.inventory.restored" },
        meta: expect.objectContaining({
          medication_id: "med-1",
          units: 2,
          item_ids: ["open"],
        }),
      }),
    );
  });

  it("clamps the refund to the item's capacity", async () => {
    const state: FakeState = {
      unitsPerDose: 2,
      events: [
        takenEvent({
          inventoryConsumption: [{ itemId: "open", units: 2 }],
        }),
      ],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsTotal: 4,
          // A stock correction raised the count since the take.
          unitsRemaining: 3,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await restoreForIntake(restoreArgs(client));

    expect(state.items[0].unitsRemaining).toBe(4);
  });

  it("re-derives EXPIRED when the refunded container's window has lapsed meanwhile", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [
        takenEvent({
          inventoryConsumption: [{ itemId: "open", units: 1 }],
        }),
      ],
      items: [
        item({
          id: "open",
          state: "USED_UP",
          unitsTotal: 4,
          unitsRemaining: 0,
          firstUseAt: new Date(NOW.getTime() - 35 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await restoreForIntake(restoreArgs(client));

    expect(state.items[0].unitsRemaining).toBe(1);
    expect(state.items[0].state).toBe("EXPIRED");
  });

  it("re-derives IN_USE for a refunded blister whose opening is long past", async () => {
    // Same refund against a tablet pack: the units come back and the
    // pack is usable again. There is no post-opening window to have
    // lapsed, so EXPIRED would be wrong.
    const state: FakeState = {
      unitsPerDose: 1,
      events: [
        takenEvent({
          inventoryConsumption: [{ itemId: "open", units: 1 }],
        }),
      ],
      items: [
        item({
          id: "open",
          containerType: "BLISTER",
          state: "USED_UP",
          unitsTotal: 4,
          unitsRemaining: 0,
          firstUseAt: new Date(NOW.getTime() - 35 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await restoreForIntake(restoreArgs(client));

    expect(state.items[0].unitsRemaining).toBe(1);
    expect(state.items[0].state).toBe("IN_USE");
  });

  it("is a no-op when the row carries no stamp", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent()],
      items: [item({ id: "open", unitsRemaining: 3 })],
    };
    const client = makeClient(state);
    await restoreForIntake(restoreArgs(client));

    expect(state.items[0].unitsRemaining).toBe(3);
    expect(client.medicationInventoryItem.update).not.toHaveBeenCalled();
    expect(client.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });

  it("skips a stamped container that was deleted since, still clearing the stamp", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [
        takenEvent({
          inventoryConsumption: [
            { itemId: "gone", units: 1 },
            { itemId: "open", units: 1 },
          ],
        }),
      ],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 1,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);
    await restoreForIntake(restoreArgs(client));

    expect(state.items[0].unitsRemaining).toBe(2);
    expect(state.events[0].inventoryConsumption).toBeNull();
  });

  it("allows a re-take to consume afresh after a restore (skip → take cycle)", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent()],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 4,
          unitsTotal: 4,
          firstUseAt: new Date(NOW.getTime() - 3 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);

    await consumeForIntake(consumeArgs(client));
    expect(state.items[0].unitsRemaining).toBe(3);

    await restoreForIntake(restoreArgs(client));
    expect(state.items[0].unitsRemaining).toBe(4);
    expect(state.events[0].inventoryConsumption).toBeNull();

    await consumeForIntake(consumeArgs(client));
    expect(state.items[0].unitsRemaining).toBe(3);
    expect(state.events[0].inventoryConsumption).toEqual([
      { itemId: "open", units: 1 },
    ]);
  });
});

describe("claim atomicity (concurrent duplicate calls)", () => {
  it("two interleaved consumes decrement exactly once — the claim, not a read, is the gate", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [takenEvent()],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 4,
          firstUseAt: new Date(NOW.getTime() - MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 29 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);

    // Both calls pass any plain read of the (still NULL) stamp; only the
    // conditional claim UPDATE — atomic per statement, like Postgres
    // under the row lock — lets exactly one through.
    await Promise.all([
      consumeForIntake(consumeArgs(client)),
      consumeForIntake(consumeArgs(client)),
    ]);

    expect(state.items[0].unitsRemaining).toBe(3);
    expect(state.events[0].inventoryConsumption).toEqual([
      { itemId: "open", units: 1 },
    ]);
  });

  it("two interleaved restores refund exactly once", async () => {
    const state: FakeState = {
      unitsPerDose: 1,
      events: [
        takenEvent({
          inventoryConsumption: [{ itemId: "open", units: 1 }],
        }),
      ],
      items: [
        item({
          id: "open",
          state: "IN_USE",
          unitsRemaining: 3,
          firstUseAt: new Date(NOW.getTime() - MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 29 * MS_PER_DAY),
        }),
      ],
    };
    const client = makeClient(state);

    const args = {
      client: client as never,
      userId: "user-1",
      eventId: "evt-1",
    };
    await Promise.all([restoreForIntake(args), restoreForIntake(args)]);

    expect(state.items[0].unitsRemaining).toBe(4);
    expect(state.events[0].inventoryConsumption).toBeNull();
  });
});
