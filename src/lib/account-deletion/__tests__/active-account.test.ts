import { describe, expect, it, vi } from "vitest";

import {
  activeAccount,
  activeAccountSql,
  dropPendingDeletion,
  ownedByActiveAccount,
} from "../active-account";

describe("the shared pending-deletion predicate", () => {
  it("narrows a User where without dropping its own conditions", () => {
    expect(activeAccount({ moodReminderEnabled: true })).toEqual({
      moodReminderEnabled: true,
      deletionRequestedAt: null,
    });
  });

  it("narrows an owned model's user filter instead of replacing it", () => {
    expect(ownedByActiveAccount({ enabled: true })).toEqual({
      enabled: true,
      user: { deletionRequestedAt: null },
    });
    expect(
      ownedByActiveAccount({ user: { cycleProfile: { is: null } } }),
    ).toEqual({
      user: { cycleProfile: { is: null }, deletionRequestedAt: null },
    });
  });

  it("splices only a column reference into SQL", () => {
    expect(activeAccountSql('m."user_id"').sql).toContain(
      '"pending_deletion"."id" = m."user_id"',
    );
    expect(() => activeAccountSql("1; DROP TABLE users")).toThrow();
  });

  it("drops the pending accounts from a scan's result", async () => {
    const findMany = vi.fn(async () => [{ id: "pending" }]);
    const db = { user: { findMany } };
    const rows = [{ userId: "pending" }, { userId: "active" }];
    expect(await dropPendingDeletion(db, rows, (r) => r.userId)).toEqual([
      { userId: "active" },
    ]);
    // An empty scan asks nothing.
    const none: Array<{ userId: string }> = [];
    expect(await dropPendingDeletion(db, none, (r) => r.userId)).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
