/**
 * v1.39.4 (#1040) — the detail header's "Ended" status follows the
 * server's `courseStatus`. It used to compare the end date's UTC midnight
 * with the clock, which read the whole last course day as ended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationDetailSummary } from "@/components/medications/medication-detail-summary";

const payload = {
  id: "m1",
  name: "Amoxicillin",
  dose: "500 mg",
  category: "ANTIBIOTIC",
  notificationsEnabled: true,
  startsOn: new Date("2026-09-20T00:00:00Z"),
  endsOn: new Date("2026-09-27T00:00:00Z"),
  oneShot: false,
  schedules: [
    {
      windowStart: "08:00",
      windowEnd: "09:00",
      timesOfDay: ["08:00"],
      rrule: "FREQ=DAILY",
    },
  ],
};

function render(
  courseStatus: "UPCOMING" | "CURRENT" | "ENDED",
  note: string | null = null,
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={new QueryClient()}>
        <MedicationDetailSummary
          name="Amoxicillin"
          dose="500 mg"
          active
          courseStatus={courseStatus}
          payload={payload}
          oneShot={false}
          startsOn="2026-09-20T00:00:00.000Z"
          note={note}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // The last course day, mid-morning in UTC.
  vi.setSystemTime(new Date("2026-09-27T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("<MedicationDetailSummary> — course status (#1040)", () => {
  it("reads as active on the last course day", () => {
    const html = render("CURRENT");
    expect(html).toContain("bg-success");
    expect(html).not.toContain("bg-muted-foreground");
  });

  it("reads as ended once the server says the course is over", () => {
    const html = render("ENDED");
    expect(html).toContain("bg-muted-foreground");
    expect(html).not.toContain("bg-success");
  });
});

describe("<MedicationDetailSummary> — the medication's own note (#1371)", () => {
  it("shows the note in foreground text, keeping its line breaks", () => {
    const html = render("CURRENT", "With food\nNot with milk");
    expect(html).toContain('data-slot="medication-detail-note"');
    expect(html).toContain("With food\nNot with milk");
    expect(html).toContain("whitespace-pre-line");
    // The note text itself is never muted; only the icon is.
    expect(html).toMatch(
      /data-slot="medication-detail-note" class="[^"]*\bwhitespace-pre-line\b[^"]*"/,
    );
    expect(html).toContain('<span class="min-w-0">With food');
    expect(html).not.toMatch(/medication-detail-note" class="[^"]*muted/);
  });

  it("renders nothing for a medication without a note", () => {
    expect(render("CURRENT")).not.toContain("medication-detail-note");
  });
});
