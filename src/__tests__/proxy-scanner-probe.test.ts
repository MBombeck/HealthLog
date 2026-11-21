/**
 * Scanner probes are answered by the proxy with a few bytes, before Next
 * renders the root layout into a full not-found page for each of them.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/process-type", () => ({ shouldRunWeb: () => true }));

import { isScannerProbe, proxy } from "../proxy";

describe("scanner probes", () => {
  it.each([
    "/.env",
    "/.git/config",
    "/wp-login.php",
    "/wp-admin/install.php",
    "/xmlrpc.php",
    "/api/.env",
    "/backup.sql",
    "/cgi-bin/luci",
  ])("refuses %s", (path) => {
    expect(isScannerProbe(path)).toBe(true);
  });

  it.each([
    "/",
    "/.well-known/apple-app-site-association",
    "/.well-known",
    "/api/auth/me",
    "/insights/weight",
    "/i18n/de.js",
    "/sw.js",
    "/manifest.json",
    "/settings/notifications",
  ])("passes %s", (path) => {
    expect(isScannerProbe(path)).toBe(false);
  });

  it("answers a small plain 404 with the baseline headers", async () => {
    const res = proxy(new NextRequest("http://localhost/wp-login.php"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await res.text()).length).toBeLessThan(20);
  });
});
