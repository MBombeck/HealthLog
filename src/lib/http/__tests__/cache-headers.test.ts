import { describe, it, expect } from "vitest";
import {
  NO_STORE_BUT_BFCACHE,
  SHORT_LIVED_PUBLIC,
  applyAuthedHeaders,
} from "../cache-headers";

describe("cache-headers presets", () => {
  it("NO_STORE_BUT_BFCACHE is bfcache-eligible (no `no-store` token)", () => {
    expect(NO_STORE_BUT_BFCACHE).toBe("private, max-age=0, must-revalidate");
    expect(NO_STORE_BUT_BFCACHE).not.toMatch(/no-store/);
    // Must keep proxies out of the loop for authed content.
    expect(NO_STORE_BUT_BFCACHE).toMatch(/private/);
    // Force revalidation on every navigation so stale state never sticks.
    expect(NO_STORE_BUT_BFCACHE).toMatch(/max-age=0/);
    expect(NO_STORE_BUT_BFCACHE).toMatch(/must-revalidate/);
  });

  it("SHORT_LIVED_PUBLIC carries a one-hour public TTL", () => {
    expect(SHORT_LIVED_PUBLIC).toBe("public, max-age=3600");
  });
});

describe("applyAuthedHeaders", () => {
  it("stamps NO_STORE_BUT_BFCACHE onto a fresh Response", () => {
    const res = new Response("payload", { status: 200 });
    const out = applyAuthedHeaders(res);
    expect(out.headers.get("Cache-Control")).toBe(NO_STORE_BUT_BFCACHE);
  });

  it("overwrites any pre-existing Cache-Control directive", () => {
    const res = new Response("payload", {
      status: 200,
      headers: { "Cache-Control": "no-store, must-revalidate" },
    });
    applyAuthedHeaders(res);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE_BUT_BFCACHE);
  });

  it("returns the same response for chaining", () => {
    const res = new Response("payload");
    const returned = applyAuthedHeaders(res);
    expect(returned).toBe(res);
  });
});
