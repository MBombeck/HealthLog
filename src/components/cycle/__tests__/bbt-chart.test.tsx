import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// `useUnitDisplay` reads the account through react-query; these static
// renders have no QueryClient, so the hook is a real display for a fixed
// preference the test sets.
const reader = vi.hoisted(() => ({
  preference: "metric" as "metric" | "imperial",
}));
vi.mock("@/hooks/use-unit-display", async () => {
  const { unitDisplayFor } =
    await import("@/__tests__/helpers/unit-display-mock");
  return { useUnitDisplay: () => unitDisplayFor(reader.preference) };
});

import { BbtChart, BbtTooltip, bbtPoints } from "../bbt-chart";
import { unitDisplayFor } from "@/__tests__/helpers/unit-display-mock";
import { I18nProvider } from "@/lib/i18n/context";
import type { CalendarDay } from "../types";

// v1.42 — the chart's row of day dots reads the day index through
// react-query, so the static render carries a client (it never fetches).
function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function day(date: string, overrides: Partial<CalendarDay> = {}): CalendarDay {
  return {
    date,
    phase: "FOLLICULAR",
    isPredictedPeriod: false,
    isFertileWindow: false,
    isPredictedOvulation: false,
    isPeriodLogged: false,
    isCycleStart: false,
    cycleDay: null,
    periodEndable: false,
    flow: null,
    hasSymptoms: false,
    confidence: 1,
    basalBodyTempC: null,
    ovulationTest: null,
    cervicalMucus: null,
    cervixPosition: null,
    cervixFirmness: null,
    cervixOpening: null,
    intermenstrualBleeding: false,
    sexualActivity: false,
    pregnancyTest: null,
    progesteroneTest: null,
    contraceptive: null,
    hasNote: false,
    ...overrides,
  };
}

describe("<BbtChart>", () => {
  const today = "2026-06-10";

  it("shows the empty hint when fewer than two readings exist", () => {
    const days = [
      day("2026-06-01", { phase: "MENSTRUAL" }),
      day("2026-06-09", { basalBodyTempC: 36.5 }),
    ];
    const html = render(
      <BbtChart
        days={days}
        today={today}
        cycleStartDate="2026-06-01"
        predictedOvulation={null}
        rawChartMode={false}
      />,
    );
    expect(html).toContain('data-slot="cycle-bbt-empty"');
    expect(html).not.toContain('data-slot="cycle-bbt-area"');
  });

  it("draws the curve once two or more readings are present", () => {
    const days = [
      day("2026-06-01", { phase: "MENSTRUAL", basalBodyTempC: 36.4 }),
      day("2026-06-05", { phase: "FOLLICULAR", basalBodyTempC: 36.5 }),
      day("2026-06-08", { phase: "OVULATORY", basalBodyTempC: 36.7 }),
      day("2026-06-10", { phase: "LUTEAL", basalBodyTempC: 36.9 }),
    ];
    const html = render(
      <BbtChart
        days={days}
        today={today}
        cycleStartDate="2026-06-01"
        predictedOvulation="2026-06-08"
        rawChartMode={false}
      />,
    );
    expect(html).toContain('data-slot="cycle-bbt-chart"');
    expect(html).toContain('data-slot="cycle-bbt-caption"');
  });
});

describe("<BbtChart> — the reader's temperature unit", () => {
  it("plots each reading in °F for an imperial reader", () => {
    const display = unitDisplayFor("imperial");
    const points = bbtPoints({
      days: [
        day("2026-06-05", { basalBodyTempC: 36.5 }),
        day("2026-06-09", { basalBodyTempC: 36.9 }),
      ],
      fromDate: "2026-06-01",
      today: "2026-06-10",
      rawChartMode: false,
      toDisplay: (c) => display.toDisplay("BODY_TEMPERATURE", c),
    });
    expect(points.map((p) => p.temp)).toEqual([97.7, 98.4]);
  });

  it("labels the tooltip with the reader's unit", () => {
    reader.preference = "imperial";
    try {
      const html = render(
        <BbtTooltip
          active
          payload={[
            {
              payload: {
                t: Date.parse("2026-06-09T12:00:00Z"),
                temp: 98.4,
                phaseHue: "red",
                mucus: null,
                ovulationTest: null,
              },
            },
          ]}
        />,
      );
      expect(html).toContain("98.4 °F");
      expect(html).not.toContain("°C");
    } finally {
      reader.preference = "metric";
    }
  });
});
