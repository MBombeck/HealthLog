import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CoachConversationDTO,
  CoachConversationDetailDTO,
  CoachConversationsPage,
} from "@/lib/ai/coach/types";
import { queryKeys } from "@/lib/query-keys";
import {
  applyOptimisticCoachConversationRename,
  invalidateCoachConversationRename,
  patchCoachConversationTitle,
  restoreCoachConversationRename,
} from "../use-coach";

function conversation(id: string, title: string): CoachConversationDTO {
  return {
    id,
    title,
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    messageCount: 2,
    fenced: false,
  };
}

function page(
  ...conversations: CoachConversationDTO[]
): CoachConversationsPage {
  return { conversations, nextCursor: null };
}

describe("Coach conversation rename cache lifecycle", () => {
  let client: QueryClient;
  const originalFetch = global.fetch;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    global.fetch = originalFetch;
  });

  it("optimistically updates the head list, every history variant, and detail cache", async () => {
    const target = conversation("c1", "Before");
    const other = conversation("c2", "Other");
    client.setQueryData(queryKeys.coachConversations(), page(target, other));
    client.setQueryData(queryKeys.coachConversationHistory(""), {
      pages: [page(target), page(other)],
      pageParams: [null, "cursor-1"],
    });
    client.setQueryData(queryKeys.coachConversationHistory("before"), {
      pages: [page(target)],
      pageParams: [null],
    });
    client.setQueryData<CoachConversationDetailDTO>(
      queryKeys.coachConversation("c1"),
      { ...target, attachmentCount: 0, messages: [] },
    );

    await applyOptimisticCoachConversationRename(client, {
      id: "c1",
      title: "After",
    });

    expect(
      client.getQueryData<CoachConversationsPage>(
        queryKeys.coachConversations(),
      )?.conversations[0].title,
    ).toBe("After");
    for (const search of ["", "before"]) {
      const data = client.getQueryData<{
        pages: CoachConversationsPage[];
      }>(queryKeys.coachConversationHistory(search));
      expect(data?.pages[0].conversations[0].title).toBe("After");
    }
    expect(
      client.getQueryData<CoachConversationDetailDTO>(
        queryKeys.coachConversation("c1"),
      )?.title,
    ).toBe("After");
  });

  it("restores the exact cache snapshots after a failed request", async () => {
    const target = conversation("c1", "Before");
    const head = page(target);
    const history = { pages: [page(target)], pageParams: [null] };
    const detail: CoachConversationDetailDTO = {
      ...target,
      attachmentCount: 0,
      messages: [],
    };
    client.setQueryData(queryKeys.coachConversations(), head);
    client.setQueryData(queryKeys.coachConversationHistory(""), history);
    client.setQueryData(queryKeys.coachConversation("c1"), detail);

    const snapshot = await applyOptimisticCoachConversationRename(client, {
      id: "c1",
      title: "After",
    });
    restoreCoachConversationRename(client, snapshot);

    expect(client.getQueryData(queryKeys.coachConversations())).toStrictEqual(
      head,
    );
    expect(
      client.getQueryData(queryKeys.coachConversationHistory("")),
    ).toStrictEqual(history);
    expect(
      client.getQueryData(queryKeys.coachConversation("c1")),
    ).toStrictEqual(detail);
  });

  it("persists the trimmed title with PATCH and returns the server result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { id: "c1", title: "Persisted" },
          error: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    global.fetch = fetchMock;

    await expect(
      patchCoachConversationTitle({ id: "c1", title: "  Persisted  " }),
    ).resolves.toEqual({ id: "c1", title: "Persisted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/insights/chat/c1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Persisted" }),
      }),
    );
  });

  it("invalidates the list prefix and renamed detail on settle", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await invalidateCoachConversationRename(client, "c1");

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.coachConversations(),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.coachConversation("c1"),
    });
  });
});
