import { describe, expect, it } from "vitest";

import { listMeasurementsSchema } from "../measurement";
import { bpTimeOfDayQuerySchema } from "../bp-time-of-day";

const SERIES = {
  aggregate: "daily",
  source: "rollup",
  from: "2026-06-01T00:00:00.000Z",
  to: "2026-06-30T23:59:59.999Z",
};

describe("listMeasurementsSchema partOfDay", () => {
  it.each(["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE"])(
    "accepts it on the %s series read",
    (type) => {
      const parsed = listMeasurementsSchema.safeParse({
        ...SERIES,
        type,
        partOfDay: "morning",
      });
      expect(parsed.success).toBe(true);
    },
  );

  it.each([
    ["another type", { ...SERIES, type: "WEIGHT" }],
    ["no type", { ...SERIES }],
    ["the plain list", { type: "BLOOD_PRESSURE_SYS" }],
    ["a live aggregate", { ...SERIES, type: "PULSE", source: undefined }],
    ["no window", { type: "PULSE", aggregate: "daily", source: "rollup" }],
  ])("refuses it on %s", (_label, query) => {
    const parsed = listMeasurementsSchema.safeParse({
      ...query,
      partOfDay: "evening",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["partOfDay"]);
  });

  it("refuses a part it does not know", () => {
    const parsed = listMeasurementsSchema.safeParse({
      ...SERIES,
      type: "PULSE",
      partOfDay: "night",
    });
    expect(parsed.success).toBe(false);
  });

  it("leaves the query untouched without it", () => {
    expect(
      listMeasurementsSchema.safeParse({ ...SERIES, type: "WEIGHT" }).success,
    ).toBe(true);
  });
});

describe("bpTimeOfDayQuerySchema", () => {
  it("defaults to 30 days and bounds the window", () => {
    expect(bpTimeOfDayQuerySchema.parse({})).toEqual({ days: 30 });
    expect(bpTimeOfDayQuerySchema.parse({ days: "3650" })).toEqual({
      days: 3650,
    });
    expect(bpTimeOfDayQuerySchema.safeParse({ days: "0" }).success).toBe(false);
    expect(bpTimeOfDayQuerySchema.safeParse({ days: "3651" }).success).toBe(
      false,
    );
    expect(bpTimeOfDayQuerySchema.safeParse({ days: "1.5" }).success).toBe(
      false,
    );
  });
});
