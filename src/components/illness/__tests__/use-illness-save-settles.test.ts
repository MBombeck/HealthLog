/**
 * An episode save settles once the server stored it.
 *
 * Every episode hook's `onSuccess` used to return the refresh of the illness
 * reads and the dashboard. A mutation waits for what `onSuccess` returns, so
 * the episode sheet kept its spinner until each of those reads had refetched.
 */
import { describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  // A refetch that never answers, as on a slow connection.
  invalidateQueries: vi.fn(() => new Promise(() => {})),
  refetchQueries: vi.fn(() => new Promise(() => {})),
  getQueryCache: () => ({ findAll: () => [] }),
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
