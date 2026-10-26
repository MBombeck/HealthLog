import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { requireFloor } from "@/__tests__/helpers/source-files";

const ROOT = join(__dirname, "../../..");
const MESSAGES_DIR = join(ROOT, "messages");
const EN_PATH = join(MESSAGES_DIR, "en.json");
const DE_PATH = join(MESSAGES_DIR, "de.json");

// Auto-discover every messages/<locale>.json. Source-of-truth is EN —
// new locales added in v1.4.25 (fr/es/it/pl) and beyond get covered
// automatically by the parity, no-empty-values, and no-TODO tests
// without having to extend this file each time.
function discoverLocales(): Array<{ locale: string; path: string }> {
  return readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      locale: f.replace(/\.json$/, ""),
      path: join(MESSAGES_DIR, f),
    }));
}

// Every parity check below iterates this list, so an empty discovery would
// run none of them and pass. Seven bundles ship today.
const ALL_LOCALES = requireFloor("message bundles", discoverLocales(), 7);
const NON_EN_LOCALES = ALL_LOCALES.filter((l) => l.locale !== "en");

// JSON.parse silently keeps the last value when an object has duplicate keys,
// which lets shadowed keys hide bugs. Walk the source manually to surface them.
function findDuplicateKeys(
  src: string,
): { path: string; line: number; firstLine: number }[] {
  const dups: { path: string; line: number; firstLine: number }[] = [];
  const pathStack: string[] = [];
  let i = 0;
  let line = 1;

  function err(msg: string): never {
    throw new Error(`${msg} at line ${line}`);
  }

  function skipWs() {
    while (i < src.length) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r") i++;
      else if (c === "\n") {
        i++;
        line++;
      } else break;
    }
  }

  function readString(): { value: string; line: number } {
    if (src[i] !== '"') err("expected string");
    const startLine = line;
    i++;
    let raw = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        raw += c + src[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return { value: JSON.parse(`"${raw}"`), line: startLine };
      }
      if (c === "\n") line++;
      raw += c;
      i++;
    }
    err("unterminated string");
  }

  function parseValue() {
    skipWs();
    const c = src[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') {
      readString();
      return;
    }
    while (i < src.length) {
      const ch = src[i];
      if (
        ch === "," ||
        ch === "}" ||
        ch === "]" ||
        ch === " " ||
        ch === "\n" ||
        ch === "\t" ||
        ch === "\r"
      )
        break;
      if (ch === "\n") line++;
      i++;
    }
  }

  function parseArray() {
    i++;
    skipWs();
    if (src[i] === "]") {
      i++;
      return;
    }
    while (true) {
      parseValue();
      skipWs();
      if (src[i] === ",") {
        i++;
        skipWs();
        continue;
      }
      if (src[i] === "]") {
        i++;
        return;
      }
      err("expected , or ] in array");
    }
  }

  function parseObject() {
    i++;
    const seen = new Map<string, number>();
    skipWs();
    if (src[i] === "}") {
      i++;
      return;
    }
    while (true) {
      skipWs();
      const { value: key, line: keyLine } = readString();
      const seenAt = seen.get(key);
      if (seenAt != null) {
        dups.push({
          path: [...pathStack, key].join("."),
          line: keyLine,
          firstLine: seenAt,
        });
      } else {
        seen.set(key, keyLine);
      }
      skipWs();
      if (src[i] !== ":") err("expected : after key");
      i++;
      pathStack.push(key);
      parseValue();
      pathStack.pop();
      skipWs();
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "}") {
        i++;
        return;
      }
      err("expected , or } in object");
    }
  }

  parseValue();
  return dups;
}

