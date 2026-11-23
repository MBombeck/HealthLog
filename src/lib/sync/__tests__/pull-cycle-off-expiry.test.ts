/**
 * A `start=now` cursor on an account with cycle tracking off. The cycle
 * watermarks are stamped when the cursor is issued and never advanced while
 * the module is off, so the retention check must not count them: a client
 * that pulls every day is healthy and must never be told its cursor expired.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => false),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => undefined,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ syncResetAt: null })) },
    measurement: { findMany: vi.fn(async () => []) },
    apiToken: { findMany: vi.fn(async () => []) },
    moodEntry: { findMany: vi.fn(async () => []) },
    medicationIntakeEvent: { findMany: vi.fn(async () => []) },
    cycleDayLog: { findMany: vi.fn(async () => []) },
    menstrualCycle: { findMany: vi.fn(async () => []) },
  },
}));

import { isModuleEnabled } from "@/lib/modules/gate";
import { pullSyncChanges, syncChangesFromNow } from "@/lib/sync/changes/pull";
import { decodeCursor } from "@/lib/sync/cursor";

const DAY = 86_400_000;
const T0 = new Date("2026-01-01T00:00:00.000Z");

async function pullDaily(days: number, startCursor: string) {
  let cursor = startCursor;
  for (let day = 1; day <= days; day++) {
    const body = await pullSyncChanges({
      userId: "u1",
      token: cursor,
      limit: 200,
      serverNow: new Date(T0.getTime() + day * DAY),
    });
    if (body.cursorExpired) return { expiredOnDay: day, cursor };
    cursor = body.cursor!;
  }
  return { expiredOnDay: null, cursor };
}

beforeEach(() => {
  vi.mocked(isModuleEnabled).mockResolvedValue(false);
});

describe("sync feed retention with the cycle module off", () => {
  it("never expires a cursor that is pulled every day", async () => {
    const { expiredOnDay, cursor } = await pullDaily(
      120,
      syncChangesFromNow(T0).cursor!,
    );

    expect(expiredOnDay).toBeNull();
    const decoded = decodeCursor(cursor)!;
    expect(decoded.measurements!.updatedAtMs).toBeGreaterThan(
      T0.getTime() + 110 * DAY,
    );
    // The cycle watermark is still where the cursor was issued, ready for the
    // module to come back on.
    expect(decoded.cycleDays!.updatedAtMs).toBe(T0.getTime() - 120_000);
  });

  it("expires the frozen cycle watermark once the module is back on", async () => {
    const { cursor } = await pullDaily(80, syncChangesFromNow(T0).cursor!);
    vi.mocked(isModuleEnabled).mockResolvedValue(true);

    const body = await pullSyncChanges({
      userId: "u1",
      token: cursor,
      limit: 200,
      serverNow: new Date(T0.getTime() + 81 * DAY),
    });

    expect(body.cursorExpired).toBe(true);
  });

  it("with the module on the same daily pull never expires", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(true);
    const { expiredOnDay } = await pullDaily(
      80,
      syncChangesFromNow(T0).cursor!,
    );
    expect(expiredOnDay).toBeNull();
  });
});
