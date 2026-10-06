/**
 * v1.41 — the memory refresh waits for a quiet conversation. Every turn asks
 * for it; the singleton slot collapses a busy conversation's turns into one
 * queued job that starts once the quiet time has passed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn(async () => "job-1");
const boss = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => boss.current,
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import {
  COACH_MEMORY_QUIET_MS,
  COACH_MEMORY_REFRESH_QUEUE,
  enqueueCoachMemoryRefresh,
} from "../coach-memory-shared";

const PAYLOAD = { conversationId: "c1", userId: "u1", locale: "de" as const };

beforeEach(() => {
  send.mockClear();
  boss.current = { send };
});

describe("enqueueCoachMemoryRefresh", () => {
  it("starts after the quiet time, one job per conversation and slot", async () => {
    await enqueueCoachMemoryRefresh(PAYLOAD);
    expect(send).toHaveBeenCalledWith(COACH_MEMORY_REFRESH_QUEUE, PAYLOAD, {
      singletonKey: "quiet:c1",
      singletonSeconds: COACH_MEMORY_QUIET_MS / 1000,
      startAfter: COACH_MEMORY_QUIET_MS / 1000,
    });
    expect(COACH_MEMORY_QUIET_MS).toBe(30 * 60_000);
  });

  it("takes the rest of the quiet time when the worker puts a job back", async () => {
    await enqueueCoachMemoryRefresh(PAYLOAD, 4 * 60_000);
    expect(send).toHaveBeenCalledWith(
      COACH_MEMORY_REFRESH_QUEUE,
      PAYLOAD,
      expect.objectContaining({ startAfter: 240 }),
    );
  });

  it("is a no-op without a queue", async () => {
    boss.current = null;
    await expect(enqueueCoachMemoryRefresh(PAYLOAD)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
