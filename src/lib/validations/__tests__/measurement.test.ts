import { describe, expect, it } from "vitest";
import {
  createMeasurementSchema,
  getUnitForType,
  listMeasurementsSchema,
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
      // v1.4.23 — sleep duration shifted from hours to minutes so per-stage
      // HealthKit category samples can be stored without precision loss.
      expect(getUnitForType("SLEEP_DURATION")).toBe("minutes");
      expect(getUnitForType("ACTIVITY_STEPS")).toBe("steps");
      expect(getUnitForType("BLOOD_GLUCOSE")).toBe("mg/dL");
      expect(getUnitForType("TOTAL_BODY_WATER")).toBe("kg");
      expect(getUnitForType("BONE_MASS")).toBe("kg");
      // ── v1.4.23 Apple Health canonical units ──
      expect(getUnitForType("HEART_RATE_VARIABILITY")).toBe("ms");
      expect(getUnitForType("RESTING_HEART_RATE")).toBe("bpm");
      expect(getUnitForType("ACTIVE_ENERGY_BURNED")).toBe("kcal");
      expect(getUnitForType("FLIGHTS_CLIMBED")).toBe("flights");
      expect(getUnitForType("WALKING_RUNNING_DISTANCE")).toBe("m");
      expect(getUnitForType("VO2_MAX")).toBe("mL/(kg·min)");
      expect(getUnitForType("BODY_TEMPERATURE")).toBe("celsius");
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

    // v1.4.25 W10 reconcile (code-review M4): `deviceType` was a
    // batch-only field; the single-entry schema silently dropped it.
    // Now it parses through so the column is populated whether the
    // client posts one row or many.
    it("accepts an optional deviceType tag and surfaces it on the parsed value", () => {
      const parsed = createMeasurementSchema.safeParse({
        ...validBase,
        type: "WEIGHT",
        value: 82,
        deviceType: "scale",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.deviceType).toBe("scale");
      }
    });

    it("accepts a null deviceType so a client can explicitly clear the column", () => {
      const parsed = createMeasurementSchema.safeParse({
        ...validBase,
        type: "WEIGHT",
        value: 82,
        deviceType: null,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.deviceType).toBeNull();
      }
    });

    it("treats a missing deviceType as undefined (back-compat with pre-W10 clients)", () => {
      const parsed = createMeasurementSchema.safeParse({
        ...validBase,
        type: "WEIGHT",
        value: 82,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.deviceType).toBeUndefined();
      }
    });
  });

  // v1.4.37 W7c — list-view "one row per day" mode for cumulative
  // types. The schema pins the optional `groupBy` enum + `dayKey`
  // shape; the route gates each branch on whether the resolved type
  // is in `CUMULATIVE_HK_TYPES`. Tests below pin the parser surface.
  describe("listMeasurementsSchema — v1.4.37 W7c groupBy + dayKey", () => {
    it("accepts an omitted groupBy + dayKey (legacy per-sample list)", () => {
      const parsed = listMeasurementsSchema.safeParse({});
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.groupBy).toBeUndefined();
        expect(parsed.data.dayKey).toBeUndefined();
      }
    });

    it("accepts groupBy=day", () => {
      const parsed = listMeasurementsSchema.safeParse({
        type: "ACTIVITY_STEPS",
        groupBy: "day",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.groupBy).toBe("day");
      }
    });

    it("rejects an unknown groupBy value", () => {
      const parsed = listMeasurementsSchema.safeParse({
        type: "ACTIVITY_STEPS",
        groupBy: "week",
      });
      expect(parsed.success).toBe(false);
    });

    it("accepts a well-formed YYYY-MM-DD dayKey", () => {
      const parsed = listMeasurementsSchema.safeParse({
        type: "ACTIVITY_STEPS",
        dayKey: "2026-05-15",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.dayKey).toBe("2026-05-15");
      }
    });

    it("rejects a malformed dayKey (DD.MM.YYYY)", () => {
      const parsed = listMeasurementsSchema.safeParse({
        type: "ACTIVITY_STEPS",
        dayKey: "15.05.2026",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects a partial dayKey (missing day component)", () => {
      const parsed = listMeasurementsSchema.safeParse({
        type: "ACTIVITY_STEPS",
        dayKey: "2026-05",
      });
      expect(parsed.success).toBe(false);
    });
  });
});
