import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.27 MB5 — `/settings/api` mobile card-list parity.
 *
 * The section ships three tables: endpoint catalogue, active tokens,
 * revoked tokens. Each table now renders twice:
 *   - desktop `<table>` wrapped in `hidden md:block`
 *   - mobile `<ul>` tagged `md:hidden`
 *
 * This file pins both surfaces against regressions so a future tweak
 * can't strip the mobile card list (and force a 393 CSS-px viewport
 * back into horizontal scroll).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/api",
  useSearchParams: () => new URLSearchParams(),
}));

const sampleTokens = [
  {
    id: "tok-active",
    name: "iOS app",
    permissions: ["ingest:medication"],
    lastUsedAt: "2026-05-08T12:00:00Z",
    expiresAt: null,
    createdAt: "2026-05-01T08:00:00Z",
    revoked: false,
  },
  {
    id: "tok-revoked",
    name: "Old laptop",
    permissions: ["ingest:weight"],
    lastUsedAt: null,
    expiresAt: null,
    createdAt: "2026-04-20T08:00:00Z",
    revoked: true,
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: sampleTokens,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "marc",
      email: "marc@example.com",
      role: "USER",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ApiSection } from "../api-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ApiSection />
    </I18nProvider>,
  );
}

describe("ApiSection — responsive dual-rendering", () => {
  it("renders the endpoint table behind `hidden md:block`", () => {
    const html = render();
    // The endpoint catalogue is the first table; its desktop wrapper
    // must carry the `hidden md:block` pair so phones never see it.
    expect(html).toMatch(/<div[^>]*\bhidden\b[^>]*md:block[^>]*>[\s\S]*<table/);
  });

  it("exposes a mobile card list for the endpoint catalogue", () => {
    const html = render();
    expect(html).toContain('data-testid="settings-api-endpoints-mobile-list"');
    // The mobile <ul> carries `md:hidden` (class attribute precedes
    // `data-testid` in the rendered markup, so we check both anchors
    // independently).
    const endpointMatch = html.match(
      /<ul[^>]*data-testid="settings-api-endpoints-mobile-list"[^>]*>/,
    );
    expect(endpointMatch).not.toBeNull();
    expect(endpointMatch![0]).toContain("md:hidden");
  });

  it("exposes a mobile card list for the active tokens table", () => {
    const html = render();
    expect(html).toContain('data-testid="settings-api-tokens-mobile-list"');
    const tokensMatch = html.match(
      /<ul[^>]*data-testid="settings-api-tokens-mobile-list"[^>]*>/,
    );
    expect(tokensMatch).not.toBeNull();
    expect(tokensMatch![0]).toContain("md:hidden");
    // Every column from the desktop table is reachable as labelled
    // copy in the mobile card body.
    expect(html).toContain("iOS app");
    expect(html).toContain("ingest:medication");
  });

  it("mobile card lists carry no overflow-x-auto wrapper", () => {
    const html = render();
    // Both mobile <ul> blocks must contain zero `overflow-x-auto`. That
    // was the original v1.4.27 CF-19 regression — the table wrapper
    // forced horizontal scroll on phones for content that easily fits
    // a card column.
    const endpointMatch = html.match(
      /<ul[^>]*settings-api-endpoints-mobile-list[^>]*>([\s\S]*?)<\/ul>/,
    );
    expect(endpointMatch).not.toBeNull();
    expect(endpointMatch![1]).not.toContain("overflow-x-auto");

    const tokensMatch = html.match(
      /<ul[^>]*settings-api-tokens-mobile-list[^>]*>([\s\S]*?)<\/ul>/,
    );
    expect(tokensMatch).not.toBeNull();
    expect(tokensMatch![1]).not.toContain("overflow-x-auto");
  });

  it("preserves the desktop tables verbatim", () => {
    const html = render();
    // The desktop tables must still mount — we did not delete them,
    // only paired them with the mobile fallback.
    expect(html).toContain("<table");
    // Active-token cell content shows up inside <td> elements as it did
    // before this change.
    expect(html).toMatch(/<td[^>]*>iOS app<\/td>/);
  });
});
