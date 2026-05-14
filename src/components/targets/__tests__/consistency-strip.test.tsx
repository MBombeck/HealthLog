import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { ConsistencyStrip } from "../consistency-strip";

/**
 * v1.4.25 W3e — `<ConsistencyStrip>` replaces the v1.4.22 per-card
 * sparkline. Seven dots, one per Berlin-tz day; band-coloured when the
 * day's mean reading was in range, hollow when no readings, and a
 * trailing caption that flips between "in range" and "logged" depending
 * on the cadence.
 */

function render(
  props: Parameters<typeof ConsistencyStrip>[0],
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ConsistencyStrip {...props} />
    </I18nProvider>,
  );
}

describe("<ConsistencyStrip>", () => {
  it("renders 7 dots with their band class and the caption", () => {
    const html = render({
      days: ["in", "in", "near", "in", "out", "in", "in"],
      daysInRange: 5,
      daysLogged: 7,
    });
    expect(html).toContain('data-slot="consistency-strip"');
    // Seven li elements, one per day.
    const liMatches = html.match(/<li/g) ?? [];
    expect(liMatches.length).toBe(7);
    // Cap shows "5 of 7 in range".
    expect(html).toContain("5 of 7 in range");
  });

  it("flips the cap to a logged-count when ≤ 2 days were logged", () => {
    const html = render({
      days: [null, null, null, null, null, "in", "in"],
      daysInRange: 2,
      daysLogged: 2,
    });
    // Misleading "2 of 7 in range" suppressed; honest "2 of 7 logged"
    // surfaced instead.
    expect(html).toContain("2 of 7 logged");
    expect(html).not.toContain("2 of 7 in range");
  });

  it("renders all-hollow when every day has null (no readings yet)", () => {
    const html = render({
      days: [null, null, null, null, null, null, null],
      daysInRange: 0,
      daysLogged: 0,
    });
    // No band classes should be present; cap shows the logged variant.
    expect(html).not.toContain("var(--dracula-green)");
    expect(html).toContain("0 of 7 logged");
  });

  it("German locale surfaces the localised cap", () => {
    const html = render(
      {
        days: ["in", "in", "in", "in", "in", "in", "in"],
        daysInRange: 7,
        daysLogged: 7,
      },
      "de",
    );
    expect(html).toContain("7 von 7 im Bereich");
  });
});
