import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

import { computeBmi, classifyBmi } from "../bmi";

const NOW = new Date("2026-06-02T07:00:00Z");

beforeEach(() => vi.clearAllMocks());

describe("classifyBmi (WHO)", () => {
  it("underweight < 18.5 (yellow)", () => {
    expect(classifyBmi(17)).toEqual({
      category: "underweight",
      band: "yellow",
    });
  });
  it("normal 18.5–24.9 (green)", () => {
    expect(classifyBmi(22)).toEqual({ category: "normal", band: "green" });
  });
  it("overweight 25–29.9 (yellow)", () => {
    expect(classifyBmi(27)).toEqual({ category: "overweight", band: "yellow" });
  });
  it("obese ≥ 30 (red)", () => {
    expect(classifyBmi(31)).toEqual({ category: "obese", band: "red" });
  });
  it("puts each WHO cut-off in the upper category, every obesity grade obese", () => {
    expect(classifyBmi(18.5).category).toBe("normal");
    expect(classifyBmi(25).category).toBe("overweight");
    expect(classifyBmi(30).category).toBe("obese");
    expect(classifyBmi(45)).toEqual({ category: "obese", band: "red" });
  });
});

describe("computeBmi", () => {
  it("insufficient with no height on profile (never reads weight)", async () => {
    const r = await computeBmi(
      "u1",
      { ageYears: 40, sex: "MALE", heightCm: null },
      { now: NOW },
    );
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient")
      expect(r.reason).toBe("no_height_on_profile");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("insufficient when height present but no recent weight", async () => {
    findMany.mockResolvedValueOnce([]);
    const r = await computeBmi(
      "u1",
      { ageYears: 40, sex: "MALE", heightCm: 180 },
      { now: NOW },
    );
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient")
      expect(r.reason).toBe("no_weight_in_window");
  });

  it("ok exact BMI from weight + height", async () => {
    findMany.mockResolvedValueOnce([{ value: 80 }]);
    const r = await computeBmi(
      "u1",
      { ageYears: 40, sex: "MALE", heightCm: 180 },
      { now: NOW },
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      // 80 / 1.8^2 = 24.69 → rounded to 24.7
      expect(r.value.bmi).toBe(24.7);
      expect(r.value.category).toBe("normal");
      expect(r.value.band).toBe("green");
      expect(r.value.weightKg).toBe(80);
      expect(r.value.heightCm).toBe(180);
      expect(r.confidence.score).toBeGreaterThan(0);
    }
  });

  it("derives a trailing BMI series from the recent weights (oldest → newest)", async () => {
    // Weights are read newest-first; the series trails oldest → newest.
    findMany.mockResolvedValueOnce([
      { value: 80 },
      { value: 81 },
      { value: 82 },
    ]);
    const r = await computeBmi(
      "u1",
      { ageYears: 40, sex: "MALE", heightCm: 180 },
      { now: NOW },
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      // 82,81,80 kg / 1.8² → 25.3, 25.0, 24.7, reversed to oldest → newest.
      expect(r.value.series).toEqual([25.3, 25, 24.7]);
    }
  });
});
