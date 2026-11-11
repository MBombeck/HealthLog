/**
 * A life event save settles once the server stored it.
 *
 * The hooks returned the timeline refresh from `onSuccess`, which a mutation
 * waits for, so the sheet kept its spinner until the timeline had refetched.
 */
import { describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  // A refetch that never answers, as on a slow connection.
  invalidateQueries: vi.fn(() => new Promise(() => {})),
  getQueryCache: () => ({ findAll: () => [] }),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: <T>(initial: T) => ({ current: initial }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => options,
  // The hook's options are what is under test; return them as they are.
  useMutation: (options: unknown) => options,
  useQueryClient: () => client,
}));

import { useLifeEventMutations } from "../use-timeline";

describe("life event saves", () => {
  it.each(["create", "update", "remove"] as const)(
    "%s starts the refresh and does not wait for it",
    (name) => {
      client.invalidateQueries.mockClear();
      const options = useLifeEventMutations()[name] as unknown as {
        onSuccess: () => unknown;
      };

      expect(options.onSuccess()).toBeUndefined();
      expect(client.invalidateQueries).toHaveBeenCalled();
    },
  );
});
