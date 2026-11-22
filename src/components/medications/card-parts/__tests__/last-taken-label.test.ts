import { describe, expect, it } from "vitest";

import { lastTakenLabel } from "../last-taken-label";

const t = (key: string) => key;
// 10:00 in Berlin on 2026-10-04; the suite's host zone is UTC.
const NOW = new Date("2026-10-04T08:00:00.000Z");

describe("lastTakenLabel", () => {
  it("names today and yesterday by the profile zone's calendar, not the host's", () => {
    // 00:30 in Berlin on the 4th, still the 3rd on the UTC host.
    expect(
      lastTakenLabel("2026-10-03T22:30:00.000Z", "Europe/Berlin", t, NOW),
    ).toMatch(/^medications\.today, /);
    // 23:30 in Berlin on the 3rd.
    expect(
      lastTakenLabel("2026-10-03T21:30:00.000Z", "Europe/Berlin", t, NOW),
    ).toMatch(/^medications\.yesterday, /);
  });

  it("gives an older intake its date", () => {
    expect(
      lastTakenLabel("2026-10-01T08:00:00.000Z", "Europe/Berlin", t, NOW),
    ).not.toMatch(/^medications\./);
  });
});
