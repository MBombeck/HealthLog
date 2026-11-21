/**
 * Undoing a dose reopens its slot in every reader.
 *
 * The undo tombstones the slot row. The today projector used to count
 * tombstones as occupying the slot, so nothing was projected back: the dose
 * vanished from `scope=today` (the list iOS and the log sheet offer doses
 * from) and from the dashboard count, which then read "all done" while the
 * web card and the ledger showed it due again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  eventDelete,
  perMedPost,
  readDashboardCompliance,
  readToday,
  setupDoseFixture,
} from "./medication-dose-state-fixtures";

vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("undo reopens the slot", () => {
  it("take then undo: the today list and the dashboard count show the dose open again", async () => {
    const { medId, slot } = await setupDoseFixture({ offsetHours: 0 });
    const onSlot = (r: { scheduledAt: string }) =>
      new Date(r.scheduledAt).getTime() === slot.getTime();

    const before = await readToday();
    expect(before.filter(onSlot).map((r) => r.status)).toEqual(["pending"]);

    const r1 = await perMedPost(medId, {
      skipped: false,
      scheduledFor: slot.toISOString(),
    });
    const created = ((await r1.json()) as { data: { id: string } }).data;
    expect((await readToday()).filter(onSlot).map((r) => r.status)).toEqual([
      "taken",
    ]);
    expect(await readDashboardCompliance()).toEqual({
      scheduledToday: 1,
      takenToday: 1,
    });

    const r2 = await eventDelete(medId, created.id);
    expect(r2.status).toBeLessThan(300);

    expect((await readToday()).filter(onSlot).map((r) => r.status)).toEqual([
      "pending",
    ]);
    expect(await readDashboardCompliance()).toEqual({
      scheduledToday: 1,
      takenToday: 0,
    });
  });
});
