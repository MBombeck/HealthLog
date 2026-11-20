/**
 * The unit a reader sees beside a value is a symbol every locale shares or a
 * word from the bundle, never a storage token. "15,4 breaths/min" on a German
 * screen came from a tile that printed the canonical unit as it is stored.
 *
 * Two halves: every canonical unit resolves to a known symbol, nothing, or a
 * key present in all eight bundles; and no display source spells a word
 * unit as a literal prop.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  stripComments,
  walkSourceFiles,
} from "@/__tests__/helpers/source-files";
import {
  getDisplayTransform,
  TRANSFORMED_TYPES,
} from "@/lib/measurements/display-transform";
import {
  measurementUnitLabel,
  measurementUnitMetaLead,
} from "@/lib/measurements/unit-label";
import { getUnitForType } from "@/lib/measurements/unit-map";
import { measurementTypeEnum } from "@/lib/validations/measurement";

import de from "../../../../messages/de.json";
import en from "../../../../messages/en.json";
import es from "../../../../messages/es.json";
import fr from "../../../../messages/fr.json";
import it_ from "../../../../messages/it.json";
import ko from "../../../../messages/ko.json";
import nl from "../../../../messages/nl.json";
import pl from "../../../../messages/pl.json";

const BUNDLES = { de, en, es, fr, it: it_, ko, nl, pl } as const;

/**
 * Unit symbols that read the same in every supported language. A token
 * outside this set that is not resolved through the bundle is an English
 * word on a non-English screen.
 */
const SHARED_SYMBOLS: ReadonlySet<string> = new Set([
  "%",
  "kg",
  "lb",
  "g",
  "mmHg",
  "bpm",
  "ms",
  "mg/dL",
  "mmol/L",
  "kcal",
  "kJ",
  "m",
  "km",
  "mi",
  "ft",
  "cm",
  "in",
  "m/s",
  "km/h",
  "mph",
  "°C",
  "°F",
  "dBA",
  "ppm",
  "mL/(kg·min)",
  // Apple physical effort, a MET-like rate. The symbol is the unit.
  "kcal/(hr·kg)",
  "kg/m²",
  "mL",
  // Litres and litres per minute (spirometry), SI symbols every locale reads.
  "L",
  "L/min",
  "h",
  "min",
  "/ 5",
  "",
]);

const KEY_MARK = "key:";
const markKey = (key: string) => `${KEY_MARK}${key}`;

function resolve(bundle: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      bundle,
    );
}

describe("measurementUnitLabel", () => {
  const t = (key: string) => `t:${key}`;

  it("names what a count-shaped type counts", () => {
    expect(measurementUnitLabel("FLIGHTS_CLIMBED", "count", t)).toBe(
      "t:insights.units.flights",
    );
    expect(measurementUnitLabel("RESPIRATORY_RATE", "count/min", t)).toBe(
      "t:insights.units.respiratoryRate",
    );
  });

  it("localises a word-shaped canonical token", () => {
    expect(measurementUnitLabel("RESPIRATORY_RATE", "breaths/min", t)).toBe(
      "t:insights.units.respiratoryRate",
    );
    expect(measurementUnitLabel("VASCULAR_AGE", "years", t)).toBe(
      "t:insights.units.years",
    );
    expect(measurementUnitLabel("TIME_IN_DAYLIGHT", "minutes", t)).toBe(
      "t:insights.deviceScore.unitMinutes",
    );
  });

  it("passes a shared symbol through", () => {
    expect(measurementUnitLabel("WEIGHT", "kg", t)).toBe("kg");
    expect(measurementUnitLabel("SKIN_TEMPERATURE", "celsius", t)).toBe("°C");
  });

  it("drops the kind markers", () => {
    expect(measurementUnitLabel("RECOVERY_SCORE", "score", t)).toBe("");
    expect(measurementUnitLabel("VISCERAL_FAT", "rating", t)).toBe("");
    expect(measurementUnitLabel("SLEEP_DISTURBANCE_COUNT", "count", t)).toBe(
      "",
    );
  });

  it("leads a meta line only when there is a unit to show", () => {
    expect(measurementUnitMetaLead("WEIGHT", "kg", t)).toBe("kg · ");
    expect(measurementUnitMetaLead("PHQ9_SCORE", "score", t)).toBeNull();
  });
});

