/**
 * The long-lived pinned dispatcher keeps one connection across sends that
 * are seconds apart; every other destination keeps undici's 4 s idle close.
 *
 * Real transport, real sockets: the server counts the TCP connections it
 * accepts. The push relay sends no `Keep-Alive` hint, so undici used to drop
 * an idle connection after 4 s and every later push paid DNS, TCP and TLS
 * again. The pause below is longer than those 4 s, so the default dispatcher
 * dials twice and the long-lived one once. Without `keepAlive` both arms
 * count two, which is how this test fails when the option stops working.
 *
 * The two IP predicates and `dns.lookup` are stubbed so a loopback server is
 * reachable through `requirePublicHost`, as in `safe-fetch-pinned.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Agent } from "undici";

vi.mock("@/lib/validations/notifications", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/validations/notifications")>();
  return {
    ...actual,
    isPublicIp: () => true,
    isPublicUrl: () => true,
  };
});

import { safeFetch, SafeFetchError } from "../safe-fetch";
import {
  getPinnedPublicDispatcher,
  getPinnedPublicKeepAliveDispatcher,
  KEEP_ALIVE_IDLE_MS,
  _resetPinnedDispatcherForTests,
} from "../safe-fetch-dispatcher";

/** Longer than undici's 4 s default idle close. */
const PAUSE_MS = 5_000;
/**
 * Pushes are separate events, not a pipelined burst. Back to back, undici can
 * dispatch the next request a tick before the previous socket returns to the
 * idle pool and dial a second connection under either dispatcher.
 */
const GAP_MS = 100;

interface CountingServer {
  server: http.Server;
  port: number;
  connections: () => number;
}

async function countingServer(): Promise<CountingServer> {
  let connections = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  // Like the relay's Go server, send no `Keep-Alive: timeout=` hint (Node
  // derives one from this value), and never close an idle socket from the
  // server side, so only the client decides when a connection ends.
  server.keepAliveTimeout = 0;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return {
    server,
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
  };
}

async function sendBurst(
  port: number,
  count: number,
  keepAlive: boolean,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, GAP_MS));
    const res = await safeFetch(
      `http://relay.test:${port}/v1/push`,
      { method: "POST", body: "{}" },
      { requirePublicHost: true, keepAlive, timeoutMs: 2_000 },
    );
    expect(res.status).toBe(200);
    await res.text();
  }
}

let longLived: CountingServer;
let ordinary: CountingServer;

beforeAll(async () => {
  vi.spyOn(dns, "lookup").mockImplementation(((
    _hostname: string,
    _opts: dns.LookupAllOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      addrs: dns.LookupAddress[],
    ) => void,
  ) => {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  }) as unknown as typeof dns.lookup);
  _resetPinnedDispatcherForTests();
  longLived = await countingServer();
  ordinary = await countingServer();
});

afterAll(async () => {
  _resetPinnedDispatcherForTests();
  vi.restoreAllMocks();
  for (const s of [longLived, ordinary]) {
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
});

function agentOptions(agent: Agent): Record<string, unknown> {
  const key = Object.getOwnPropertySymbols(agent).find(
    (s) => s.description === "options",
  );
  expect(key).toBeDefined();
  return (agent as unknown as Record<symbol, Record<string, unknown>>)[key!];
}

describe("safeFetch keepAlive", () => {
  it("reuses one connection across a pause the default dispatcher does not survive", async () => {
    // Both arms run side by side so the pause is paid once.
    await Promise.all([
      sendBurst(longLived.port, 3, true),
      sendBurst(ordinary.port, 3, false),
    ]);
    expect(longLived.connections()).toBe(1);
    expect(ordinary.connections()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

    await Promise.all([
      sendBurst(longLived.port, 2, true),
      sendBurst(ordinary.port, 2, false),
    ]);
    expect(longLived.connections()).toBe(1);
    expect(ordinary.connections()).toBe(2);
  }, 20_000);

  it("gives only the long-lived dispatcher the long idle time", () => {
    const keepAlive = agentOptions(getPinnedPublicKeepAliveDispatcher());
    expect(keepAlive.keepAliveTimeout).toBe(KEEP_ALIVE_IDLE_MS);
    expect(keepAlive.keepAliveMaxTimeout).toBe(KEEP_ALIVE_IDLE_MS);
    // Below the relay's 60 s server idle timeout, so the client closes first.
    expect(KEEP_ALIVE_IDLE_MS).toBeLessThan(60_000);
    expect(agentOptions(getPinnedPublicDispatcher()).keepAliveTimeout).toBe(
      undefined,
    );
  });

  it("refuses keepAlive without the pinned public host", async () => {
    await expect(
      safeFetch(`http://relay.test:${ordinary.port}/`, {}, { keepAlive: true }),
    ).rejects.toBeInstanceOf(SafeFetchError);
  });
});
