import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import enMessages from "../../../../messages/en.json";

import { I18nProvider } from "@/lib/i18n/context";

import {
  DayCalendar,
  DayDatePicker,
  keyToLocalDate,
  localDateToKey,
  monthWindow,
  pickedDay,
} from "../day-date-picker";

/**
 * The day header's calendar: the date is the button that opens it, the month
 * marks the days that hold anything, nothing past today can be picked, and
 * "Today" goes to today. SSR, like the rest of the suite; the clicks
 * themselves run in `e2e/day-view.spec.ts`.
 */

vi.mock("../use-day", () => ({
  useDayIndex: () => ({ data: undefined }),
}));

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en" initialMessages={enMessages}>
      {node}
    </I18nProvider>,
  );
}

function calendar(
  props: Partial<Parameters<typeof DayCalendar>[0]> = {},
): string {
  return render(
    <DayCalendar
      date="2026-09-24"
      today="2026-10-08"
      month={keyToLocalDate("2026-09-24")}
      onMonthChange={() => undefined}
      withEntries={["2026-09-03", "2026-09-24"]}
      onPick={() => undefined}
      {...props}
    />,
  );
}

function dayButton(html: string, key: string): string {
  return (
    html.match(new RegExp(`<button[^>]*data-date-key="${key}"[^>]*>`))?.[0] ??
    ""
  );
}

describe("<DayDatePicker>", () => {
  it("makes the written date the button, with no icon beside it", () => {
    const html = render(
      <DayDatePicker
        date="2026-09-24"
        today="2026-10-08"
        label="Thursday, September 24, 2026"
        onPick={() => undefined}
      />,
    );
    const button = html.match(/<button[^>]*data-slot="day-date-button"[^>]*>/);
    expect(button?.[0]).toContain('aria-haspopup="dialog"');
    expect(button?.[0]).toContain('aria-expanded="false"');
    expect(html).toContain("Thursday, September 24, 2026");
    expect(html).not.toContain("<svg");
  });
});

describe("<DayCalendar>", () => {
  it("shows the month of the day on screen with that day selected", () => {
    const html = calendar();
    expect(html).toContain("September 2026");
    expect(dayButton(html, "2026-09-24")).toContain(
      'data-selected-single="true"',
    );
  });

  it("marks the days that hold anything, and says so", () => {
    const html = calendar();
    expect(dayButton(html, "2026-09-03")).toContain('data-entries="true"');
    expect(dayButton(html, "2026-09-03")).toContain(
      'aria-label="Thursday, September 3, 2026, has entries"',
    );
    expect(dayButton(html, "2026-09-04")).not.toContain("data-entries");
  });

  it("offers nothing past today", () => {
    const html = calendar({
      date: "2026-10-01",
      month: keyToLocalDate("2026-10-01"),
    });
    expect(dayButton(html, "2026-10-08")).not.toMatch(/\sdisabled=""/);
    expect(dayButton(html, "2026-10-09")).toMatch(/\sdisabled=""/);
  });

  it("offers Today, except on today", () => {
    const today = (html: string) =>
      html.match(/<button[^>]*data-slot="day-date-today"[^>]*>Today/)?.[0];
    expect(today(calendar())).not.toMatch(/\sdisabled=""/);
    expect(
      today(
        calendar({ date: "2026-10-08", month: keyToLocalDate("2026-10-08") }),
      ),
    ).toMatch(/\sdisabled=""/);
  });
});

describe("picking a day", () => {
  it("opens a past day or today, never the open day or a future one", () => {
    expect(pickedDay("2026-09-03", "2026-09-24", "2026-10-08")).toBe(
      "2026-09-03",
    );
    expect(pickedDay("2026-10-08", "2026-09-24", "2026-10-08")).toBe(
      "2026-10-08",
    );
    expect(pickedDay("2026-09-24", "2026-09-24", "2026-10-08")).toBeNull();
    expect(pickedDay("2026-10-09", "2026-09-24", "2026-10-08")).toBeNull();
  });

  it("reads the month it shows, and never past today", () => {
    expect(monthWindow(keyToLocalDate("2026-09-24"), "2026-10-08")).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(monthWindow(keyToLocalDate("2026-10-02"), "2026-10-08")).toEqual({
      from: "2026-10-01",
      to: "2026-10-08",
    });
    expect(localDateToKey(keyToLocalDate("2024-02-29"))).toBe("2024-02-29");
  });
});
