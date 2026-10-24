/**
 * A server render's query cache must not outlive the request.
 *
 * `Providers` builds the app's `QueryClient` once per render. With a finite
 * `gcTime` every entry that render built started a timer of that length, and
 * a Node timer keeps the async context it was created in: on the server that
 * is the request's, with the response, the Flight stream and the compressed
 * body behind it. Production kept every page render, not-found pages for
 * scanner probes included, reachable for ten minutes after it was answered.
 *
 * The scope test below reproduces that chain without a server: an object held
 * only by an `AsyncLocalStorage` store stands in for the request, a query is
 * built inside it, and after the client is dropped the object must be
 * collectable. Its positive control runs the same steps on a plain client with
 * the same defaults and must see the object survive, so the detector is shown
 * to fire before its silence is trusted.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import {
  QueryClient,
  QueryObserver,
  environmentManager,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUERY_CLIENT_DEFAULT_OPTIONS,
  createAppQueryClient,
} from "../query-client-options";

setFlagsFromString("--expose-gc");
const forceGc: () => void = runInNewContext("gc");
setFlagsFromString("--no-expose-gc");

const TEN_MINUTES = 10 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  environmentManager.setIsServer(() => typeof window === "undefined");
});

/**
 * What a render does: one observer per hook, some on the client's default
 * `gcTime`, some with their own, disabled ones included.
 */
function renderQueries(client: QueryClient): void {
  new QueryObserver(client, { queryKey: ["me"], queryFn: () => "me" });
  new QueryObserver(client, {
    queryKey: ["chart"],
    queryFn: () => "chart",
    gcTime: FIVE_MINUTES,
  });
  new QueryObserver(client, {
    queryKey: ["disabled"],
    queryFn: () => "disabled",
    enabled: false,
    gcTime: FIVE_MINUTES,
  });
}

/**
 * Renders inside a request scope, lets the client go, collects, and reports
 * whether the request's response survived.
 */
async function requestSurvivesRender(
  makeClient: () => QueryClient,
): Promise<{ survived: boolean; client: WeakRef<QueryClient> }> {
  const storage = new AsyncLocalStorage<{ response: object }>();
  const { request, client } = storage.run(
    { response: { body: new Uint8Array(64 * 1024) } },
    () => {
      const queryClient = makeClient();
      renderQueries(queryClient);
      return {
        request: new WeakRef(storage.getStore()!.response),
        client: new WeakRef(queryClient),
      };
    },
  );

  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    forceGc();
  }
  return { survived: request.deref() !== undefined, client };
}

describe("AppQueryClient on the server", () => {
  it("schedules no garbage-collection timer for any entry", () => {
    vi.useFakeTimers();
    environmentManager.setIsServer(() => true);

    const client = createAppQueryClient();
    renderQueries(client);

    expect(client.getQueryCache().getAll()).toHaveLength(3);
    for (const query of client.getQueryCache().getAll()) {
      expect(query.gcTime).toBe(Infinity);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves the request that rendered it collectable", async () => {
    environmentManager.setIsServer(() => true);

    const { survived } = await requestSurvivesRender(createAppQueryClient);

    expect(survived).toBe(false);
  });

  it("positive control: a plain client with the same defaults keeps the request alive", async () => {
    environmentManager.setIsServer(() => true);

    const { survived, client } = await requestSurvivesRender(
      () => new QueryClient({ defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS }),
    );

    expect(survived).toBe(true);
    // Release the pending timers so the worker is not left holding them.
    client.deref()?.clear();
  });
});

describe("AppQueryClient in the browser", () => {
  it("keeps the configured gcTime, from the defaults and from the call site", () => {
    vi.useFakeTimers();
    environmentManager.setIsServer(() => false);

    const client = createAppQueryClient();
    renderQueries(client);

    const byKey = new Map(
      client
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryKey[0], query.gcTime]),
    );
    expect(byKey.get("me")).toBe(TEN_MINUTES);
    expect(byKey.get("chart")).toBe(FIVE_MINUTES);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    client.clear();
  });
});
