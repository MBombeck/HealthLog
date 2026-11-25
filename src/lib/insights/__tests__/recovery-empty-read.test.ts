import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A device's own recovery leads the Device scores page, but the
 * `RECOVERY_SCORE` summary also counts the readiness HealthLog stores each
 * night. The reader asks for a device row by source, so an account with only
 * HealthLog's own still reads as empty, and one with a WHOOP row does not.
 */

const findFirst = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findFirst: (...a: unknown[]) => findFirst(...a) },
    user: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));

import { loadRecoveryEmpty } from "../recovery-empty-read";

describe("loadRecoveryEmpty", () => {
  beforeEach(() => {
    findFirst.mockReset();
    findUnique.mockReset().mockResolvedValue(null);
  });

  it("is not empty when a device wrote a recovery score", async () => {
    findFirst.mockResolvedValue({ id: "m1" });
    await expect(
      loadRecoveryEmpty("u1", { RECOVERY_SCORE: { count: 30 } }),
    ).resolves.toBeNull();
    const where = findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      userId: "u1",
      type: "RECOVERY_SCORE",
      source: { not: "COMPUTED" },
      deletedAt: null,
    });
  });

  it("stays empty with only HealthLog's stored readiness", async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      loadRecoveryEmpty("u1", { RECOVERY_SCORE: { count: 30 } }),
    ).resolves.toBe("general");
  });

  it("reads nothing when another recovery type has a reading", async () => {
    await expect(
      loadRecoveryEmpty("u1", { STRESS_SCORE: { count: 3 } }),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
