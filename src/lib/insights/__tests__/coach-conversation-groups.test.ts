import { describe, expect, it } from "vitest";

import { groupConversationsByRecency } from "../coach-conversation-groups";

// The suite runs with TZ=UTC, so local day boundaries are UTC midnights.
const NOW = new Date("2026-10-04T15:00:00.000Z");

function c(id: string, updatedAt: string) {
  return { id, updatedAt };
}

describe("groupConversationsByRecency", () => {
  it("buckets by local day: today, yesterday, the six days before, earlier", () => {
    const groups = groupConversationsByRecency(
      [
        c("a", "2026-10-04T00:00:00.000Z"), // today, at midnight
        c("b", "2026-10-03T23:59:59.000Z"), // yesterday, last second
        c("c", "2026-10-03T00:00:00.000Z"), // yesterday, first second
        c("d", "2026-09-28T00:00:00.000Z"), // six days before today
        c("e", "2026-09-27T23:59:59.000Z"), // one second older: earlier
      ],
      NOW,
    );
    expect(groups.map((g) => [g.id, g.conversations.map((x) => x.id)])).toEqual(
      [
        ["today", ["a"]],
        ["yesterday", ["b", "c"]],
        ["thisWeek", ["d"]],
        ["earlier", ["e"]],
      ],
    );
  });

  it("drops empty groups and keeps the caller's order inside a group", () => {
    const groups = groupConversationsByRecency(
      [c("x", "2026-01-02T00:00:00.000Z"), c("y", "2026-03-02T00:00:00.000Z")],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("earlier");
    expect(groups[0].labelKey).toBe("insights.coach.history.groupEarlier");
    expect(groups[0].conversations.map((x) => x.id)).toEqual(["x", "y"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupConversationsByRecency([], NOW)).toEqual([]);
  });
});
