import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Stub out next/navigation. The settings sections that read it (Account)
// only call `useRouter().push()` from inside an effect after mount, so a
// no-op stub is enough for SSR smoke rendering. v1.4.16 phase B2:
// `<AiSection>` reads `?provider=…` via `useSearchParams()` to pick the
// dropdown branch, so the mock has to expose that hook too.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/account",
  useSearchParams: () => new URLSearchParams(),
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
// v1.4.16 phase B6: the inner editor moved from `thresholds-section.tsx` to
// `thresholds-editor-section.tsx` so the route-level wrapper can claim the
// canonical `<slug>-section.tsx` filename. The wrapper itself is now
// `<ThresholdsSection>`. This stub mocks the inner editor so the
// SSR smoke test for `<DashboardSection>` (which never imports thresholds)
// stays unaffected.
vi.mock("@/components/settings/thresholds-editor-section", () => ({
  ThresholdsEditorSection: () => <div data-testid="thresholds-editor" />,
}));
// v1.4.34 IW-D — `<ThresholdsSection>` now also embeds
// `<SourcesSection mode="embedded">` so the combined "Targets &
// Sources" page reads as one shelf. The SourcesSection itself owns
// React Query and TanStack mutation wiring; stub it at the import
// boundary to keep the SSR smoke test focused on the wrapper.
vi.mock("@/components/settings/sources-section", () => ({
  SourcesSection: () => <div data-testid="sources-section" />,
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
// v1.4.16 phase B6: route-level wrapper. The historic
// `<ThresholdsSettingsSection>` was renamed to `<ThresholdsSection>` and
// its filename changed from `thresholds-settings-section.tsx` to
// `thresholds-section.tsx` so the component name + filename match the
// slug like every other settings section.
import { ThresholdsSection } from "../thresholds-section";

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

  it("<AccountSection> exposes a Restart-tour button for B5 replay", () => {
    const html = render(<AccountSection />);
    // v1.4.15 phase B5 acceptance criterion 4: Settings → Account
    // exposes a "Restart onboarding tour" button that resets the
    // server-side flag. Rendered as a card next to Password reset.
    expect(html).toContain('data-testid="settings-restart-tour"');
    expect(html).toContain("Restart onboarding tour");
    // No raw i18n key leaks.
    expect(html).not.toContain("onboarding.tour.");
  });

  it("<AboutSection> renders version + license + sources/docs cards (no Updates panel)", () => {
    const html = render(<AboutSection />);
    expect(html).toContain("About");
    // v1.4.36 W4f — the dedicated "Updates" card with its manual
    // "Check now" button is gone. The 24 h auto-check still runs and
    // surfaces a subtle ArrowUpCircle badge next to the version line
    // when a newer release is available. The Sources & docs card
    // stays put.
    expect(html).toContain("Sources &amp; docs");
    expect(html).not.toContain(">Check now<");
    expect(html).not.toContain(">Check for updates<");
    expect(html).not.toContain("settings.about.");
  });

  it("<AiSection> renders the Insights card", () => {
    const html = render(<AiSection />);
    // v1.4.33 IW7 — section renamed from "AI Insights" to "Insights"
    // per the Marc-Voice rule. The card title is replaced with a sparkles
    // icon + status badges, and the section H1 carries the only heading.
    expect(html).toContain("Insights");
    expect(html).toContain("settings-section-ai-title");
  });

  it("<IntegrationsSection> renders Withings card title", () => {
    const html = render(<IntegrationsSection />);
    expect(html).toContain("Integrations");
    expect(html).toContain("Withings");
  });

  it("<NotificationsSection> renders heading", () => {
    const html = render(<NotificationsSection />);
    // v1.4.33 IW7 — section renamed from "Notifications" to
    // "Notification channels" so it doesn't collide with the inbox at
    // `/notifications` ("Notification Center").
    expect(html).toContain("Notification channels");
  });

  it("<DashboardSection> renders heading and embeds the layout customizer", () => {
    // v1.4.3 split: the per-metric thresholds (Persönliche Zielwerte) moved
    // out into their own settings section under `/settings/thresholds`,
    // so the dashboard panel is now layout-only. Verifying the heading
    // says "Dashboard" (not "Übersicht" — the v1.4.2 placeholder) and the
    // layout slot still mounts.
    const html = render(<DashboardSection />);
    expect(html).toContain("Dashboard");
    expect(html).toContain('data-testid="dashboard-layout"');
    expect(html).not.toContain('data-testid="thresholds"');
  });

  it("<ApiSection> renders endpoints + tokens cards", () => {
    const html = render(<ApiSection />);
    expect(html).toContain("API &amp; Tokens");
  });

  it("<AdvancedSection> renders the danger-zone card only (export moved to /settings/export)", () => {
    const html = render(<AdvancedSection />);
    // v1.4.16 phase B7: every export path moved out into the dedicated
    // `<ExportSection>` so what remains is the irreversible delete-all
    // path. The section heading + dangerZone surface are the only
    // primary surfaces here now.
    expect(html).toContain("Advanced");
    expect(html).not.toContain("settings.export");
    expect(html).not.toContain("doctorReport");
  });

  it("<AboutSection> resolves about.* keys in German", () => {
    const html = render(<AboutSection />, "de");
    // v1.4.36 W4f — "Updates" panel + "Jetzt prüfen" button removed;
    // the surviving German copy is the section title + the Sources
    // & docs heading + the version line.
    expect(html).toContain("Über");
    expect(html).toContain("Quellen &amp; Dokumentation");
    expect(html).not.toContain(">Jetzt prüfen<");
  });

  it("<ThresholdsSection> renders heading and embeds both editors (v1.4.34 IW-D merge)", () => {
    // v1.4.16 phase B6 contract: the route wrapper is named
    // `<ThresholdsSection>` (was `<ThresholdsSettingsSection>`), lives
    // at `thresholds-section.tsx`, and embeds the inner editor under
    // `<ThresholdsEditorSection>` (was `<ThresholdsSection>`).
    // v1.4.34 IW-D — the wrapper now also embeds
    // `<SourcesSection mode="embedded">` so the page is the merged
    // "Targets & Sources" surface. Both editor mounts must be present.
    const html = render(<ThresholdsSection />);
    // v1.4.34 IW-D: section renamed to "Targets & Sources".
    expect(html).toContain("Targets &amp; Sources");
    expect(html).toContain('data-testid="thresholds-editor"');
    expect(html).toContain('data-testid="sources-section"');
    expect(html).not.toContain("settings.sections.thresholds.");
  });

  it("<ThresholdsSection> resolves the German title (B6 rename + IW-D merge)", () => {
    const html = render(<ThresholdsSection />, "de");
    expect(html).toContain("Zielwerte &amp; Quellen");
    expect(html).toContain('data-testid="thresholds-editor"');
    expect(html).toContain('data-testid="sources-section"');
  });
});
