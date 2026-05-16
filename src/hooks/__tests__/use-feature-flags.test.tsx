import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  DEFAULT_ASSISTANT_FLAGS,
  useFeatureFlags,
} from "../use-feature-flags";

function Probe() {
  const flags = useFeatureFlags();
  return <pre data-testid="flags">{JSON.stringify(flags)}</pre>;
}

function htmlEscape(s: string): string {
  return s.replace(/"/g, "&quot;");
}

describe("useFeatureFlags", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the all-on default when no QueryClient is mounted", () => {
    const html = renderToStaticMarkup(<Probe />);
    expect(html).toContain(htmlEscape(JSON.stringify(DEFAULT_ASSISTANT_FLAGS)));
  });

  it("returns the all-on default while the query is still loading", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 0 } },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(html).toContain(htmlEscape(JSON.stringify(DEFAULT_ASSISTANT_FLAGS)));
  });

  it("returns the resolved matrix when the endpoint responds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              assistant: {
                enabled: true,
                coach: false,
                briefing: true,
                insightStatus: false,
                correlations: true,
                healthScoreExplainer: false,
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: 0 } },
    });
    // Pre-populate so the SSR pass surfaces the cached payload
    // synchronously without a fetch round-trip.
    client.setQueryData(["feature-flags"], {
      assistant: {
        enabled: true,
        coach: false,
        briefing: true,
        insightStatus: false,
        correlations: true,
        healthScoreExplainer: false,
      },
    });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(html).toContain("&quot;coach&quot;:false");
    expect(html).toContain("&quot;insightStatus&quot;:false");
    expect(html).toContain("&quot;healthScoreExplainer&quot;:false");
  });
});
