/**
 * An update to an existing intake row keeps the slot the row names.
 *
 * The status route (`POST /api/medications/intake`) used to re-bind a take by
 * the clock time of the request alone. With "now" outside every band, saving
 * the injection site right after a late take, or marking an overdue reminder
 * row as taken, tombstoned the slot row and filed the dose ad-hoc: the slot
 * read as missed, an extra dose appeared, and the client got back an id it
 * never sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  eventPut,
  perMedPost,
  readLedger,
  setupDoseFixture,
  statusPost,
} from "./medication-dose-state-fixtures";

vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function liveRows(userId: string, medicationId: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: { userId, medicationId, deletedAt: null },
  });
}

describe("an update to an existing intake row keeps its slot", () => {
  it("confirming the injection site after a late take leaves the dose on its slot", async () => {
    const { user, medId, slot } = await setupDoseFixture({
      offsetHours: 12,
      injection: true,
    });
    const r1 = await perMedPost(medId, {
      skipped: false,
      scheduledFor: slot.toISOString(),
    });
    expect(r1.status).toBe(201);
    const created = ((await r1.json()) as { data: { id: string } }).data;
    const takenAt = (await liveRows(user.id, medId))[0].takenAt;

    const r2 = await statusPost({
      intakeId: created.id,
      status: "taken",
      injectionSite: "ABDOMEN_LEFT",
    });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { data: { id: string } }).data.id).toBe(
      created.id,
    );

    const live = await liveRows(user.id, medId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(created.id);
    expect(live[0].scheduledFor.getTime()).toBe(slot.getTime());
    expect(live[0].injectionSite).toBe("ABDOMEN_LEFT");
    // Documenting the dose does not move its recorded time.
    expect(live[0].takenAt?.getTime()).toBe(takenAt?.getTime());

    const ledger = await readLedger(medId, slot);
    const slotRow = ledger.find(
      (r) => r.kind === "slot" && new Date(r.at).getTime() === slot.getTime(),
    );
    expect(slotRow?.status).not.toBe("missed");
    expect(ledger.some((r) => r.kind !== "slot")).toBe(false);
  });

  it("marking an overdue reminder row as taken keeps the row and its id", async () => {
    const { user, medId, slot } = await setupDoseFixture({ offsetHours: 12 });
    const row = await getPrismaClient().medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: medId,
        scheduledFor: slot,
        takenAt: null,
        skipped: false,
        source: "REMINDER",
      },
    });
    const r = await statusPost({ intakeId: row.id, status: "taken" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { id: string } }).data.id).toBe(row.id);
    const live = await liveRows(user.id, medId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(row.id);
    expect(live[0].scheduledFor.getTime()).toBe(slot.getTime());
    expect(live[0].takenAt).not.toBeNull();
    // Held by its anchor, not by the band, so every reader binds it there.
    expect(live[0].attributionSource).toBe("USER_PIN");
  });

  it("a time correction through the event PUT keeps the dose on its slot", async () => {
    const { user, medId, slot } = await setupDoseFixture({ offsetHours: 12 });
    const row = await getPrismaClient().medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: medId,
        scheduledFor: slot,
        takenAt: new Date(slot.getTime() + 5 * 60_000),
        skipped: false,
        source: "WEB",
      },
    });
    const corrected = new Date(Date.now() - 60_000);
    const r = await eventPut(medId, row.id, {
      takenAt: corrected.toISOString(),
    });
    expect(r.status).toBe(200);
    const live = await liveRows(user.id, medId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(row.id);
    expect(live[0].scheduledFor.getTime()).toBe(slot.getTime());
    expect(live[0].takenAt?.getTime()).toBe(corrected.getTime());
  });
});
