import { describe, it, expect } from "vitest";
import {
  classifyClient,
  resolveTokenPolicy,
  shouldIssueBearerToken,
  isCookielessNativeCaller,
} from "../native-client";

function h(pairs: Record<string, string>): Headers {
  return new Headers(pairs);
}

describe("native-client classification", () => {
  it.each([
    ["browser Chrome", "Mozilla/5.0 (Macintosh) Chrome/142", "web"],
    [
      "browser Safari",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605",
      "web",
    ],
    ["HealthLog-iOS", "HealthLog-iOS/1.4.0", "native"],
    ["HealthLog-iPad", "HealthLog-iPad/1.4.0", "native"],
    ["n8n", "n8n/1.62.0", "native"],
    ["Health-Connect", "Health-Connect/2025.1", "native"],
    ["unknown UA", "curl/8.5", "native"],
    ["empty UA", "", "native"],
  ] as const)("%s → %s", (_name, ua, expected) => {
    expect(classifyClient(h({ "user-agent": ua }))).toBe(expected);
  });

  it("X-Client-Type header overrides UA", () => {
    const browserAsNative = h({
      "user-agent": "Mozilla/5.0",
      "x-client-type": "native",
    });
    expect(classifyClient(browserAsNative)).toBe("native");

    const iosAsWeb = h({
      "user-agent": "HealthLog-iOS/1.0",
      "x-client-type": "web",
    });
    expect(classifyClient(iosAsWeb)).toBe("web");
  });
});

describe("resolveTokenPolicy", () => {
  it("web → 90d access, no refresh", () => {
    const p = resolveTokenPolicy(h({ "user-agent": "Mozilla/5.0" }));
    expect(p).toEqual({
      policy: "web",
      accessTokenDays: 90,
      refreshTokenDays: null,
      tokenLabel: "web",
    });
  });

  it("native → 1d access + 60d refresh", () => {
    const p = resolveTokenPolicy(h({ "user-agent": "HealthLog-iOS/1.4" }));
    expect(p).toEqual({
      policy: "native",
      accessTokenDays: 1,
      refreshTokenDays: 60,
      tokenLabel: "native",
    });
  });
});

describe("shouldIssueBearerToken", () => {
  it("emits Bearer for native UAs and X-Client-Type:native", () => {
    expect(shouldIssueBearerToken(h({ "user-agent": "HealthLog-iOS/1" }))).toBe(
      true,
    );
    expect(shouldIssueBearerToken(h({ "user-agent": "n8n/1" }))).toBe(true);
    expect(
      shouldIssueBearerToken(
        h({ "x-client-type": "native", "user-agent": "Mozilla/5.0" }),
      ),
    ).toBe(true);
  });
  it("does NOT emit Bearer for plain browser sessions", () => {
    expect(
      shouldIssueBearerToken(h({ "user-agent": "Mozilla/5.0 Safari" })),
    ).toBe(false);
    expect(shouldIssueBearerToken(h({}))).toBe(false);
  });
});

describe("isCookielessNativeCaller (M-3 refresh-token issuance gate)", () => {
  it("true for a genuine native caller (native UA, no cookie)", () => {
    expect(
      isCookielessNativeCaller(h({ "user-agent": "HealthLog-iOS/1.4" })),
    ).toBe(true);
    expect(isCookielessNativeCaller(h({ "x-client-type": "native" }))).toBe(
      true,
    );
    // Blank UA classifies native and carries no cookie.
    expect(isCookielessNativeCaller(h({}))).toBe(true);
  });

  it("false for a plain web browser (not native)", () => {
    expect(
      isCookielessNativeCaller(h({ "user-agent": "Mozilla/5.0 Safari" })),
    ).toBe(false);
  });

  it("false for a browser spoofing X-Client-Type:native via Mozilla UA", () => {
    // classifyClient honours the header (native), but the Mozilla UA is the
    // browser tell that suppresses refresh-token issuance.
    expect(
      isCookielessNativeCaller(
        h({ "x-client-type": "native", "user-agent": "Mozilla/5.0 Chrome" }),
      ),
    ).toBe(false);
  });

  it("false when an inbound session cookie is present (browser round-trip)", () => {
    expect(
      isCookielessNativeCaller(
        h({
          "x-client-type": "native",
          cookie: "foo=bar; healthlog_session=abc123; baz=qux",
        }),
      ),
    ).toBe(false);
  });

  it("false when the session cookie arrives under its __Host- name", () => {
    expect(
      isCookielessNativeCaller(
        h({
          "x-client-type": "native",
          cookie: "foo=bar; __Host-healthlog_session=abc123",
        }),
      ),
    ).toBe(false);
  });

  it("true for a native caller whose cookie header lacks the session cookie", () => {
    expect(
      isCookielessNativeCaller(
        h({
          "x-client-type": "native",
          cookie: "other=1; hl_onboarding=pending",
        }),
      ),
    ).toBe(true);
  });
});
