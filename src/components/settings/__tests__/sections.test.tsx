import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Stub out next/navigation. The settings sections that read it (Account)
// only call `useRouter().push()` from inside an effect after mount, so a
// no-op stub is enough for SSR smoke rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/account",
}));

// Stub TanStack Query — every section reads from it but we only need the
// SSR markup, not live data. Returning a stable empty payload keeps the
// "loading" branch from spinning forever and lets the section title render.
// The About section reads `["api", "version"]` and gates the body on data
// presence — return a representative payload so the version card paints.
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (
      Array.isArray(queryKey) &&
      queryKey[0] === "api" &&
      queryKey[1] === "version"
    ) {
      return {
        data: {
          version: "1.4.0",
          buildSha: "abc1234567",
          builtAt: "2026-05-08T12:00:00Z",
          license: "AGPL-3.0",
          repository: "https://github.com/MBombeck/HealthLog",
          changelog:
            "https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md",
          docs: "https://docs.healthlog.dev",
        },
        isLoading: false,
        refetch: vi.fn(),
      };
    }
    return { data: null, isLoading: false, refetch: vi.fn() };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Stub the auth hook — sections check `isAuthenticated` to enable queries.
// We return `isAuthenticated: true` + a minimal user so the loading-spinner
// branch in AccountSection paints the real form.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "marc",
      email: "marc@example.com",
      heightCm: 180,
      dateOfBirth: "1990-01-01",
      gender: "MALE",
      role: "USER",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

// Sub-sections of Dashboard own complex data fetching that's already
// covered by their own tests. Stub at the import boundary.
vi.mock("@/components/settings/dashboard-layout-section", () => ({
  DashboardLayoutSection: () => <div data-testid="dashboard-layout" />,
}));
vi.mock("@/components/settings/thresholds-section", () => ({
  ThresholdsSection: () => <div data-testid="thresholds" />,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AboutSection } from "../about-section";
import { AccountSection } from "../account-section";
import { AdvancedSection } from "../advanced-section";
import { AiSection } from "../ai-section";
import { ApiSection } from "../api-section";
import { DashboardSection } from "../dashboard-section";
import { IntegrationsSection } from "../integrations-section";
import { NotificationsSection } from "../notifications-section";

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("settings sections — SSR smoke", () => {
  it("<AccountSection> renders the Account heading and Profile card", () => {
    const html = render(<AccountSection />);
    // Section title resolves via the i18n provider.
    expect(html).toContain("Account");
    // Profile card heading is also painted.
    expect(html).toContain("Profile");
    // No raw key leaks past the i18n layer.
    expect(html).not.toContain("settings.sections.");
  });

  it("<AboutSection> renders version + license + check-for-updates button", () => {
    const html = render(<AboutSection />);
    expect(html).toContain("About");
    // The new about.* keys resolve.
    expect(html).toContain("Check for updates");
    expect(html).not.toContain("settings.about.");
  });

  it("<AiSection> renders the AI Insights card", () => {
    const html = render(<AiSection />);
    expect(html).toContain("AI Insights");
  });

  it("<IntegrationsSection> renders Withings card title", () => {
    const html = render(<IntegrationsSection />);
    expect(html).toContain("Integrations");
    expect(html).toContain("Withings");
  });

  it("<NotificationsSection> renders heading", () => {
    const html = render(<NotificationsSection />);
    expect(html).toContain("Notifications");
  });

  it("<DashboardSection> renders heading and embeds layout + thresholds", () => {
    const html = render(<DashboardSection />);
    expect(html).toContain("Dashboard");
    expect(html).toContain('data-testid="dashboard-layout"');
    expect(html).toContain('data-testid="thresholds"');
  });

  it("<ApiSection> renders endpoints + tokens cards", () => {
    const html = render(<ApiSection />);
    expect(html).toContain("API &amp; Tokens");
  });

  it("<AdvancedSection> renders export + danger-zone cards", () => {
    const html = render(<AdvancedSection />);
    expect(html).toContain("Advanced");
  });

  it("<AboutSection> resolves about.* keys in German", () => {
    const html = render(<AboutSection />, "de");
    expect(html).toContain("Auf Updates prüfen");
  });
});
