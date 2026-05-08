import { describe, expect, it } from "vitest";
import {
  createMeasurementSchema,
  getUnitForType,
  validateMeasurementRange,
} from "../measurement";

describe("measurement validation", () => {
  describe("getUnitForType", () => {
    it("returns canonical unit for each measurement type", () => {
      expect(getUnitForType("WEIGHT")).toBe("kg");
      expect(getUnitForType("BLOOD_PRESSURE_SYS")).toBe("mmHg");
      expect(getUnitForType("BLOOD_PRESSURE_DIA")).toBe("mmHg");
      expect(getUnitForType("PULSE")).toBe("bpm");
      expect(getUnitForType("BODY_FAT")).toBe("%");
      expect(getUnitForType("SLEEP_DURATION")).toBe("hours");
      expect(getUnitForType("ACTIVITY_STEPS")).toBe("steps");
      expect(getUnitForType("BLOOD_GLUCOSE")).toBe("mg/dL");
      expect(getUnitForType("TOTAL_BODY_WATER")).toBe("kg");
      expect(getUnitForType("BONE_MASS")).toBe("kg");
    });

    it("returns 'unknown' for unrecognised types", () => {
      expect(getUnitForType("MADE_UP_TYPE")).toBe("unknown");
    });
  });

  describe("validateMeasurementRange", () => {
    it("rejects values below the plausible minimum", () => {
      expect(validateMeasurementRange("WEIGHT", 0.5)).toMatch(/between/i);
      expect(validateMeasurementRange("BONE_MASS", 0.1)).toMatch(/between/i);
      expect(validateMeasurementRange("TOTAL_BODY_WATER", 1)).toMatch(
        /between/i,
      );
    });

    it("rejects values above the plausible maximum", () => {
      expect(validateMeasurementRange("WEIGHT", 600)).toMatch(/between/i);
      expect(validateMeasurementRange("BONE_MASS", 12)).toMatch(/between/i);
      expect(validateMeasurementRange("TOTAL_BODY_WATER", 200)).toMatch(
        /between/i,
      );
    });

    it("accepts values inside the plausible range", () => {
      expect(validateMeasurementRange("WEIGHT", 75)).toBeNull();
      expect(validateMeasurementRange("BONE_MASS", 3.0)).toBeNull();
      expect(validateMeasurementRange("TOTAL_BODY_WATER", 42)).toBeNull();
    });

    it("returns null for unknown types (no range = no opinion)", () => {
      expect(validateMeasurementRange("MADE_UP_TYPE", 9999)).toBeNull();
    });
  });

  describe("createMeasurementSchema", () => {
    const validBase = {
      value: 75,
      measuredAt: "2026-04-27T08:00:00.000Z",
    };

    it("accepts a TOTAL_BODY_WATER measurement without glucoseContext", () => {
      const parsed = createMeasurementSchema.safeParse({
        ...validBase,
        type: "TOTAL_BODY_WATER",
        value: 42,
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts a BONE_MASS measurement without glucoseContext", () => {
      const parsed = createMeasurementSchema.safeParse({
        ...validBase,
        type: "BONE_MASS",
        value: 3.2,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects out-of-range values for body composition types", () => {
      const tooMuchWater = createMeasurementSchema.safeParse({
        ...validBase,
        type: "TOTAL_BODY_WATER",
        value: 500,
      });
      expect(tooMuchWater.success).toBe(false);

      const tooLittleBone = createMeasurementSchema.safeParse({
        ...validBase,
        type: "BONE_MASS",
        value: 0.1,
      });
      expect(tooLittleBone.success).toBe(false);
    });

    it("rejects glucoseContext on non-glucose measurements", () => {
      const parsed = createMeasurementSchema.safeParse({
        ...validBase,
        type: "TOTAL_BODY_WATER",
        value: 42,
        glucoseContext: "FASTING",
      });
      expect(parsed.success).toBe(false);
    });

    it("requires glucoseContext on BLOOD_GLUCOSE measurements", () => {
      const parsed = createMeasurementSchema.safeParse({
        ...validBase,
        type: "BLOOD_GLUCOSE",
        value: 95,
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects unrecognised measurement types", () => {
      const parsed = createMeasurementSchema.safeParse({
        ...validBase,
        type: "TBD_NEW_TYPE",
        value: 1,
      });
      expect(parsed.success).toBe(false);
    });
  });
});
