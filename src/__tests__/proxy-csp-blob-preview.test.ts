import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Refs #787 — the record fence made every vault preview load through
 * `useFencedObjectUrl`, i.e. `blob:` URLs. The app CSP had no `frame-src`, so
 * `default-src 'self'` blocked the PDF preview iframe loudly, and
 * `img-src 'self' data:` degraded every blob thumbnail to an icon silently.
 *
 * These tests pin the fix exactly:
 *   - `frame-src` exists and admits precisely 'self' and blob: — nothing else.
 *   - `img-src` admits blob: alongside 'self' and data:.
 *   - The boundaries that make blob: safe stay untouched: `object-src 'none'`,
 *     `frame-ancestors 'self'`, `default-src 'self'`, nonce-bound script-src.
 *   - The vault SERVE route keeps its own stricter document CSP unchanged.
 *
 * Security rationale (mirrors the comment in proxy.ts): a `blob:` URL can only
 * be minted by same-origin script, and script execution stays nonce-bound, so
 * admitting blob: admits exactly the app's own decrypted documents.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

function setNodeEnv(value: "development" | "production") {
  vi.stubEnv("NODE_ENV", value);
}

beforeEach(() => {
  setNodeEnv("production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { cookie: "healthlog_session=sess-1" },
  });
}

/** Parse one directive's source list out of a CSP header string. */
function directive(csp: string, name: string): string[] | null {
  const match = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `) || part === name);
  if (!match) return null;
  return match.split(/\s+/).slice(1);
}

describe("proxy.ts blob preview CSP (#787)", () => {
  it("production frame-src admits exactly 'self' and blob:", () => {
    const res = proxy(makeRequest("/documents"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(directive(csp, "frame-src")).toEqual(["'self'", "blob:"]);
  });

  it("production img-src admits blob: alongside 'self' and data:", () => {
    const res = proxy(makeRequest("/documents"));
    const csp = res.headers.get("content-security-policy") ?? "";
    const sources = directive(csp, "img-src");
    expect(sources).toContain("blob:");
    expect(sources).toContain("'self'");
    expect(sources).toContain("data:");
  });

  it("production keeps the boundaries that make blob: safe", () => {
    const res = proxy(makeRequest("/documents"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    // 'self', never 'none': the blob: preview inherits this policy, and
    // WebKit applies the inherited frame-ancestors to the preview's own
    // parent, so 'none' blanks every PDF preview in Safari.
    expect(directive(csp, "frame-ancestors")).toEqual(["'self'"]);
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(csp).toMatch(/script-src 'self' 'nonce-/);
  });

  it("development frame-src admits exactly 'self' and blob:", () => {
    setNodeEnv("development");
    const res = proxy(makeRequest("/documents"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(directive(csp, "frame-src")).toEqual(["'self'", "blob:"]);
  });

  it("development img-src admits blob:", () => {
    setNodeEnv("development");
    const res = proxy(makeRequest("/documents"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(directive(csp, "img-src")).toContain("blob:");
  });

  it("leaves the vault serve route's document CSP untouched (no frame-src, no blob:)", () => {
    const res = proxy(makeRequest("/api/documents/inbound/doc-1/original"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toBe("default-src 'none'; frame-ancestors 'self';");
  });
});
