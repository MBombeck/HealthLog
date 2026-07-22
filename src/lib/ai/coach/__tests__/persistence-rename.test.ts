import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachConversation: { updateMany },
  },
}));

import { renameConversation } from "../persistence";

beforeEach(() => {
  updateMany.mockReset();
});

describe("renameConversation", () => {
  it("includes owner id in the database update predicate", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await expect(
      renameConversation("owner-1", "conversation-1", "Renamed"),
    ).resolves.toEqual({ id: "conversation-1", title: "Renamed" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "conversation-1", userId: "owner-1" },
      data: { title: "Renamed" },
    });
  });

  it("returns null when the owned update matched no row", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      renameConversation("owner-1", "foreign-or-missing", "Renamed"),
    ).resolves.toBeNull();
  });
});
