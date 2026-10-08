/**
 * Settings → Source priority lists only the sources the account has connected
 * or holds data from, and opens one metric group at a time. The ladders it
 * edits stay whole: a hidden source keeps its slot when a visible one moves.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { parseSourcePriority } from "@/lib/validations/source-priority";
import { moveAmongVisible, SourcesSection } from "../sources-section";

function render(inUse: string[] | undefined): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.sourcePriority(), {
    ...parseSourcePriority(null),
    ...(inUse ? { inUse } : {}),
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <SourcesSection />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Settings → Source priority, sources in use", () => {
  it("lists only metrics and sources the account uses", () => {
    const html = render(["WITHINGS"]);
    expect(html).toContain('data-testid="sources-metric-weight"');
    // WHOOP-only metric classes have nothing in use here.
    expect(html).not.toContain('data-testid="sources-metric-stress"');
    expect(html).not.toContain("Apple Health");
  });

  it("opens the first group and collapses the rest", () => {
    const html = render(["WITHINGS", "MANUAL"]);
    const expanded = html.match(/aria-expanded="true"/g) ?? [];
    expect(expanded).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
  });

  it("names an element with every toggle's aria-controls, open or not", () => {
    const html = render(["WITHINGS", "MANUAL"]);
    const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(controls.length).toBeGreaterThan(1);
    for (const id of controls) expect(html).toContain(`id="${id}"`);
  });

  it("lets a collapsed group's winner truncate instead of squeezing the label", () => {
    const html = render(["WITHINGS", "MANUAL"]);
    const winner = html.match(
      /data-slot="sources-metric-winner" class="([^"]*)"/,
    )?.[1];
    expect(winner).toBeDefined();
    expect(winner).toMatch(/\btruncate\b/);
    expect(winner).toMatch(/\bmin-w-0\b/);
    expect(winner).not.toMatch(/\bshrink-0\b/);
  });

  it("says so when no source is in use at all", () => {
    expect(render([])).toContain('data-testid="sources-none-in-use"');
  });

  it("lists every source when the server sends no in-use list", () => {
    expect(render(undefined)).toContain("Apple Health");
  });
});

describe("moveAmongVisible", () => {
  const visible = (s: string) => s !== "B";

  it("swaps past a hidden neighbour, keeping its slot", () => {
    expect(moveAmongVisible(["A", "B", "C"], "C", -1, visible)).toEqual([
      "C",
      "B",
      "A",
    ]);
  });

  it("refuses a move with no visible neighbour", () => {
    expect(moveAmongVisible(["A", "B", "C"], "A", -1, visible)).toBeNull();
    expect(moveAmongVisible(["A", "B"], "A", 1, visible)).toBeNull();
  });
});
