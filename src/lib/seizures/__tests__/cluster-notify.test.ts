import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { newlyFormedCluster } from "../cluster-notify";

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-11-18T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);
const rule = { count: 2, windowHours: 24 };

describe("newlyFormedCluster", () => {
  it("answers the cluster the second seizure forms", () => {
    const events = [
      { id: "a", onsetAt: at(5), count: 1 },
      { id: "b", onsetAt: at(1), count: 1 },
    ];
    expect(newlyFormedCluster(events, "b", rule, now)).toMatchObject({
      seizureCount: 2,
      eventIds: ["a", "b"],
    });
  });

  it("stays silent for a seizure that joins a cluster already there", () => {
    const events = [
      { id: "a", onsetAt: at(5), count: 1 },
      { id: "b", onsetAt: at(3), count: 1 },
      { id: "c", onsetAt: at(1), count: 1 },
    ];
    expect(newlyFormedCluster(events, "c", rule, now)).toBeNull();
  });

  it("sends nothing for a tally alone, and counts it once another entry joins", () => {
    const rule = { count: 3, windowHours: 24 };
    const tally = { id: "a", onsetAt: at(2), count: 3 };
    expect(newlyFormedCluster([tally], "a", rule, now)).toBeNull();
    const next = { id: "b", onsetAt: at(1), count: 1 };
    expect(newlyFormedCluster([tally, next], "b", rule, now)).toMatchObject({
      seizureCount: 4,
    });
  });

  it("stays silent below the rule and for a back-filled seizure", () => {
    expect(
      newlyFormedCluster(
        [{ id: "a", onsetAt: at(1), count: 1 }],
        "a",
        rule,
        now,
      ),
    ).toBeNull();
    const old = [
      { id: "a", onsetAt: at(50), count: 1 },
      { id: "b", onsetAt: at(48), count: 1 },
    ];
    expect(newlyFormedCluster(old, "b", rule, now)).toBeNull();
  });

  it("stays silent for an id it was not given", () => {
    expect(newlyFormedCluster([], "x", rule, now)).toBeNull();
  });
});
