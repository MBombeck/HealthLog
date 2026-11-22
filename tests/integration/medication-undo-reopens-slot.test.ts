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
import { NextRequest } from "next/server";
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

describe("the today list names the instant it reflects", () => {
  async function today(etag?: string) {
    const { GET } = await import("@/app/api/medications/intake/route");
    return (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/medications/intake?scope=today", {
        headers: etag ? { "If-None-Match": etag } : {},
      }),
    );
  }

  it("sends HealthLog-As-Of on 200 and on 304, and it moves no ETag", async () => {
    await setupDoseFixture({ offsetHours: 0 });
    const t0 = Date.now();
    const first = await today();
    expect(first.status).toBe(200);
    const asOf = first.headers.get("HealthLog-As-Of");
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(asOf!)).toBeGreaterThanOrEqual(t0);
    expect(Date.parse(asOf!)).toBeLessThanOrEqual(Date.now());
    const etag = first.headers.get("ETag")!;

    await new Promise((r) => setTimeout(r, 5));
    const again = await today(etag);
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    const confirmed = again.headers.get("HealthLog-As-Of");
    expect(Date.parse(confirmed!)).toBeGreaterThan(Date.parse(asOf!));
  });
});
