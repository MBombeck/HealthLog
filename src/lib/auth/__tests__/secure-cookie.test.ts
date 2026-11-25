import { describe, it, expect, afterEach, vi } from "vitest";

import { detectInsecureCookieTransport } from "../cookie-transport-warning";
import { shouldEmitSecureCookie } from "../secure-cookie";

function req(headers: Record<string, string>, url = "http://10.0.0.5:3000/x") {
  return { headers: new Headers(headers), url };
}

describe("shouldEmitSecureCookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits Secure under NODE_ENV=production when no override is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    expect(shouldEmitSecureCookie()).toBe(true);
  });

  it("omits Secure under NODE_ENV=development when no override is set", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    expect(shouldEmitSecureCookie()).toBe(false);
  });

  it("omits Secure when SESSION_COOKIE_SECURE=false even under NODE_ENV=production (LAN / VPN self-host opt-out)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");
    expect(shouldEmitSecureCookie()).toBe(false);
  });

  it("emits Secure when SESSION_COOKIE_SECURE=true even under NODE_ENV=development (dev box behind HTTPS)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");
    expect(shouldEmitSecureCookie()).toBe(true);
  });

  it("trims whitespace and accepts case-insensitive `False` / `TRUE`", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "  False  ");
    expect(shouldEmitSecureCookie()).toBe(false);
    vi.stubEnv("SESSION_COOKIE_SECURE", "TRUE");
    expect(shouldEmitSecureCookie()).toBe(true);
  });

  it("falls back to the NODE_ENV default for unrecognised override values", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "yes");
    expect(shouldEmitSecureCookie()).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    expect(shouldEmitSecureCookie()).toBe(false);
  });
});

describe("detectInsecureCookieTransport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when the Secure flag is off (SESSION_COOKIE_SECURE=false)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");
    expect(detectInsecureCookieTransport(req({}))).toBeNull();
  });

  it("warns when a Secure cookie will be set on a plain-HTTP request (no proxy)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    const msg = detectInsecureCookieTransport(req({}));
    expect(msg).toContain("SESSION_COOKIE_SECURE=false");
  });

  it("returns null behind a TLS proxy that forwards X-Forwarded-Proto: https", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    expect(
      detectInsecureCookieTransport(req({ "x-forwarded-proto": "https" })),
    ).toBeNull();
  });

  it("reads the left-most entry of a comma-separated proto chain", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    expect(
      detectInsecureCookieTransport(
        req({ "x-forwarded-proto": "https, http" }),
      ),
    ).toBeNull();
  });

  it("warns when the proxy forwards X-Forwarded-Proto: http explicitly", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    expect(
      detectInsecureCookieTransport(req({ "x-forwarded-proto": "http" })),
    ).not.toBeNull();
  });

  it("returns null when the request URL is already https", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    expect(
      detectInsecureCookieTransport(req({}, "https://healthlog.example.com/x")),
    ).toBeNull();
  });
});
