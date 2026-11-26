import { describe, expect, it } from "vitest";

import {
  DEVICE_RECOVERY_LABEL_KEYS,
  DEVICE_SLEEP_SCORE_LABEL_KEYS,
  deviceRecoveryOf,
  deviceSourceOf,
  polarRechargeStatus,
  type ScoreRow,
} from "../device-score-rows";

const NOW = new Date("2026-11-25T08:00:00Z");
const day = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** Newest first, as the list read answers. */
function rows(spec: Array<[string, number, number]>): ScoreRow[] {
  return spec.map(([source, value, daysAgo]) => ({
    source,
    value,
    measuredAt: day(daysAgo),
  }));
}

describe("deviceRecoveryOf", () => {
  it("never shows HealthLog's stored readiness as a device's recovery", () => {
    expect(
      deviceRecoveryOf(
        rows([
          ["COMPUTED", 70, 0],
          ["COMPUTED", 65, 1],
        ]),
      ),
    ).toBeNull();
  });

  it("names the device and takes its latest row, never the proxy's", () => {
    const recovery = deviceRecoveryOf(
      rows([
        ["COMPUTED", 90, 0],
        ["WHOOP", 63, 0],
        ["COMPUTED", 88, 1],
        ["WHOOP", 58, 1],
        ["WHOOP", 71, 2],
        ["WHOOP", 40, 20],
      ]),
    );
    expect(recovery?.source).toBe("WHOOP");
    expect(recovery?.labelKey).toBe("measurements.typeRecoveryScoreWhoop");
    expect(recovery?.latest.value).toBe(63);
  });

  it("follows the newest device when two have written", () => {
    const recovery = deviceRecoveryOf(
      rows([
        ["OURA", 80, 0],
        ["WHOOP", 63, 3],
      ]),
    );
    expect(recovery?.source).toBe("OURA");
    expect(recovery?.latest.value).toBe(80);
  });
});

describe("device score labels", () => {
  it("label every recovery and sleep-score source by its own name", () => {
    expect(Object.keys(DEVICE_RECOVERY_LABEL_KEYS).sort()).toEqual([
      "OURA",
      "POLAR",
      "WHOOP",
    ]);
    expect(Object.keys(DEVICE_SLEEP_SCORE_LABEL_KEYS).sort()).toEqual([
      "GARMIN",
      "OURA",
      "WITHINGS",
    ]);
    expect(
      deviceSourceOf(
        rows([
          ["COMPUTED", 70, 0],
          ["GARMIN", 82, 1],
        ]),
        DEVICE_SLEEP_SCORE_LABEL_KEYS,
      ),
    ).toBe("GARMIN");
  });

  it("shows Polar's Nightly Recharge on its own 1 to 6 scale again", () => {
    // Stored as (status - 1) / 5 * 100 (`polar/map.ts`).
    expect(polarRechargeStatus(0)).toBe(1);
    expect(polarRechargeStatus(60)).toBe(4);
    expect(polarRechargeStatus(100)).toBe(6);
  });
});
