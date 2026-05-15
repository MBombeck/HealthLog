import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.27 MB5 — `/admin/login-overview` pagination + summary lifted
 * out of the `overflow-x-auto` table wrapper.
 *
 * The audit table can be wider than the viewport on phones, so it
 * stays in an `overflow-x-auto` container that pans horizontally on
 * touch. Before this fix the prev/next controls lived *inside* that
 * same wrapper, meaning admins on narrow viewports had to scroll the
 * table back to its starting offset before they could reach the
 * pagination controls. The summary "showing X of Y" line was hidden
 * the same way. The fix moves both into a sibling block under the
 * scroll container.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/login-overview",
}));

const sampleEntries = [
  {
    id: "ev-1",
    user: { id: "u1", username: "marc" },
    action: "auth.login.success",
    ipAddress: "203.0.113.10",
    location: "Berlin, DE",
    carrier: null,
    createdAt: "2026-05-10T09:00:00Z",
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      entries: sampleEntries,
      meta: { total: 23, limit: 50, offset: 0, page: 1, perPage: 50 },
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

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <LoginOverviewSection />
    </I18nProvider>,
  );
}

describe("LoginOverviewSection — pagination lives outside the scroll wrapper", () => {
  it("renders the pagination row with the stable test id", () => {
    const html = render();
    expect(html).toContain('data-testid="login-overview-pagination"');
  });

  it("places the pagination row outside any `overflow-x-auto` container", () => {
    const html = render();
    // Capture the pagination block and assert that the rendered
    // markup leading up to its opening tag closes the scroll
    // container first. The simplest invariant: there is no
    // `<div class="overflow-x-auto">` ancestor that is still open
    // when the pagination div opens. We approximate this by finding
    // the last `<div class="overflow-x-auto"` before the pagination
    // div and confirming the inner content closes (matching `</div>`)
    // before the pagination div opens.
    const paginationIdx = html.indexOf(
      'data-testid="login-overview-pagination"',
    );
    expect(paginationIdx).toBeGreaterThan(-1);
    const before = html.slice(0, paginationIdx);
    const lastScrollOpen = before.lastIndexOf('class="overflow-x-auto"');
    expect(lastScrollOpen).toBeGreaterThan(-1);
    // Between the scroll-wrapper opening and the pagination opening
    // there must be at least one `</div>` closing the wrapper.
    const tail = before.slice(lastScrollOpen);
    expect(tail).toContain("</div>");
  });

  it("does not nest the prev/next buttons inside the scroll wrapper", () => {
    const html = render();
    // Pin the entire scroll wrapper and confirm the prev/next button
    // labels are not within it. We slice the markup between the
    // wrapper's opening tag and its first balanced closing tag at the
    // same depth — naively by grabbing up to `</table></div>`, which
    // matches the structure produced by the current implementation.
    const wrapper = html.match(
      /<div class="overflow-x-auto"[^>]*>[\s\S]*?<\/table><\/div>/,
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper![0]).not.toContain("admin.section.auditLog.next");
    // The English labels also must not appear inside the wrapper.
    expect(wrapper![0]).not.toMatch(/>\s*Next\s*</);
    expect(wrapper![0]).not.toMatch(/>\s*Previous\s*</);
  });
});
