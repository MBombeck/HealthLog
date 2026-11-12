/**
 * Settings lists the Coach entry only while the Coach can answer, like the
 * sidebar and the bottom bar, and Settings → AI then keeps the stored Coach
 * memory in reach.
 *
 * Both used to read the raw module map, which answers the operator's switch
 * and Hide Coach but not a missing provider or missing consent: the settings
 * nav kept a Coach entry the sidebar had already dropped. The two now read
 * the same map (`useNavModules`), so the memory's own entry and the fallback
 * under Settings → AI cannot both go.
 *
 * The shell's module filter runs after hydration only, so `useMounted` is
 * mocked to the hydrated answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  coachAvailable: true,
  active: null as Record<string, unknown> | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/ai",
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      role: "USER",
      modules: { coach: true },
      accountAccess: { active: h.active },
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: h.coachAvailable,
    reason: h.coachAvailable ? null : "no_provider",
    onDeviceAllowed: true,
  }),
}));
// Settings → AI's cards have their own suites; only the memory slot is
// under test here.
vi.mock("@/components/ai/ai-consent-request", () => ({
  AiConsentRequest: () => null,
}));
vi.mock("@/components/settings/ai/ai-insights-card", () => ({
  AiInsightsCard: () => null,
}));
vi.mock("@/components/settings/ai/operator-off-notice", () => ({
  OperatorOffNotice: () => null,
}));
vi.mock("@/components/insights/ai-setup-hint", () => ({
  AiSetupHint: () => null,
}));
vi.mock("@/components/settings/coach-memory-section", () => ({
  StoredCoachMemory: () => <div data-slot="stored-coach-memory" />,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AiSection } from "../ai-section";
import { SettingsShell } from "../settings-shell";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("the Coach entry in Settings", () => {
  beforeEach(() => {
    h.coachAvailable = true;
    h.active = null;
  });

  it("is listed while the Coach can answer, and the memory lives there", () => {
    expect(render(<SettingsShell active="ai">body</SettingsShell>)).toContain(
      'href="/settings/coach"',
    );
    expect(render(<AiSection />)).not.toContain(
      'data-slot="stored-coach-memory"',
    );
  });

  it("goes when the Coach cannot answer, and Settings → AI keeps the memory", () => {
    h.coachAvailable = false;
    expect(
      render(<SettingsShell active="ai">body</SettingsShell>),
    ).not.toContain('href="/settings/coach"');
    expect(render(<AiSection />)).toContain('data-slot="stored-coach-memory"');
  });

  it("stays for a managed record whose Coach cannot answer yet", () => {
    // A record has no Settings, AI: the guardian reaches the record's Coach
    // data scope and switch through this entry only.
    h.coachAvailable = false;
    h.active = {
      recordKind: "managed",
      level: "manage",
      manageableDomains: [],
    };
    expect(
      render(<SettingsShell active="coach">body</SettingsShell>),
    ).toContain('href="/settings/coach"');
  });
});
