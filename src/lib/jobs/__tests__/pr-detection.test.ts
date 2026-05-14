/**
 * `enqueuePrDetection` is a thin wrapper around the global boss
 * singleton. We assert two behaviours:
 *   1. No boss attached → the call is a silent no-op (route paths in
 *      test environments don't run a worker process).
 *   2. Boss attached → `boss.send` receives the expected payload with
 *      the `silent` flag propagated through.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { setGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  PR_DETECTION_QUEUE,
  enqueuePrDetection,
} from "@/lib/jobs/pr-detection";

describe("enqueuePrDetection", () => {
  beforeEach(() => {
    // Reset the global singleton between tests.
    (globalThis as Record<string, unknown>)["__healthlog_pgboss__"] = undefined;
  });

  it("is a no-op when no boss instance is attached", async () => {
    await expect(
      enqueuePrDetection("user-1", { silent: false }),
    ).resolves.toBeUndefined();
  });

  it("forwards the payload to boss.send when a boss instance is attached", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setGlobalBoss({ send } as never);

    await enqueuePrDetection("user-1", { silent: true });

    expect(send).toHaveBeenCalledTimes(1);
    const [queue, payload] = send.mock.calls[0];
    expect(queue).toBe(PR_DETECTION_QUEUE);
    expect(payload).toMatchObject({ userId: "user-1", silent: true });
    expect(typeof (payload as { triggeredAt: string }).triggeredAt).toBe(
      "string",
    );
  });

  it("defaults silent to false when not provided", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setGlobalBoss({ send } as never);

    await enqueuePrDetection("user-2");

    const [, payload] = send.mock.calls[0];
    expect(payload).toMatchObject({ userId: "user-2", silent: false });
  });
});
