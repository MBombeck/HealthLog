/**
 * #1404 — the chains-per-task card renders what the server stored: each
 * chain's entries in order with the egress class the server published, a
 * one-entry chain called out as a binding, and every task on Default unless
 * attached.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

import { NamedChainsCard } from "../named-chains-card";
import { NAMED_CHAIN_CAPABILITIES, type NamedChainsData } from "../shared";

const DATA: NamedChainsData = {
  chains: [
    { id: "home", name: "Stays home", entries: ["local"] },
    { id: "cloud", name: "Cloud", entries: ["anthropic", "openai"] },
  ],
  defaultChainId: null,
  attachments: { documentAi: "home", coach: "cloud" },
  mainChain: ["openai", "local"],
  providers: [
    { providerType: "codex", available: false, egress: "external" },
    { providerType: "openai", available: true, egress: "external" },
    { providerType: "anthropic", available: true, egress: "external" },
    { providerType: "local", available: true, egress: "local" },
    {
      providerType: "openai-compatible",
      available: false,
      egress: "external",
    },
    { providerType: "admin-openai", available: false, egress: "external" },
    { providerType: "admin-codex", available: false, egress: "external" },
  ],
};

function render(data: NamedChainsData | undefined, isPending = false) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <NamedChainsCard
          query={{
            data,
            isPending,
            error: null,
            refetch: () => undefined,
          }}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** The markup of one `<li data-…="id">` up to the next sibling of its kind. */
function row(html: string, attr: string, id: string): string {
  const start = html.indexOf(`${attr}="${id}"`);
  expect(start, `${attr}=${id}`).toBeGreaterThan(-1);
  const next = html.indexOf(`${attr}="`, start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("NamedChainsCard", () => {
  it("holds a placeholder until the read lands", () => {
    const html = render(undefined, true);
    expect(html).toContain("Chains per task");
    expect(html).not.toContain('data-slot="named-chain-tasks"');
  });

  it("lists each chain's entries in order with where their input goes", () => {
    const html = render(DATA);
    const home = row(html, "data-named-chain", "home");
    expect(home).toContain("Local model");
    expect(home).toContain("Stays on this machine");
    expect(home).toContain("can&#x27;t answer, the task stops");

    const cloud = row(html, "data-named-chain", "cloud");
    expect(cloud.indexOf("Anthropic")).toBeLessThan(cloud.indexOf("OpenAI"));
    expect(cloud).toContain("Leaves this machine");
    expect(cloud).not.toContain("the task stops");
  });

  it("offers every task, attached ones on their chain and the rest on Default", () => {
    const html = render(DATA);
    for (const key of NAMED_CHAIN_CAPABILITIES) {
      expect(html).toContain(`data-capability="${key}"`);
    }
    const documents = row(html, "data-capability", "documentAi");
    expect(documents).toContain("Bound to this provider, no fallback.");
    expect(documents).toMatch(/<option value="home" selected="">/);

    // A task on Default does not repeat the default chain's providers.
    const briefing = row(html, "data-capability", "briefing");
    expect(briefing).toMatch(/<option value="" selected="">Default/);
    expect(briefing).not.toContain("OpenAI");
    expect(briefing).not.toContain("Local model");
  });

  it("says what Default means when there are no chains yet", () => {
    const html = render({ ...DATA, chains: [], attachments: {} });
    expect(html).toContain("No chains yet.");
    expect(html).not.toContain("Default chain");
    // No column of disabled selects: one sentence instead.
    expect(html).toContain('data-slot="named-chain-tasks-empty"');
    expect(html).not.toContain('data-slot="named-chain-tasks"');
  });
});
