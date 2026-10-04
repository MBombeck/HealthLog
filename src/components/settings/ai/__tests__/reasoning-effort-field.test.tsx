import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import en from "../../../../../messages/en.json";
import { CompatProviderForm } from "../compat-provider-form";
import { LocalProviderForm } from "../local-provider-form";
import type { UserAIProvider } from "../shared";

/**
 * #1126 — the Reasoning select on the Local and OpenAI-compatible forms. It
 * sits right under the model field, offers exactly Default / Off / Low /
 * Medium / High, and seeds from the value the server stored on the entry.
 * Saving it is pinned end to end in `e2e/ai-provider-dropdown.spec.ts`.
 */

function provider(overrides: Partial<UserAIProvider>): UserAIProvider {
  return {
    provider: "LOCAL",
    model: "llama3:8b",
    baseUrl: "http://ollama.example.org:11434/v1",
    hasAnthropicKey: false,
    anthropicKeyPreview: null,
    hasLocalKey: false,
    hasOpenaiKey: false,
    openaiKeyPreview: null,
    compatBaseUrl: "https://gateway.example.org/v1",
    compatModel: "qwen3",
    hasCompatKey: false,
    responseTimeoutSeconds: null,
    ...overrides,
  };
}

function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

/** The `<select>` element with the given id, as markup. */
function selectMarkup(html: string, id: string): string {
  const match = new RegExp(`<select[^>]*\\bid="${id}"`).exec(html);
  expect(match, `no select #${id}`).not.toBeNull();
  const start = match!.index;
  return html.slice(start, html.indexOf("</select>", start));
}

const OPTION_VALUES = ["", "none", "low", "medium", "high"];

describe.each([
  {
    name: "Local",
    id: "ai-local-reasoning",
    after: "ai-local-model",
    form: (p: UserAIProvider) => <LocalProviderForm userProvider={p} />,
    stored: (v: UserAIProvider["localReasoningEffort"]) => ({
      localReasoningEffort: v,
    }),
  },
  {
    name: "OpenAI-compatible",
    id: "ai-compat-reasoning",
    after: "ai-compat-model",
    form: (p: UserAIProvider) => <CompatProviderForm userProvider={p} />,
    stored: (v: UserAIProvider["compatReasoningEffort"]) => ({
      compatReasoningEffort: v,
      provider: "OPENAI_COMPATIBLE",
    }),
  },
])("$name form", ({ id, after, form, stored }) => {
  it("offers Default, Off, Low, Medium and High under the model field", () => {
    const html = render(form(provider({})));
    const select = selectMarkup(html, id);
    expect(
      [...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]),
    ).toEqual(OPTION_VALUES);
    const r = en.settings.ai.reasoning;
    for (const label of Object.values(r.options)) {
      expect(select).toContain(`>${label}</option>`);
    }
    expect(html).toContain(`<label`);
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain(r.label);
    expect(html).toContain(r.hint);
    expect(html.indexOf(`id="${id}"`)).toBeGreaterThan(
      html.indexOf(`id="${after}"`),
    );
  });

  it("seeds Default when nothing is stored, or a payload predates the field", () => {
    const select = selectMarkup(render(form(provider({}))), id);
    expect(select).toMatch(/<option value="" selected="">/);
  });

  it("seeds the stored value", () => {
    const select = selectMarkup(render(form(provider(stored("none")))), id);
    expect(select).toMatch(/<option value="none" selected="">/);
  });
});