describe("every canonical unit reaches the reader in their language", () => {
  const types = measurementTypeEnum.options;

  it("walks the whole type list", () => {
    expect(types.length).toBeGreaterThan(60);
  });

  it.each(types)("%s resolves to a shared symbol or a bundle key", (type) => {
    const shown = [
      getUnitForType(type),
      ...(TRANSFORMED_TYPES.has(type)
        ? [
            getDisplayTransform(type, "metric").displayUnit,
            getDisplayTransform(type, "imperial").displayUnit,
          ]
        : []),
    ].map((unit) => measurementUnitLabel(type, unit, markKey));

    for (const label of shown) {
      if (label.startsWith(KEY_MARK)) {
        const key = label.slice(KEY_MARK.length);
        for (const [locale, bundle] of Object.entries(BUNDLES)) {
          expect(
            typeof resolve(bundle, key),
            `${type}: ${key} missing in ${locale}`,
          ).toBe("string");
        }
      } else {
        expect(
          SHARED_SYMBOLS.has(label),
          `${type} shows "${label}" as is. Give it a bundle key in unit-label.ts, or add it to SHARED_SYMBOLS if every locale reads it unchanged.`,
        ).toBe(true);
      }
    }
  });

  it("the German bundle does not spell the respiratory unit in English", () => {
    const t = (key: string) => String(resolve(de, key));
    expect(
      measurementUnitLabel("RESPIRATORY_RATE", "breaths/min", t),
    ).not.toMatch(/breaths/);
  });
});

describe("no display source spells a word unit as a literal", () => {
  const SRC = join(process.cwd(), "src");
  const roots = ["app", "components", "hooks"];
  // `unit="…"` as a prop or `unit: "…"` in an object literal.
  const LITERAL = /\bunit(?:=|:\s*)"([^"]*)"/g;

  const offenders: string[] = [];
  let scanned = 0;
  for (const root of roots) {
    const dir = join(SRC, root);
    for (const rel of walkSourceFiles(dir, {
      floor: root === "hooks" ? 50 : 500,
    })) {
      if (rel.includes("__tests__/") || rel.startsWith("api/")) continue;
      scanned += 1;
      const source = stripComments(readFileSync(join(dir, rel), "utf8"));
      for (const match of source.matchAll(LITERAL)) {
        if (!SHARED_SYMBOLS.has(match[1])) {
          offenders.push(`${root}/${rel}: unit "${match[1]}"`);
        }
      }
    }
  }

  it("reads the display tree", () => {
    expect(scanned).toBeGreaterThan(1000);
  });

  it("finds only shared symbols", () => {
    expect(offenders).toEqual([]);
  });

  it("would catch a word unit", () => {
    const planted = stripComments(`<Tile unit="breaths/min" />`);
    expect(
      [...planted.matchAll(LITERAL)]
        .map((m) => m[1])
        .filter((u) => !SHARED_SYMBOLS.has(u)),
    ).toEqual(["breaths/min"]);
  });
});

/**
 * A component that keeps its own table of unit words is a second source the
 * shared one cannot correct: three insight boards each mapped their display
 * kinds to `*.unit<Word>` bundle keys, and the German cycle board printed
 * "S/min" where every other screen says "bpm". A unit beside a measurement
 * value comes from `measurementUnitLabel`; an object literal holding two or
 * more unit-word keys is refused.
 */
describe("no display source keeps its own unit table", () => {
  const SRC = join(process.cwd(), "src");
  const roots = ["app", "components", "hooks"];
  const BLOCK = /=\s*\{([^{}]*)\}/g;
  const UNIT_KEY = /:\s*"[\w.]+\.unit[A-Z]\w*"/g;

  function unitTables(source: string): number[] {
    const sizes: number[] = [];
    for (const block of source.matchAll(BLOCK)) {
      const n = [...block[1].matchAll(UNIT_KEY)].length;
      if (n >= 2) sizes.push(n);
    }
    return sizes;
  }

  const offenders: string[] = [];
  let scanned = 0;
  for (const root of roots) {
    const dir = join(SRC, root);
    for (const rel of walkSourceFiles(dir, {
      floor: root === "hooks" ? 50 : 500,
    })) {
      if (rel.includes("__tests__/") || rel.startsWith("api/")) continue;
      scanned += 1;
      const source = stripComments(readFileSync(join(dir, rel), "utf8"));
      for (const size of unitTables(source)) {
        offenders.push(`${root}/${rel}: a table of ${size} unit keys`);
      }
    }
  }

  it("reads the display tree", () => {
    expect(scanned).toBeGreaterThan(1000);
  });

  it("finds none", () => {
    expect(offenders).toEqual([]);
  });

  it("counter-check: would catch the boards' old table, not a single key", () => {
    expect(
      unitTables(`const UNIT_KEY: Record<D, string> = {
  hours: "cycle.insights.crosstab.unitHours",
  bpm: "cycle.insights.crosstab.unitBpm",
};`),
    ).toEqual([2]);
    expect(
      unitTables(
        `const entry = { value: "SLEEP", unitKey: "measurements.unitHours" };`,
      ),
    ).toEqual([]);
  });
});
