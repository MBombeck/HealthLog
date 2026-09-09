/**
 * Structural guard on the Apple Health mapping table's unit column
 * (issue #944).
 *
 * `AppleHealthMapping.hkUnit` records the unit HealthLog ASSUMES a
 * HealthKit reading arrives in, and `convertToDbUnit` is written against
 * that assumption. Apple's `export.xml` does not honour it: every quantity
 * `<Record>` carries the account's own display unit, so a metric archive
 * reports walking distance in `km` and an imperial one in `mi`. For ten
 * years those readings were stored as if the number were already metres —
 * the whole history understated by a factor of a thousand — because the
 * mapper accepted `input.unit` and never read it.
 *
 * So an entry now has exactly two legal shapes:
 *
 *   1. its `hkUnit` is one `convertHkValue()` knows a factor for, in which
 *      case `mapAppleHealthEntry()` converts a differing record unit into
 *      it before `convertToDbUnit` runs; or
 *   2. it carries a written `unitFixedReason` saying why no unit attribute
 *      Apple could write would change the reading (a dimensionless count,
 *      a pinned event, a logarithmic dB level, a compound rate).
 *
 * The conversion is opt-in per caller (`convertRecordUnit`), and only the
 * archive path opts in: `POST /api/measurements/batch` documents its `unit`
 * as captured-not-validated and nothing pins the native client's strings.
 * The last block below holds that boundary, so the batch contract cannot be
 * widened by accident.
 *
 * The reason arm alone would be a guard that cannot fail: an entry could
 * declare a convertible unit while the mapper quietly ignored it. The
 * behavioural block below therefore feeds every convertible entry a
 * reading in a SIBLING unit and asserts the stored number moved by the
 * documented factor — so deleting the conversion turns this guard red,
 * not just the one reproduction test.
 *
 * A tripwire, not a proof: a reviewer who waves through a wrong factor
 * defeats it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  APPLE_HEALTH_TYPE_MAP,
  mapAppleHealthEntry,
} from "@/lib/measurements/apple-health-mapping";
import {
  convertHkValue,
  isConvertibleHkUnit,
} from "@/lib/measurements/hk-units";

const ENTRIES = Object.values(APPLE_HEALTH_TYPE_MAP);

/**
 * Units from every family the table touches. The behavioural block picks
 * the first one that converts into an entry's `hkUnit` and actually moves
 * the number, so a new family only needs one representative here.
 */
const SIBLING_UNITS = [
  "km",
  "mi",
  "cm",
  "lb",
  "st",
  "kJ",
  "cal",
  "degF",
  "K",
  "mmol<180.156>/L",
  "kPa",
  "km/hr",
  "hr",
  "ms",
];

function siblingUnitFor(hkUnit: string): string | null {
  for (const candidate of SIBLING_UNITS) {
    const converted = convertHkValue(1, candidate, hkUnit);
    if (converted !== null && converted !== 1) return candidate;
  }
  return null;
}

