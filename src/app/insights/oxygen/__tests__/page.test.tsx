/**
 * The SpO₂ chart shades the person's own target when they set one on
 * `/targets`, and the clinical bands otherwise. The page used to hand the
 * chart a fixed 80 / 90 / 95 / 100 band, so a target of 88 to 92 % (COPD,
 * altitude) left every reading of the person's normal range shaded as a
 * warning.
 *
 * The scaffold is replaced by a probe that prints the bands it receives; the
 * thresholds read is seeded straight into the shared query cell, which is the
 * cell the target editor invalidates on save.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { ValueBand } from "@/lib/analytics/value-bands";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/components/insights/healthkit-metric-page", () => ({
  HealthKitMetricPage: (props: { valueBands?: ValueBand[] }) => (
    <pre data-testid="bands">{JSON.stringify(props.valueBands ?? null)}</pre>
  ),
}));

const { default: InsightsOxygenSaturationPage } = await import("../page");

function bandsRendered(thresholds: unknown): ValueBand[] {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (thresholds !== undefined) {
    client.setQueryData(queryKeys.userThresholds(), thresholds);
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <InsightsOxygenSaturationPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  const match = /<pre[^>]*>([^<]*)<\/pre>/.exec(html);
  const json = (match?.[1] ?? "null").replaceAll("&quot;", '"');
  return JSON.parse(json) as ValueBand[];
}

const green = (bands: ValueBand[]) =>
  bands.find((band) => band.color === "var(--success)");

describe("/insights/oxygen value bands", () => {
  it("keeps the clinical bands without a personal target", () => {
    const bands = bandsRendered({
      effective: {
        OXYGEN_SATURATION: {
          range: { greenMin: 95, greenMax: 100, orangeMin: 92, orangeMax: 100 },
          isOverride: false,
        },
      },
    });
    expect(bands).toEqual([
      { min: 80, max: 90, color: "var(--destructive)", opacity: 0.18 },
      { min: 90, max: 95, color: "var(--warning)", opacity: 0.18 },
      { min: 95, max: 100, color: "var(--success)", opacity: 0.18 },
    ]);
  });

  it("keeps the clinical bands while the thresholds read is still loading", () => {
    expect(green(bandsRendered(undefined))).toEqual(
      expect.objectContaining({ min: 95, max: 100 }),
    );
  });

  it("shades the person's own band when they set one", () => {
    const bands = bandsRendered({
      effective: {
        OXYGEN_SATURATION: {
          range: {
            greenMin: 88,
            greenMax: 92,
            orangeMin: 87.4,
            orangeMax: 92.6,
          },
          isOverride: true,
        },
      },
    });
    expect(green(bands)).toEqual(expect.objectContaining({ min: 88, max: 92 }));
    // Nothing is shaded above 100 %.
    expect(Math.max(...bands.map((band) => band.max))).toBe(100);
  });
});
