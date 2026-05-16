import React from "react";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { InsightStatusCard } from "../insight-status-card";

/**
 * v1.4.31 — the per-metric `<InsightStatusCard>` returns `null` when
 * the operator has disabled the `insightStatus` surface. Renders
 * normally otherwise.
 */
function wrap(node: React.ReactNode, client: QueryClient) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

const baseProps = {
  title: "Pulse",
  icon: null,
  text: "Your pulse is stable.",
  hasProvider: true,
  cached: false,
  updatedAt: null,
};

function makeClient(flags: {
  enabled: boolean;
  coach: boolean;
  briefing: boolean;
  insightStatus: boolean;
  correlations: boolean;
  healthScoreExplainer: boolean;
}): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
  client.setQueryData(["feature-flags"], { assistant: flags });
  return client;
}

describe("<InsightStatusCard> — assistant.insightStatus gate", () => {
  it("renders the card when the flag is on", () => {
    const html = wrap(
      <InsightStatusCard {...baseProps} />,
      makeClient({
        enabled: true,
        coach: true,
        briefing: true,
        insightStatus: true,
        correlations: true,
        healthScoreExplainer: true,
      }),
    );
    expect(html).toContain("Your pulse is stable");
  });

  it("returns null when the operator disables the sub-flag", () => {
    const html = wrap(
      <InsightStatusCard {...baseProps} />,
      makeClient({
        enabled: true,
        coach: true,
        briefing: true,
        insightStatus: false,
        correlations: true,
        healthScoreExplainer: true,
      }),
    );
    expect(html).toBe("");
  });

  it("returns null when the master flag is off", () => {
    const html = wrap(
      <InsightStatusCard {...baseProps} />,
      makeClient({
        enabled: false,
        coach: false,
        briefing: false,
        insightStatus: false,
        correlations: false,
        healthScoreExplainer: false,
      }),
    );
    expect(html).toBe("");
  });
});
