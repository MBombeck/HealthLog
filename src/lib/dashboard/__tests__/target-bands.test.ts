/**
 * v1.18.6 — parity test for the server-side band / target math
 * (audit finding #3). `buildTargetBands` must produce byte-identical
 * numbers to the legacy client-side derivation in `page.tsx`, which is
 * just a sequence of the SAME pure helpers. The test re-derives each
 * structure with those helpers and asserts deep equality for a male
 * profile, a female profile, and a no-profile user.
 */
import { describe, it, expect } from "vitest";

import { buildTargetBands } from "../snapshot";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { METRIC_BOUNDS } from "@/lib/analytics/effective-range";
import {
  buildTrafficLightBands,
  buildTrafficRange,
  buildBandsFromTrafficRange,
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";

/** Re-derive bands exactly as `page.tsx` did before v1.18.6. */
function clientBands(profile: {
  dateOfBirth: Date | null;
  gender: "MALE" | "FEMALE" | null;
  heightCm: number | null;
}) {
  const bpTargets = profile.dateOfBirth
    ? getBpTargets(profile.dateOfBirth)
    : null;
  const pulseAge = getAgeFromDateOfBirth(profile.dateOfBirth);
  const pulseTarget = getPersonalizedPulseTarget(pulseAge, profile.gender);
  const bodyFatRange = getBodyFatTargetRange(profile.gender);
  const weightRange = profile.heightCm
    ? buildWeightRangeFromHeight(profile.heightCm)
    : null;
  const weightBands = profile.heightCm
    ? buildBandsFromTrafficRange(buildWeightRangeFromHeight(profile.heightCm), {
        lowerBound: METRIC_BOUNDS.WEIGHT.min,
        upperBound: 250,
      })
    : null;
  return {
    bpTargets,
    bpSysRange: bpTargets
      ? buildTrafficRange(bpTargets.sysLow, bpTargets.sysHigh)
      : null,
    bpDiaRange: bpTargets
      ? buildTrafficRange(bpTargets.diaLow, bpTargets.diaHigh)
      : null,
    pulseDisplayRange: {
      greenMin: pulseTarget.greenMin,
      greenMax: pulseTarget.greenMax,
      orangeMin: pulseTarget.orangeMin,
      orangeMax: pulseTarget.orangeMax,
    },
    pulseBands: [
      {
        min: 30,
        max: pulseTarget.orangeMin,
        color: "var(--destructive)",
        opacity: 0.16,
      },
      {
        min: pulseTarget.orangeMin,
        max: pulseTarget.greenMin,
        color: "var(--warning)",
        opacity: 0.18,
      },
      {
        min: pulseTarget.greenMin,
        max: pulseTarget.greenMax,
        color: "var(--success)",
        opacity: 0.2,
      },
      {
        min: pulseTarget.greenMax,
        max: pulseTarget.orangeMax,
        color: "var(--warning)",
        opacity: 0.18,
      },
      {
        min: pulseTarget.orangeMax,
        max: 220,
        color: "var(--destructive)",
        opacity: 0.16,
      },
    ].filter((b) => b.max > b.min),
    bodyFatRange,
    bodyFatBands: buildTrafficLightBands(bodyFatRange.min, bodyFatRange.max, {
      lowerBound: 2,
      upperBound: 55,
    }),
    weightRange,
    weightBands,
  };
}

describe("buildTargetBands — server/client parity", () => {
  const profiles: Array<{
    name: string;
    dateOfBirth: Date | null;
    gender: "MALE" | "FEMALE" | null;
    heightCm: number | null;
    thresholdsJson: unknown;
  }> = [
    {
      name: "male 180cm with DOB",
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
      gender: "MALE",
      heightCm: 180,
      thresholdsJson: null,
    },
    {
      name: "female 165cm with DOB",
      dateOfBirth: new Date("1970-01-01T00:00:00.000Z"),
      gender: "FEMALE",
      heightCm: 165,
      thresholdsJson: null,
    },
    {
      name: "no-profile user (null DOB / gender / height)",
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      thresholdsJson: null,
    },
  ];

  for (const profile of profiles) {
    it(`matches the legacy client math for ${profile.name}`, () => {
      const server = buildTargetBands(profile);
      const client = clientBands(profile);
      expect(server).toEqual(client);
    });
  }

  it("gives OTHER the neutral bands, identical to an unanswered profile", () => {
    // OTHER has no row in the percentile / body-fat tables. It must land on
    // the same neutral fallback an unanswered profile gets, never on one of
    // the two sides — and the type must be able to carry it here at all.
    const other = buildTargetBands({
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
      gender: "OTHER",
      heightCm: 180,
      thresholdsJson: null,
    });
    const unanswered = buildTargetBands({
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
      gender: null,
      heightCm: 180,
      thresholdsJson: null,
    });
    expect(other).toEqual(unanswered);
    const male = buildTargetBands({
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
      gender: "MALE",
      heightCm: 180,
      thresholdsJson: null,
    });
    expect(other.bodyFatBands).not.toEqual(male.bodyFatBands);
  });

  it("nulls the profile-derived bands when no DOB / height", () => {
    const bands = buildTargetBands({
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      thresholdsJson: null,
    });
    expect(bands.bpTargets).toBeNull();
    expect(bands.bpSysRange).toBeNull();
    expect(bands.bpDiaRange).toBeNull();
    expect(bands.weightRange).toBeNull();
    expect(bands.weightBands).toBeNull();
    // Pulse + body-fat always resolve (AHA / neutral fallback).
    expect(bands.pulseBands.length).toBeGreaterThan(0);
    expect(bands.bodyFatBands.length).toBeGreaterThan(0);
  });
});

/**
 * v1.34 — an explicit weight target outranks the height-derived WHO band.
 * The dashboard used to shade the BMI band for someone who had already
 * answered the question on `/targets`, so the answer stayed invisible on
 * every surface that mattered.
 */
describe("buildTargetBands — user weight target", () => {
  const profile = {
    dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
    gender: "MALE" as const,
    heightCm: 180,
  };

  it("replaces the height-derived band with the user's own", () => {
    const withTarget = buildTargetBands({
      ...profile,
      thresholdsJson: { WEIGHT: { min: 74, max: 78 } },
    });
    expect(withTarget.weightRange?.greenMin).toBe(74);
    expect(withTarget.weightRange?.greenMax).toBe(78);

    const heightDerived = buildTargetBands({
      ...profile,
      thresholdsJson: null,
    });
    expect(heightDerived.weightRange).not.toEqual(withTarget.weightRange);
    // The chart bands follow the same range, so tile and chart agree.
    expect(withTarget.weightBands).not.toEqual(heightDerived.weightBands);
    const green = withTarget.weightBands?.find(
      (b) => b.color === "var(--success)",
    );
    expect(green).toEqual(expect.objectContaining({ min: 74, max: 78 }));
  });

  it("honours a target even for a profile with no height on file", () => {
    const bands = buildTargetBands({
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      thresholdsJson: { WEIGHT: { min: 60, max: 65 } },
    });
    expect(bands.weightRange?.greenMin).toBe(60);
    expect(bands.weightBands?.length).toBeGreaterThan(0);
  });

  it("leaves every non-weight band untouched", () => {
    const withTarget = buildTargetBands({
      ...profile,
      thresholdsJson: { WEIGHT: { min: 74, max: 78 } },
    });
    const without = buildTargetBands({
      ...profile,
      thresholdsJson: null,
    });
    expect(withTarget.bpTargets).toEqual(without.bpTargets);
    expect(withTarget.pulseBands).toEqual(without.pulseBands);
    expect(withTarget.bodyFatBands).toEqual(without.bodyFatBands);
  });
});

/**
 * The other metrics the dashboard shades take the person's own target the
 * same way weight does. A blood-pressure, resting-pulse or body-fat target set
 * on `/targets` used to leave the chart on the age / sex default, so the band
 * under the line contradicted the band the person had just entered.
 */
describe("buildTargetBands — the user's own targets on every shaded metric", () => {
  const profile = {
    dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
    gender: "MALE" as const,
    heightCm: 180,
  };
  const without = buildTargetBands({ ...profile, thresholdsJson: null });
  const greenOf = (bands: Array<{ min: number; max: number; color: string }>) =>
    bands.find((band) => band.color === "var(--success)");

  it("draws the blood-pressure zones and tile ranges from the own band", () => {
    const bands = buildTargetBands({
      ...profile,
      thresholdsJson: {
        BLOOD_PRESSURE_SYS: { min: 115, max: 125 },
        BLOOD_PRESSURE_DIA: { min: 70, max: 78 },
      },
    });
    expect(bands.bpTargets).toEqual({
      sysLow: 115,
      sysHigh: 125,
      diaLow: 70,
      diaHigh: 78,
    });
    expect(bands.bpTargets).not.toEqual(without.bpTargets);
    expect(bands.bpSysRange).toEqual(
      expect.objectContaining({ greenMin: 115, greenMax: 125 }),
    );
    expect(bands.bpDiaRange).toEqual(
      expect.objectContaining({ greenMin: 70, greenMax: 78 }),
    );
  });

  it("fills a one-sided blood-pressure target with the age default", () => {
    const bands = buildTargetBands({
      ...profile,
      thresholdsJson: { BLOOD_PRESSURE_SYS: { min: 110, max: 128 } },
    });
    expect(bands.bpTargets?.sysLow).toBe(110);
    expect(bands.bpTargets?.sysHigh).toBe(128);
    expect(bands.bpTargets?.diaLow).toBe(without.bpTargets?.diaLow);
    expect(bands.bpTargets?.diaHigh).toBe(without.bpTargets?.diaHigh);
    expect(bands.bpDiaRange).toEqual(without.bpDiaRange);
  });

  it("draws a blood-pressure band from a target even without a date of birth", () => {
    const bands = buildTargetBands({
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      thresholdsJson: {
        BLOOD_PRESSURE_SYS: { min: 115, max: 125 },
        BLOOD_PRESSURE_DIA: { min: 70, max: 78 },
      },
    });
    expect(bands.bpTargets).toEqual({
      sysLow: 115,
      sysHigh: 125,
      diaLow: 70,
      diaHigh: 78,
    });
  });

  it("draws the resting-pulse bands and display range from the own band", () => {
    const bands = buildTargetBands({
      ...profile,
      thresholdsJson: { PULSE: { min: 48, max: 58 } },
    });
    expect(bands.pulseDisplayRange).toEqual(
      expect.objectContaining({ greenMin: 48, greenMax: 58 }),
    );
    expect(greenOf(bands.pulseBands)).toEqual(
      expect.objectContaining({ min: 48, max: 58 }),
    );
    expect(bands.pulseBands).not.toEqual(without.pulseBands);
  });

  it("draws the body-fat bands and range from the own band", () => {
    const bands = buildTargetBands({
      ...profile,
      thresholdsJson: { BODY_FAT: { min: 12, max: 16 } },
    });
    expect(bands.bodyFatRange).toEqual({ min: 12, max: 16 });
    expect(greenOf(bands.bodyFatBands)).toEqual(
      expect.objectContaining({ min: 12, max: 16 }),
    );
    expect(bands.bodyFatBands).not.toEqual(without.bodyFatBands);
  });

  it("ignores a malformed target and keeps the default band", () => {
    const bands = buildTargetBands({
      ...profile,
      thresholdsJson: {
        BLOOD_PRESSURE_SYS: { min: 130, max: 120 },
        PULSE: { min: "fast", max: 60 },
        BODY_FAT: null,
      },
    });
    expect(bands).toEqual(without);
  });

  it("leaves the other metrics' bands alone", () => {
    const bands = buildTargetBands({
      ...profile,
      thresholdsJson: { BLOOD_PRESSURE_SYS: { min: 115, max: 125 } },
    });
    expect(bands.pulseBands).toEqual(without.pulseBands);
    expect(bands.bodyFatBands).toEqual(without.bodyFatBands);
    expect(bands.weightBands).toEqual(without.weightBands);
  });
});
