import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";
import { PAIRED_METRICS } from "@/lib/measurements/paired-metrics";

/**
 * A paired metric's strip names every component, each with its own band and
 * its own reading. The blood-pressure page used to print the systolic band
 * alone and unnamed ("Your usual range is 79–177 mmHg; … was 118"), which read
 * as one range over systolic and diastolic values together.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

import { CoachReadStrip } from "../coach-read-strip";

function read(low: number, high: number, latest: number): CoachReadStripData {
  return {
    baseline: {
      low,
      high,
      latest,
      latestDate: "2026-11-18",
      latestIsToday: false,
      placement: "within",
      sampleDays: 24,
    },
    learning: false,
    driver: null,
  };
}

const READS: Record<string, CoachReadStripData> = {
  BLOOD_PRESSURE_SYS: read(110, 140, 118),
  BLOOD_PRESSURE_DIA: read(70, 90, 77),
};

function render(
  metricType: string,
  seeded: Record<string, CoachReadStripData>,
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [type, data] of Object.entries(seeded)) {
    client.setQueryData(queryKeys.insightsCoachRead(type, "en"), data);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <CoachReadStrip
          metricType={metricType}
          unit="mmHg"
          fractionDigits={0}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("CoachReadStrip — paired metrics", () => {
  it.each(PAIRED_METRICS.flatMap((p) => p.components))(
    "the %s page names every component with its own band",
    (metricType) => {
      const html = render(metricType, READS);
      expect(html).toContain(
        "Systolic: Your usual range is 110–140\u00a0mmHg; your latest reading, November 18, was 118, within it.",
      );
      expect(html).toContain(
        "Diastolic: Your usual range is 70–90\u00a0mmHg; your latest reading, November 18, was 77, within it.",
      );
      // Systolic first, as a reading is written.
      expect(html.indexOf("Systolic:")).toBeLessThan(
        html.indexOf("Diastolic:"),
      );
      // No band spans one component's low edge and the other's high edge.
      expect(html).not.toContain("70–140");
      expect(html).not.toContain("110–90");
    },
  );

  it("holds the placeholder until every component has landed", () => {
    const html = render("BLOOD_PRESSURE_SYS", {
      BLOOD_PRESSURE_SYS: READS.BLOOD_PRESSURE_SYS,
    });
    expect(html).toContain('data-state="loading"');
    expect(html).not.toContain("Systolic:");
  });

  it("leaves a standalone metric's single line unnamed", () => {
    const html = render("RESTING_HEART_RATE", {
      RESTING_HEART_RATE: read(55, 62, 58),
    });
    expect(html).toContain("Your usual range is 55–62\u00a0mmHg");
    expect(html).not.toContain(": Your usual range");
  });
});
