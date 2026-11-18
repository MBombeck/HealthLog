import { describe, expect, it } from "vitest";

import {
  seizureEventCreateSchema,
  seizureEventUpdateSchema,
  seizureSettingsUpdateSchema,
} from "../shared";

const onsetAt = "2026-03-01T08:00:00.000Z";

describe("a duration and its source agree", () => {
  it("accepts a timed duration and an untimed seizure", () => {
    expect(
      seizureEventCreateSchema.safeParse({
        onsetAt,
        durationSec: 75,
        durationSource: "TIMED",
      }).success,
    ).toBe(true);
    expect(seizureEventCreateSchema.safeParse({ onsetAt }).success).toBe(true);
  });

  it("refuses a seizure that claims to be timed without a duration", () => {
    expect(
      seizureEventCreateSchema.safeParse({ onsetAt, durationSource: "TIMED" })
        .success,
    ).toBe(false);
  });

  it("refuses a duration whose source is unknown", () => {
    expect(
      seizureEventCreateSchema.safeParse({
        onsetAt,
        durationSec: 30,
        durationSource: "UNKNOWN",
      }).success,
    ).toBe(false);
  });

  it("refuses an edit that clears the duration and keeps an estimate", () => {
    expect(
      seizureEventUpdateSchema.safeParse({
        durationSec: null,
        durationSource: "ESTIMATED",
      }).success,
    ).toBe(false);
    expect(
      seizureEventUpdateSchema.safeParse({ durationSec: null }).success,
    ).toBe(true);
  });

  it("refuses an empty edit", () => {
    expect(seizureEventUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("keeps a tally count within bounds", () => {
    expect(
      seizureEventCreateSchema.safeParse({ onsetAt, count: 0 }).success,
    ).toBe(false);
  });
});

describe("the cluster rule", () => {
  it("takes 2 to 20 seizures within 1 to 168 hours", () => {
    expect(
      seizureSettingsUpdateSchema.safeParse({
        clusterCount: 3,
        clusterWindowHours: 24,
      }).success,
    ).toBe(true);
    expect(
      seizureSettingsUpdateSchema.safeParse({
        clusterCount: 1,
        clusterWindowHours: 24,
      }).success,
    ).toBe(false);
    expect(
      seizureSettingsUpdateSchema.safeParse({
        clusterCount: 2,
        clusterWindowHours: 200,
      }).success,
    ).toBe(false);
  });
});
