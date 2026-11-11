/**
 * An episode save settles once the server stored it, and stores it once.
 *
 * Every episode hook's `onSuccess` used to return the refresh of the illness
 * reads and the dashboard. A mutation waits for what `onSuccess` returns, so
 * the episode sheet kept its spinner until each of those reads had refetched.
 * And a create retried after a timeout went out under a new key, so the
 * server stored the episode twice.
 */
import { describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  // A refetch that never answers, as on a slow connection.
  invalidateQueries: vi.fn(() => new Promise(() => {})),
  refetchQueries: vi.fn(() => new Promise(() => {})),
  getQueryCache: () => ({ findAll: () => [] }),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: <T>(initial: T) => ({ current: initial }),
}));

vi.mock("@tanstack/react-query", () => ({
  // The hook's options are what is under test; return them as they are.
  useQuery: (options: unknown) => options,
  useMutation: (options: unknown) => options,
  useQueryClient: () => client,
}));

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiGetList: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

import { apiPost } from "@/lib/api/api-fetch";
import {
  useCreateEpisode,
  useDeleteEpisode,
  useResolveEpisode,
  useRestoreEpisode,
  useUpdateEpisode,
  useUpsertDayLog,
} from "../use-illness";

describe("episode saves", () => {
  it.each([
    ["create", () => useCreateEpisode()],
    ["update", () => useUpdateEpisode()],
    ["resolve", () => useResolveEpisode()],
    ["delete", () => useDeleteEpisode()],
    ["restore", () => useRestoreEpisode()],
    ["day log", () => useUpsertDayLog("e1")],
  ])("%s starts the refresh and does not wait for it", (_, hook) => {
    client.invalidateQueries.mockClear();
    const options = hook() as unknown as { onSuccess: () => unknown };

    expect(options.onSuccess()).toBeUndefined();
    expect(client.invalidateQueries).toHaveBeenCalled();
  });
});

describe("creating an episode", () => {
  it("retries under the same Idempotency-Key and starts the next one fresh", async () => {
    const create = useCreateEpisode() as unknown as {
      mutationFn: (input: unknown) => Promise<unknown>;
    };
    const post = vi.mocked(apiPost);
    post.mockRejectedValueOnce(new TypeError("timed out"));
    post.mockResolvedValue({ id: "e1" });
    const keyOf = (call: number) =>
      new Headers((post.mock.calls[call]![2] as RequestInit).headers).get(
        "Idempotency-Key",
      );

    await expect(create.mutationFn({ name: "Flu" })).rejects.toThrow();
    await create.mutationFn({ name: "Flu" });
    await create.mutationFn({ name: "Cold" });

    expect(keyOf(0)).toBeTruthy();
    expect(keyOf(1)).toBe(keyOf(0));
    expect(keyOf(2)).not.toBe(keyOf(0));
  });
});
