import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CoachConversationDTO,
  CoachConversationsPage,
} from "@/lib/ai/coach/types";
import { queryKeys } from "@/lib/query-keys";
import {
  CONVERSATION_DELETE_UNDO_MS,
  commitCoachConversationDelete,
  createCoachConversationDeleteQueue,
  deleteCoachConversationRequest,
  removeCoachConversationFromCaches,
} from "../use-coach";

function conversation(id: string): CoachConversationDTO {
  return {
    id,
    title: id,
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

describe("Coach conversation delete queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits when the undo window runs out", () => {
    const commit = vi.fn();
    const queue = createCoachConversationDeleteQueue(commit);
    queue.request("c1");
    vi.advanceTimersByTime(CONVERSATION_DELETE_UNDO_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledExactlyOnceWith("c1");
  });

  it("commits a scheduled delete when the page goes away inside the window", () => {
    // The defect: a delete followed by a reload, a closed tab or a
    // backgrounded app inside the window lived only in a timer that never
    // fired, so no request was sent and the conversation came back.
    const commit = vi.fn();
    const queue = createCoachConversationDeleteQueue(commit);
    queue.request("c1");
    queue.request("c2");
    queue.flush();
    expect(commit.mock.calls).toEqual([["c1"], ["c2"]]);

    // Committed once: neither the timer nor a second flush repeats it.
    vi.advanceTimersByTime(CONVERSATION_DELETE_UNDO_MS);
    queue.flush();
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("undo cancels inside the window and reports false once committed", () => {
    const commit = vi.fn();
    const queue = createCoachConversationDeleteQueue(commit);
    queue.request("c1");
    expect(queue.undo("c1")).toBe(true);
    queue.flush();
    vi.advanceTimersByTime(CONVERSATION_DELETE_UNDO_MS);
    expect(commit).not.toHaveBeenCalled();

    queue.request("c2");
    queue.flush();
    expect(queue.undo("c2")).toBe(false);
    expect(commit).toHaveBeenCalledExactlyOnceWith("c2");
  });
});

describe("Coach conversation delete caches and request", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("removes the row from the head list and every history variant at once", () => {
    // The hide filter is released only after this, so no cached list may
    // still hold the row: the paginated history used to keep it until the
    // refetch, and the row reappeared for that long.
    const client = new QueryClient();
    client.setQueryData(
      queryKeys.coachConversations(),
      page(conversation("c1"), conversation("c2")),
    );
    client.setQueryData(queryKeys.coachConversationHistory(""), {
      pages: [page(conversation("c2")), page(conversation("c1"))],
      pageParams: [null, "cursor-1"],
    });
    client.setQueryData(queryKeys.coachConversationHistory("c1"), {
      pages: [page(conversation("c1"))],
      pageParams: [null],
    });

    const snapshot = removeCoachConversationFromCaches(client, "c1");

    expect(
      client
        .getQueryData<CoachConversationsPage>(queryKeys.coachConversations())
        ?.conversations.map((c) => c.id),
    ).toEqual(["c2"]);
    for (const search of ["", "c1"]) {
      const data = client.getQueryData<{ pages: CoachConversationsPage[] }>(
        queryKeys.coachConversationHistory(search),
      );
      expect(
        data?.pages.flatMap((p) => p.conversations.map((c) => c.id)),
      ).not.toContain("c1");
    }
    expect(snapshot).toHaveLength(3);
  });

  it("sends the DELETE with keepalive so it outlives the page", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { deleted: true }, error: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await deleteCoachConversationRequest("c 1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/insights/chat/c%201");
    expect(init.method).toBe("DELETE");
    expect(init.keepalive).toBe(true);
  });

  function seeded(): QueryClient {
    const client = new QueryClient();
    client.setQueryData(
      queryKeys.coachConversations(),
      page(conversation("c1"), conversation("c2")),
    );
    return client;
  }

  function respond(status: number) {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            status === 200
              ? { data: { deleted: true }, error: null }
              : { data: null, error: "coach.conversation.notFound" },
          ),
          { status, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
  }

  const headIds = (client: QueryClient) =>
    client
      .getQueryData<CoachConversationsPage>(queryKeys.coachConversations())
      ?.conversations.map((c) => c.id);

  it("treats a 404 as already deleted", async () => {
    // A delete re-sent after a reload meets a row the first request already
    // removed.
    respond(404);
    const client = seeded();
    const onFailed = vi.fn();
    commitCoachConversationDelete(client, "c1", onFailed);
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onFailed).not.toHaveBeenCalled();
    expect(headIds(client)).toEqual(["c2"]);
  });

  it("restores the lists and reports a failed delete", async () => {
    respond(500);
    const client = seeded();
    const onFailed = vi.fn();
    commitCoachConversationDelete(client, "c1", onFailed);
    expect(headIds(client)).toEqual(["c2"]);
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(headIds(client)).toEqual(["c1", "c2"]);
  });
});
