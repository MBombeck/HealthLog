import { describe, expect, it } from "vitest";

import {
  DRAIN_MAX_CONTINUATIONS,
  nextDrainContinuation,
} from "@/lib/jobs/drain-continuation";

// A nightly drain tick that ran out of budget hands the rest to a follow-up
// job, so a first-time backlog drains the same night (issue #1031). The chain
// must not loop on a pass that cannot move, and must end.

describe("nextDrainContinuation", () => {
  it("hands on a tick that stopped early after folding something", () => {
    expect(
      nextDrainContinuation({
        stoppedEarly: true,
        daysFolded: 12,
        continuation: 0,
      }),
    ).toBe(1);
    expect(
      nextDrainContinuation({
        stoppedEarly: true,
        daysFolded: 1,
        continuation: 5,
      }),
    ).toBe(6);
  });

  it("does not hand on a tick that finished", () => {
    expect(
      nextDrainContinuation({
        stoppedEarly: false,
        daysFolded: 400,
        continuation: 0,
      }),
    ).toBeNull();
  });

  it("does not hand on a tick that stopped without progress", () => {
    expect(
      nextDrainContinuation({
        stoppedEarly: true,
        daysFolded: 0,
        continuation: 0,
      }),
    ).toBeNull();
  });

  it("ends the chain at the cap", () => {
    expect(
      nextDrainContinuation({
        stoppedEarly: true,
        daysFolded: 10,
        continuation: DRAIN_MAX_CONTINUATIONS - 1,
      }),
    ).toBe(DRAIN_MAX_CONTINUATIONS);
    expect(
      nextDrainContinuation({
        stoppedEarly: true,
        daysFolded: 10,
        continuation: DRAIN_MAX_CONTINUATIONS,
      }),
    ).toBeNull();
  });
});
