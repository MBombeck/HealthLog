/**
 * A device's score is named after the source of its row, never after
 * the measurement type, and shown on the vendor's own scale.
 *
 * Pins the register (`recoverySourceLabel`, `recoverySourceLabelEn`,
 * `vendorScoreScale`) and the morning read's source values
 * (`toDeviceSourceValue`) to the same names and the same Polar scale, so the
 * doctor report, the clinician view and the morning card cannot disagree.
 */
import { describe, expect, it } from "vitest";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { locales } from "@/lib/i18n/config";
import {
  isProxyRecovery,
  recoverySourceLabel,
  recoverySourceLabelEn,
  vendorScoreScale,
} from "@/lib/scores/registry";
import { isProxyRecovery as reExported } from "@/lib/insights/derived/recovery-resolve";
import { toDeviceSourceValue } from "@/lib/daily/morning-load";

const en = getServerTranslator("en").t;
const de = getServerTranslator("de").t;
const AT = new Date("2026-11-25T06:30:00Z");

function row(type: string, source: string, value: number) {
  return { type, source, value, measuredAt: AT, timeZone: null };
}

describe("recovery is named by its source", () => {
  it("names the computed proxy as HealthLog's readiness, in every language", () => {
    expect(recoverySourceLabel("COMPUTED", en)).toBe("Readiness (HealthLog)");
    expect(recoverySourceLabel("COMPUTED", de)).toBe(
      "Bereitschaft (HealthLog)",
    );
    expect(recoverySourceLabelEn("COMPUTED")).toBe("Readiness (HealthLog)");
    for (const locale of locales) {
      const t = getServerTranslator(locale).t;
      expect(recoverySourceLabel("COMPUTED", t)).toBe(
        `${t("insights.derived.composite.READINESS.title")} (HealthLog)`,
      );
    }
  });

  it("names a device's recovery with the device's own term, never HealthLog's readiness", () => {
    const cases: Array<[string, string]> = [
      ["WHOOP", "WHOOP Recovery"],
      ["OURA", "Oura Readiness"],
      ["POLAR", "Polar Nightly Recharge"],
    ];
    for (const [source, term] of cases) {
      expect(recoverySourceLabelEn(source)).toBe(term);
      for (const t of [en, de]) {
        const label = recoverySourceLabel(source, t);
        expect(label).toBe(term);
        expect(label).not.toContain("Bereitschaft");
        expect(label).not.toContain("HealthLog");
      }
    }
    // A source without its own term still says whose number it is.
    expect(recoverySourceLabelEn("GARMIN")).toBe("Garmin recovery");
    expect(recoverySourceLabel("GARMIN", de)).toBe("Garmin Erholung");
  });

  it("agrees with the morning read's source values", () => {
    for (const source of ["WHOOP", "OURA", "POLAR", "GARMIN"]) {
      for (const t of [en, de]) {
        expect(
          toDeviceSourceValue(row("RECOVERY_SCORE", source, 80), t).label,
        ).toBe(recoverySourceLabel(source, t));
      }
    }
  });

  it("is the one proxy rule, re-exported beside the resolver", () => {
    expect(reExported).toBe(isProxyRecovery);
    expect(isProxyRecovery({ source: "COMPUTED" })).toBe(true);
    for (const source of ["WHOOP", "OURA", "POLAR", "GARMIN", "APPLE_HEALTH"])
      expect(isProxyRecovery({ source })).toBe(false);
  });
});

describe("vendor sleep scores are named by their source", () => {
  it("labels Oura, Garmin and Withings SLEEP_SCORE after the device", () => {
    for (const [source, name] of [
      ["OURA", "Oura"],
      ["GARMIN", "Garmin"],
      ["WITHINGS", "Withings"],
    ]) {
      const value = toDeviceSourceValue(row("SLEEP_SCORE", source, 84), de);
      expect(value.label).toBe(`${name} Schlafscore`);
      expect(value.scaleMax).toBe(100);
      expect(value.value).toBe(84);
      expect(vendorScoreScale("SLEEP_SCORE", source).scaleMax).toBe(100);
    }
  });
});

describe("Polar is shown on its own scale", () => {
  it("turns the stored 0..100 back into the 1 to 6 Nightly Recharge status", () => {
    const scale = vendorScoreScale("RECOVERY_SCORE", "POLAR");
    expect(scale.scaleMax).toBe(6);
    // Ingest maps status s to (s - 1) / 5 * 100.
    for (let status = 1; status <= 6; status++) {
      const stored = ((status - 1) / 5) * 100;
      expect(scale.toDisplay(stored)).toBe(status);
      const morning = toDeviceSourceValue(
        row("RECOVERY_SCORE", "POLAR", stored),
        en,
      );
      expect(morning.value).toBe(status);
      expect(morning.scaleMax).toBe(scale.scaleMax);
    }
    expect(vendorScoreScale("RECOVERY_SCORE", "WHOOP").scaleMax).toBe(100);
  });
});
