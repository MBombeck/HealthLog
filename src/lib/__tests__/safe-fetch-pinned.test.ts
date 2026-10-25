/**
 * End-to-end regression for the pinned (`requirePublicHost: true`) egress path.
 *
 * This is deliberately NOT a mocked-fetch test. The production bug it guards
 * against is a coupling between the fetch ENGINE and the undici dispatcher:
 *
 *  1. Version skew — handing an `undici@8` `Agent` to Node's built-in global
 *     `fetch` (backed by a different, internal undici copy) throws
 *     `UND_ERR_INVALID_ARG`. A mocked `fetch` would never surface this; only a
 *     real dispatch through the real fetch engine does. The fix routes the
 *     pinned path through undici's OWN `fetch`.
 *  2. Single-address pin — returning only the first resolved address made a
 *     host whose first record is an unreachable IPv6 fail instantly. The fix
 *     hands undici the full vetted set + enables Happy Eyeballs.
 *
 * To exercise the real transport against a localhost-bound server we stub the
 * two IP-classification predicates (so loopback is treated as dialable for the
 * harness) and `dns.lookup` (so the test hostname maps to the test server).
 * The dispatcher, the undici fetch engine, the connect, and the server are all
 * REAL — which is exactly what makes this catch the coupling bug.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import http from "node:http";
import dns from "node:dns";
import type { AddressInfo } from "node:net";

const notificationMocks = vi.hoisted(() => ({
  isPublicIp: vi.fn((_ip: string) => true),
  isPublicUrl: vi.fn((_url: string) => true),
}));

// Treat every address/URL as public so the harness can reach a loopback server
// through the requirePublicHost guard. The transport coupling under test is
// orthogonal to IP classification (covered by safe-fetch-dispatcher.test.ts).
vi.mock("@/lib/validations/notifications", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/validations/notifications")>();
  return {
    ...actual,
    isPublicIp: notificationMocks.isPublicIp,
    isPublicUrl: notificationMocks.isPublicUrl,
  };
});

import { safeFetch, SafeFetchError } from "../safe-fetch";
import { _resetPinnedDispatcherForTests } from "../safe-fetch-dispatcher";

let server: http.Server;
let port: number;
const requestedPaths: string[] = [];

function mockLookupTo(addresses: dns.LookupAddress[]): void {
  vi.spyOn(dns, "lookup").mockImplementation(((
    _hostname: string,
    _opts: dns.LookupAllOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      addrs: dns.LookupAddress[],
    ) => void,
  ) => {
    callback(null, addresses);
  }) as unknown as typeof dns.lookup);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestedPaths.push(req.url ?? "");
    if (req.url === "/redirect-literal") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
      res.end();
      return;
    }
    if (req.url === "/redirect-public") {
      res.writeHead(302, { location: `http://pinned.test:${port}/api` });
      res.end();
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, {
        location: `http://redirect-target.test:${port}/api`,
      });
      res.end();
      return;
    }
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("chunk-1;");
      setTimeout(() => {
        res.write("chunk-2;");
        res.end("chunk-3");
      }, 10);
      return;
    }
    if (req.url === "/hang") {
      // Never respond — drives the timeout path.
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
  notificationMocks.isPublicIp.mockReset();
  notificationMocks.isPublicIp.mockImplementation((_ip: string) => true);
  notificationMocks.isPublicUrl.mockReset();
  notificationMocks.isPublicUrl.mockImplementation((_url: string) => true);
  requestedPaths.length = 0;
  _resetPinnedDispatcherForTests();
});

describe("safeFetch pinned path — real transport", () => {
  it("returns 200 end-to-end through the pinned dispatcher + undici fetch", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);

    const res = await safeFetch(
      `http://pinned.test:${port}/api`,
      {},
      { requirePublicHost: true, timeoutMs: 5000 },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  }, 20_000);

  it("retains fallback connectivity across public native IPv6 and IPv4", async () => {
    // The first record is a genuinely public native IPv6 address, while the
    // harness server is reachable through the IPv4 record behind it. The
    // dispatcher must preserve both vetted families for Happy Eyeballs.
    mockLookupTo([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ]);

    const res = await safeFetch(
      `http://dualstack.test:${port}/api`,
      {},
      { requirePublicHost: true, timeoutMs: 5000 },
    );

    expect(res.status).toBe(200);
  }, 20_000);

  it("re-runs the pinned DNS verdict for a followed redirect destination", async () => {
    const deniedRedirectAddress = "64:ff9b::7f00:1";
    const lookupHosts: string[] = [];
    notificationMocks.isPublicIp.mockImplementation(
      (ip: string) => ip !== deniedRedirectAddress,
    );
    vi.spyOn(dns, "lookup").mockImplementation(((
      hostname: string,
      _opts: dns.LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        addrs: dns.LookupAddress[],
      ) => void,
    ) => {
      lookupHosts.push(hostname);
      callback(
        null,
        hostname === "redirect-target.test"
          ? [{ address: deniedRedirectAddress, family: 6 }]
          : [{ address: "127.0.0.1", family: 4 }],
      );
    }) as unknown as typeof dns.lookup);

    await expect(
      safeFetch(
        `http://pinned.test:${port}/redirect`,
        {},
        {
          requirePublicHost: true,
          followRedirects: true,
          timeoutMs: 5000,
        },
      ),
    ).rejects.toMatchObject({ kind: "private_host" });

    expect(lookupHosts).toContain("pinned.test");
    expect(lookupHosts).toContain("redirect-target.test");
    expect(notificationMocks.isPublicIp).toHaveBeenCalledWith(
      deniedRedirectAddress,
    );
    expect(requestedPaths).toEqual(["/redirect"]);
  }, 20_000);

  it("checks a followed redirect to an IP literal, which the DNS pin never sees", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);
    // The input-time floor, as it really decides for a literal: the harness
    // host passes, the loopback literal the redirect names does not.
    notificationMocks.isPublicUrl.mockImplementation(
      (url: string) => !new URL(url).hostname.startsWith("127."),
    );
    requestedPaths.length = 0;

    await expect(
      safeFetch(
        `http://pinned.test:${port}/redirect-literal`,
        {},
        { requirePublicHost: true, followRedirects: true, timeoutMs: 5000 },
      ),
    ).rejects.toMatchObject({ kind: "private_host" });
    expect(requestedPaths).toEqual(["/redirect-literal"]);
    notificationMocks.isPublicUrl.mockImplementation(() => true);
  }, 20_000);

  it("follows a redirect to a public host, one checked hop at a time", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);
    requestedPaths.length = 0;
    const res = await safeFetch(
      `http://pinned.test:${port}/redirect-public`,
      {},
      { requirePublicHost: true, followRedirects: true, timeoutMs: 5000 },
    );
    expect(res.status).toBe(200);
    expect(requestedPaths).toEqual(["/redirect-public", "/api"]);
  }, 20_000);

  it("streams a chunked response body via getReader() on the pinned path", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);

    const res = await safeFetch(
      `http://pinned.test:${port}/stream`,
      {},
      { requirePublicHost: true, timeoutMs: 5000 },
    );
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    expect(out).toBe("chunk-1;chunk-2;chunk-3");
  }, 20_000);

  it("times out on the pinned path and maps to SafeFetchError kind 'timeout'", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);

    await expect(
      safeFetch(
        `http://pinned.test:${port}/hang`,
        {},
        { requirePublicHost: true, timeoutMs: 200 },
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  }, 20_000);

  it("honours a caller-supplied abort signal on the pinned path", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);

    const controller = new AbortController();
    const pending = safeFetch(
      `http://pinned.test:${port}/hang`,
      { signal: controller.signal },
      { requirePublicHost: true, timeoutMs: 5000 },
    );
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SafeFetchError);
    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
  }, 20_000);
});
