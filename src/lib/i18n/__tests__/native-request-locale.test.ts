/**
 * #176 — a native app request is worded in the language the app runs in.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { nativeRequestLocale } from "../server-locale";

function req(acceptLanguage?: string) {
  return {
    headers: new Headers(
      acceptLanguage ? { "accept-language": acceptLanguage } : {},
    ),
  };
}

describe("nativeRequestLocale", () => {
  it("takes the app's language from Accept-Language on a Bearer request", () => {
    expect(nativeRequestLocale("bearer", req("en-US;q=1"))).toBe("en");
    expect(nativeRequestLocale("bearer", req("nl-BE, de;q=0.5"))).toBe("nl");
    expect(nativeRequestLocale("bearer", req("pt-BR"))).toBe("pt-BR");
  });

  it("leaves the stored language in charge when the header names none we ship", () => {
    expect(nativeRequestLocale("bearer", req())).toBeNull();
    expect(nativeRequestLocale("bearer", req("ja-JP"))).toBeNull();
  });

  it("never applies to a browser, whose cookie already carries its choice", () => {
    expect(nativeRequestLocale("cookie", req("en-US"))).toBeNull();
  });
});
