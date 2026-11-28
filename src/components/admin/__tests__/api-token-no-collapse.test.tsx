import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.19 — `/admin/api-tokens` no longer renders a Collapse
 * / Expand toggle. The toggle existed as an escape hatch from the
 * v1.4 shared-admin page where 13 sections lived on one route; in
 * v1.5 every section has its own dedicated route, so collapsing the
 * only card on `/admin/api-tokens` hides the entire surface and
 * confused the maintainer more than it helped.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/api-tokens",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [],
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
      username: "testuser",
      email: "user@example.com",
      role: "ADMIN",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ApiTokenOverviewSection } from "../api-token-overview-section";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ApiTokenOverviewSection />
    </I18nProvider>,
  );
}

describe("ApiTokenOverviewSection — no collapse button", () => {
  it("does not render a Collapse / Expand button (English)", () => {
    const html = render("en");
    expect(html).not.toMatch(/\bCollapse\b/);
    expect(html).not.toMatch(/\bExpand\b/);
  });

  it("does not render an Einklappen / Ausklappen button (German)", () => {
    const html = render("de");
    expect(html).not.toMatch(/\bEinklappen\b/);
    expect(html).not.toMatch(/\bAusklappen\b/);
  });

  it("never renders an `aria-expanded` button on the section header", () => {
    const html = render();
    // The toggle previously surfaced as <button aria-expanded={…}>.
    // No button on the section header should carry that attribute now.
    const sectionHeader = html.match(
      /<div\b[^>]*flex[^>]*items-center[^>]*>[\s\S]*?<\/div>/,
    );
    expect(sectionHeader).not.toBeNull();
    expect(sectionHeader![0]).not.toMatch(/aria-expanded=/);
  });
});
