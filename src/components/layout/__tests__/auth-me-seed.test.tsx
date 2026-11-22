/**
 * The account seed: the root layout's `/api/auth/me` payload lands in the
 * query cache before the shell reads it, stale, so the shell still fetches it
 * once in the background. Rendered here the way the server renders it: the
 * browser-side effects (record-session adoption, preference mirrors) are
 * withheld, since on the server they would write state shared by every
 * request.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const adopt = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-auth", () => ({
  adoptMePayload: (payload: unknown, opts: { apply: boolean }) => {
    adopt(opts);
    return { ...(payload as object), adopted: true };
  },
}));

import { toAccountSeed, type AccountSeed } from "@/lib/auth/account-seed";
import { queryKeys } from "@/lib/query-keys";
import { AuthMeSeed } from "../auth-me-seed";

const PAYLOAD: AccountSeed = toAccountSeed({
  id: "u1",
  username: "u1",
  role: "USER",
  timezone: "Europe/Berlin",
});

function seed(client: QueryClient, payload: AccountSeed | null) {
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AuthMeSeed payload={payload} />
    </QueryClientProvider>,
  );
}

describe("AuthMeSeed", () => {
  it("seeds the account on the server, stale and without the browser effects", () => {
    const client = new QueryClient();
    seed(client, PAYLOAD);
    expect(client.getQueryData(queryKeys.authMe())).toEqual({
      ...PAYLOAD,
      adopted: true,
    });
    expect(adopt).toHaveBeenCalledWith({ apply: false });
    expect(client.getQueryState(queryKeys.authMe())?.dataUpdatedAt).toBe(0);
  });

  it("leaves a cache that already holds the account alone", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.authMe(), { id: "fresh" });
    adopt.mockClear();
    seed(client, PAYLOAD);
    expect(client.getQueryData(queryKeys.authMe())).toEqual({ id: "fresh" });
    expect(adopt).not.toHaveBeenCalled();
  });

  it("does nothing without a payload", () => {
    const client = new QueryClient();
    seed(client, null);
    expect(client.getQueryData(queryKeys.authMe())).toBeUndefined();
  });
});
