/**
 * v1.18.0 — Settings → Gesundheitsakte section.
 *
 * The full health-record export (PDF + FHIR R4 + zip package) lifted out
 * of Export & Import into its own top-level home. SSR-only smoke test —
 * interaction is exercised by the panel's own contract test + e2e.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/health-record",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SettingsSectionFrame } from "./section-frame-harness";
import { GesundheitsakteSection } from "../gesundheitsakte-section";

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<GesundheitsakteSection> — SSR smoke", () => {
  it("renders the section heading and the health-record panel", () => {
    // v1.18.6 — the visible heading (with the historic id) comes from
    // the shared frame the route wraps the section in.
    const html = render(
      <SettingsSectionFrame slug="health-record">
        <GesundheitsakteSection />
      </SettingsSectionFrame>,
    );
    expect(html).toContain('id="settings-section-health-record-title"');
    expect(html).toContain('data-testid="health-record-export-panel"');
    // Raw key never leaks past i18n.
    expect(html).not.toContain("settings.sections.health-record.");
  });

  it("German locale resolves without leaking the raw key", () => {
    const html = render(<GesundheitsakteSection />, "de");
    expect(html).toContain('data-testid="health-record-export-panel"');
    expect(html).not.toContain("settings.sections.health-record.");
  });
});
