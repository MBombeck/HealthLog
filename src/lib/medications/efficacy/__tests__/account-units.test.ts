/**
 * The Effect tab reads in the account's unit (#1406): the series, the
 * before/after means, the reference band and the segmented estimates of a
 * metric target all go through the account's display transform, and the band
 * is the account's own target where one exists.
 */
import { describe, expect, it } from "vitest";

import {
  displaySegmented,
  efficacyDisplayFor,
  efficacyReferenceBand,
  type EfficacyAccount,
} from "@/lib/medications/efficacy/account-units";
import { beforeAfterFromSeries } from "@/lib/medications/efficacy/build-efficacy";
import type { EfficacySegmented } from "@/lib/medications/efficacy/segmented-effect";

const DAY = 24 * 60 * 60 * 1000;
const pivot = Date.parse("2026-03-01T12:00:00Z");

const account = (over: Partial<EfficacyAccount> = {}): EfficacyAccount => ({
  preferences: { system: "metric", glucoseUnit: "mg/dL" },
  hasDiabetes: false,
  thresholds: null,
  profile: { heightCm: null, dateOfBirth: null, gender: null },
  ...over,
});

const MMOL = account({
  preferences: { system: "metric", glucoseUnit: "mmol/L" },
});

describe("efficacyDisplayFor", () => {
  it("reads glucose in mmol/L for an mmol/L account, one decimal", () => {
    const d = efficacyDisplayFor("BLOOD_GLUCOSE", "mg/dL", MMOL.preferences);
    expect(d.unit).toBe("mmol/L");
    expect(d.abs(193)).toBe(10.7);
    expect(d.abs(383)).toBe(21.3);
    expect(d.delta(-18.0182)).toBe(-1);
  });

  it("keeps mg/dL and the one-decimal view for an mg/dL account", () => {
    const d = efficacyDisplayFor("BLOOD_GLUCOSE", "mg/dL", {
      system: "metric",
      glucoseUnit: "mg/dL",
    });
    expect(d.unit).toBe("mg/dL");
    expect(d.abs(351.44)).toBe(351.4);
  });

  it("reads weight in pounds for an imperial account", () => {
    const d = efficacyDisplayFor("WEIGHT", "kg", {
      system: "imperial",
      glucoseUnit: "mg/dL",
    });
    expect(d.unit).toBe("lb");
    expect(d.abs(80)).toBe(176.4);
  });

  it("converts an absolute temperature with its offset, a delta without", () => {
    const d = efficacyDisplayFor("BODY_TEMPERATURE", "°C", {
      system: "imperial",
      glucoseUnit: "mg/dL",
    });
    expect(d.unit).toBe("°F");
    expect(d.abs(37)).toBe(98.6);
    expect(d.delta(1)).toBe(1.8);
  });

  it("leaves a type without a transform on its registry unit", () => {
    const d = efficacyDisplayFor("PULSE", "bpm", MMOL.preferences);
    expect(d.unit).toBe("bpm");
    expect(d.abs(61.26)).toBe(61.3);
  });
});

describe("efficacyReferenceBand", () => {
  it("is the general 70–140 band for an account without targets", () => {
    expect(
      efficacyReferenceBand("BLOOD_GLUCOSE", { low: 70, high: 140 }, account()),
    ).toEqual({ low: 70, high: 140 });
  });

  it("follows the account's diabetes goal", () => {
    expect(
      efficacyReferenceBand(
        "BLOOD_GLUCOSE",
        { low: 70, high: 140 },
        account({ hasDiabetes: true }),
      ),
    ).toEqual({ low: 80, high: 180 });
  });

  it("follows the account's own spot-reading glucose threshold", () => {
    expect(
      efficacyReferenceBand(
        "BLOOD_GLUCOSE",
        { low: 70, high: 140 },
        account({
          thresholds: { BLOOD_GLUCOSE_RANDOM: { min: 90, max: 160 } },
        }),
      ),
    ).toEqual({ low: 90, high: 160 });
  });

  it("takes an own weight target, otherwise the registry default", () => {
    expect(
      efficacyReferenceBand(
        "WEIGHT",
        null,
        account({ thresholds: { WEIGHT: { min: 70, max: 75 } } }),
      ),
    ).toEqual({ low: 70, high: 75 });
    expect(
      efficacyReferenceBand(
        "BLOOD_PRESSURE_SYS",
        { low: 90, high: 120 },
        account(),
      ),
    ).toEqual({ low: 90, high: 120 });
  });
});

describe("beforeAfterFromSeries in the display unit", () => {
  it("converts the means and the delta, keeps the percentage", () => {
    const points = [
      ...Array.from({ length: 10 }, (_, i) => ({
        at: pivot - (10 - i) * DAY,
        value: 180,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        at: pivot + i * DAY,
        value: 144,
      })),
    ];
    const d = efficacyDisplayFor("BLOOD_GLUCOSE", "mg/dL", MMOL.preferences);
    const r = beforeAfterFromSeries(points, pivot, d);
    expect(r.before?.mean).toBe(10);
    expect(r.after?.mean).toBe(8);
    expect(r.delta?.mean).toBe(-2);
    expect(r.delta?.pct).toBe(-20);
  });
});

describe("displaySegmented", () => {
  const estimate = (v: number) => ({
    estimate: v,
    ciLow: v - 9,
    ciHigh: v + 9,
    standardError: 4.5,
    includesZero: false,
  });
  const seg = {
    present: true,
    level: 0.95,
    levelChange: estimate(-36),
    slopeChangePerWeek: estimate(-18),
    preSlopePerWeek: estimate(0),
  } as unknown as EfficacySegmented;

  it("converts every estimate as a difference", () => {
    const d = efficacyDisplayFor("BLOOD_GLUCOSE", "mg/dL", MMOL.preferences);
    const out = displaySegmented(seg, d)!;
    expect(out.levelChange!.estimate).toBe(-2);
    expect(out.levelChange!.ciLow).toBe(-2.5);
    expect(out.slopeChangePerWeek!.estimate).toBe(-1);
    expect(out.levelChange!.includesZero).toBe(false);
  });

  it("is the identity when the unit does not rescale", () => {
    const d = efficacyDisplayFor("BLOOD_GLUCOSE", "mg/dL", {
      system: "metric",
      glucoseUnit: "mg/dL",
    });
    expect(displaySegmented(seg, d)).toBe(seg);
  });
});
