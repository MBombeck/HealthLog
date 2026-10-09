/**
 * The pure parts of a day's scores: the usual range stays on the score's own
 * scale and needs a week behind it, and a score leaves with its module.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";

import { dayScoreVisible, scoreBand } from "../scores";

const ALL_ON = Object.fromEntries(MODULE_KEYS.map((k) => [k, true])) as Record<
  ModuleKey,
  boolean
>;

describe("score band", () => {
  it("needs seven days before it is drawn", () => {
    expect(scoreBand([70, 71, 72, 70, 71, 72], 100)).toBeNull();
    expect(scoreBand([70, 71, 72, 70, 71, 72, 71], 100)).not.toBeNull();
  });

  it("stays inside the scale and on whole points for a 0 to 100 score", () => {
    const band = scoreBand([96, 99, 100, 98, 100, 97, 100, 99], 100)!;
    expect(band.hi).toBeLessThanOrEqual(100);
    expect(Number.isInteger(band.lo)).toBe(true);
    expect(Number.isInteger(band.hi)).toBe(true);
    expect(band.n).toBe(8);
  });

  it("reads a device strain to one decimal on its own scale", () => {
    const band = scoreBand([10.1, 11.3, 12.2, 9.8, 10.7, 11.9, 12.4], 21)!;
    expect(band.lo * 10).toBeCloseTo(Math.round(band.lo * 10));
    expect(band.hi).toBeLessThanOrEqual(21);
    expect(String(band.hi)).not.toMatch(/\d\.\d{2,}/);
  });

  it("keeps the edges apart when every day was the same", () => {
    const band = scoreBand([70, 70, 70, 70, 70, 70, 70], 100)!;
    expect(band.hi).toBeGreaterThan(band.lo);
  });
});

describe("score modules", () => {
  it("takes readiness, recovery and strain out with the recovery module", () => {
    const modules = { ...ALL_ON, recovery: false };
    expect(dayScoreVisible("readiness", modules)).toBe(false);
    expect(dayScoreVisible("recovery", modules)).toBe(false);
    expect(dayScoreVisible("strain", modules)).toBe(false);
    expect(dayScoreVisible("sleepScore", modules)).toBe(true);
    expect(dayScoreVisible("healthScore", modules)).toBe(true);
  });

  it("takes the sleep score out with the sleep module, and never the health score", () => {
    const modules = { ...ALL_ON, sleep: false };
    expect(dayScoreVisible("sleepScore", modules)).toBe(false);
    expect(dayScoreVisible("healthScore", modules)).toBe(true);
  });
});
