import { describe, expect, it } from "vitest";

import { fhirInstant, firstDated } from "../fields";

describe("fhirInstant", () => {
  it("reads a time without an offset on the person's clock", () => {
    expect(fhirInstant("2024-03-05T08:00:00", "Europe/Berlin")).toEqual(
      new Date("2024-03-05T07:00:00Z"),
    );
    expect(fhirInstant("2024-07-05T08:00:00.250", "Europe/Berlin")).toEqual(
      new Date("2024-07-05T06:00:00.250Z"),
    );
    expect(fhirInstant("2024-03-05T08:00", "America/New_York")).toEqual(
      new Date("2024-03-05T13:00:00Z"),
    );
  });

  it("keeps a stated offset whatever the person's zone", () => {
    expect(fhirInstant("2024-03-05T08:00:00+02:00", "Asia/Tokyo")).toEqual(
      new Date("2024-03-05T06:00:00Z"),
    );
    expect(fhirInstant("2024-03-05T08:00:00Z", "Asia/Tokyo")).toEqual(
      new Date("2024-03-05T08:00:00Z"),
    );
  });

  it("answers null for a time that does not read", () => {
    expect(fhirInstant("2024-03-05T25:00:00", "UTC")).toBeNull();
    expect(fhirInstant("2024-03-05Tnoon", "UTC")).toBeNull();
  });

  it("keeps a date alone at noon UTC", () => {
    expect(fhirInstant("2024-03-05", "Pacific/Honolulu")).toEqual(
      new Date("2024-03-05T12:00:00Z"),
    );
  });
});

describe("firstDated", () => {
  it("takes the day from the text and the instant on the person's clock", () => {
    expect(firstDated("Europe/Berlin", "2024-03-05T00:30:00")).toEqual({
      at: new Date("2024-03-04T23:30:00Z"),
      dateKey: "2024-03-05",
    });
  });
});
