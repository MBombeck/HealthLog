import { describe, expect, it } from "vitest";

import { CONFLICT_SETTLE_MS, relayStateAt } from "@/lib/push-relay/relay-state";

const now = new Date("2026-11-22T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("relayStateAt", () => {
  it("keeps a fresh conflict for the challenge's 30 minutes", () => {
    expect(
      relayStateAt(
        {
          relayState: "conflict",
          relayConflictAt: ago(CONFLICT_SETTLE_MS - 1),
        },
        now,
      ),
    ).toBe("conflict");
  });

  it("asks for a rebind once the conflict is 30 minutes old", () => {
    expect(
      relayStateAt(
        { relayState: "conflict", relayConflictAt: ago(CONFLICT_SETTLE_MS) },
        now,
      ),
    ).toBe("rebind_needed");
    // A conflict without its time is no fresh one.
    expect(
      relayStateAt({ relayState: "conflict", relayConflictAt: null }, now),
    ).toBe("rebind_needed");
  });

  it("leaves every other state as stored", () => {
    for (const relayState of ["none", "bound", "rebind_needed"]) {
      expect(
        relayStateAt({ relayState, relayConflictAt: ago(3600_000) }, now),
      ).toBe(relayState);
    }
  });
});
