/**
 * The Fitbit card's notice about the end of the legacy Web API: before the
 * day it says when the connection stops, from the day on that it has, and
 * both times it points at Google Health and says the data stays.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { FitbitRetirementNotice } from "../fitbit-retirement-notice";

function render(ended: boolean | null) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <FitbitRetirementNotice
        retirement={
          ended === null
            ? undefined
            : { endsOn: "2026-10-30", ended, successor: "google-health" }
        }
      />
    </I18nProvider>,
  );
}

describe("<FitbitRetirementNotice>", () => {
  it("names the day the connection stops, and the way on", () => {
    const html = render(false);
    expect(html).toContain('data-ended="false"');
    expect(html).toContain("Google turns the Fitbit Web API off on");
    expect(html).toContain("Google Health reads the same Fitbit and Pixel");
    expect(html).toContain("Everything already imported stays.");
    expect(html).toContain('href="#google-health"');
    expect(html).toContain("/guides/connect-google-health/");
  });

  it("says the connection has stopped once the day has come", () => {
    const html = render(true);
    expect(html).toContain('data-ended="true"');
    expect(html).toContain("Google turned the Fitbit Web API off on");
    expect(html).not.toContain("Google turns the Fitbit Web API off on");
  });

  it("renders nothing without a retirement on the status entry", () => {
    expect(render(null)).toBe("");
  });
});
