/**
 * The reminder window saves on choice, like the switches beside it in the
 * reminder card. It used to carry its own Save button mid-card, a second
 * way to save in a tab whose schedule card already has one.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  GraceRow,
  graceOptions,
} from "@/components/medications/sections/settings-section";

function render(grace: number | null) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={new QueryClient()}>
        <GraceRow
          medicationId="m1"
          schedules={[
            {
              windowStart: "08:00",
              windowEnd: "08:00",
              label: null,
              dose: null,
              daysOfWeek: null,
              timesOfDay: ["08:00"],
              reminderGraceMinutes: grace,
            },
          ]}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("reminder window", () => {
  it("has no Save button of its own and offers a choice", () => {
    const html = render(30);
    expect(html).not.toMatch(/>Save</);
    expect(html).toContain('id="medication-detail-grace-input"');
    expect(html).toContain('role="combobox"');
  });

  it("keeps a stored value that is not a preset", () => {
    expect(graceOptions(37)).toEqual([15, 30, 37, 45, 60, 90, 120, 180, 240]);
    expect(graceOptions(30)).toEqual([15, 30, 45, 60, 90, 120, 180, 240]);
  });
});
