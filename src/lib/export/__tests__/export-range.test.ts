import { describe, expect, it } from "vitest";

import { parseExportRange } from "../export-range";

const range = (query: string, tz = "Europe/Berlin") =>
  parseExportRange(new URLSearchParams(query), tz);

describe("parseExportRange", () => {
  it("reads both calendar days as whole local days", () => {
    expect(range("since=2026-05-01&until=2026-05-11")).toEqual({
      gte: new Date("2026-04-30T22:00:00.000Z"),
      lt: new Date("2026-05-11T22:00:00.000Z"),
    });
  });

  it("keeps a reading in the evening of the until day", () => {
    const r = range("until=2026-05-11")!;
    const evening = new Date("2026-05-11T19:30:00.000Z"); // 21:30 Berlin
    expect(evening.getTime()).toBeLessThan(r.lt!.getTime());
  });

  it("follows a DST change on the until day", () => {
    // 29 March 2026 is 23 hours long in Berlin.
    expect(range("since=2026-03-29&until=2026-03-29")).toEqual({
      gte: new Date("2026-03-28T23:00:00.000Z"),
      lt: new Date("2026-03-29T22:00:00.000Z"),
    });
  });

  it("takes an exact instant as the bound it names", () => {
    expect(
      range("since=2026-05-01T06:00:00Z&until=2026-05-02T06:00:00Z"),
    ).toEqual({
      gte: new Date("2026-05-01T06:00:00.000Z"),
      lte: new Date("2026-05-02T06:00:00.000Z"),
    });
  });

  it("ignores what it cannot read", () => {
    expect(range("since=nonsense&until=2026-02-30")).toBeUndefined();
  });

  it("returns nothing without a bound", () => {
    expect(range("")).toBeUndefined();
  });
});
