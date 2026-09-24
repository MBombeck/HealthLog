/**
 * #1031 — the cumulative-record repair must not lose records when the
 * re-derivation fails.
 *
 * The repair deleted every suspect cumulative record, committed, and only
 * then re-ran the detector. A detector that failed (a timeout on a large
 * account, a crash) left the records deleted, and because discovery looks
 * for the suspect rows the deletion removed, the account was never
 * repaired again: its step, energy and distance records were simply gone.
 * The delete and the re-derivation now commit together or not at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const detect = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/personal-records/pr-detection-worker", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/lib/personal-records/pr-detection-worker")
    >();
  return {
    ...actual,
    detectPersonalRecordsForUser: async (
      ...args: Parameters<typeof actual.detectPersonalRecordsForUser>
    ) => {
      if (detect.fail) throw new Error("detector ran out of time");
      return actual.detectPersonalRecordsForUser(...args);
    },
  };
});
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const { runCumulativePrRederivationForUser, CUMULATIVE_PR_FIX_CUTOFF } =
  await import("@/lib/personal-records/cumulative-pr-rederivation");

const USER = "user-pr-rederive-atomic";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  detect.fail = false;
  await prisma.user.create({
    data: { id: USER, username: USER, email: `${USER}@example.test` },
  });
  const before = new Date(CUMULATIVE_PR_FIX_CUTOFF.getTime() - 86_400_000);
  await prisma.personalRecord.create({
    data: {
      userId: USER,
      metricType: "ACTIVITY_STEPS",
      direction: "MAX",
      value: 99_999,
      unit: "steps",
      achievedAt: new Date("2025-03-01T12:00:00Z"),
      createdAt: before,
    },
  });
  // Enough steps for the detector's warm-up gate, one clear best day.
  await prisma.measurement.createMany({
    data: Array.from({ length: 10 }, (_, day) => ({
      userId: USER,
      type: "ACTIVITY_STEPS" as const,
      value: day === 4 ? 12_000 : 5_000,
      unit: "steps",
      source: "APPLE_HEALTH" as const,
      measuredAt: new Date(Date.UTC(2025, 3, 1 + day, 12)),
      externalId: `s-${day}`,
    })),
  });
});

describe("runCumulativePrRederivationForUser", () => {
  it("keeps the suspect record when the re-derivation fails", async () => {
    detect.fail = true;
    await expect(runCumulativePrRederivationForUser(USER)).rejects.toThrow(
      "detector ran out of time",
    );
    const left = await getPrismaClient().personalRecord.findMany({
      where: { userId: USER },
    });
    expect(left.map((r) => r.value)).toEqual([99_999]);
  });

  it("replaces the suspect record with the re-derived one when it succeeds", async () => {
    const summary = await runCumulativePrRederivationForUser(USER);
    expect(summary.rowsDeleted).toBe(1);
    const left = await getPrismaClient().personalRecord.findMany({
      where: { userId: USER },
    });
    expect(left.map((r) => r.value)).toEqual([12_000]);
  });
});
