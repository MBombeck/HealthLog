import { describe, expect, it } from "vitest";

import { updateMedicationSchema } from "@/lib/validations/medication/create-update";

import { endCourseBody } from "../destructive-zone-section";

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
