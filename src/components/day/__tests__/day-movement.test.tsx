/**
 * "On the move" renders the server's values as they come and leaves out what
 * the day has no value for: a null is no coverage, never a zero.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";

import { DayMovementSection } from "../day-movement";

function render(
  movement: Parameters<typeof DayMovementSection>[0]["movement"],
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DayMovementSection movement={movement} />
    </I18nProvider>,
  );
}

const base = {
  source: "dawarich" as const,
  distance: { unit: "km" as const, total: 48.3, driving: 12, train: 0 },
  placesVisited: 4,
  awayFromHomeMinutes: 600,
  travel: { isTravelDay: true, countryCode: "ES" },
  fetchedAt: "2026-06-16T01:20:00.000Z",
};

describe("DayMovementSection", () => {
  it("shows each value the day has", () => {
    const html = render(base);
    expect(html).toContain('data-movement="total"');
    expect(html).toContain("48.3\u00a0km");
    expect(html).toContain('data-movement="driving"');
    expect(html).toContain('data-movement="away"');
    expect(html).toContain("Spain");
    // No train that day: no row, rather than "0 km".
    expect(html).not.toContain('data-movement="train"');
  });

  it("leaves out time away from home without coverage", () => {
    const html = render({
      ...base,
      awayFromHomeMinutes: null,
      travel: null,
    });
    expect(html).not.toContain('data-movement="away"');
    expect(html).not.toContain('data-movement="travel"');
  });

  it("renders nothing when the day has no value at all", () => {
    const html = render({
      ...base,
      distance: { unit: "mi", total: null, driving: null, train: null },
      placesVisited: null,
      awayFromHomeMinutes: null,
      travel: null,
    });
    expect(html).toBe("");
  });
});
