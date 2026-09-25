import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BbtChart } from "../bbt-chart";
import { I18nProvider } from "@/lib/i18n/context";
import type { CalendarDay } from "../types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
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
