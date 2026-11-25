/**
 * #1267 — the pinned dispatchers leave the deadline to the caller's signal.
 *
 * undici's Agent arms its own 300 s header timer and 300 s body timer by
 * default. A local model with the response timeout at 600 s answers a
 * non-streamed completion only once it is done, so its headers can arrive
 * after 300 s: undici then dropped a call the caller still allowed, and the
 * failure read as a bare network error. Waiting five minutes in a unit test
 * proves nothing faster, so this reads the options the Agent was built with.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "undici";
import {
  getPinnedOperatorApprovedDispatcher,
  getPinnedPublicDispatcher,
  getPinnedPublicKeepAliveDispatcher,
  _resetPinnedDispatcherForTests,
} from "../safe-fetch-dispatcher";

function agentOptions(agent: Agent): {
  headersTimeout?: number;
  bodyTimeout?: number;
} {
  const key = Object.getOwnPropertySymbols(agent).find(
    (s) => s.description === "options",
  );
  expect(key).toBeDefined();
  return (agent as unknown as Record<symbol, Record<string, number>>)[key!];
}

afterEach(() => {
  _resetPinnedDispatcherForTests();
});

describe("pinned dispatcher timers", () => {
  it.each([
    ["public", getPinnedPublicDispatcher],
    ["public keep-alive", getPinnedPublicKeepAliveDispatcher],
    ["operator-approved", getPinnedOperatorApprovedDispatcher],
  ])("the %s dispatcher arms no header or body timer of its own", (_, get) => {
    const options = agentOptions(get());
    expect(options.headersTimeout).toBe(0);
    expect(options.bodyTimeout).toBe(0);
  });
});
