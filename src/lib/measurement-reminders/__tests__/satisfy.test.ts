/**
 * v1.18.1 — the shared `satisfyReminder` primitive: forward-only guard +
 * re-anchored reschedule. The cron, the manual satisfy route, and the
 * eventful worker all route through it, so these tests pin the invariants
 * every caller relies on.
 *
 * v1.37.20 (#223) — extended for the skip/snooze feature: the ledger append
 * (iOS #68), the skip-aware satisfy anchor, snooze clearing, and the
 * `skipReminder` primitive with its hard invariant (`lastSatisfiedAt` is
 * never touched by a skip). Watched red: the pre-#223 suite went red on the
 * widened `SatisfiableReminder` shape and the new `source` argument before
 * this file was updated — proof the type system walks every caller.
 */
import { describe, expect, it, vi } from "vitest";

import { satisfyReminder, skipReminder } from "../satisfy";

const TZ = "Europe/Berlin";

function makePrisma(updateManyCount = 1) {
  const updates: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];
  const events: Array<Record<string, unknown>> = [];
  const prisma = {
    measurementReminder: {
      // v1.18.1 — `satisfyReminder` writes via a conditional `updateMany` so
      // the forward-only guard re-asserts at the DB row (close the
      // cron-vs-worker TOCTOU). `updateManyCount` simulates a racing writer
      // having already advanced the row (count === 0).
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (updateManyCount > 0) updates.push({ where, data });
          return { count: updateManyCount };
        },
      ),
    },
    measurementReminderEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return { id: "evt", ...data };
      }),
    },
  };
  return { prisma, updates, events };
}

function reminder(
  overrides: Partial<Parameters<typeof satisfyReminder>[1]> = {},
) {
  return {
    id: "r1",
    userId: "u1",
    intervalDays: 7,
    rrule: null,
    anchorDate: null,
    notifyHour: 9,
    nextDueAt: null,
    lastSatisfiedAt: null,
    lastSkippedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    endsOn: null,
    ...overrides,
  };
}

