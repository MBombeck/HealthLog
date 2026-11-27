/**
 * v1.4.16 — AI provider settings UX (dropdown-driven).
 *
 * The new section replaces the v1.4.15-vintage top/bottom split (the maintainer's
 * `feedback_settings_no_split.md`): a single Select picks the active
 * provider; the form below is switch-rendered for that provider; the
 * fallback chain at the bottom reorders / toggles entries with arrow
 * controls (no new dependency — dnd-kit is not in package.json).
 *
 * Tests cover:
 *   1. Codex selected → Codex form (connect button) renders, OpenAI
 *      form does NOT.
 *   2. OpenAI selected → API-key field + model select render, Codex
 *      connect button does NOT.
 *   3. Fallback-chain rows surface in priority order with the right
 *      i18n labels.
 *
 * Each case feeds the section a different `?provider=…` URL parameter
 * so the SSR render lands on the desired branch — the production
 * component reads the same parameter via `useSearchParams()`. This
 * keeps the test SSR-only (no jsdom dependency, no testing-library)
 * and matches the existing settings-section test style.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let activeProviderQuery: string | null = null;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/ai",
  useSearchParams: () =>
    new URLSearchParams(
      activeProviderQuery ? `provider=${activeProviderQuery}` : "",
    ),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

// The AI capability map on `/api/auth/me`: everything available, a provider
// configured, nothing switched off by the operator. The notices and the
// setup hint above the provider card have their own suites.
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
  useAiCapabilityMap: () => null,
  // v1.43 — no usage level published: the setting stays out of the way.
  useAiUsage: () => null,
  // v1.43.2 — nothing to ask: the provider is the person's own.
  useAiConsent: () => ({
    status: "not_needed",
    since: null,
    recipients: [],
  }),
  useAiProviderState: () => ({
    configured: true,
    managedBy: "user",
    canConfigure: true,
  }),
}));

// Stable mocks for every TanStack Query the section reads. The chain
// fixture mirrors the default order (codex first) so the rows render in
// a known order; insights settings + ai-provider GET return enough to
// keep the form branches content (status, hasOpenaiKey etc.).
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = Array.isArray(queryKey) ? queryKey.join("/") : "";
    if (key === "insights/settings") {
      return {
        data: {
          codexStatus: "disconnected",
          codexConnectedAt: null,
          hasAdminKey: false,
          codexOauthConfigured: true,
          privacyMode: "aggregated",
          lastInsightAt: null,
        },
        isLoading: false,
      };
    }
    if (key === "user/ai-provider") {
      return {
        data: {
          provider: null,
          model: null,
          baseUrl: null,
          hasAnthropicKey: false,
          anthropicKeyPreview: null,
          hasLocalKey: false,
          hasOpenaiKey: false,
          openaiKeyPreview: null,
        },
        isLoading: false,
      };
    }
    if (key === "insights/provider-chain") {
      return {
        data: {
          activeProvider: "codex",
          cachedActiveProvider: null,
          configuredChain: [
            { providerType: "codex", available: true },
            { providerType: "openai", available: true },
            { providerType: "anthropic", available: true },
          ],
        },
        isLoading: false,
      };
    }
    return { data: null, isLoading: false };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AiSection } from "../ai-section";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <AiSection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  activeProviderQuery = null;
});

describe("<AiSection> — dropdown-driven UX (B2)", () => {
  it("renders the active-provider Select with the configured options", () => {
    activeProviderQuery = "codex";
    const html = render();
    expect(html).toContain('data-testid="ai-active-provider-select"');
    // The four selectable options resolve via the new
    // `settings.ai.providerSelect.*` keys.
    expect(html).toContain("ChatGPT account (Codex)");
    expect(html).toContain("OpenAI (your API key)");
    expect(html).toContain("Anthropic (Claude)");
    expect(html).toContain("Local model (OpenAI-compatible)");
  });

  it("Codex selected → Codex provider form, no OpenAI form", () => {
    activeProviderQuery = "codex";
    const html = render();
    // Provider-config card surfaces.
    expect(html).toContain('data-testid="ai-provider-config-codex"');
    // OpenAI's API-key field is NOT rendered when Codex is active.
    expect(html).not.toContain('data-testid="ai-provider-config-openai"');
    // Connect-with-ChatGPT CTA is the focal action.
    expect(html).toContain("Connect with ChatGPT");
  });

  it("OpenAI selected → API-key field + model select, no Codex form", () => {
    activeProviderQuery = "openai";
    const html = render();
    expect(html).toContain('data-testid="ai-provider-config-openai"');
    expect(html).not.toContain('data-testid="ai-provider-config-codex"');
    // OpenAI form surfaces the API-key input + model select.
    expect(html).toContain('data-testid="ai-openai-api-key"');
    expect(html).toContain('data-testid="ai-openai-model"');
  });

  it("Anthropic selected → Anthropic API-key form", () => {
    activeProviderQuery = "anthropic";
    const html = render();
    expect(html).toContain('data-testid="ai-provider-config-anthropic"');
    expect(html).not.toContain('data-testid="ai-provider-config-openai"');
  });

  it("Local selected → Local base-URL + key form", () => {
    activeProviderQuery = "local";
    const html = render();
    expect(html).toContain('data-testid="ai-provider-config-local"');
    expect(html).not.toContain('data-testid="ai-provider-config-codex"');
  });

  it("renders the fallback-chain card with rows in priority order", () => {
    activeProviderQuery = "codex";
    const html = render();
    expect(html).toContain('data-testid="ai-fallback-chain"');
    // Each row carries a stable `data-chain-row="<providerType>"`
    // marker so the e2e suite can target without leaning on i18n
    // labels (which differ per locale).
    expect(html).toContain('data-chain-row="codex"');
    expect(html).toContain('data-chain-row="openai"');
    expect(html).toContain('data-chain-row="anthropic"');
  });

  it("names the provider on screen on the Test button (#1417)", () => {
    activeProviderQuery = "codex";
    const html = render();
    expect(html).toContain('data-testid="ai-test-active-provider"');
    expect(html).toContain("Test ChatGPT account (Codex)");
  });

  it("tests the provider in use when the operator's key is on screen", () => {
    activeProviderQuery = "admin-openai";
    const html = render();
    expect(html).toContain("Test active provider");
  });

  it("renders the German labels when locale=de", () => {
    activeProviderQuery = "codex";
    const html = render("de");
    expect(html).toContain("Mit ChatGPT verbinden");
    expect(html).toContain("ChatGPT-Account (Codex)");
    // v1.4.33 — the active-provider heading and the parent section
    // both ship without the "KI"/"AI" prefix per the project-voice rule
    // ("Aktiver KI-Provider" → "Aktiver Provider"). The picker below it is
    // labelled for what it does: it chooses the form, not the order.
    expect(html).toContain("Aktiver Anbieter");
    expect(html).toContain("Anbieter einrichten");
  });

  it("labels the picker for what it does, not as the primary provider", () => {
    // The select picks which provider's key and model the form below edits.
    // It never wrote anything, yet read "Primary provider" under a card
    // that said it held "the provider HealthLog asks first": a person who
    // picked one expected it to answer first, and the chain order, which is
    // what decides that, stayed as it was. The chain card below says what
    // its order decides (behind its info button).
    activeProviderQuery = "codex";
    const html = render();
    expect(html).not.toContain("Primary provider");
    expect(html).toContain("Set up a provider");
  });

  // v1.18.0 — the Coach preference cards (disable toggle, preferences,
  // memory) moved out to the dedicated Coach section; the AI section keeps
  // only provider / model / BYOK plus the "about me" context.
  it("no longer mounts the Coach cards (moved to the Coach section)", () => {
    activeProviderQuery = "codex";
    const html = render();
    expect(html).not.toContain('data-slot="settings-coach-state-card"');
  });
});
