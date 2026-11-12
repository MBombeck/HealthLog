import { describe, expect, it } from "vitest";

import { lastLoggableDay } from "../log-day-sheet";

/**
 * "Log day" on an illness opens on the day it suggests and bounds the picker
 * there. For a recovered episode that used to be today, so one tap on Save
 * filed a sick day days after the recovery, and the day view then showed it
 * with no illness running beside it.
 */
describe("lastLoggableDay", () => {
  it("is today while the episode runs", () => {
    expect(lastLoggableDay("2026-11-12", null, "Europe/Berlin")).toBe(
      "2026-11-12",
    );
  });

  it("is the recovery day once the episode ended before today", () => {
    expect(
      lastLoggableDay(
        "2026-11-12",
        "2026-11-09T08:00:00.000Z",
        "Europe/Berlin",
      ),
    ).toBe("2026-11-09");
  });

  it("stays today when the episode ended today", () => {
    expect(
      lastLoggableDay(
        "2026-11-12",
        "2026-11-12T08:00:00.000Z",
        "Europe/Berlin",
      ),
    ).toBe("2026-11-12");
  });

  it("reads the recovery day in the profile zone", () => {
    // 23:30 UTC is already the next day in Berlin.
    expect(
      lastLoggableDay(
        "2026-11-12",
        "2026-11-09T23:30:00.000Z",
        "Europe/Berlin",
      ),
    ).toBe("2026-11-10");
  });
});
