import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isAllowlistedApiRead,
  isCacheableApiResponse,
} from "@/lib/pwa/sw-cache-policy";

const SW_SOURCE = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");

describe("isAllowlistedApiRead — offline read boundary", () => {
  it("caches the curated safe GET read endpoints", () => {
    expect(isAllowlistedApiRead("/api/dashboard/snapshot")).toBe(true);
    expect(isAllowlistedApiRead("/api/dashboard/widgets")).toBe(true);
    // v1.37.20 — the Today rail's offline read. Watched red before the
    // allowlist entry landed.
    expect(isAllowlistedApiRead("/api/daily/digest")).toBe(true);
    expect(isAllowlistedApiRead("/api/measurements")).toBe(true);
    expect(
      isAllowlistedApiRead("/api/measurements/series-batch?types=WEIGHT"),
    ).toBe(true);
    expect(isAllowlistedApiRead("/api/medications")).toBe(true);
    expect(isAllowlistedApiRead("/api/version")).toBe(true);
  });

  // v1.18.6 — AI/clinical narrative surfaces are never disk-cached. `/api/insights`
  // previously prefix-matched the Coach chat list (`/api/insights/chat`, which
  // returns decrypted conversation content) into the data cache; `/api/analytics`
  // carries clinical aggregates. Both are off the allowlist.
  it("never caches the AI / clinical narrative surfaces", () => {
    expect(isAllowlistedApiRead("/api/insights")).toBe(false);
    expect(isAllowlistedApiRead("/api/insights/chat")).toBe(false);
    expect(isAllowlistedApiRead("/api/insights/generate")).toBe(false);
    expect(isAllowlistedApiRead("/api/analytics")).toBe(false);
    expect(isAllowlistedApiRead("/api/analytics/range")).toBe(false);
  });

  it("never caches auth / session / token / login surfaces", () => {
    expect(isAllowlistedApiRead("/api/auth/me")).toBe(false);
    expect(isAllowlistedApiRead("/api/auth/logout")).toBe(false);
    expect(isAllowlistedApiRead("/api/sessions")).toBe(false);
    expect(isAllowlistedApiRead("/api/tokens")).toBe(false);
    expect(isAllowlistedApiRead("/api/login")).toBe(false);
    expect(isAllowlistedApiRead("/api/webauthn/options")).toBe(false);
  });

  it("refuses an auth/token segment nested under an allowlisted prefix", () => {
    expect(isAllowlistedApiRead("/api/medications/tokens")).toBe(false);
    expect(isAllowlistedApiRead("/api/measurements/auth")).toBe(false);
  });

  it("does not cache endpoints outside the allowlist", () => {
    expect(isAllowlistedApiRead("/api/admin/users")).toBe(false);
    expect(isAllowlistedApiRead("/api/devices")).toBe(false);
    expect(isAllowlistedApiRead("/api/withings/callback")).toBe(false);
  });

  it("never caches the cycle calendar feed or its management routes (#1350)", () => {
    // The feed URL is a credential and its body is a record's cycle dates;
    // neither belongs in a browser's durable storage.
    const feed = `/api/cycle/feed/hlf_${"1f".repeat(24)}.ics`;
    expect(isAllowlistedApiRead(feed)).toBe(false);
    expect(isAllowlistedApiRead("/api/cycle/feed-subscription")).toBe(false);
    expect(SW_SOURCE).not.toContain("/api/cycle");
  });

  it("does not match a prefix that is only a partial path segment", () => {
    // `/api/measurements-export` must NOT match `/api/measurements`.
    expect(isAllowlistedApiRead("/api/measurements-export")).toBe(false);
  });
});

describe("isCacheableApiResponse — body/header refusal", () => {
  it("caches a successful read with a plain body", () => {
    expect(
      isCacheableApiResponse({
        ok: true,
        cacheControl: "private, max-age=0",
        bodyText: JSON.stringify({ data: { weightKg: 80 }, error: null }),
      }),
    ).toBe(true);
  });

  it("refuses non-ok responses", () => {
    expect(isCacheableApiResponse({ ok: false, bodyText: "{}" })).toBe(false);
  });

  it("refuses a no-store response", () => {
    expect(
      isCacheableApiResponse({
        ok: true,
        cacheControl: "no-store",
        bodyText: "{}",
      }),
    ).toBe(false);
  });

  it("refuses secret-shaped bodies (hlk_ / hlr_ / sk-)", () => {
    expect(
      isCacheableApiResponse({
        ok: true,
        bodyText: JSON.stringify({ data: { token: "hlk_abc123def" } }),
      }),
    ).toBe(false);
    expect(
      isCacheableApiResponse({
        ok: true,
        bodyText: JSON.stringify({ data: { refresh: "hlr_xyz789ghi" } }),
      }),
    ).toBe(false);
    expect(
      isCacheableApiResponse({
        ok: true,
        bodyText: JSON.stringify({ data: { key: "sk-livesecret00" } }),
      }),
    ).toBe(false);
  });
});

// v1.18.6.x regression guard. The first v1.18.6 cut cached allowlisted API
// reads with stale-while-revalidate, which served the pre-mutation copy first
// and broke read-after-write (a list fetched straight after a create showed
// the old/empty data). The strategy must be network-first: always fetch fresh
// online, fall back to cache ONLY when the network throws (offline).
describe("public/sw.js — allowlisted API reads are network-first", () => {
  it("routes the allowlisted API branch through a network-first handler", () => {
    expect(SW_SOURCE).toContain("networkFirstApi(request)");
    expect(SW_SOURCE).toContain("async function networkFirstApi(request)");
  });

  it("no longer uses stale-while-revalidate for API reads", () => {
    expect(SW_SOURCE).not.toContain("staleWhileRevalidateApi");
  });

  it("falls back to the cached copy only inside the network-failure catch", () => {
    const handler = SW_SOURCE.slice(
      SW_SOURCE.indexOf("async function networkFirstApi(request)"),
    );
    const tryIdx = handler.indexOf("await fetch(request)");
    const catchIdx = handler.indexOf("} catch {");
    const cacheMatchIdx = handler.indexOf("cache.match(request)");
    // fetch comes first; the cache read lives after the catch boundary.
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    expect(cacheMatchIdx).toBeGreaterThan(catchIdx);
  });
});
