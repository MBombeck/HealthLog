/**
 * v1.18.0 (S5) — Settings → Coach section.
 *
 * The Coach preference cards (disable toggle, preferences, memory) moved
 * out of the AI / Assistant section into their own dedicated, module-gated
 * entry. SSR-only smoke test — interactive contracts live in the cards'
 * own suites (`disable-coach-card.test.tsx`, `coach-memory-section.test.tsx`).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/coach",
}));

// Past hydration only where a test says so: the gate reads the account once
// mounted, and the pre-hydration pass shows every card.
const mountState = { mounted: false };
vi.mock("@/hooks/use-mounted", () => ({
  useMounted: () => mountState.mounted,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useInfiniteQuery: () => ({ data: undefined, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// The reminders card reads the Coach capability off `/api/auth/me`; the
// react-query mock above carries no context for the real hook to read.
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
  // v1.41 — the thinking depth reads the resolved block; none here.
  useCoachReasoning: () => null,
}));

const authState: {
  disableCoach: boolean;
  modules: { coach?: boolean } | undefined;
} = { disableCoach: false, modules: undefined };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      role: "USER",
      disableCoach: authState.disableCoach,
      modules: authState.modules,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SettingsSectionFrame } from "./section-frame-harness";
import { CoachSection } from "../coach-section";

function render(locale: "en" | "de" = "en") {
  // v1.18.6 (W9) — the visible heading lives in the shared frame the route
  // wraps the section in; render through it so the heading id is present.
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <SettingsSectionFrame slug="coach">
        <CoachSection />
      </SettingsSectionFrame>
    </I18nProvider>,
  );
}

describe("<CoachSection> — SSR smoke", () => {
  it("renders the section scaffold + the Activate-Coach toggle card", () => {
    authState.disableCoach = false;
    const html = render();
    expect(html).toContain('id="settings-section-coach-title"');
    expect(html).toContain('data-testid="settings-disable-coach-card"');
    expect(html).toContain('data-testid="settings-disable-coach-switch"');
    // v1.18.1 (D7) — polarity flipped to activate/default-on.
    expect(html).toContain("Activate Coach");
    expect(html).toContain("Show the Coach button and drawer");
    // v1.18.6 (W9) — the proactive Coach nudge card moved here from
    // Benachrichtigungen; its anchor renders under the enabled-coach gate.
    expect(html).toContain('id="coach-nudge"');
    // Raw key never leaks past i18n.
    expect(html).not.toContain("settings.sections.coach.");
    expect(html).not.toContain("settings.coach.activate.");
  });

  it("renders the German Activate-Coach copy", () => {
    authState.disableCoach = false;
    const html = render("de");
    expect(html).toContain("Coach aktivieren");
    expect(html).not.toContain("settings.sections.coach.");
    expect(html).not.toContain("settings.coach.activate.");
  });
});

describe("<CoachSection> — the tuning follows the record, not the account", () => {
  it("hides the nudge when the record has the Coach off, whatever the viewer's own opt-out says", () => {
    // A guardian with the Coach on, inside a managed record that has it off:
    // `/me` publishes the viewer's own `disableCoach` and the RECORD's module
    // map. The record's answer decides.
    mountState.mounted = true;
    authState.disableCoach = false;
    authState.modules = { coach: false };
    try {
      expect(render()).not.toContain('id="coach-nudge"');
      authState.disableCoach = true;
      authState.modules = { coach: true };
      expect(render()).toContain('id="coach-nudge"');
    } finally {
      mountState.mounted = false;
      authState.disableCoach = false;
      authState.modules = undefined;
    }
  });
});
