import { describe, expect, it } from "vitest";

import { daysUntilPurge, purgeCountdownKey } from "../trash-utils";

const NOW = new Date("2026-10-24T12:00:00Z");

describe("daysUntilPurge", () => {
  it("rounds a part day up: the whole of it is still restorable", () => {
    expect(daysUntilPurge("2026-11-20T15:00:00Z", NOW)).toBe(28);
    expect(daysUntilPurge("2026-10-25T11:00:00Z", NOW)).toBe(1);
    expect(daysUntilPurge("2026-10-24T12:00:01Z", NOW)).toBe(1);
  });

  it("is zero once the moment has passed, and for an unreadable date", () => {
    expect(daysUntilPurge("2026-10-24T12:00:00Z", NOW)).toBe(0);
    expect(daysUntilPurge("2026-10-01T00:00:00Z", NOW)).toBe(0);
    expect(daysUntilPurge("not a date", NOW)).toBe(0);
  });
});

describe("purgeCountdownKey", () => {
  it("names the days while there are two or more", () => {
    expect(purgeCountdownKey(30)).toEqual({
      key: "documents.trash.removesIn",
      params: { days: 30 },
    });
    expect(purgeCountdownKey(2)).toEqual({
      key: "documents.trash.removesIn",
      params: { days: 2 },
    });
  });

  it("says within a day for the last one, and after the moment passed", () => {
    expect(purgeCountdownKey(1)).toEqual({
      key: "documents.trash.removesSoon",
    });
    expect(purgeCountdownKey(0)).toEqual({
      key: "documents.trash.removesSoon",
    });
  });
});
