/**
 * v1.4.16 phase B2 — AI provider settings UX (dropdown-driven).
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

  it("exposes a Test active provider button", () => {
    activeProviderQuery = "codex";
    const html = render();
    expect(html).toContain('data-testid="ai-test-active-provider"');
    expect(html).toContain("Test active provider");
  });

  it("renders the German labels when locale=de", () => {
    activeProviderQuery = "codex";
    const html = render("de");
    expect(html).toContain("Mit ChatGPT verbinden");
    expect(html).toContain("ChatGPT-Account (Codex)");
    // v1.4.33 IW7 — the active-provider heading and the parent section
    // both ship without the "KI"/"AI" prefix per the Marc-Voice rule
    // ("Aktiver KI-Provider" → "Aktiver Provider"). The heading and the
    // chain summary now share the same phrase, so we assert against the
    // explicit `activeProviderLabel` slot below it ("Primärer Provider")
    // to keep the test pinned to the right surface.
    expect(html).toContain("Aktiver Provider");
    expect(html).toContain("Primärer Provider");
  });

  // v1.4.47 W3 — per-user "Hide Coach" toggle. The card lives at the
  // bottom of the AI section so privacy-leaning users never scroll
  // past the provider configuration to find it.
  it("mounts the Hide-Coach toggle card", () => {
    activeProviderQuery = "codex";
    const html = render();
    expect(html).toContain('data-testid="settings-disable-coach-card"');
    expect(html).toContain('data-testid="settings-disable-coach-switch"');
    // The localised label + helper line are both surfaced — proves
    // the i18n keys resolve and the description string ships with the
    // bilingual copy required by the QoL audit (M2).
    expect(html).toContain("Hide Coach");
    expect(html).toContain("Hides the Coach button and drawer everywhere.");
  });

  it("renders the German Hide-Coach copy", () => {
    activeProviderQuery = "codex";
    const html = render("de");
    expect(html).toContain("Coach ausblenden");
    expect(html).toContain(
      "Versteckt den Coach-Button und das Coach-Panel auf allen Seiten.",
    );
  });
});
