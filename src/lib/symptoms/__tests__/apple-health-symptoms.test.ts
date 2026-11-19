/**
 * The pure half of the Apple Health symptom import: the built-in code list
 * and the per-entry checks that need no database.
 *
 * Mutation checks (each run, each seen red):
 *   - accept a non-integer intensity → "skips an intensity off the 0-10
 *     integer scale" goes red;
 *   - store `endAt` equal to the start → "stores a moment without an end"
 *     goes red;
 *   - drop a code from `SYMPTOM_BUILTINS` → "carries the 39 codes" goes red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { locales } from "@/lib/i18n/config";
import { resolveKey } from "@/lib/i18n/resolve-key";
import { classifySymptomEntry } from "../apple-health-ingest";
import {
  isSymptomBuiltinCode,
  SYMPTOM_BUILTIN_CODES,
  SYMPTOM_BUILTINS,
  symptomBuiltinLabelKey,
} from "../builtin";
import { SYMPTOM_ICON_ALLOWLIST } from "../shared";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");

function entry(overrides: Partial<Parameters<typeof classifySymptomEntry>[0]>) {
  return {
    code: "FEVER",
    occurredAt: new Date("2026-11-19T07:00:00.000Z"),
    intensity: 6,
    externalId: "A0000000-0000-4000-8000-000000000001",
    source: "APPLE_HEALTH",
    ...overrides,
  };
}

describe("the built-in codes", () => {
  it("carries the 39 codes, the eleven cycle types among them", () => {
    expect(SYMPTOM_BUILTIN_CODES).toHaveLength(39);
    for (const code of [
      "FEVER",
      "HOT_FLASHES",
      "NIGHT_SWEATS",
      "HEADACHE",
      "NAUSEA",
      "ABDOMINAL_CRAMPS",
      "FATIGUE",
    ]) {
      expect(isSymptomBuiltinCode(code), code).toBe(true);
    }
    expect(isSymptomBuiltinCode("SNEEZING")).toBe(false);
    expect(isSymptomBuiltinCode("toString")).toBe(false);
  });

  it("names a HealthKit type and an allowed icon for each", () => {
    const icons = new Set<string>(SYMPTOM_ICON_ALLOWLIST);
    for (const code of SYMPTOM_BUILTIN_CODES) {
      const { hkSuffix, icon } = SYMPTOM_BUILTINS[code];
      expect(icons.has(icon), code).toBe(true);
      // The code is the suffix in SCREAMING_SNAKE_CASE.
      expect(hkSuffix.replace(/(?<!^)([A-Z])/g, "_$1").toUpperCase()).toBe(
        code,
      );
    }
  });

  it("has a label in every shipped language", () => {
    for (const locale of locales) {
      const bundle = JSON.parse(
        readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
      ) as Record<string, unknown>;
      for (const code of SYMPTOM_BUILTIN_CODES) {
        const label = resolveKey(bundle, symptomBuiltinLabelKey(code));
        expect(typeof label, `${locale} ${code}`).toBe("string");
        expect(
          (label as string).length,
          `${locale} ${code}`,
        ).toBeLessThanOrEqual(40);
      }
    }
  });
});

describe("classifySymptomEntry", () => {
  it("accepts a well-formed sample", () => {
    expect(classifySymptomEntry(entry({}), 3, NOW)).toEqual({
      index: 3,
      code: "FEVER",
      externalId: "A0000000-0000-4000-8000-000000000001",
      occurredAt: new Date("2026-11-19T07:00:00.000Z"),
      endAt: null,
      intensity: 6,
    });
  });

  it("skips anything but an Apple Health sample", () => {
    expect(classifySymptomEntry(entry({ source: "MANUAL" }), 0, NOW)).toEqual({
      skip: "unsupported_source",
    });
  });

  it("skips an unknown code", () => {
    expect(classifySymptomEntry(entry({ code: "SNEEZING" }), 0, NOW)).toEqual({
      skip: "unknown_code",
    });
  });

  it("skips an intensity off the 0-10 integer scale", () => {
    for (const intensity of [-1, 11, 2.5]) {
      expect(
        classifySymptomEntry(entry({ intensity }), 0, NOW),
        String(intensity),
      ).toEqual({ skip: "value_out_of_range" });
    }
    expect(
      "skip" in classifySymptomEntry(entry({ intensity: 0 }), 0, NOW),
    ).toBe(false);
    expect(
      "skip" in classifySymptomEntry(entry({ intensity: 10 }), 0, NOW),
    ).toBe(false);
  });

  it("skips a time in the future, before 1900, or ending before it began", () => {
    const cases = [
      { occurredAt: new Date(NOW + 6 * 60_000) },
      { occurredAt: new Date("1899-12-31T23:59:59.000Z") },
      {
        occurredAt: new Date("2026-11-19T07:00:00.000Z"),
        endAt: new Date("2026-11-19T06:00:00.000Z"),
      },
      {
        occurredAt: new Date("2026-11-19T07:00:00.000Z"),
        endAt: new Date(NOW + 6 * 60_000),
      },
    ];
    for (const c of cases) {
      expect(classifySymptomEntry(entry(c), 0, NOW)).toEqual({
        skip: "implausible_timestamp",
      });
    }
    // Within the shared five-minute skew is fine.
    expect(
      "skip" in
        classifySymptomEntry(
          entry({ occurredAt: new Date(NOW + 60_000) }),
          0,
          NOW,
        ),
    ).toBe(false);
  });

  it("stores a moment without an end, and a span with one", () => {
    const start = new Date("2026-11-19T07:00:00.000Z");
    const moment = classifySymptomEntry(
      entry({ occurredAt: start, endAt: new Date(start) }),
      0,
      NOW,
    );
    expect(moment).toMatchObject({ endAt: null });
    const end = new Date("2026-11-19T09:00:00.000Z");
    expect(
      classifySymptomEntry(entry({ occurredAt: start, endAt: end }), 0, NOW),
    ).toMatchObject({ endAt: end });
  });

  it("skips an id that cannot be stable, naming its shape", () => {
    expect(
      classifySymptomEntry(
        entry({ externalId: "<HKCategorySample: 0x600003a1c0f0>" }),
        0,
        NOW,
      ),
    ).toEqual({ skip: "unstable_external_id", shape: "object_description" });
  });
});
