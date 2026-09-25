import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CycleCalendar } from "../cycle-calendar";
import { I18nProvider } from "@/lib/i18n/context";
import type { CalendarDay } from "../types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function dayBase(date: string): CalendarDay {
  return {
    date,
    phase: null,
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
  };
}

/** The opening tag of one day's cell, by its date in the aria-label. */
function cellTag(html: string, date: string): string {
  const match = html.match(
    new RegExp(`<(?:button|div)[^>]*aria-label="${date}[^"]*"[^>]*>`),
  );
  if (!match) throw new Error(`no cell for ${date}`);
  return match[0];
}

describe("<CycleCalendar>", () => {
  const today = "2026-06-15";

  it("renders the month grid for today's month", () => {
    const html = render(
      <CycleCalendar days={[]} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain('data-slot="cycle-calendar"');
    expect(html).toContain('role="grid"');
    // The current day cell is marked.
    expect(html).toContain('aria-current="date"');
  });

  it("labels a logged-period day in its aria-label", () => {
    const days = [{ ...dayBase("2026-06-10"), isPeriodLogged: true }];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain("Logged period");
  });

  it("renders the predicted period as a dashed soft fill, distinct from a logged pip", () => {
    const days = [{ ...dayBase("2026-06-20"), isPredictedPeriod: true }];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    // Predicted days are a soft FILL with a dashed outline (not the old
    // underline), tagged data-predicted; the solid logged pip has no dashes.
    expect(html).toContain("Predicted period");
    expect(html).toContain('data-predicted="true"');
    expect(html).toContain("border-dashed");
  });

  it("labels a fertile-window day (only present when goal-gated server allows it)", () => {
    const days = [{ ...dayBase("2026-06-12"), isFertileWindow: true }];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain("Fertile window");
  });

  it("renders a localized Monday-first weekday header row", () => {
    const html = render(
      <CycleCalendar days={[]} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain('role="columnheader"');
  });

  it("exposes the flow level on a logged period day as a stable data-attr", () => {
    const days = [
      { ...dayBase("2026-06-10"), isPeriodLogged: true, flow: "HEAVY" },
    ];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain('data-flow-level="HEAVY"');
    // The flow grade is named in the aria text (never colour-only).
    expect(html).toContain("heavy");
  });

  it("marks a logged period day with no flow grade as UNGRADED", () => {
    const days = [{ ...dayBase("2026-06-10"), isPeriodLogged: true }];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain('data-flow-level="UNGRADED"');
  });

  it("renders a predicted-ovulation day as a predicted dot", () => {
    const days = [{ ...dayBase("2026-06-14"), isPredictedOvulation: true }];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain('data-ovulation="predicted"');
    expect(html).toContain("Ovulation");
  });

  it("renders a CONFIRMED-ovulation day as the distinct oval, not the dot", () => {
    const days = [{ ...dayBase("2026-06-14"), isPredictedOvulation: true }];
    const html = render(
      <CycleCalendar
        days={days}
        today={today}
        confirmedOvulation="2026-06-14"
        onSelectDay={() => {}}
      />,
    );
    expect(html).toContain('data-ovulation="confirmed"');
    expect(html).not.toContain('data-ovulation="predicted"');
    expect(html).toContain("Confirmed ovulation");
  });

  it("renders the fertile window as a data-attr-tagged soft band", () => {
    const days = [{ ...dayBase("2026-06-12"), isFertileWindow: true }];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain('data-fertile="true"');
  });

  describe("per-day entries beyond period and symptoms (#1032)", () => {
    it("marks an intercourse day with its own marker and names it", () => {
      const days = [{ ...dayBase("2026-06-05"), sexualActivity: true }];
      const html = render(
        <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
      );
      const cell = cellTag(html, "2026-06-05");
      expect(cell).toContain('data-intercourse="true"');
      expect(cell).toContain("Intercourse");
      // Only that day.
      expect(cellTag(html, "2026-06-06")).not.toContain("data-intercourse");
      expect(html).toContain('data-slot="cycle-calendar-intercourse"');
    });

    it("the legend names intercourse and the other-entries marker", () => {
      const html = render(
        <CycleCalendar days={[]} today={today} onSelectDay={() => {}} />,
      );
      expect(html).toContain('data-legend="cycle.calendar.legendIntercourse"');
      expect(html).toContain('data-legend="cycle.calendar.legendOtherEntries"');
      expect(html).toContain("Intercourse");
      expect(html).toContain("Other entries");
    });

    it.each([
      [
        "a pregnancy test",
        { pregnancyTest: "POSITIVE" },
        "Pregnancy test (Positive)",
      ],
      [
        "a progesterone test",
        { progesteroneTest: "NEGATIVE" },
        "Progesterone test (Negative)",
      ],
      ["contraception", { contraceptive: "ORAL" }, "Contraceptive (Pill)"],
      [
        "spotting",
        { intermenstrualBleeding: true },
        "Spotting between periods",
      ],
      ["a note", { hasNote: true }, "Note"],
      ["a temperature", { basalBodyTempC: 36.6 }, "Basal body temperature"],
      [
        "an ovulation test",
        { ovulationTest: "POSITIVE_LH_SURGE" },
        "Ovulation test (LH surge)",
      ],
      [
        "a mucus reading",
        { cervicalMucus: "CREAMY" },
        "Cervical mucus (Creamy)",
      ],
      ["a cervix sign", { cervixPosition: "HIGH" }, "Cervix"],
    ] as const)(
      "a day with only %s logged no longer looks empty",
      (_label, over, aria) => {
        const days = [{ ...dayBase("2026-06-08"), ...over } as CalendarDay];
        const html = render(
          <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
        );
        const cell = cellTag(html, "2026-06-08");
        expect(cell).toContain('data-other-entries="true"');
        expect(cell).toContain(aria);
      },
    );

    it("an empty day carries neither marker", () => {
      const html = render(
        <CycleCalendar
          days={[dayBase("2026-06-08")]}
          today={today}
          onSelectDay={() => {}}
        />,
      );
      const cell = cellTag(html, "2026-06-08");
      expect(cell).not.toContain("data-other-entries");
      expect(cell).not.toContain("data-intercourse");
    });
  });
});
