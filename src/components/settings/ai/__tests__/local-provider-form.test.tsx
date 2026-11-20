import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { LocalProviderForm } from "../local-provider-form";
import type { UserAIProvider } from "../shared";

/**
 * #1417 — the Local card filled its fields only while Local was the selected
 * provider. With the gateway selected it rendered blank, and a Save on that
 * untouched card wrote the blanks over the saved Local setup. Its base URL
 * and model are Local's own now, so the card shows them whatever is selected.
 */

function provider(overrides: Partial<UserAIProvider>): UserAIProvider {
  return {
    provider: "OPENAI_COMPATIBLE",
    model: null,
    baseUrl: null,
    localModel: null,
    hasAnthropicKey: false,
    anthropicKeyPreview: null,
    hasLocalKey: true,
    hasOpenaiKey: false,
    openaiKeyPreview: null,
    compatBaseUrl: "https://gateway.example.com/v1",
    compatModel: "cloud-model",
    hasCompatKey: true,
    responseTimeoutSeconds: null,
    ...overrides,
  };
}

function render(userProvider: UserAIProvider) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <LocalProviderForm userProvider={userProvider} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("LocalProviderForm", () => {
  it("shows the saved Local base URL and model while another provider is selected", () => {
    const html = render(
      provider({
        baseUrl: "http://ollama.lan:11434/v1",
        localModel: "gemma3:27b",
        model: "gpt-4o",
      }),
    );
    expect(html).toContain('value="http://ollama.lan:11434/v1"');
    expect(html).toContain('value="gemma3:27b"');
    // The shared cloud model is not Local's.
    expect(html).not.toContain('value="gpt-4o"');
  });

  it("selects a preset Local model in the list", () => {
    const html = render(
      provider({
        provider: "LOCAL",
        baseUrl: "http://ollama.lan:11434/v1",
        localModel: "qwen2.5",
      }),
    );
    expect(html).toMatch(/<option value="qwen2.5" selected="">/);
  });
});