describe("i18n locale file integrity", () => {
  it.each(ALL_LOCALES)(
    "messages/$locale.json has no duplicate keys",
    ({ path }) => {
      const dups = findDuplicateKeys(readFileSync(path, "utf8"));
      expect(
        dups,
        `Duplicate keys silently shadow earlier definitions:\n` +
          dups
            .map(
              (d) =>
                `  ${d.path} at line ${d.line} (first defined at line ${d.firstLine})`,
            )
            .join("\n"),
      ).toEqual([]);
    },
  );

  function flatten(obj: unknown, prefix: string, out: string[]) {
    if (obj == null || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") out.push(key);
      else if (typeof v === "object") flatten(v, key, out);
    }
  }

  it.each(NON_EN_LOCALES)(
    "en and $locale share the same key shape (locale parity)",
    ({ locale, path }) => {
      const en = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<
        string,
        unknown
      >;
      const other = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;

      const enKeys = new Set<string>();
      const otherKeys = new Set<string>();
      const enArr: string[] = [];
      const otherArr: string[] = [];
      flatten(en, "", enArr);
      flatten(other, "", otherArr);
      enArr.forEach((k) => enKeys.add(k));
      otherArr.forEach((k) => otherKeys.add(k));

      const onlyInEn = [...enKeys].filter((k) => !otherKeys.has(k)).sort();
      const onlyInOther = [...otherKeys].filter((k) => !enKeys.has(k)).sort();

      expect(
        { onlyInEn, onlyInOther },
        `Locale files drifted apart — every key in en.json must exist in ${locale}.json and vice versa.`,
      ).toEqual({ onlyInEn: [], onlyInOther: [] });
    },
  );

  // Questionnaire wording lives in code with its source
  // (`src/lib/mental-health/wording/`), never in a bundle: a translator
  // working through the bundles must not see an item, an answer, a stem or
  // the PHQ-9 follow-up, let alone reword one. The app's own copy around the
  // questionnaires (`mentalHealth.instrument.*`, `mentalHealth.wording.*`,
  // the notes and buttons) stays here.
  const QUESTIONNAIRE_SUBTREES = [
    "mentalHealth.items",
    "mentalHealth.options",
    "mentalHealth.gad7Options",
    "mentalHealth.who5Options",
    "mentalHealth.sciOptions",
    "mentalHealth.stems",
    "mentalHealth.functional",
    "mentalHealth.functionalTitle",
  ];

  it.each(ALL_LOCALES)(
    "$locale carries no questionnaire wording",
    ({ path }) => {
      const keys: string[] = [];
      flatten(JSON.parse(readFileSync(path, "utf8")), "", keys);
      expect(keys.length).toBeGreaterThan(3000);
      const carried = keys.filter((key) =>
        QUESTIONNAIRE_SUBTREES.some(
          (tree) => key === tree || key.startsWith(`${tree}.`),
        ),
      );
      expect(carried).toEqual([]);
    },
  );

  // Flat helper used by the value-quality checks below.
  function flattenValues(
    obj: unknown,
    prefix: string,
    out: [string, string][],
  ) {
    if (obj == null || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") out.push([key, v]);
      else if (typeof v === "object") flattenValues(v, key, out);
    }
  }

  // Translations whose last-segment legitimately equals the value in BOTH
  // locales — brand names, anglicisms, identical EN/DE technical terms.
  // See `docs/audit/v1415-i18n-coverage.md` §Legitimate EN==DE==key cases.
  const PLACEHOLDER_ALLOWLIST = new Set<string>([
    "settings.ntfy",
    // v1.4.19 — "BMI" is the same acronym in EN and DE,
    // and the medical / fitness "Optimal", "Fitness", "Normal"
    // categories are technical terms that German clinics also use
    // verbatim. The actual translations live in `targets.status.*`
    // and `targets.label.*`; the entries here just acknowledge the
    // legitimate same-token cases.
    "targets.bmi",
    "targets.label.BMI",
    "targets.status.normal",
    "targets.status.optimal",
    "targets.status.fitness",
    // v1.5.4 modal wizard — SI-unit abbreviations the wizard
    // surfaces in its dose-unit dropdown. The labels are identical
    // across every locale (mg / ml / g are universal SI tokens).
    "medications.wizard.steps.step3.unit.mg",
    "medications.wizard.steps.step3.unit.ml",
    "medications.wizard.steps.step3.unit.g",
    // v1.11.0 — "WHOOP" is a brand name, identical across every locale.
    "settings.sections.sources.sourceLabels.WHOOP",
    // "MCP" is the protocol's own acronym — the same four letters in every
    // locale, exactly like the WHOOP entry above.
    "settings.sections.sources.sourceLabels.MCP",
  ]);

  it.each(ALL_LOCALES)("$locale locale has no empty values", ({ path }) => {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const flat: [string, string][] = [];
    flattenValues(data, "", flat);
    const empties = flat.filter(([, v]) => v === "").map(([k]) => k);
    expect(
      empties,
      `Empty translations are forbidden — every key needs a real string:\n` +
        empties.map((k) => `  ${k}`).join("\n"),
    ).toEqual([]);
  });

  it("has no placeholder values (value === key last segment in BOTH locales)", () => {
    // We only fail when the same key has value == last-segment in BOTH locales.
    // EN-only matches are usually legitimate (the key is named after the EN word
    // so naturally `"of": "of"` looks like a match — but DE has `"of": "von"`,
    // which is a real translation). EN+DE both equalling the key is a strong
    // signal of a forgotten placeholder like `"bugReport": "bugReport"`.
    const en = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    const de = JSON.parse(readFileSync(DE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    const enFlat: [string, string][] = [];
    const deFlat: [string, string][] = [];
    flattenValues(en, "", enFlat);
    flattenValues(de, "", deFlat);
    const deMap = new Map(deFlat);
    const placeholders = enFlat
      .filter(([k, enV]) => {
        if (PLACEHOLDER_ALLOWLIST.has(k)) return false;
        const last = k.split(".").pop();
        if (last === undefined) return false;
        if (enV !== last) return false;
        const deV = deMap.get(k);
        return deV !== undefined && deV === last;
      })
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
    expect(
      placeholders,
      `Found keys whose value equals the key's last segment in BOTH locales —\n` +
        `usually a forgotten placeholder (e.g. \`"bugReport": "bugReport"\`).\n` +
        `Either replace with real translations or add to PLACEHOLDER_ALLOWLIST\n` +
        `in this test if the match is genuinely intentional (brand names,\n` +
        `identical EN/DE terms):\n` +
        placeholders.map((s) => `  ${s}`).join("\n"),
    ).toEqual([]);
  });

  it.each(ALL_LOCALES)(
    "$locale locale has no TODO/FIXME placeholders in values",
    ({ path }) => {
      const data = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      const flat: [string, string][] = [];
      flattenValues(data, "", flat);
      const todoRe = /\b(TODO|FIXME|XXX|TBD)\b/;
      const todos = flat
        .filter(([, v]) => todoRe.test(v))
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
      expect(
        todos,
        `Found TODO/FIXME/XXX/TBD placeholders in translation values:\n` +
          todos.map((s) => `  ${s}`).join("\n"),
      ).toEqual([]);
    },
  );

  /**
   * Placeholder parity. `t()` replaces `{name}` tokens literally, so a
   * translation that renames one ("{when}" for "{date}") renders the raw
   * token, and one that drops one ("Plano limitado" for "Your {provider}
   * plan does not include {list}") loses the information the sentence was
   * for. Neither breaks the key-parity check above, which is how 38 of them
   * reached a bundle unnoticed.
   *
   * A singular plural form (`…One`) may name the count in words instead of
   * `{count}`, or name it where English does not.
   */
  function placeholderSet(value: string, singular: boolean): string {
    const names = new Set(
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
    );
    if (singular) names.delete("count");
    return [...names].sort().join(",");
  }

  it.each(NON_EN_LOCALES)(
    "$locale uses exactly the English placeholders",
    ({ locale, path }) => {
      const enFlat: [string, string][] = [];
      flattenValues(JSON.parse(readFileSync(EN_PATH, "utf8")), "", enFlat);
      const other = new Map<string, string>();
      const otherFlat: [string, string][] = [];
      flattenValues(JSON.parse(readFileSync(path, "utf8")), "", otherFlat);
      for (const [key, value] of otherFlat) other.set(key, value);

      // A floor, so an empty or unreadable English bundle cannot pass.
      requireFloor(
        "English strings carrying a placeholder",
        enFlat.filter(([, value]) => /\{\w+\}/.test(value)),
        1000,
      );
      const drift = enFlat
        .filter(([key, enValue]) => {
          const value = other.get(key);
          if (value === undefined) return false;
          const singular = key.endsWith("One");
          return (
            placeholderSet(value, singular) !==
            placeholderSet(enValue, singular)
          );
        })
        .map(
          ([key, enValue]) =>
            `  ${key}: en {${placeholderSet(enValue, false)}} vs ${locale} {${placeholderSet(other.get(key) ?? "", false)}}`,
        );
      expect(
        drift,
        `Translations whose placeholders differ from English:\n${drift.join("\n")}`,
      ).toEqual([]);
    },
  );

  it("DE locale renders Health Score pillar labels in German", () => {
    const de = JSON.parse(readFileSync(DE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    const flat: [string, string][] = [];
    flattenValues(de, "", flat);
    const byKey = new Map(flat);
    const expected: Array<[string, string]> = [
      ["insights.healthScore.pillar.bloodPressure", "Blutdruck"],
      ["insights.healthScore.pillar.glycaemia", "Blutzucker"],
      ["insights.healthScore.pillar.activity", "Aktivität"],
      ["insights.healthScore.pillar.sleep", "Schlaf"],
      ["insights.healthScore.pillar.wellbeing", "Wohlbefinden"],
      ["insights.healthScore.pillar.lipids", "Blutfette"],
    ];
    for (const [key, expectedDe] of expected) {
      expect(byKey.get(key), `DE label for ${key}`).toBe(expectedDe);
    }
  });

  it("retained Health Score transparency keys resolve in every locale", () => {
    const transparencyKeys = [
      "insights.healthScore.bandSetter",
      "insights.healthScore.versionAndNoise",
      "insights.healthScore.methodVersion",
      "insights.healthScore.observed",
      "insights.healthScore.reference",
      "insights.healthScore.source",
      "insights.healthScore.weightGoal.notScored",
    ] as const;
    for (const { locale, path } of ALL_LOCALES) {
      const data = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      const flat: [string, string][] = [];
      flattenValues(data, "", flat);
      const byKey = new Map(flat);
      for (const key of transparencyKeys) {
        expect(
          byKey.get(key),
          `${locale} locale missing or empty: ${key}`,
        ).toBeTruthy();
      }
    }
  });
});
