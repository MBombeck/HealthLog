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
  consumeOneDose,
  expireStaleInUseItems,
} from "../service";

const NOW = new Date("2026-05-14T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("consumeOneDose", () => {
  it("returns null when no eligible pen exists for the medication", async () => {
    vi.mocked(prisma.medicationInventoryItem.findFirst).mockResolvedValueOnce(
      null,
    );
    vi.mocked(prisma.medicationInventoryItem.findFirst).mockResolvedValueOnce(
      null,
    );

    const result = await consumeOneDose({
      userId: "u",
      medicationId: "m",
      intakeAt: NOW,
    });
    expect(result).toBeNull();
    expect(prisma.medicationInventoryItem.update).not.toHaveBeenCalled();
  });

  it("flips an ACTIVE pen to IN_USE on first use", async () => {
    // No IN_USE pen, fall back to ACTIVE.
    vi.mocked(prisma.medicationInventoryItem.findFirst).mockResolvedValueOnce(
      null,
    );
    vi.mocked(prisma.medicationInventoryItem.findFirst).mockResolvedValueOnce({
      id: "inv-1",
      state: "ACTIVE",
      dosesTotal: 4,
      dosesRemaining: 4,
      firstUseAt: null,
      printedExpiry: null,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({} as never);

    const result = await consumeOneDose({
      userId: "u",
      medicationId: "m",
      intakeAt: NOW,
    });
    expect(result).toEqual({ itemId: "inv-1", change: "first_use" });

    const updateCall = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0];
    expect(updateCall.data).toMatchObject({
      state: "IN_USE",
      dosesRemaining: 3,
      firstUseAt: NOW,
    });
  });

  it("prefers the IN_USE pen with the earliest expiry", async () => {
    const firstUse = new Date(NOW.getTime() - 5 * MS_PER_DAY);
    vi.mocked(prisma.medicationInventoryItem.findFirst).mockResolvedValueOnce({
      id: "inv-active",
      state: "IN_USE",
      dosesTotal: 4,
      dosesRemaining: 3,
      firstUseAt: firstUse,
      printedExpiry: null,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({} as never);

    const result = await consumeOneDose({
      userId: "u",
      medicationId: "m",
      intakeAt: NOW,
    });
    expect(result).toEqual({ itemId: "inv-active", change: "consumed" });
    expect(prisma.medicationInventoryItem.findFirst).toHaveBeenCalledTimes(1);
  });

  it("returns 'depleted' when the final dose is consumed", async () => {
    const firstUse = new Date(NOW.getTime() - 5 * MS_PER_DAY);
    vi.mocked(prisma.medicationInventoryItem.findFirst).mockResolvedValueOnce({
      id: "inv-last",
      state: "IN_USE",
      dosesTotal: 4,
      dosesRemaining: 1,
      firstUseAt: firstUse,
      printedExpiry: null,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({} as never);

    const result = await consumeOneDose({
      userId: "u",
      medicationId: "m",
      intakeAt: NOW,
    });
    expect(result).toEqual({ itemId: "inv-last", change: "depleted" });
    const updateCall = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0];
    expect(updateCall.data).toMatchObject({
      state: "USED_UP",
      dosesRemaining: 0,
    });
  });
});

describe("expireStaleInUseItems", () => {
  it("transitions IN_USE rows whose deadline has lapsed via a single updateMany", async () => {
    // The selector `state = IN_USE AND expiresAt < now` already proves
    // the row must transition to EXPIRED (IN_USE implies dosesRemaining
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
    const printed = new Date("2027-06-01T00:00:00Z");
    const input = buildCreateInventoryInput({
      userId: "u",
      medicationId: "m",
      dosesTotal: 4,
      printedExpiry: printed,
      purchasedAt: null,
      notes: null,
    });
    expect(input).toMatchObject({
      state: "ACTIVE",
      dosesTotal: 4,
      dosesRemaining: 4,
      firstUseAt: null,
      expiresAt: printed,
    });
  });

  it("computes expiresAt = null when neither firstUseAt nor printedExpiry is set", () => {
    const input = buildCreateInventoryInput({
      userId: "u",
      medicationId: "m",
      dosesTotal: 4,
      printedExpiry: null,
      purchasedAt: null,
      notes: null,
    });
    expect(input.expiresAt).toBeNull();
  });
});
