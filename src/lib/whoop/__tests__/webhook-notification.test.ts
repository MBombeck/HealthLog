/**
 * v1.16.16 (iOS #17) — `processWhoopNotification` enqueue tests (mocked).
 *
 * A `*.updated` webhook must enqueue the per-resource sync job carrying the
 * resource id so the worker can do a targeted fetch-by-id refresh (landing the
 * exact record immediately rather than waiting for the next overlap window).
 * The existing 200-always + unknown-user + delete-soft-delete contract is
 * preserved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, bossSend, updateMany, deleteMany } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  bossSend: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    whoopConnection: { findUnique: (...a: unknown[]) => findUnique(...a) },
    measurement: { updateMany: (...a: unknown[]) => updateMany(...a) },
    workout: { deleteMany: (...a: unknown[]) => deleteMany(...a) },
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: (...a: unknown[]) => bossSend(...a) }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/api-response", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => ({ setAuth: vi.fn(), addWarning: vi.fn() }),
}));

import { processWhoopNotification } from "../webhook-handler";

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ userId: "user-1" });
  bossSend.mockResolvedValue("job-id");
});

describe("processWhoopNotification — fetch-by-id enqueue", () => {
  it("enqueues the workout queue with the resource id", async () => {
    const res = await processWhoopNotification({
      user_id: 42,
      id: "w-123",
      type: "workout.updated",
    });

    expect(res.status).toBe(200);
    expect(bossSend).toHaveBeenCalledWith("whoop-workout-sync", {
      userId: "user-1",
      resourceId: "w-123",
    });
  });

  it("carries a numeric resource id (cycle-based recovery) as a string", async () => {
    await processWhoopNotification({
      user_id: 42,
      id: 9981,
      type: "recovery.updated",
    });

    expect(bossSend).toHaveBeenCalledWith("whoop-recovery-sync", {
      userId: "user-1",
      resourceId: "9981",
    });
  });

  it("returns 200 for an unknown user without enqueuing", async () => {
    findUnique.mockResolvedValue(null);

    const res = await processWhoopNotification({
      user_id: 7,
      id: "w-1",
      type: "workout.updated",
    });

    expect(res.status).toBe(200);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("soft-deletes on a *.deleted event (no enqueue)", async () => {
    updateMany.mockResolvedValue({ count: 3 });
    deleteMany.mockResolvedValue({ count: 1 });

    const res = await processWhoopNotification({
      user_id: 42,
      id: "w-123",
      type: "workout.deleted",
    });

    expect(res.status).toBe(200);
    expect(bossSend).not.toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalled();
  });
});
