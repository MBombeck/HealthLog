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
          license: "PolyForm-Noncommercial-1.0.0",
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

// The AI capability map on `/api/auth/me`: everything available, a provider
// configured, nothing switched off by the operator.
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
  useAiCapabilityMap: () => null,
  useAiProviderState: () => ({
    configured: true,
    managedBy: "user",
    canConfigure: true,
  }),
}));

// Stub the auth hook — sections check `isAuthenticated` to enable queries.
// v1.16.4 — AccountSection gates its content on `useMounted()` so the
// SSR pass and the hydration render agree (React #418 family). The
// smoke test asserts the post-mount content, so pin the flag to true.
vi.mock("@/hooks/use-mounted", () => ({
  useMounted: () => true,
}));

// We return `isAuthenticated: true` + a minimal user so the loading-spinner
// branch in AccountSection paints the real form.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "testuser",
      email: "user@example.com",
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
import { I18nProvider } from "@/lib/i18n/context";
import { SettingsSectionFrame } from "./section-frame-harness";
import type { SettingsSectionSlug } from "../section-slugs";
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

const CALLBACK_URLS = {
  withings: "https://app.example/api/withings/callback",
  whoop: "https://app.example/api/whoop/callback",
  fitbit: "https://app.example/api/fitbit/callback",
  "google-health": "https://app.example/api/google-health/callback",
  polar: "https://app.example/api/polar/callback",
  oura: "https://app.example/api/oura/callback",
  strava: "https://app.example/api/strava/callback",
};

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

// v1.18.6 (W9) — the visible page heading + subtitle moved out of the section
// bodies into the shared `<SettingsSectionFrame>` that the route wraps every
// section in. The heading-level smoke checks render the body THROUGH the frame
// (mirroring production) so they assert what the user actually sees.
function renderFramed(
  // A slug or a layout-hub child id — see the harness note.
  slug: SettingsSectionSlug | "dashboard",
  node: React.ReactElement,
  locale: "en" | "de" = "en",
) {
  return render(
    <SettingsSectionFrame slug={slug}>{node}</SettingsSectionFrame>,
    locale,
  );
}

