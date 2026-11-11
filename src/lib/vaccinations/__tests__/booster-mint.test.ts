/**
 * The first booster is due one interval after the dose. The dose date is a
 * calendar date stored at UTC midnight; adding the interval to that instant
 * put the anchor on the evening before for anyone west of UTC, so the
 * reminder came due a day early there.
 */
import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { mintOrReanchorBooster } from "@/lib/vaccinations/booster-mint";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

function fakeTx() {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    vaccinationRecord: {
      findFirst: vi.fn(async () => ({
        id: "dose-1",
        antigenSlug: "tetanus",
        customVaccineId: null,
        occurredAt: new Date("2026-11-11T00:00:00.000Z"),
      })),
      update: vi.fn(async () => ({})),
    },
    measurementReminder: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "reminder-1" };
      }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, created };
}

describe("mintOrReanchorBooster", () => {
  it("counts the interval from the dose's own date west of UTC", async () => {
    const { tx, created } = fakeTx();
    // 12 months → round(12 × 30.4375) = 365 days after 11 November 2026.
    await mintOrReanchorBooster(
      tx,
      "u1",
      { vaccinationId: "dose-1", intervalMonths: 12, label: "Tetanus" },
      "America/New_York",
    );
    expect(created[0].anchorDate).toEqual(
      startOfLocalDayKey("2027-11-11", "America/New_York"),
    );
  });
});
