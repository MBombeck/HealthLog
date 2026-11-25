/**
 * #1215 — the intake-tracking switch says what the medication does. An ended
 * course (ended by hand, or imported with an end date in the past) keeps
 * intake tracking on, so a dose from the past can still be recorded; the
 * course window is what keeps it from falling due. The helper line must say
 * so, not promise doses on the schedule.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import en from "../../../../../messages/en.json";
import { IntakeTrackingBody } from "@/components/medications/sections/intake-tracking-section";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={new QueryClient()}>
        {node}
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const copy = en.medications.trackIntake;

describe("IntakeTrackingBody helper", () => {
  it("promises due doses only while the course runs", () => {
    const html = render(<IntakeTrackingBody medicationId="m" trackIntake />);
    expect(html).toContain(copy.helperOn);
  });

  it("says nothing falls due once the course has ended", () => {
    const html = render(
      <IntakeTrackingBody medicationId="m" trackIntake courseEnded />,
    );
    expect(html).toContain(copy.helperEnded);
    expect(html).not.toContain(copy.helperOn);
  });

  it("keeps the record-only line when tracking is off", () => {
    const html = render(
      <IntakeTrackingBody medicationId="m" trackIntake={false} courseEnded />,
    );
    expect(html).toContain(copy.helperOff);
  });
});
