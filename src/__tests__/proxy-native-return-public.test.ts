import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The native https return page (`/auth/native-return`). A sign-in in the app
 * may finish here with a one-time handoff code or second-factor ticket in the
 * query. The app normally intercepts the address before it loads; a browser
 * without the app shows a short page. Either way the address carries a
 * one-time credential, so the hop is public (no session to bounce to), never
 * cached, never indexed and never leaked as a `Referer`.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";
import { NATIVE_OIDC_RETURN_PATH } from "@/lib/auth/native-return";
import { readSource } from "./helpers/source-files";

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

const WITH_CODE = `${NATIVE_OIDC_RETURN_PATH}?code=hlh_${"a".repeat(43)}`;

describe("proxy.ts — the native https return page", () => {
  it("does not bounce an anonymous visitor to the sign-in page", () => {
    const res = proxy(request(WITH_CODE));
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not bounce a pending-onboarding session either", () => {
    const res = proxy(
      request(WITH_CODE, "healthlog_session=sess-1; hl_onboarding=pending"),
    );
    expect(res.headers.get("location")).toBeNull();
  });

  it("is never cached, indexed, or sent on as a Referer", () => {
    const res = proxy(request(WITH_CODE));
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("names no third-party origin in its content policy", () => {
    const res = proxy(request(WITH_CODE));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    // Script, style, image and connect sources stay on the instance itself.
    for (const directive of ["script-src", "connect-src", "img-src"]) {
      const value =
        csp
          .split(";")
          .map((d) => d.trim())
          .find((d) => d.startsWith(`${directive} `)) ?? "";
      expect(value, directive).not.toMatch(/https?:\/\//);
    }
  });
});

describe("the native https return page itself", () => {
  const page = readSource(
    "src/app/auth/native-return/page.tsx",
    "NativeReturnNotice",
  );
  const notice = readSource(
    "src/components/auth/native-return-notice.tsx",
    "replaceState",
  );

  it("never reads its query, so the code is rendered into nothing", () => {
    for (const src of [page, notice]) {
      expect(src).not.toMatch(/searchParams|useSearchParams/);
      expect(src).not.toMatch(/location\.(search|href)/);
    }
  });

  it("scrubs the query from the address on mount", () => {
    expect(notice).toMatch(
      /history\.replaceState\(null, "", window\.location\.pathname\)/,
    );
  });

  it("carries no outbound link a Referer could ride", () => {
    for (const src of [page, notice]) {
      expect(src).not.toMatch(/<a\s|<Link\s|href=/);
    }
  });
});