describe("satisfyReminder", () => {
  it("stamps lastSatisfiedAt + recomputes nextDueAt when never satisfied", async () => {
    const { prisma, updates } = makePrisma();
    const at = new Date("2026-06-14T18:00:00Z");

    const result = await satisfyReminder(
      prisma as never,
      reminder(),
      TZ,
      at,
      "manual",
    );

    expect(result.satisfied).toBe(true);
    expect(result.nextDueAt).toBeInstanceOf(Date);
    expect(updates).toHaveLength(1);
    expect(updates[0].data.lastSatisfiedAt).toEqual(at);
    // Rolling +7d from the satisfy instant — strictly in the future.
    expect((updates[0].data.nextDueAt as Date).getTime()).toBeGreaterThan(
      at.getTime(),
    );
  });

  it("re-asserts the forward-only invariant in the conditional updateMany", async () => {
    const { prisma } = makePrisma();
    const at = new Date("2026-06-14T18:00:00Z");

    await satisfyReminder(prisma as never, reminder(), TZ, at, "manual");

    const call = prisma.measurementReminder.updateMany.mock
      .calls[0][0] as unknown as {
      where: { id: string; OR: unknown[] };
    };
    expect(call.where.id).toBe("r1");
    expect(call.where.OR).toEqual([
      { lastSatisfiedAt: null },
      { lastSatisfiedAt: { lt: at } },
    ]);
  });

  it("treats a racing-writer updateMany count of 0 as a forward-only no-op", async () => {
    const { prisma, events } = makePrisma(0);
    const at = new Date("2026-06-14T18:00:00Z");

    const result = await satisfyReminder(
      prisma as never,
      reminder(),
      TZ,
      at,
      "manual",
    );

    // The in-memory guard passed (lastSatisfiedAt null) but the DB write
    // matched no row — a concurrent satisfy already advanced it. No-op, and
    // crucially NO ledger row: an unapplied satisfy must leave no history.
    expect(result.satisfied).toBe(false);
    expect(result.nextDueAt).toBeNull();
    expect(events).toHaveLength(0);
  });

  it("advances when the event is strictly after the existing lastSatisfiedAt", async () => {
    const { prisma, updates } = makePrisma();
    const prev = new Date("2026-06-10T08:00:00Z");
    const at = new Date("2026-06-17T08:00:00Z");

    const result = await satisfyReminder(
      prisma as never,
      reminder({ lastSatisfiedAt: prev }),
      TZ,
      at,
      "manual",
    );

    expect(result.satisfied).toBe(true);
    expect(updates[0].data.lastSatisfiedAt).toEqual(at);
  });

  it("is a forward-only no-op when the event is older than lastSatisfiedAt", async () => {
    const { prisma, updates } = makePrisma();
    const prev = new Date("2026-06-17T08:00:00Z");
    const stale = new Date("2026-06-10T08:00:00Z");

    const result = await satisfyReminder(
      prisma as never,
      reminder({ lastSatisfiedAt: prev }),
      TZ,
      stale,
      "manual",
    );

    expect(result.satisfied).toBe(false);
    expect(result.nextDueAt).toBeNull();
    expect(prisma.measurementReminder.updateMany).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("is a no-op when the event equals lastSatisfiedAt (cron behind an applied hook)", async () => {
    const { prisma } = makePrisma();
    const same = new Date("2026-06-17T08:00:00Z");

    const result = await satisfyReminder(
      prisma as never,
      reminder({ lastSatisfiedAt: same }),
      TZ,
      same,
      "manual",
    );

    expect(result.satisfied).toBe(false);
    expect(prisma.measurementReminder.updateMany).not.toHaveBeenCalled();
  });

  it("clears the snooze cursor on satisfy", async () => {
    const { prisma, updates } = makePrisma();
    const at = new Date("2026-06-14T18:00:00Z");

    await satisfyReminder(prisma as never, reminder(), TZ, at, "manual");

    expect(updates[0].data.snoozedUntil).toBeNull();
  });

  it("appends a SATISFIED ledger row with write-time onTime (on time)", async () => {
    const { prisma, events } = makePrisma();
    const due = new Date("2026-06-15T07:00:00Z");
    const at = new Date("2026-06-14T18:00:00Z"); // before due → on time

    await satisfyReminder(
      prisma as never,
      reminder({ nextDueAt: due }),
      TZ,
      at,
      "auto_measurement",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: "u1",
      reminderId: "r1",
      kind: "SATISFIED",
      occurredAt: at,
      onTime: true,
      source: "auto_measurement",
    });
  });

  it("derives onTime=false when the event lands after the pre-event due instant", async () => {
    const { prisma, events } = makePrisma();
    const due = new Date("2026-06-10T07:00:00Z");
    const late = new Date("2026-06-14T18:00:00Z");

    await satisfyReminder(
      prisma as never,
      reminder({ nextDueAt: due }),
      TZ,
      late,
      "manual",
    );

    expect(events[0].onTime).toBe(false);
  });

  it("never lets a backdated satisfy re-anchor behind a fresh skip (max anchor)", async () => {
    const { prisma, updates } = makePrisma();
    const skippedAt = new Date("2026-06-20T10:00:00Z");
    const backdated = new Date("2026-06-14T18:00:00Z"); // real event, older sync

    const result = await satisfyReminder(
      prisma as never,
      reminder({ lastSkippedAt: skippedAt }),
      TZ,
      backdated,
      "auto_measurement",
    );

    // The event is honestly recorded as lastSatisfiedAt …
    expect(result.satisfied).toBe(true);
    expect(updates[0].data.lastSatisfiedAt).toEqual(backdated);
    // … but the reschedule anchors on the LATER skip: next due lands a full
    // interval after the skip decision, never behind it.
    expect((updates[0].data.nextDueAt as Date).getTime()).toBeGreaterThan(
      skippedAt.getTime(),
    );
  });
});

describe("course window", () => {
  // A twice-daily course whose last day is 2026-06-15 (Berlin). Satisfying
  // or skipping the final evening slot must end the course, not roll it on
  // to an open-ended 2026-06-16 morning.
  const course = {
    intervalDays: null,
    rrule: "FREQ=DAILY;BYHOUR=7,19",
    notifyHour: 7,
    createdAt: new Date("2026-06-13T10:00:00Z"),
    endsOn: new Date("2026-06-15T10:00:00Z"),
  };
  const lastEvening = new Date("2026-06-15T17:30:00Z");

  it("satisfy past the last slot leaves no next slot", async () => {
    const { prisma, updates } = makePrisma();
    const result = await satisfyReminder(
      prisma as never,
      reminder(course),
      TZ,
      lastEvening,
      "manual",
    );
    expect(result.satisfied).toBe(true);
    expect(result.nextDueAt).toBeNull();
    expect(updates[0].data.nextDueAt).toBeNull();
  });

  it("skip past the last slot leaves no next slot", async () => {
    const { prisma, updates } = makePrisma();
    const result = await skipReminder(
      prisma as never,
      reminder(course),
      TZ,
      lastEvening,
    );
    expect(result.skipped).toBe(true);
    expect(result.nextDueAt).toBeNull();
    expect(updates[0].data.nextDueAt).toBeNull();
  });

  it("still rolls within the window", async () => {
    const { prisma } = makePrisma();
    const result = await satisfyReminder(
      prisma as never,
      reminder(course),
      TZ,
      new Date("2026-06-15T05:30:00Z"),
      "manual",
    );
    expect(result.nextDueAt).toEqual(new Date("2026-06-15T17:00:00Z"));
  });
});

describe("skipReminder", () => {
  it("stamps lastSkippedAt, increments skipCount, clears snooze — and never touches lastSatisfiedAt", async () => {
    const { prisma, updates } = makePrisma();
    const at = new Date("2026-06-14T18:00:00Z");

    const result = await skipReminder(prisma as never, reminder(), TZ, at);

    expect(result.skipped).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].data.lastSkippedAt).toEqual(at);
    expect(updates[0].data.skipCount).toEqual({ increment: 1 });
    expect(updates[0].data.snoozedUntil).toBeNull();
    // THE hard invariant of the whole feature: a skip is not a completion.
    expect("lastSatisfiedAt" in updates[0].data).toBe(false);
  });

  it("restarts a rolling interval from the skip instant", async () => {
    const { prisma, updates } = makePrisma();
    const at = new Date("2026-06-14T18:00:00Z");

    const result = await skipReminder(prisma as never, reminder(), TZ, at);

    // +7d at the 09:00 notify hour, strictly after the skip.
    expect(result.nextDueAt).toBeInstanceOf(Date);
    expect((updates[0].data.nextDueAt as Date).getTime()).toBeGreaterThan(
      at.getTime() + 6 * 24 * 60 * 60 * 1000,
    );
  });

  it("walks an rrule cadence to the next occurrence strictly after the skip", async () => {
    const { prisma, updates } = makePrisma();
    const at = new Date("2026-06-14T18:00:00Z");

    const result = await skipReminder(
      prisma as never,
      reminder({ intervalDays: null, rrule: "FREQ=YEARLY" }),
      TZ,
      at,
    );

    expect(result.skipped).toBe(true);
    expect((updates[0].data.nextDueAt as Date).getTime()).toBeGreaterThan(
      at.getTime(),
    );
  });

  it("is a forward-only no-op at or behind the last satisfy OR the last skip", async () => {
    const { prisma, events } = makePrisma();
    const cursor = new Date("2026-06-17T08:00:00Z");
    const stale = new Date("2026-06-10T08:00:00Z");

    const bySatisfy = await skipReminder(
      prisma as never,
      reminder({ lastSatisfiedAt: cursor }),
      TZ,
      stale,
    );
    const bySkip = await skipReminder(
      prisma as never,
      reminder({ lastSkippedAt: cursor }),
      TZ,
      stale,
    );

    expect(bySatisfy.skipped).toBe(false);
    expect(bySkip.skipped).toBe(false);
    expect(prisma.measurementReminder.updateMany).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("re-asserts forward-only against BOTH cursors in the conditional updateMany", async () => {
    const { prisma } = makePrisma();
    const at = new Date("2026-06-14T18:00:00Z");

    await skipReminder(prisma as never, reminder(), TZ, at);

    const call = prisma.measurementReminder.updateMany.mock
      .calls[0][0] as unknown as {
      where: { id: string; AND: unknown[] };
    };
    expect(call.where.id).toBe("r1");
    expect(call.where.AND).toEqual([
      { OR: [{ lastSatisfiedAt: null }, { lastSatisfiedAt: { lt: at } }] },
      { OR: [{ lastSkippedAt: null }, { lastSkippedAt: { lt: at } }] },
    ]);
  });

  it("treats a racing-writer updateMany count of 0 as a no-op with no ledger row", async () => {
    const { prisma, events } = makePrisma(0);
    const at = new Date("2026-06-14T18:00:00Z");

    const result = await skipReminder(prisma as never, reminder(), TZ, at);

    expect(result.skipped).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("appends a SKIPPED ledger row with source 'skip' and write-time onTime", async () => {
    const { prisma, events } = makePrisma();
    const due = new Date("2026-06-10T07:00:00Z");
    const at = new Date("2026-06-14T18:00:00Z"); // skipping while overdue

    await skipReminder(prisma as never, reminder({ nextDueAt: due }), TZ, at);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: "u1",
      reminderId: "r1",
      kind: "SKIPPED",
      occurredAt: at,
      onTime: false,
      source: "skip",
    });
  });
});
