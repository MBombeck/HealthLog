/**
 * Which tab a link to `/care` opens.
 *
 * Visits are the page's second tab. `?visit=<id>` opens one, `?view=visits`
 * the list, and the bare path keeps opening the checkups, which is what the
 * nav entry and the checkup surfaces mean by it.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/care",
  useSearchParams: () => search,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({}),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("@/hooks/use-pull-to-refresh", () => ({
  usePullToRefresh: () => ({}),
}));
vi.mock("@/components/ui/pull-to-refresh-indicator", () => ({
  PullToRefreshIndicator: () => null,
}));
vi.mock("@/components/measurement-reminders/vorsorge-section", () => ({
  VorsorgeSection: () => <div data-section="vorsorge" />,
}));
vi.mock("@/components/encounters/visits-section", () => ({
  VisitsSection: () => <div data-section="visits" />,
}));
vi.mock("@/components/encounters/procedures-section", () => ({
  ProceduresSection: () => <div data-section="procedures" />,
}));
vi.mock("@/components/body-sites/body-sites-section", () => ({
  BodySitesSection: () => <div data-section="body-sites" />,
}));

import { I18nProvider } from "@/lib/i18n/context";
import CarePageClient from "../page-client";

function openTab(query: string): string | null {
  search = new URLSearchParams(query);
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <CarePageClient />
    </I18nProvider>,
  );
  return html.match(/data-section="([^"]+)"/)?.[1] ?? null;
}

describe("/care — the tab a link opens", () => {
  it("opens the checkups on the bare path", () => {
    expect(openTab("")).toBe("vorsorge");
  });

  it("opens the visits for a link to one visit", () => {
    expect(openTab("visit=v1")).toBe("visits");
  });

  it("opens the tab `view` names", () => {
    expect(openTab("view=visits")).toBe("visits");
    expect(openTab("view=procedures")).toBe("procedures");
  });

  it("ignores a `view` it does not know", () => {
    expect(openTab("view=elsewhere")).toBe("vorsorge");
  });
});
