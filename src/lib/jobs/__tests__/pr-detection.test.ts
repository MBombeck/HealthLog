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
  PR_DETECTION_DEBOUNCE_SECONDS,
  PR_DETECTION_QUEUE,
  prDetectionSingletonKey,
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

  it("coalesces one account's sends per mode behind a short debounce", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setGlobalBoss({ send } as unknown as Parameters<typeof setGlobalBoss>[0]);

    await enqueuePrDetection("user-1", { silent: true });
    await enqueuePrDetection("user-1", { silent: false });
    await enqueuePrDetection("user-2", { silent: true });

    const options = send.mock.calls.map(
      (call) => call[2] as { singletonKey: string; startAfter: number },
    );
    // Same account and mode share a key, so the queue's `short` policy
    // folds a burst into the one queued run; another mode or account does not.
    expect(options[0]!.singletonKey).toBe(
      prDetectionSingletonKey("user-1", true),
    );
    expect(new Set(options.map((o) => o.singletonKey)).size).toBe(3);
    for (const o of options) {
      expect(o.startAfter).toBe(PR_DETECTION_DEBOUNCE_SECONDS);
    }
  });

  it("defaults silent to false when not provided", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setGlobalBoss({ send } as never);

    await enqueuePrDetection("user-2");

    const [, payload] = send.mock.calls[0];
    expect(payload).toMatchObject({ userId: "user-2", silent: false });
  });
});
