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

import { apiPatch, apiPost } from "@/lib/api/api-fetch";
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

describe("updating an episode", () => {
  it("supports useUpdateEpisode(id) with direct input", async () => {
    const patch = vi.mocked(apiPatch);
    patch.mockResolvedValueOnce({ id: "e1" });
    const update = useUpdateEpisode("e1") as unknown as {
      mutationKey: unknown;
      scope: { id: string };
      mutationFn: (input: unknown) => Promise<unknown>;
    };

    expect(update.scope).toEqual({ id: "illness-episode-update-e1" });
    expect(update.mutationKey).toEqual(["illness", "episode", "e1", "update"]);

    await update.mutationFn({ label: "Migraine" });
    expect(patch).toHaveBeenCalledWith("/api/illness/episodes/e1", {
      label: "Migraine",
    });
  });

  it("supports useUpdateEpisode(id) with legacy { id, input } payload", async () => {
    const patch = vi.mocked(apiPatch);
    patch.mockResolvedValueOnce({ id: "e2" });
    const update = useUpdateEpisode("e1") as unknown as {
      mutationFn: (input: unknown) => Promise<unknown>;
    };

    await update.mutationFn({ id: "e2", input: { label: "Flu" } });
    expect(patch).toHaveBeenCalledWith("/api/illness/episodes/e2", {
      label: "Flu",
    });
  });

  it("supports legacy useUpdateEpisode() without id and with { id, input } payload", async () => {
    const patch = vi.mocked(apiPatch);
    patch.mockResolvedValueOnce({ id: "e3" });
    const update = useUpdateEpisode() as unknown as {
      mutationKey?: unknown;
      scope?: unknown;
      mutationFn: (input: unknown) => Promise<unknown>;
    };

    expect(update.scope).toBeUndefined();
    expect(update.mutationKey).toBeUndefined();

    await update.mutationFn({ id: "e3", input: { label: "Cold" } });
    expect(patch).toHaveBeenCalledWith("/api/illness/episodes/e3", {
      label: "Cold",
    });
  });
});
