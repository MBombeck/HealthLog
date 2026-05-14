import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.25 W8b — `/admin/login-overview` no longer renders a Collapse
 * / Expand toggle. The toggle was a leftover from the v1.4 shared
 * admin page where 13 sections lived on one route; collapsing the
 * only card on the dedicated login-overview route hid the entire
 * surface. Visiting the page is itself the opt-in.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/login-overview",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      entries: [],
      meta: { total: 0, limit: 50, offset: 0, page: 1, perPage: 50 },
    },
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
      role: "ADMIN",
      timezone: "Europe/Berlin",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { LoginOverviewSection } from "../login-overview-section";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <LoginOverviewSection />
    </I18nProvider>,
  );
}

describe("LoginOverviewSection — no collapse button", () => {
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
    // The toggle previously surfaced as <button aria-expanded={…}>
    // immediately after the ScrollText icon + title pair. Radix
    // Select triggers below carry `aria-expanded` legitimately, so
    // we scope the assertion to the first 800 chars of the markup
    // (the heading slice) instead of the entire SSR output.
    const heading = html.slice(0, 800);
    expect(heading).not.toMatch(/aria-expanded=/);
  });

  it("paints the section body unconditionally (no `expanded` gate)", () => {
    // The filter pills used to live inside an `{expanded && (…)}`
    // wrapper. With the toggle gone the pills must always be in the
    // SSR output.
    const html = render("en");
    expect(html).toContain("All auth events");
    expect(html).toContain("Failed only");
  });
});
