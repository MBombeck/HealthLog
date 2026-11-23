/**
 * The one rule every surface applies to a dose before a medication existed:
 * a clock-time dose whose time had already passed at creation is not owed; a
 * later one is, even with its window already open; a rolling occurrence is
 * exempt (it hangs on the course start or the last take).
 */
import { describe, expect, it } from "vitest";

import { predatesMedication } from "../live-era";

const created = { createdAt: new Date("2026-11-21T07:30:00.000Z") };

describe("predatesMedication", () => {
  it("is true for a clock-time dose whose time had passed at creation", () => {
    expect(
      predatesMedication(new Date("2026-11-21T07:00:00.000Z"), created, false),
    ).toBe(true);
  });

  it("is false for a dose still ahead at creation, and at the instant itself", () => {
    expect(
      predatesMedication(new Date("2026-11-21T08:00:00.000Z"), created, false),
    ).toBe(false);
    expect(predatesMedication(created.createdAt, created, false)).toBe(false);
  });

  it("never applies to a rolling occurrence", () => {
    expect(
      predatesMedication(new Date("2026-11-14T07:00:00.000Z"), created, true),
    ).toBe(false);
  });
});
