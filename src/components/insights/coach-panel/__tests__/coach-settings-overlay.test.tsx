import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";
import type {
  ProviderChainData,
  UserAIProvider,
} from "@/components/settings/ai/shared";

import { CoachSettingsOverlay } from "../coach-settings-overlay";
import {
  COACH_SETTINGS_DATA_SECTION_ID,
  CoachSettingsBody,
} from "../coach-settings-body";

const CHAIN: ProviderChainData = {
  activeProvider: "local",
  cachedActiveProvider: "local",
  configuredChain: [
    { providerType: "codex", enabled: true, available: false },
    { providerType: "local", enabled: true, available: true },
    { providerType: "admin-openai", enabled: true, available: true },
  ],
};

const PROVIDER: UserAIProvider = {
  provider: "LOCAL",
  model: "qwen2.5",
  baseUrl: "http://localhost:11434/v1",
  hasAnthropicKey: false,
  anthropicKeyPreview: null,
  hasLocalKey: false,
  hasOpenaiKey: false,
  openaiKeyPreview: null,
  compatBaseUrl: null,
  compatModel: null,
  hasCompatKey: false,
  responseTimeoutSeconds: null,
  localReasoningEffort: "none",
  compatReasoningEffort: null,
};

function render(node: React.ReactNode, chain: ProviderChainData = CHAIN) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(queryKeys.insightsProviderChain(), chain);
  client.setQueryData(queryKeys.userAiProvider(), PROVIDER);
  client.setQueryData(queryKeys.coachPrefs(), DEFAULT_COACH_PREFS);
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<CoachSettingsBody>", () => {
  it("holds the model choice, what the Coach sees, and a way to the full settings", () => {
    const html = render(<CoachSettingsBody />);
    expect(html).toContain('data-slot="coach-settings-model"');
    expect(html).toContain('data-slot="coach-model-picker"');
    expect(html).toContain(`id="${COACH_SETTINGS_DATA_SECTION_ID}"`);
    // "What I can see" is the existing rail, wired to the saved preference:
    // the lookback control and the data-area switches.
    expect(html).toContain('data-slot="coach-sources-window"');
    expect(html).toContain('data-slot="coach-sources-list"');
    expect(html).toMatch(/href="\/settings\/ai"[^>]*>All AI settings</);
  });

  it("offers only the providers that can answer, with the active one selected", () => {
    const html = render(<CoachSettingsBody />);
    const select = html.match(
      /<select[^>]*data-slot="coach-quick-provider"[\s\S]*?<\/select>/,
    )?.[0];
    expect(select).toBeDefined();
    expect(select).toContain('value="local"');
    expect(select).toContain('value="admin-openai"');
    expect(select).not.toContain('value="codex"');
  });

  it("shows the operator's central Codex as the active provider when it answers", () => {
    // `admin-codex` is never a chain entry, so no option matched it and the
    // select showed its first option as the one answering.
    const html = render(<CoachSettingsBody />, {
      ...CHAIN,
      activeProvider: "admin-codex" as ProviderChainData["activeProvider"],
    });
    const select = html.match(
      /<select[^>]*data-slot="coach-quick-provider"[\s\S]*?<\/select>/,
    )?.[0];
    expect(select).toMatch(
      /<option value="admin-codex" disabled="" selected="">ChatGPT \(shared by the operator\)<\/option>/,
    );
    expect(select).not.toMatch(/value="local"[^>]*selected/);
    expect(html).toContain('data-slot="coach-quick-provider-operator"');
  });

  it("shows the model and reasoning controls the active provider owns", () => {
    const html = render(<CoachSettingsBody />);
    expect(html).toContain('data-slot="coach-quick-model"');
    expect(html).toContain('id="coach-quick-reasoning"');
    // Keys, base URLs and the chain order are not here.
    expect(html).not.toContain("http://localhost:11434/v1");
    expect(html).not.toMatch(/type="password"/);
  });

  it("locks the reasoning select while a change is saving", async () => {
    // Two writes in flight at once could land out of order and lose one;
    // the provider and model selects already lock, the thinking depth too.
    const source = (await import("node:fs")).readFileSync(
      new URL("../coach-reasoning-field.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/disabled=\{locked \|\| busy\}/);
    expect(source).toMatch(/busy=\{save\.isPending\}/);
  });

  it("names the data section so a deep link can land on it", () => {
    const html = render(<CoachSettingsBody />);
    expect(html).toMatch(
      new RegExp(
        `<section[^>]*id="${COACH_SETTINGS_DATA_SECTION_ID}"[^>]*tabindex="-1"`,
      ),
    );
  });
});

describe("<CoachSettingsOverlay>", () => {
  it("renders a labelled gear that announces a dialog and its state", () => {
    const html = render(
      <CoachSettingsOverlay open={false} onOpenChange={() => {}} />,
    );
    const gear = html.match(
      /<button[^>]*data-slot="coach-settings"[^>]*>/,
    )?.[0];
    expect(gear).toContain('aria-label="Coach settings"');
    expect(gear).toContain('aria-haspopup="dialog"');
    expect(gear).toContain('aria-expanded="false"');
    // Closed: no popover content in the markup.
    expect(html).not.toContain('data-slot="coach-settings-popover"');
  });
});
