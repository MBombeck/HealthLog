import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.20 phase B3 — `<TrendsRow>` mounts three small charts (BP /
 * weight / mood) and an annotation under each.
 *
 * Recharts is dynamic-imported behind `next/dynamic`, so SSR
 * snapshots show the loading skeleton — that's still enough to verify
 * the row's layout chrome (3-up grid wrapper + per-metric annotation
 * slots).
 *
 * v1.4.25 W7 added a `useAuth()` call inside `<TrendsRow>` to plumb
 * `userTimezone` through to the dynamically-imported chart components,
 * so the test wraps every render in a TanStack-Query provider — the
 * stub charts never trigger an actual fetch but `useAuth` requires a
 * client to mount.
 */

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = ({ title }: { title?: string }) => (
      <div data-slot="trends-row-chart-stub">{title ?? "chart"}</div>
    );
    Stub.displayName = "TrendsRowChartStub";
    return Stub;
  },
}));

import { TrendsRow } from "../trends-row";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<TrendsRow>", () => {
  it("renders the row title in English", () => {
    const html = render(<TrendsRow />);
    expect(html).toMatch(/data-slot="trends-row"/);
    expect(html).toContain("Trends");
  });

  it("renders the row title in German", () => {
    const html = render(<TrendsRow />, "de");
    expect(html).toContain("Trends");
  });

  it("mounts a card per metric (BP / weight / mood)", () => {
    const html = render(<TrendsRow />);
    expect(html).toMatch(/data-metric="bp"/);
    expect(html).toMatch(/data-metric="weight"/);
    expect(html).toMatch(/data-metric="mood"/);
  });

  it("renders a 3-up grid layout", () => {
    const html = render(<TrendsRow />);
    expect(html).toMatch(/md:grid-cols-3/);
    expect(html).toMatch(/grid-cols-1/);
  });

  it("renders annotations when supplied", () => {
    const html = render(
      <TrendsRow
        annotations={{
          bp: "BP trending down — a pattern worth watching.",
          weight: "Weight down 1.4 kg over 30 days.",
          mood: "Mood stable, scoring 4 of 5 most days.",
        }}
      />,
    );
    expect(html).toContain("BP trending down");
    expect(html).toContain("Weight down 1.4 kg");
    expect(html).toContain("Mood stable");
  });

  it("renders the empty-state hint when annotations are absent", () => {
    const html = render(<TrendsRow />);
    expect(html).toContain("Awaiting more data");
    // All three metric slots show the hint when nothing is supplied.
    const matches = html.match(/Awaiting more data/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("propagates per-metric confidence chips", () => {
    const html = render(
      <TrendsRow
        annotations={{
          bp: "BP trending down.",
          weight: "Weight steady.",
          mood: "Mood stable.",
        }}
        confidence={{ bp: "high", weight: "moderate", mood: "low" }}
      />,
    );
    expect(html).toContain("High confidence");
    expect(html).toContain("Moderate confidence");
    expect(html).toContain("Low confidence");
  });
});
