import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetch as undiciFetch } from "undici";
import {
  isOperatorGrantableIp,
  isPublicIp,
} from "@/lib/validations/notifications";
import {
  getPinnedOperatorApprovedDispatcher,
  getPinnedPublicDispatcher,
  _resetPinnedDispatcherForTests,
} from "../safe-fetch-dispatcher";

const EMBEDDED_PRIVATE_DNS_ANSWERS = [
  ["IPv4-compatible loopback", "::7f00:1"],
  ["IPv4-compatible metadata", "::a9fe:a9fe"],
  ["6to4 RFC1918", "2002:a00:1::"],
  ["6to4 metadata", "2002:a9fe:a9fe::"],
  ["NAT64 WKP RFC1918", "64:ff9b::c0a8:101"],
  ["NAT64 WKP metadata", "64:ff9b::a9fe:a9fe"],
  ["RFC8215 local-use RFC1918", "64:ff9b:1:ac10:0:1::"],
  ["RFC8215 local-use metadata", "64:ff9b:1:a9fe:0:a9fe::"],
] as const;

function errorCodes(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const value = error as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown[];
  };
  return [
    ...(typeof value.code === "string" ? [value.code] : []),
    ...errorCodes(value.cause),
    ...(value.errors ?? []).flatMap(errorCodes),
  ];
}

describe("isPublicIp", () => {
  it("accepts a public IPv4 address", () => {
    expect(isPublicIp("203.0.113.5")).toBe(true);
    expect(isPublicIp("8.8.8.8")).toBe(true);
  });

  it("rejects RFC1918 IPv4", () => {
    expect(isPublicIp("10.0.0.1")).toBe(false);
    expect(isPublicIp("192.168.0.1")).toBe(false);
    expect(isPublicIp("172.16.0.1")).toBe(false);
  });

  it("rejects loopback + reserved IPv4", () => {
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("0.0.0.0")).toBe(false);
  });

  it("rejects 169.254/16 cloud-metadata", () => {
    expect(isPublicIp("169.254.169.254")).toBe(false);
  });

  it("rejects CGNAT 100.64/10", () => {
    expect(isPublicIp("100.64.0.1")).toBe(false);
    expect(isPublicIp("100.127.255.255")).toBe(false);
  });

  it("rejects IPv6 loopback + link-local + ULA", () => {
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("fe80::1")).toBe(false);
    expect(isPublicIp("fc00::1")).toBe(false);
    expect(isPublicIp("fd12:3456:789a::1")).toBe(false);
  });

  it("accepts a public IPv6 address", () => {
    expect(isPublicIp("2001:db8::1")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects IPv4-mapped IPv6 that wraps a private IPv4", () => {
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIp("::ffff:10.0.0.1")).toBe(false);
  });

  it("accepts IPv4-mapped IPv6 that wraps a public IPv4", () => {
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
  });

  it("rejects empty input", () => {
    expect(isPublicIp("")).toBe(false);
  });
});

