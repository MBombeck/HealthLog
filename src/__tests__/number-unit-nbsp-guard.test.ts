import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NBSP, withUnit } from "@/lib/format/unit-join";

/**
 * A number and its unit never break apart in server-worded text.
 *
 * The clients render the lead, the digest, the briefing and every
 * `serverText.*` sentence as delivered, so a plain space between "91" and
 * "%" lets a narrow line end on the figure and start the next with the
 * sign. The join is U+00A0 (`withUnit` and `NBSP`), in the message
 * bundles and in the server code that joins a value and a unit itself.
 *
 * Bundle rule: a placeholder, an ICU `#` or a digit, then a plain space,
 * then a unit (a `{...unit...}` placeholder, "%", or a unit symbol from
 * `UNITS`) fails, in every bundle. Words are not units: "{count} Tage" keeps
 * its ordinary space, and so does a letter that is a word in a language
 * ("w" in Polish, "e" in Italian); the abbreviations that are units only in
 * one language sit in `PER_BUNDLE`.
 *
 * zh-CN: no space at all before a Chinese measure word ("3天"), which is the
 * zh-CN typography guard's rule, while a Latin unit keeps its space, now a
 * no-break one ("82 kg"). This guard checks that the no-break space
 * never stands before a Han character after a count, so it cannot undo the
 * measure-word rule.
 *
 * Code: server text that joins a value and a unit itself goes through
 * `withUnit()` or `NBSP`; the formatter tests pin the joined output.
 */

const MESSAGES_DIR = join(__dirname, "../../messages");

const UNITS = [
  "%",
  "‰",
  "°C",
  "°F",
  "kg/m²",
  "kg",
  "mg/dL",
  "mg/dl",
  "mmol/L",
  "mmol/l",
  "mmol/mol",
  "mg",
  "µg",
  "μg",
  "mcg",
  "ng/mL",
  "ng",
  "g",
  "lbs",
  "lb",
  "oz",
  "kcal",
  "kJ",
  "mL",
  "ml",
  "dL",
  "dl",
  "km",
  "mi",
  "cm",
  "mm",
  "m/s",
  "mmHg",
  "bpm",
  "Hz",
  "dB",
  "ms",
  "sec",
  "s",
  "min",
  "Min",
  "h",
  "Std",
  "d",
  "yr",
  "MB",
  "GB",
  "KB",
  "kB",
  "TB",
  "IE",
  "IU",
  "ккал",
  "кг/м²",
  "кг",
  "мг",
  "мл",
  "км",
  "см",
  "мм",
  "м/с",
  "уд/мин",
  "мин",
  "ч",
  "сек",
  "дн",
  "МБ",
  "ГБ",
  "КБ",
];

/** Abbreviations that are a unit in one language and a word in another. */
const PER_BUNDLE: Record<string, string[]> = {
  "nl.json": ["u"],
  "fr.json": ["j"],
  "it.json": ["g"],
  "de.json": ["T", "J"],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function unitAlternation(extra: readonly string[] = []): string {
  return [...UNITS, ...extra]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|");
}

const UNIT_PLACEHOLDER = String.raw`\{[^{}\s,]*[uU]nit[^{}\s,]*\}`;
const COUNT = String.raw`\{[^{}\s,]+\}|#|\d`;

function breakingJoin(extra: readonly string[] = []): RegExp {
  return new RegExp(
    `(?:${COUNT})[ \\u2009](?:${UNIT_PLACEHOLDER}|(?:${unitAlternation(extra)})(?![\\p{L}\\p{N}'’]))`,
    "u",
  );
}

interface Entry {
  key: string;
  value: string;
}

function flatten(node: unknown, prefix: string, out: Entry[]): Entry[] {
  if (typeof node === "string") out.push({ key: prefix, value: node });
  else if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

const BUNDLES = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json"));

function entries(file: string): Entry[] {
  return flatten(
    JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8")),
    "",
    [],
  );
}

describe("number and unit: the rule, on its own", () => {
  const rule = breakingJoin();

  it("flags a breaking space between a count and a unit", () => {
    for (const s of [
      "liegt bei {value} %",
      "{value} {unit}",
      "{low}–{high} {glucoseUnit}",
      "{count, plural, other {# kg}}",
      "über 140 mmHg",
      "{hours} h {minutes} min",
      "{size} MB.",
    ]) {
      expect(rule.test(s), s).toBe(true);
    }
  });

  it("accepts the no-break join and leaves words alone", () => {
    for (const s of [
      "liegt bei {value} %",
      "{value} {unit}",
      "{count} Tage",
      "{name} s'est connecté",
      "{value} w ciągu",
      "{value}%",
      "3天",
    ]) {
      expect(rule.test(s), s).toBe(false);
    }
  });

  it("joins through withUnit with U+00A0", () => {
    expect(NBSP).toBe(" ");
    expect(withUnit("91", "%")).toBe("91 %");
    expect(withUnit(5, "")).toBe("5");
    expect(withUnit(5, null)).toBe("5");
  });
});

describe("number and unit: the bundles", () => {
  it("walks every locale", () => {
    expect(BUNDLES.length).toBeGreaterThanOrEqual(11);
  });

  it.each(BUNDLES)(
    "%s joins no count and unit with a breaking space",
    (file) => {
      const rule = breakingJoin(PER_BUNDLE[file] ?? []);
      const all = entries(file);
      expect(all.length).toBeGreaterThan(1000);
      const offenders = all
        .filter((e) => rule.test(e.value))
        .map((e) => `${e.key}: ${e.value}`);
      expect(offenders).toEqual([]);
    },
  );

  it("zh-CN never sets a no-break space before a Han character after a count", () => {
    const rule = new RegExp(`(?:${COUNT})\\u00a0[\\u4e00-\\u9fff]`, "u");
    const offenders = entries("zh-CN.json")
      .filter((e) => rule.test(e.value))
      .map((e) => `${e.key}: ${e.value}`);
    expect(offenders).toEqual([]);
  });

  it("zh-CN keeps a Latin unit's space, as a no-break one", () => {
    const joined = new RegExp(`(?:${COUNT})\\u00a0(?:kg|mmHg|%)`, "u");
    expect(entries("zh-CN.json").some((e) => joined.test(e.value))).toBe(true);
  });
});
