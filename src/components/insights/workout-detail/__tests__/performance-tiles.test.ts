import { describe, expect, it } from "vitest";

import en from "../../../../../messages/en.json";
import { performanceTiles } from "../performance-tiles";

function t(key: string, params?: Record<string, string | number>): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      en,
    );
  if (typeof value !== "string") return key;
  return value.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k]));
}

const NONE = {
  aerobicTrainingEffect: null,
  anaerobicTrainingEffect: null,
  trainingLoad: null,
  recoveryTimeMin: null,
  sweatLossMl: null,
  avgPowerW: null,
  avgVerticalOscillationMm: null,
  avgGroundContactTimeMs: null,
  avgGroundContactBalancePct: null,
};

describe("performanceTiles", () => {
  it("draws a tile only for a figure the source computed", () => {
    const tiles = performanceTiles(
      { ...NONE, aerobicTrainingEffect: 3, avgGroundContactBalancePct: 49.5 },
      t,
      "en",
    );
    expect(tiles.map((x) => [x.label, x.value])).toEqual([
      ["Aerobic training effect", "3.0"],
      ["Ground contact balance", "49.5\u00a0% L, 50.5\u00a0% R"],
    ]);
  });

  it("shows vertical oscillation in centimetres and recovery as a duration", () => {
    const tiles = performanceTiles(
      { ...NONE, avgVerticalOscillationMm: 103.5, recoveryTimeMin: 1899 },
      t,
      "en",
    );
    const byLabel = Object.fromEntries(tiles.map((x) => [x.label, x.value]));
    expect(byLabel["Vertical oscillation"]).toBe("10.4 cm");
    expect(byLabel["Recovery time"]).toMatch(/31/);
  });

  it("draws nothing for a workout without figures", () => {
    expect(performanceTiles(null, t, "en")).toEqual([]);
  });
});
