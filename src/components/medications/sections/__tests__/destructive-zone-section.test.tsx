import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  canEndCourse,
  courseEndNow,
  dayKeyOfDate,
} from "@/lib/medications/course-window";
import { updateMedicationSchema } from "@/lib/validations/medication/create-update";

import { LifecycleManageBody } from "../destructive-zone-section";

/** The end day End writes, as the `YYYY-MM-DD` an `endsOn` field carries. */
function endCourseBody(now: Date, timeZone: string): { endsOn: string } {
  return { endsOn: dayKeyOfDate(courseEndNow(now, timeZone).endsOn) };
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "test-user", username: "tester", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

/**
 * "End medication" sent `new Date().toISOString()`, a full instant, against an
 * `endsOn` that only takes `YYYY-MM-DD`, so every press answered 422 and the
 * toast said the medication could not be ended. End now asks the server to
 * end the course (`POST /courses/end`), which writes the person's own
 * calendar day (`courseEndNow`) as the last day.
 */
describe("endCourseBody", () => {
  it("is a date the update schema accepts", () => {
    const body = endCourseBody(
      new Date("2026-10-21T09:30:00.000Z"),
      "Europe/Berlin",
    );
    expect(body).toEqual({ endsOn: "2026-10-21" });
    expect(updateMedicationSchema.safeParse(body).success).toBe(true);
  });

  it("is the person's day, not the UTC one", () => {
    // 23:30 UTC is already the next day in Warsaw and still the same day in
    // New York.
    const lateUtc = new Date("2026-10-20T23:30:00.000Z");
    expect(endCourseBody(lateUtc, "Europe/Warsaw").endsOn).toBe("2026-10-21");
    expect(endCourseBody(lateUtc, "America/New_York").endsOn).toBe(
      "2026-10-20",
    );
  });

  it("is what the update schema refused before: a full instant is not a date", () => {
    expect(
      updateMedicationSchema.safeParse({
        endsOn: new Date("2026-10-21T09:30:00.000Z").toISOString(),
      }).success,
    ).toBe(false);
  });
});

/**
 * Ending writes today as the end of the latest course. On a course that has
 * already ended that would reopen it up to today, and on one that has not
 * started it would become a one-day course today, so End is only offered while
 * the course runs. The server resolves that as `canEndCourse` (a medication
 * with no dates is CURRENT); the controls render from it, and without it
 * (a read that does not carry it) End stays hidden.
 */
describe("End is offered only for a running course", () => {
  function render(served: boolean | undefined) {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <QueryClientProvider client={new QueryClient()}>
          <LifecycleManageBody
            medication={{
              id: "med-1",
              name: "Example",
              active: true,
              canEndCourse: served,
            }}
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  it.each([
    ["CURRENT", true],
    [undefined, false],
    ["ENDED", false],
    ["UPCOMING", false],
  ] as const)("course %s → End shown: %s", (status, shown) => {
    const served = status === undefined ? undefined : canEndCourse(status);
    expect(served ?? false).toBe(shown);
    const html = render(served);
    expect(html.includes('data-slot="destructive-zone-end"')).toBe(shown);
    // Pausing stays available whatever the course.
    expect(html).toContain('id="medication-detail-pause-switch"');
  });
});
