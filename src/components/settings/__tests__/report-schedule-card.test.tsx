/**
 * The scheduled-report card renders what the server stamped: off with the
 * turn-on control, or on with the last outcome and the period due next. It
 * computes no period of its own.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { ReportScheduleCard } from "../report-schedule-card";

function render(data: unknown) {
  const c = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: Infinity } },
  });
  c.setQueryData(queryKeys.settingsReportSchedule(), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={c}>
      <I18nProvider initialLocale="en">
        <ReportScheduleCard />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("<ReportScheduleCard>", () => {
  it("is off with a turn-on control and no status", () => {
    const html = render({ schedule: null });
    expect(html).toContain("Scheduled doctor report");
    expect(html).toContain("Turn on");
    expect(html).not.toContain('data-slot="report-schedule-status"');
  });

  it("shows the stamped outcome and the period the server says is due", () => {
    const html = render({
      schedule: {
        cadence: "QUARTERLY",
        window: "LAST_365_DAYS",
        lastPeriod: "2026-Q2",
        lastOutcome: "quotaExceeded",
        lastRunAt: "2026-07-01T04:25:00.000Z",
        duePeriod: "2026-Q3",
      },
    });
    expect(html).toContain('data-slot="report-schedule-status"');
    expect(html).toContain(
      "The report for 2026-Q2 did not fit in your document storage.",
    );
    expect(html).toContain("Next report: 2026-Q3");
    expect(html).toContain('value="QUARTERLY" selected=""');
    expect(html).toContain("Turn off");
  });

  it("says it is up to date when nothing is due", () => {
    const html = render({
      schedule: {
        cadence: "MONTHLY",
        window: "PERIOD",
        lastPeriod: "2026-10",
        lastOutcome: "stored",
        lastRunAt: "2026-11-01T04:25:00.000Z",
        duePeriod: null,
      },
    });
    expect(html).toContain("The report for 2026-10 is in your documents.");
    expect(html).toContain("Up to date.");
  });
});