describe("pinnedPublicDispatcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetPinnedDispatcherForTests();
  });

  it("refuses a hostname that resolves to a private IP", async () => {
    // Mock dns.lookup to return 169.254.169.254 (cloud metadata).
    const lookupSpy = vi.spyOn(dns, "lookup");
    lookupSpy.mockImplementation(((
      _hostname: string,
      _opts: dns.LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        addresses: dns.LookupAddress[],
      ) => void,
    ) => {
      callback(null, [{ address: "169.254.169.254", family: 4 }]);
    }) as unknown as typeof dns.lookup);

    const dispatcher = getPinnedPublicDispatcher();
    let caught: unknown;
    try {
      await undiciFetch("https://attacker-controlled.example.test/probe", {
        dispatcher,
      });
    } catch (error) {
      caught = error;
    }

    // A known-denied plain IPv4 answer proves the harness can distinguish
    // policy refusal from a later socket failure.
    expect(caught).toBeDefined();
    expect(errorCodes(caught)).toContain("ENOTFOUND");
  }, 20_000);

  it("forwards a public-resolving hostname to the real connector", async () => {
    // Mock dns.lookup to claim the host resolves to 192.0.2.1 — a
    // documented public range (TEST-NET-1) that is also unroutable.
    // The expected outcome is therefore NOT ENOTFOUND but a connect
    // failure further down the stack (the IP refuses or times out).
    const lookupSpy = vi.spyOn(dns, "lookup");
    lookupSpy.mockImplementation(((
      _hostname: string,
      _opts: dns.LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        addresses: dns.LookupAddress[],
      ) => void,
    ) => {
      callback(null, [{ address: "192.0.2.1", family: 4 }]);
    }) as unknown as typeof dns.lookup);

    const dispatcher = getPinnedPublicDispatcher();
    let caught: unknown;
    try {
      await fetch("https://example.test/probe", {
        signal: AbortSignal.timeout(500),
        dispatcher,
      } as RequestInit & { dispatcher: typeof dispatcher });
    } catch (e) {
      caught = e;
    }

    // The pinned lookup must have ACCEPTED the address (no ENOTFOUND);
    // the connect failure surfaces as a timeout / connect refused.
    expect(caught).toBeDefined();
    const code = (caught as NodeJS.ErrnoException)?.code;
    expect(code === "ENOTFOUND").toBe(false);
  }, 20_000);

  it("filters a mixed result so only the public address is pinned", async () => {
    // Mock dns.lookup to return one private + one public address. The
    // dispatcher must drop the private one and pin to the public one.
    const lookupSpy = vi.spyOn(dns, "lookup");
    lookupSpy.mockImplementation(((
      _hostname: string,
      _opts: dns.LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        addresses: dns.LookupAddress[],
      ) => void,
    ) => {
      callback(null, [
        { address: "10.0.0.5", family: 4 },
        { address: "192.0.2.1", family: 4 },
      ]);
    }) as unknown as typeof dns.lookup);

    const dispatcher = getPinnedPublicDispatcher();
    let caught: unknown;
    try {
      await fetch("https://example.test/probe", {
        signal: AbortSignal.timeout(500),
        dispatcher,
      } as RequestInit & { dispatcher: typeof dispatcher });
    } catch (e) {
      caught = e;
    }

    // Again: the dispatch must NOT short-circuit with ENOTFOUND — the
    // public alternate is what gets dialled.
    const code = (caught as NodeJS.ErrnoException)?.code;
    expect(code === "ENOTFOUND").toBe(false);
  }, 20_000);

  it.each(EMBEDDED_PRIVATE_DNS_ANSWERS)(
    "refuses a hostname whose resolver returns %s before Undici connects",
    async (_label, address) => {
      vi.spyOn(dns, "lookup").mockImplementation(((
        _hostname: string,
        _opts: dns.LookupAllOptions,
        callback: (
          err: NodeJS.ErrnoException | null,
          addresses: dns.LookupAddress[],
        ) => void,
      ) => {
        callback(null, [{ address, family: 6 }]);
      }) as unknown as typeof dns.lookup);

      const dispatcher = getPinnedPublicDispatcher();
      let caught: unknown;
      try {
        await undiciFetch("http://transition-answer.example.test:8089/probe", {
          dispatcher,
          signal: AbortSignal.timeout(750),
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(errorCodes(caught)).toContain("ENOTFOUND");
    },
    5_000,
  );
});

describe("isOperatorGrantableIp", () => {
  it("keeps the private ranges an operator may deliberately list", () => {
    expect(isOperatorGrantableIp("10.0.0.5")).toBe(true);
    expect(isOperatorGrantableIp("172.16.0.9")).toBe(true);
    expect(isOperatorGrantableIp("192.168.1.20")).toBe(true);
    expect(isOperatorGrantableIp("100.64.0.7")).toBe(true);
    expect(isOperatorGrantableIp("fd12:3456:789a::1")).toBe(true);
    expect(isOperatorGrantableIp("::ffff:10.0.0.5")).toBe(true);
  });

  it("keeps public addresses grantable (a listed public origin is harmless)", () => {
    expect(isOperatorGrantableIp("203.0.113.5")).toBe(true);
    expect(isOperatorGrantableIp("2001:db8::1")).toBe(true);
  });

  it.each([
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv4 loopback, high octet", "127.255.0.1"],
    ["IPv4 unspecified", "0.0.0.0"],
    ["IPv4 link-local / metadata", "169.254.169.254"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["6to4 metadata", "2002:a9fe:a9fe::"],
    ["NAT64 loopback", "64:ff9b::7f00:1"],
    ["not an address", "gotify.lan"],
    ["empty", ""],
  ])("never grants %s, listed or not", (_label, ip) => {
    expect(isOperatorGrantableIp(ip)).toBe(false);
  });
});

describe("pinnedOperatorApprovedDispatcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetPinnedDispatcherForTests();
  });

  function resolveTo(addresses: dns.LookupAddress[]): void {
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

  it.each([
    ["loopback", { address: "127.0.0.1", family: 4 }],
    ["link-local / metadata", { address: "169.254.169.254", family: 4 }],
    ["unspecified", { address: "0.0.0.0", family: 4 }],
    ["IPv6 loopback", { address: "::1", family: 6 }],
    ["IPv6 link-local", { address: "fe80::1", family: 6 }],
    ["IPv4-mapped metadata", { address: "::ffff:169.254.169.254", family: 6 }],
  ])(
    "refuses a listed name that resolves to %s even under the approved policy",
    async (_label, answer) => {
      resolveTo([answer]);

      const dispatcher = getPinnedOperatorApprovedDispatcher();
      let caught: unknown;
      try {
        await undiciFetch("http://gotify-listed.example.test:8089/message", {
          dispatcher,
          signal: AbortSignal.timeout(750),
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(errorCodes(caught)).toContain("ENOTFOUND");
    },
    5_000,
  );

  it("forwards an RFC1918 answer to the connector (the grant does its job)", async () => {
    // 10.255.255.1 is private and, on this harness, unroutable: the pinned
    // lookup must ACCEPT it (no ENOTFOUND) and the failure, if any, comes from
    // the socket below.
    resolveTo([{ address: "10.255.255.1", family: 4 }]);

    const dispatcher = getPinnedOperatorApprovedDispatcher();
    let caught: unknown;
    try {
      await undiciFetch("http://gotify-listed.example.test:8089/message", {
        dispatcher,
        signal: AbortSignal.timeout(500),
      });
    } catch (error) {
      caught = error;
    }

    expect(errorCodes(caught)).not.toContain("ENOTFOUND");
  }, 20_000);

  it("drops the loopback answer from a mixed set and dials only the private one", async () => {
    // A real server on loopback proves the point: the listed name resolves to
    // loopback AND to an unroutable private address; the pinned lookup must
    // hand undici only the private survivor, so the loopback server never
    // sees a request and the dial fails at the socket, not at the resolver.
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as AddressInfo).port;
    try {
      resolveTo([
        { address: "127.0.0.1", family: 4 },
        { address: "10.255.255.1", family: 4 },
      ]);

      const dispatcher = getPinnedOperatorApprovedDispatcher();
      let caught: unknown;
      try {
        await undiciFetch(`http://gotify-listed.example.test:${port}/message`, {
          dispatcher,
          signal: AbortSignal.timeout(500),
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(errorCodes(caught)).not.toContain("ENOTFOUND");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
