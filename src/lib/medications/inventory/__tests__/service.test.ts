import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    medicationInventoryItem: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import {
  buildCreateInventoryInput,
  expireStaleInUseItems,
  serializeInventoryItem,
} from "../service";

const NOW = new Date("2026-05-14T12:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
});

describe("expireStaleInUseItems", () => {
  it("transitions IN_USE rows whose deadline has lapsed via a single updateMany", async () => {
    // The selector `state = IN_USE AND expiresAt < now` already proves
    // the row must transition to EXPIRED (IN_USE implies unitsRemaining
    // > 0, and the expiresAt filter proves the deadline lapsed). Using
    // `updateMany` collapses N row round-trips into one.
    vi.mocked(prisma.medicationInventoryItem.updateMany).mockResolvedValue({
      count: 3,
    } as never);

    const count = await expireStaleInUseItems({ nowMs: NOW.getTime() });
    expect(count).toBe(3);
    expect(prisma.medicationInventoryItem.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.medicationInventoryItem.updateMany).toHaveBeenCalledWith({
      where: {
        state: "IN_USE",
        expiresAt: { lt: new Date(NOW.getTime()) },
        // The cron leaves an account pending deletion as it was.
        user: { deletionRequestedAt: null },
      },
      data: { state: "EXPIRED" },
    });
    expect(prisma.medicationInventoryItem.update).not.toHaveBeenCalled();
    expect(prisma.medicationInventoryItem.findMany).not.toHaveBeenCalled();
  });

  it("scopes to a single user when userId is given", async () => {
    vi.mocked(prisma.medicationInventoryItem.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    await expireStaleInUseItems({ userId: "user-1", nowMs: NOW.getTime() });
    expect(prisma.medicationInventoryItem.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ userId: "user-1" }),
      data: { state: "EXPIRED" },
    });
  });

  it("returns 0 when no rows match", async () => {
    vi.mocked(prisma.medicationInventoryItem.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const count = await expireStaleInUseItems({ nowMs: NOW.getTime() });
    expect(count).toBe(0);
  });
});

describe("buildCreateInventoryInput", () => {
  it("computes expiresAt = printedExpiry when firstUseAt is null", () => {
    // Now-anchored so the fixture can never age into a past expiry.
    const printed = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000);
    const input = buildCreateInventoryInput({
      userId: "u",
      medicationId: "m",
      unitsTotal: 4,
      containerType: "PEN",
      printedExpiry: printed,
      purchasedAt: null,
      manufacturer: null,
      doseStrength: null,
      notes: null,
    });
    expect(input).toMatchObject({
      state: "ACTIVE",
      containerType: "PEN",
      unitsTotal: 4,
      unitsRemaining: 4,
      firstUseAt: null,
      expiresAt: printed,
    });
  });

  it("computes expiresAt = null when neither firstUseAt nor printedExpiry is set", () => {
    const input = buildCreateInventoryInput({
      userId: "u",
      medicationId: "m",
      unitsTotal: 4,
      containerType: "OTHER",
      printedExpiry: null,
      purchasedAt: null,
      manufacturer: null,
      doseStrength: null,
      notes: null,
    });
    expect(input.expiresAt).toBeNull();
  });
});

describe("serializeInventoryItem (iOS#31)", () => {
  it("serialises a Decimal-as-string unit count to a JSON number", () => {
    const out = serializeInventoryItem({
      id: "i1",
      unitsTotal: "30",
      unitsRemaining: "29.5",
    });
    expect(out.unitsTotal).toBe(30);
    expect(out.unitsRemaining).toBe(29.5);
  });

  it("keeps a genuine tracked zero as 0, not null", () => {
    const out = serializeInventoryItem({
      id: "i2",
      unitsTotal: 4,
      unitsRemaining: 0,
    });
    expect(out.unitsRemaining).toBe(0);
    expect(out.unitsTotal).toBe(4);
  });

  it("serialises an unknown (null) unit count as null, not a fabricated 0", () => {
    const out = serializeInventoryItem({
      id: "i3",
      unitsTotal: null,
      unitsRemaining: null,
    });
    expect(out.unitsTotal).toBeNull();
    expect(out.unitsRemaining).toBeNull();
  });

  it("rejects non-finite corrupt values (NaN / Infinity) to null", () => {
    const out = serializeInventoryItem({
      id: "i4",
      unitsTotal: "not-a-number",
      unitsRemaining: Infinity,
    });
    expect(out.unitsTotal).toBeNull();
    expect(out.unitsRemaining).toBeNull();
  });

  it("preserves every other field unchanged", () => {
    const out = serializeInventoryItem({
      id: "i5",
      state: "ACTIVE",
      unitsTotal: "10",
      unitsRemaining: "10",
    });
    expect(out).toMatchObject({ id: "i5", state: "ACTIVE" });
  });
});

describe("buildCreateInventoryInput — carton labelling", () => {
  it("carries manufacturer + doseStrength onto the create input", () => {
    // The native pen list renders these as its headline and subhead; a
    // container created on the web carried neither, so the row could not be
    // shown there without fabricating an empty card.
    const input = buildCreateInventoryInput({
      userId: "u",
      medicationId: "m",
      unitsTotal: 4,
      containerType: "PEN",
      printedExpiry: null,
      purchasedAt: null,
      manufacturer: "Example Pharma",
      doseStrength: "5 mg/0.5 ml",
      notes: null,
    });
    expect(input.manufacturer).toBe("Example Pharma");
    expect(input.doseStrength).toBe("5 mg/0.5 ml");
  });

  it("leaves both null for a plain supply container", () => {
    const input = buildCreateInventoryInput({
      userId: "u",
      medicationId: "m",
      unitsTotal: 30,
      containerType: "BLISTER",
      printedExpiry: null,
      purchasedAt: null,
      manufacturer: null,
      doseStrength: null,
      notes: null,
    });
    expect(input.manufacturer).toBeNull();
    expect(input.doseStrength).toBeNull();
  });
});
