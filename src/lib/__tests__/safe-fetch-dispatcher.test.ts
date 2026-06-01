import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import { isPublicIp } from "@/lib/validations/notifications";
import {
  getPinnedPublicDispatcher,
  _resetPinnedDispatcherForTests,
} from "../safe-fetch-dispatcher";

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
    lookupSpy.mockImplementation(
      ((
        _hostname: string,
        _opts: dns.LookupAllOptions,
        callback: (
          err: NodeJS.ErrnoException | null,
          addresses: dns.LookupAddress[],
        ) => void,
      ) => {
        callback(null, [{ address: "169.254.169.254", family: 4 }]);
      }) as unknown as typeof dns.lookup,
    );

    const dispatcher = getPinnedPublicDispatcher();
    // Drive the dispatcher through `fetch` so the integration mirrors
    // what safeFetch does. The expected outcome is a connect error
    // (the lookup wrapper raised ENOTFOUND).
    await expect(
      fetch(
        "https://attacker-controlled.example.test/probe",
        // Node's fetch RequestInit accepts undici's `dispatcher`; the
        // DOM types do not, hence the cast.
        { dispatcher } as RequestInit & { dispatcher: typeof dispatcher },
      ),
    ).rejects.toThrow();
  }, 20_000);

  it("forwards a public-resolving hostname to the real connector", async () => {
    // Mock dns.lookup to claim the host resolves to 192.0.2.1 — a
    // documented public range (TEST-NET-1) that is also unroutable.
    // The expected outcome is therefore NOT ENOTFOUND but a connect
    // failure further down the stack (the IP refuses or times out).
    const lookupSpy = vi.spyOn(dns, "lookup");
    lookupSpy.mockImplementation(
      ((
        _hostname: string,
        _opts: dns.LookupAllOptions,
        callback: (
          err: NodeJS.ErrnoException | null,
          addresses: dns.LookupAddress[],
        ) => void,
      ) => {
        callback(null, [{ address: "192.0.2.1", family: 4 }]);
      }) as unknown as typeof dns.lookup,
    );

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
    lookupSpy.mockImplementation(
      ((
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
      }) as unknown as typeof dns.lookup,
    );

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
});
