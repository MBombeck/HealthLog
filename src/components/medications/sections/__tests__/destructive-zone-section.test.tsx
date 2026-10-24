import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { updateMedicationSchema } from "@/lib/validations/medication/create-update";

import {
  canEndCourse,
  endCourseBody,
  LifecycleManageBody,
} from "../destructive-zone-section";

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
 * toast said the medication could not be ended. The body now carries the
 * person's own calendar day.
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
 * the course runs. A medication with no dates is CURRENT.
 */
describe("End is offered only for a running course", () => {
  function render(courseStatus?: "UPCOMING" | "CURRENT" | "ENDED") {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <QueryClientProvider client={new QueryClient()}>
          <LifecycleManageBody
            medication={{
              id: "med-1",
              name: "Example",
              active: true,
              courseStatus,
            }}
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  it.each([
    ["CURRENT", true],
    [undefined, true],
    ["ENDED", false],
    ["UPCOMING", false],
  ] as const)("course %s → End shown: %s", (status, shown) => {
    expect(canEndCourse(status)).toBe(shown);
    const html = render(status);
    expect(html.includes('data-slot="destructive-zone-end"')).toBe(shown);
    // Pausing stays available whatever the course.
    expect(html).toContain('id="medication-detail-pause-switch"');
  });
});
