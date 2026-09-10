/**
 * End-to-end Nightscout transport regression.
 *
 * The ordinary client suite mocks SafeFetch and therefore cannot prove that
 * an operator-approved private origin reaches the pinned Undici connector.
 * This test keeps the Nightscout client, SafeFetch, dispatcher, socket, and
 * HTTP server real. Only DNS is deterministic: the approved test hostname is
 * resolved to the loopback server from inside the connector. Loopback is a
 * grantable answer under the operator-approved policy (a host-networking
 * deployment lists it), so the floor runs for real here.
 */
import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { _resetPinnedDispatcherForTests } from "@/lib/safe-fetch-dispatcher";

import { fetchSgvEntries } from "../client";

const ORIGINAL_PRIVATE_ORIGINS = process.env.NIGHTSCOUT_PRIVATE_ORIGINS;

let server: http.Server;
let port: number;
let requestCount = 0;

function pinTestHostnameToLoopback(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(dns, "lookup").mockImplementation(((
    _hostname: string,
    _opts: dns.LookupAllOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      addresses: dns.LookupAddress[],
    ) => void,
  ) => {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  }) as unknown as typeof dns.lookup);
}

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        {
          _id: "private-cgm-reading",
          type: "sgv",
          sgv: 109,
          date: 1_718_000_000_000,
        },
      ]),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  _resetPinnedDispatcherForTests();
  vi.restoreAllMocks();
  requestCount = 0;
  if (ORIGINAL_PRIVATE_ORIGINS === undefined) {
    delete process.env.NIGHTSCOUT_PRIVATE_ORIGINS;
  } else {
    process.env.NIGHTSCOUT_PRIVATE_ORIGINS = ORIGINAL_PRIVATE_ORIGINS;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Nightscout exact private-origin connect-time pin", () => {
  it("reaches the real server only through connector-time pinned DNS", async () => {
    const origin = `http://nightscout-private.test:${port}`;
    process.env.NIGHTSCOUT_PRIVATE_ORIGINS = origin;
    const lookup = pinTestHostnameToLoopback();

    await expect(
      fetchSgvEntries({
        baseUrl: origin,
        token: "",
        count: 1,
        allowPrivateHost: false,
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual([
      {
        id: "private-cgm-reading",
        sgv: 109,
        date: 1_718_000_000_000,
      },
    ]);

    expect(lookup).toHaveBeenCalled();
    expect(lookup.mock.calls[0]?.[0]).toBe("nightscout-private.test");
    expect(requestCount).toBe(1);
  });

  it("denies a sibling port before DNS or a socket can be reached", async () => {
    process.env.NIGHTSCOUT_PRIVATE_ORIGINS = `http://nightscout-private.test:${port}`;
    const lookup = pinTestHostnameToLoopback();

    await expect(
      fetchSgvEntries({
        baseUrl: `http://nightscout-private.test:${port + 1}`,
        token: "",
        count: 1,
        allowPrivateHost: true,
      }),
    ).rejects.toMatchObject({
      reasonCode: "private_origin_not_approved",
    });

    expect(lookup).not.toHaveBeenCalled();
    expect(requestCount).toBe(0);
  });

  it("does not let the legacy request boolean create a private trust grant", async () => {
    delete process.env.NIGHTSCOUT_PRIVATE_ORIGINS;
    const lookup = pinTestHostnameToLoopback();

    await expect(
      fetchSgvEntries({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "",
        count: 1,
        allowPrivateHost: true,
      }),
    ).rejects.toMatchObject({
      reasonCode: "private_origin_not_approved",
    });

    expect(lookup).not.toHaveBeenCalled();
    expect(requestCount).toBe(0);
  });
});