describe("settings sections — SSR smoke", () => {
  it("<AccountSection> renders the Account heading and Profile card", () => {
    const html = renderFramed("account", <AccountSection />);
    // Section title resolves via the frame + i18n provider.
    expect(html).toContain("Account");
    // Profile card heading is also painted.
    expect(html).toContain("Profile");
    // No raw key leaks past the i18n layer.
    expect(html).not.toContain("settings.sections.");
  });

  it("<AdvancedSection> no longer carries a tour-replay card", () => {
    // v1.18.6.1 — the guided tour exists only as the first-time auto-start
    // after onboarding. Every in-app replay / re-entry trigger was removed,
    // including this Advanced card.
    const html = render(<AdvancedSection />);
    expect(html).not.toContain('data-testid="settings-restart-tour"');
    expect(html).not.toContain("Restart module tour");
    expect(html).not.toContain("onboarding.tour.restart");
  });

  it("<AccountSection> no longer carries the Restart-tour button", () => {
    const html = render(<AccountSection />);
    expect(html).not.toContain('data-testid="settings-restart-tour"');
  });

  it("<AboutSection> renders version + license + sources/docs cards (no Updates panel)", () => {
    const html = renderFramed("about", <AboutSection />);
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

  it("<AboutSection> no longer carries a tour-replay card (consolidated to Advanced)", () => {
    // v1.18.6 — the tour replay lives on one home in Settings → Advanced;
    // the About duplicate was removed. Per-module "Diese Tour zeigen"
    // affordances cover in-context re-entry.
    const html = render(<AboutSection />);
    expect(html).not.toContain('data-testid="about-replay-tour"');
    expect(html).not.toContain("Replay the tour");
  });

  it("<AiSection> renders the AI provider heading", () => {
    const html = renderFramed("ai", <AiSection />);
    // v1.18.6 (W9) — section renamed to "AI provider"; the visible heading
    // now comes from the shared frame, which keeps the historic id.
    expect(html).toContain("AI provider");
    expect(html).toContain("settings-section-ai-title");
  });

  it("<IntegrationsSection> renders Withings card + the delivery-channels group", () => {
    const html = renderFramed(
      "integrations",
      <IntegrationsSection callbackUrls={CALLBACK_URLS} />,
    );
    expect(html).toContain("Integrations");
    expect(html).toContain("Withings");
    // v1.25.7 — delivery channels moved here from Notifications: the
    // `#channels` anchor and the embedded channels panel both render.
    expect(html).toContain('id="channels"');
    expect(html).toContain('data-slot="notification-channels-panel"');
    expect(html).toContain("Delivery channels");
  });

  it("<NotificationsSection> renders the reminders group only (channels moved out, v1.25.7)", () => {
    const html = renderFramed("notifications", <NotificationsSection />);
    // v1.18.6 (W9) — the visible heading comes from the frame; the proactive
    // Coach nudge moved to Settings → Coach, so it no longer renders here.
    expect(html).toContain("settings-section-notifications-title");
    expect(html).not.toContain('data-slot="notifications-channels-cross-link"');
    expect(html).not.toContain('data-slot="notifications-inbox-cross-link"');
    // The mood card fails OPEN (mock user carries no module map), so both
    // reminder-type cards render under the Reminders group. The coach-nudge
    // card is gone.
    expect(html).toContain('id="mood-reminder"');
    expect(html).toContain('id="low-stock"');
    expect(html).not.toContain('id="coach-nudge"');
    // v1.25.7 — delivery channels moved to Settings → Integrationen, so the
    // channels group + panel no longer render on this surface.
    expect(html).not.toContain('id="channels"');
    expect(html).not.toContain('data-slot="notification-channels-panel"');
    expect(html).toContain("Reminders");
    // No raw i18n key leaks past the provider.
    expect(html).not.toContain("settings.sections.notifications.");
  });

  it("<DashboardSection> renders heading and embeds the layout customizer", () => {
    // v1.4.3 split: the per-metric thresholds (Persönliche Zielwerte) moved
    // out into their own settings section under `/settings/thresholds`,
    // so the dashboard panel is now layout-only. Verifying the heading
    // (supplied by the frame) says "Dashboard" and the layout slot mounts.
    const html = renderFramed("dashboard", <DashboardSection />);
    expect(html).toContain("Dashboard");
    expect(html).toContain('data-testid="dashboard-layout"');
    expect(html).not.toContain('data-testid="thresholds"');
  });

  it("<ApiSection> renders endpoints + tokens cards", () => {
    const html = renderFramed("api", <ApiSection />);
    expect(html).toContain("API &amp; tokens");
  });

  it("<AdvancedSection> renders the danger-zone card only (export moved to /settings/export)", () => {
    const html = renderFramed("advanced", <AdvancedSection />);
    // v1.4.16 phase B7: every export path moved out into the dedicated
    // `<ExportSection>` so what remains is the irreversible delete-all
    // path. The heading (supplied by the frame) + dangerZone surface are the
    // only primary surfaces here now.
    expect(html).toContain("Advanced");
    expect(html).not.toContain("settings.export");
    expect(html).not.toContain("doctorReport");
  });

  it("<AboutSection> resolves about.* keys in German", () => {
    const html = renderFramed("about", <AboutSection />, "de");
    // v1.4.36 W4f — "Updates" panel + "Jetzt prüfen" button removed;
    // the surviving German copy is the section title + the Sources
    // & docs heading + the version line.
    expect(html).toContain("Über");
    expect(html).toContain("Quellen &amp; Dokumentation");
    expect(html).not.toContain(">Jetzt prüfen<");
  });

  it("<ThresholdsSection> renders the Targets heading and the threshold editor only", () => {
    // v1.4.16 phase B6 contract: the route wrapper is named
    // `<ThresholdsSection>` (was `<ThresholdsSettingsSection>`), lives
    // at `thresholds-section.tsx`, and embeds the inner editor under
    // `<ThresholdsEditorSection>` (was `<ThresholdsSection>`).
    // v1.8.7.1 — Sources split back onto its own page, so this wrapper
    // renders the target-range editor only.
    const html = renderFramed("thresholds", <ThresholdsSection />);
    // v1.8.7.1: section renamed to "Targets".
    expect(html).toContain("Targets");
    expect(html).toContain('data-testid="thresholds-editor"');
    expect(html).not.toContain('data-testid="sources-section"');
    expect(html).not.toContain("settings.sections.thresholds.");
  });

  it("<ThresholdsSection> carries the glucose reference band control", () => {
    // The declared diabetes opt-in (`PATCH /api/auth/me/diabetes`) selects the
    // tighter glucose band and grounds the Coach, but shipped with no web
    // control at all — a web-only account could never reach it. It belongs on
    // Targets: same question ("which range judges my reading") as the editor
    // below it, and the copy must stay honest about being a reference band
    // rather than a diagnosis.
    const html = renderFramed("thresholds", <ThresholdsSection />);
    expect(html).toContain("Glucose reference band");
    expect(html).toContain("Use the diabetes goal band");
    expect(html).toContain("not a diagnosis");
    expect(html).toContain('data-slot="glucose-reference-disclaimer"');
    expect(html).not.toContain("settings.glucoseReference.");
  });

  it("<ThresholdsSection> resolves the German title", () => {
    const html = renderFramed("thresholds", <ThresholdsSection />, "de");
    // v1.8.7.1 — German title is "Zielwerte" (Targets only).
    expect(html).toContain("Zielwerte");
    expect(html).toContain('data-testid="thresholds-editor"');
    expect(html).not.toContain('data-testid="sources-section"');
  });
});
