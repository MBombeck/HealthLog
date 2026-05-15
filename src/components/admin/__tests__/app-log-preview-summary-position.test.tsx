import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.27 MB5 — `/admin/app-logs` summary line lifted out of the
 * `overflow-x-auto` table wrapper so admins on narrow viewports can
 * still see "showing X of Y events" without first scrolling the table
 * back to its starting offset. The refresh control already lives in
 * the section header.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/app-logs",
}));

const sampleEvents = [
  {
    request_id: "req-1",
    trace_id: "abcdef1234567890",
    level: "info" as const,
    timestamp: "2026-05-10T09:00:00Z",
    duration_ms: 12,
    action: { name: "auth.login.success" },
    kind: "request",
    http: { method: "POST", path: "/api/auth/login" },
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      events: sampleEvents,
      meta: { total: 1, bufferMax: 500 },
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isFetching: false,
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
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AppLogPreviewSection } from "../app-log-preview-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AppLogPreviewSection />
    </I18nProvider>,
  );
}

describe("AppLogPreviewSection — summary lives outside the scroll wrapper", () => {
  it("renders the summary row with the stable test id", () => {
    const html = render();
    expect(html).toContain('data-testid="app-log-preview-summary"');
  });

  it("places the summary row outside any `overflow-x-auto` container", () => {
    const html = render();
    const summaryIdx = html.indexOf('data-testid="app-log-preview-summary"');
    expect(summaryIdx).toBeGreaterThan(-1);
    const before = html.slice(0, summaryIdx);
    const lastScrollOpen = before.lastIndexOf('class="overflow-x-auto"');
    expect(lastScrollOpen).toBeGreaterThan(-1);
    const tail = before.slice(lastScrollOpen);
    expect(tail).toContain("</div>");
  });

  it("does not nest the summary copy inside the scroll wrapper", () => {
    const html = render();
    const wrapper = html.match(
      /<div class="overflow-x-auto"[^>]*>[\s\S]*?<\/table><\/div>/,
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper![0]).not.toContain("app-log-preview-summary");
  });
});
