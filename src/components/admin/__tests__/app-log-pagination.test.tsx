import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * `/admin/app-logs` pages the buffered events fifty at a time, like the
 * login overview, instead of painting up to ~500 rows in one table.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/app-logs",
}));

const events = Array.from({ length: 120 }, (_, i) => ({
  request_id: `req-${i}`,
  trace_id: `trace${String(i).padStart(11, "0")}`,
  level: "info" as const,
  timestamp: "2026-05-10T09:00:00Z",
  duration_ms: 12,
  action: { name: `event.number.${i}` },
  kind: "request",
}));

let served = events;

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { events: served, meta: { total: served.length, bufferMax: 500 } },
    isLoading: false,
    refetch: vi.fn(),
    isFetching: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  APP_LOG_PAGE_SIZE,
  AppLogPreviewSection,
} from "../app-log-preview-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AppLogPreviewSection />
    </I18nProvider>,
  );
}

describe("AppLogPreviewSection — pagination", () => {
  it("paints one page of fifty rows and a pager", () => {
    served = events;
    const html = render();
    expect(APP_LOG_PAGE_SIZE).toBe(50);
    expect(html.match(/<tr /g)?.length).toBe(APP_LOG_PAGE_SIZE + 1);
    expect(html).toContain(">event.number.0<");
    expect(html).not.toContain(">event.number.50<");
    expect(html).toContain('data-testid="app-log-pagination"');
    expect(html).toContain("Page 1 of 3");
  });

  it("shows no pager when everything fits on one page", () => {
    served = events.slice(0, 10);
    expect(render()).not.toContain('data-testid="app-log-pagination"');
  });
});
