import { describe, expect, it } from "vitest";

import {
  isStorableTimeZone,
  readingDayKey,
  readingZone,
} from "../reading-zone";
import { readingWallSql } from "../reading-zone-sql";

describe("reading zone (iOS #181)", () => {
  it("reads a reading in its own zone, and in the profile zone without one", () => {
    // 03:30 UTC on 2 June: still 1 June in New York, 2 June in Berlin.
    const at = new Date("2026-06-02T03:30:00Z");
    expect(readingDayKey(at, "America/New_York", "Europe/Berlin")).toBe(
      "2026-06-01",
    );
    expect(readingDayKey(at, null, "Europe/Berlin")).toBe("2026-06-02");
    expect(readingDayKey(at, undefined, "Europe/Berlin")).toBe("2026-06-02");
    expect(readingZone(null, "Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("stores only well-formed IANA names the runtime knows", () => {
    expect(isStorableTimeZone("America/New_York")).toBe(true);
    expect(isStorableTimeZone("Asia/Kolkata")).toBe(true);
    expect(isStorableTimeZone("UTC")).toBe(true);
    expect(isStorableTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isStorableTimeZone("Europe/Berlin'; DROP TABLE x;--")).toBe(false);
    expect(isStorableTimeZone("")).toBe(false);
    expect(isStorableTimeZone("+02:00")).toBe(false);
  });

  it("binds the profile zone and splices only a checked alias", () => {
    const sql = readingWallSql("m", "Europe/Berlin");
    expect(sql.sql).toContain('COALESCE(m."time_zone", ?)');
    expect(sql.values).toEqual(["Europe/Berlin"]);
    expect(() => readingWallSql('m"; --', "UTC")).toThrow();
  });
});
