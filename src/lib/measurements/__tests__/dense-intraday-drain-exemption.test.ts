/**
 * v1.10.0 — computed scores (WX-E). Dense intra-day retention DRAIN-EXEMPTION
 * regression guard.
 *
 * LOAD-BEARING — a regression here is silent and irreversible.
 *
 * The Stress engine reads the intra-day SDNN (and daytime HR) SHAPE across
 * the day, not a single daily mean. The destructive daily-mean drain
 * (`consolidateDailyMean`) collapses a day's per-sample rows for every type
 * in its allowlist (`HIGH_FREQUENCY_MEAN_TYPES`) to ONE daily mean and
 * SOFT-DELETES the raw rows. If `HEART_RATE_VARIABILITY` (or the daytime
 * `PULSE` the engine relies on) were ever added to that allowlist, the
 * intra-day shape Stress needs would be destroyed the next night the drain
 * ran — and the raw rows would be gone for good.
 *
 * This test pins both exclusions so a future edit that adds either type to
 * the drain's allowlist fails CI loudly. The dense intra-day retention tier
 * (`dense-intraday-retention.ts`) is the ONLY pass allowed to fold these
 * types, and it does so behind a bounded window that preserves the recent
 * intra-day samples.
 */
import { describe, expect, it } from "vitest";
import type { MeasurementType } from "@/generated/prisma/client";

import {
  CUMULATIVE_HK_TYPES,
  HIGH_FREQUENCY_MEAN_TYPES,
} from "../apple-health-mapping";
import { DENSE_INTRADAY_RETENTION_TYPES } from "../dense-intraday-sources";

describe("dense intra-day retention — drain exemption (WX-E)", () => {
  it("EXEMPTS HEART_RATE_VARIABILITY from the destructive daily-mean drain", () => {
    // If this fails, the nightly daily-mean drain will collapse intra-day
    // SDNN to a single daily mean + soft-delete the raw rows, destroying the
    // shape the Stress engine reads. The dense-tier retention drain is the
    // only pass allowed to fold HRV, and only out-of-window samples.
    expect(
      HIGH_FREQUENCY_MEAN_TYPES.has(
        "HEART_RATE_VARIABILITY" as MeasurementType,
      ),
    ).toBe(false);
  });

  it("EXEMPTS PULSE from the destructive daily-mean drain", () => {
    expect(HIGH_FREQUENCY_MEAN_TYPES.has("PULSE" as MeasurementType)).toBe(
      false,
    );
  });

  it("EXEMPTS OXYGEN_SATURATION from the destructive daily-mean drain", () => {
    // SpO2 is folded ONLY by the dense tier (bounded window, min/max
    // preserved). If it were added to HIGH_FREQUENCY_MEAN_TYPES too, both
    // drains would fold it and the overnight-desaturation nadir (the daily
    // MIN) would be lost the next night the mean drain ran.
    expect(
      HIGH_FREQUENCY_MEAN_TYPES.has("OXYGEN_SATURATION" as MeasurementType),
    ).toBe(false);
  });

  it("EXEMPTS both dense-tier types from the cumulative (SUM) drain too", () => {
    // HRV / HR are spot signals, never cumulative — they must not be in the
    // SUM drain either, which would also collapse + hard-delete them.
    for (const type of DENSE_INTRADAY_RETENTION_TYPES) {
      expect(CUMULATIVE_HK_TYPES.has(type)).toBe(false);
    }
  });

  it("scopes the dense tier to exactly HEART_RATE_VARIABILITY + PULSE + OXYGEN_SATURATION", () => {
    expect(Array.from(DENSE_INTRADAY_RETENTION_TYPES).sort()).toEqual(
      ["HEART_RATE_VARIABILITY", "PULSE", "OXYGEN_SATURATION"].sort(),
    );
  });

  it("keeps the dense tier strictly disjoint from the daily-mean drain", () => {
    // The two passes must never overlap: the daily-mean drain would destroy
    // the intra-day shape; the dense tier preserves it behind a window.
    for (const type of DENSE_INTRADAY_RETENTION_TYPES) {
      expect(HIGH_FREQUENCY_MEAN_TYPES.has(type)).toBe(false);
    }
  });
});
