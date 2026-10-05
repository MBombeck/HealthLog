import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import de from "../../../../messages/de.json";
import en from "../../../../messages/en.json";
import es from "../../../../messages/es.json";
import fr from "../../../../messages/fr.json";
import it_ from "../../../../messages/it.json";
import ko from "../../../../messages/ko.json";
import pl from "../../../../messages/pl.json";

/**
 * The chart names a series by its localised metric label, never by the enum.
 *
 * The label map in the chart covered eleven types and fell back to the raw
 * type for every other one, so a resting-pulse chart with its trend overlays
 * on read "RESTING_HEART_RATE" in the trend line, the legend, the tooltip and
 * the spoken summary. Every overlay series takes its name from the same
 * helper, so the summary and the trend line stand in for all of them here.
 */

const MESSAGES = { de, en, es, fr, it: it_, ko, pl } as const;

function buildData(): unknown[] {
  const out: Array<{
    date: string;
    timestamp: number;
    RESTING_HEART_RATE: number;
  }> = [];
  const base = Date.now() - 12 * 3_600_000;
  for (let i = 0; i < 28; i++) {
    out.push({
      date: `p${i}`,
      timestamp: base - (27 - i) * 86_400_000,
      RESTING_HEART_RATE: 58 + (i % 5),
    });
  }
  return out;
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, isLoading: false }),
}));

vi.mock("@/hooks/use-chart-overlay-prefs", () => ({
  useChartOverlayPrefs: () => ({
    prefs: {
      showTrendIndicator: true,
      showTrendArrow: true,
      showTargetRange: true,
      comparisonBaseline: "none",
    },
    setPrefs: () => undefined,
    isSaving: false,
  }),
}));

describe("<HealthChart> — series names", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each(Object.keys(MESSAGES) as Array<keyof typeof MESSAGES>)(
    "names the resting-pulse series in %s, overlays on",
    async (locale) => {
      const data = buildData();
      vi.doMock("@tanstack/react-query", () => ({
        keepPreviousData: (previous: unknown) => previous,
        useQuery: () => ({ data, isLoading: false }),
        useQueryClient: () => ({
          cancelQueries: () => Promise.resolve(),
          getQueryData: () => undefined,
          setQueryData: () => undefined,
          invalidateQueries: () => Promise.resolve(),
        }),
        useMutation: () => ({ mutate: () => undefined, isPending: false }),
      }));

      const { I18nProvider } = await import("@/lib/i18n/context");
      const { HealthChart } = await import("../health-chart");
      const messages = MESSAGES[locale];

      const html = renderToStaticMarkup(
        <I18nProvider initialLocale={locale} initialMessages={messages}>
          <HealthChart
            types={["RESTING_HEART_RATE"]}
            title="Resting pulse"
            unit="bpm"
            chartKey="pulse"
          />
        </I18nProvider>,
      );

      const label = (
        messages as unknown as { measurements: Record<string, string> }
      ).measurements.typeRestingHeartRate;
      expect(label).toBeTruthy();

      const aria = html.match(/role="img"[^>]*aria-label="([^"]*)"/)?.[1];
      expect(aria).toBeTruthy();
      expect(aria).not.toContain("RESTING_HEART_RATE");

      const visible = html.replace(/<[^>]+>/g, " ");
      expect(visible).not.toContain("RESTING_HEART_RATE");
      expect(visible).toContain(label);

      vi.doUnmock("@tanstack/react-query");
    },
  );
});

describe("measurementLabelKey", () => {
  it("matches the canonical label map for every type outside the chart's own labels", async () => {
    const { MEASUREMENT_TYPE_LABEL_KEYS } =
      await import("@/lib/measurements/type-label-keys");
    const { measurementLabelKey } = await import("../health-chart");
    // The four types whose key breaks the convention carry a chart label.
    const chartLabelled = new Set([
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "PULSE",
      "BODY_FAT",
      "SLEEP_DURATION",
      "ACTIVITY_STEPS",
      "BLOOD_GLUCOSE",
      "TOTAL_BODY_WATER",
      "BONE_MASS",
      "OXYGEN_SATURATION",
    ]);
    const mismatched = Object.entries(MEASUREMENT_TYPE_LABEL_KEYS)
      .filter(([type]) => !chartLabelled.has(type))
      .filter(([type, key]) => measurementLabelKey(type) !== key);
    expect(mismatched).toEqual([]);
    expect(Object.keys(MEASUREMENT_TYPE_LABEL_KEYS).length).toBeGreaterThan(50);
  });
});
