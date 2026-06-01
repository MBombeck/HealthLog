import { describe, it, expect, afterEach, vi } from "vitest";

import { shouldEmitSecureCookie } from "../secure-cookie";

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