describe("Apple Health mapping — the record's own unit (issue #944)", () => {
  it("examines the whole mapping table", () => {
    // An empty match set is the failure mode this repo keeps rediscovering:
    // a guard is green because it matched nothing, not because nothing is
    // wrong. Pin the floor.
    expect(ENTRIES.length).toBeGreaterThan(40);
  });

  it.each(ENTRIES)(
    "$hkIdentifier either converts its record unit or says why it cannot",
    (mapping) => {
      if (isConvertibleHkUnit(mapping.hkUnit)) {
        expect(mapping.unitFixedReason).toBeUndefined();
        return;
      }
      expect(
        mapping.unitFixedReason,
        `${mapping.hkIdentifier} pins hkUnit "${mapping.hkUnit}" with no conversion and no written reason`,
      ).toBeTypeOf("string");
      // Long enough to be a sentence rather than a shrug.
      expect(mapping.unitFixedReason!.length).toBeGreaterThan(40);
    },
  );

  const convertible = ENTRIES.filter((mapping) =>
    isConvertibleHkUnit(mapping.hkUnit),
  );

  it("has convertible entries to exercise", () => {
    expect(convertible.length).toBeGreaterThan(10);
  });

  it.each(convertible)(
    "$hkIdentifier honours a sibling unit on the record itself",
    (mapping) => {
      const sibling = siblingUnitFor(mapping.hkUnit);
      expect(
        sibling,
        `no sibling unit listed for the family of "${mapping.hkUnit}"`,
      ).not.toBeNull();

      const base = {
        hkIdentifier: mapping.hkIdentifier,
        value: 2,
        startDate: "2026-05-14T08:00:00.000Z",
        endDate: "2026-05-14T08:30:00.000Z",
      };
      const native = mapAppleHealthEntry(
        { ...base, unit: mapping.hkUnit },
        { convertRecordUnit: true },
      );
      const foreign = mapAppleHealthEntry(
        { ...base, unit: sibling! },
        { convertRecordUnit: true },
      );
      expect(native).not.toBeNull();
      expect(foreign).not.toBeNull();

      const expected = mapping.convertToDbUnit(
        convertHkValue(2, sibling!, mapping.hkUnit)!,
      );
      expect(foreign!.value).toBeCloseTo(expected, 9);
      expect(foreign!.value).not.toBeCloseTo(native!.value, 9);
    },
  );

  it("keeps a unit it cannot place from rescaling the reading", () => {
    const out = mapAppleHealthEntry(
      {
        hkIdentifier: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        value: 1234,
        unit: "furlong",
        startDate: "2026-05-14T08:00:00.000Z",
        endDate: "2026-05-14T08:30:00.000Z",
      },
      { convertRecordUnit: true },
    );
    expect(out?.value).toBe(1234);
  });

  it("leaves the batch path's readings alone whatever unit they name", () => {
    // The batch contract: `unit` is captured, never read. Every convertible
    // entry has to behave that way by DEFAULT, or a native client stamping
    // the person's display unit silently rescales their history.
    for (const mapping of convertible) {
      const sibling = siblingUnitFor(mapping.hkUnit);
      if (!sibling) continue;
      const base = {
        hkIdentifier: mapping.hkIdentifier,
        value: 2,
        startDate: "2026-05-14T08:00:00.000Z",
        endDate: "2026-05-14T08:30:00.000Z",
      };
      const declared = mapAppleHealthEntry({ ...base, unit: mapping.hkUnit });
      const foreign = mapAppleHealthEntry({ ...base, unit: sibling });
      expect(declared).not.toBeNull();
      expect(
        foreign!.value,
        `${mapping.hkIdentifier} rescaled a batch reading from "${sibling}"`,
      ).toBeCloseTo(declared!.value, 9);
    }
  });

  it("has only the archive path opting into the conversion", () => {
    // A grep, not a proof — but the wire change this pins is exactly the
    // kind that lands as a one-word argument in an unrelated diff.
    const optIn = "convertRecordUnit: true";
    const archive = readFileSync(
      join(process.cwd(), "src/lib/measurements/import-apple-health-export.ts"),
      "utf8",
    );
    expect(archive).toContain(optIn);
    const batch = readFileSync(
      join(process.cwd(), "src/app/api/measurements/batch/route.ts"),
      "utf8",
    );
    expect(
      batch,
      "the batch route opted into record-unit conversion",
    ).not.toContain("convertRecordUnit");
  });

  it("leaves the km/mi factors in one shared module", () => {
    // The workout path used to carry its own copy of the km/mi branch; the
    // duplicate is what let the `<Record>` path stay wrong for ten years.
    //
    // `* 1000` alone is not the offence — these files also turn seconds into
    // milliseconds — so a rescale only counts when it stands in a LENGTH
    // context: a distance identifier on the same line, or within the five
    // lines above it (which covers a rescale in the body of a
    // distance-named helper). The limit is the usual one for a matcher of
    // this shape: a length conversion inside a helper named nothing like a
    // distance, more than five lines below its own signature, slips it.
    const shared = join(process.cwd(), "src/lib/measurements/hk-units.ts");
    const owners = [
      "src/lib/measurements/apple-health-mapping.ts",
      "src/lib/measurements/import-apple-health-export.ts",
    ];
    expect(readFileSync(shared, "utf8")).toContain("1609.344");

    const RESCALE = /\*\s*1_?000(?!\d)/;
    const LENGTH = /distance|metre|meter|\bkm\b/i;
    for (const rel of owners) {
      const source = readFileSync(join(process.cwd(), rel), "utf8");
      expect(source, `${rel} re-implements the mile factor`).not.toContain(
        "1609.344",
      );
      const lines = source.split("\n");
      const offenders = lines
        .map((line, i) => ({ line, i }))
        .filter(
          ({ line, i }) =>
            RESCALE.test(line) &&
            lines.slice(Math.max(0, i - 5), i + 1).some((l) => LENGTH.test(l)),
        )
        .map(({ line, i }) => `${rel}:${i + 1}: ${line.trim()}`);
      expect(
        offenders,
        `${rel} re-implements a length factor — the km/mi conversion belongs in hk-units.ts`,
      ).toEqual([]);
    }
  });
});
