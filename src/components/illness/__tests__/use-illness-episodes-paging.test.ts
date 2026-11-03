/**
 * The journal reads every episode, not the list route's first page.
 *
 * The route pages at 50 by default; one unpaged call left the oldest episodes
 * off the illness page, its settings and every picker once a record held more
 * than that, and they could then be found only through search.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("@tanstack/react-query", () => ({
  // The hook's options are what is under test; return them as they are.
  useQuery: (options: unknown) => options,
  useMutation: () => ({}),
  useQueryClient: () => ({}),
}));

const journal = vi.hoisted(() => ({ total: 230 }));

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiGetList: async (url: string) => {
    calls.push(url);
    // The route's own paging: 50 unless asked otherwise, from offset 0, and
    // the cap it sends: a row past the page exists or it does not.
    const params = new URL(url, "http://x").searchParams;
    const offset = Number(params.get("offset") ?? 0);
    const limit = Number(params.get("limit") ?? 50);
    const count = Math.max(0, Math.min(limit, journal.total - offset));
    return {
      data: Array.from({ length: count }, (_, i) => ({ id: `e${offset + i}` })),
      cap: { truncated: offset + count < journal.total, limit },
    };
  },
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

import { useIllnessEpisodes } from "../use-illness";

describe("useIllnessEpisodes", () => {
  // Each case states its own journal and counts only its own requests.
  beforeEach(() => {
    calls.length = 0;
    journal.total = 230;
  });

  it("reads page after page until the whole journal is in", async () => {
    const options = useIllnessEpisodes(true) as unknown as {
      queryFn: () => Promise<{ id: string }[]>;
    };
    const episodes = await options.queryFn();
    expect(episodes).toHaveLength(230);
    expect(new Set(episodes.map((e) => e.id)).size).toBe(230);
    expect(calls).toHaveLength(3);
    expect(calls.every((url) => url.includes("includeResolved=true"))).toBe(
      true,
    );
  });

  it("stops on a full last page the route says is the end", async () => {
    journal.total = 200;
    const options = useIllnessEpisodes(true) as unknown as {
      queryFn: () => Promise<{ id: string }[]>;
    };
    expect(await options.queryFn()).toHaveLength(200);
    // Two full pages of 100, no third request for an empty one.
    expect(calls).toHaveLength(2);
  });
});
