/**
 * A `*One` string carries the count wherever "one" is more than 1.
 *
 * `pluralTier` takes the tier from CLDR, and in several shipped languages the
 * "one" category is not the number 1 alone: Russian files 21, 31, 101 under
 * it, French and Brazilian Portuguese file 0 there. A `*One` value that
 * spells the number out ("за 1 день") then reads "1" for 21 days. In those
 * locales the value takes the `{count}` that `tCount` passes, and a call that
 * reaches such a key directly passes the count too.
 *
 * Both checks are functions of their input, and each is shown failing once on
 * an input built to break it.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder } from "@/__tests__/helpers/source-files";
import { resolveIntlLocale } from "@/lib/format-locale";

import { locales, type Locale } from "../config";
import { pluralKey } from "../plural";
import { getServerTranslator } from "../server-translator";
import { allMessages } from "../shared-resolve";

/** Locales whose CLDR "one" category holds an integer other than 1. */
function localesWithWideOne(): Locale[] {
  return locales.filter((locale) => {
    const rules = new Intl.PluralRules(resolveIntlLocale(locale));
    for (let n = 0; n <= 1000; n++) {
      if (n !== 1 && rules.select(n) === "one") return true;
    }
    return false;
  });
}

function flatten(
  node: unknown,
  prefix = "",
  out = new Map<string, string>(),
): Map<string, string> {
  if (typeof node === "string") {
    out.set(prefix, node);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

function bundle(locale: Locale): Map<string, string> {
  return flatten(allMessages[locale]);
}

/** A digit 1 standing on its own, not part of a larger number. */
const BARE_ONE = /(?<!\d)1(?!\d)/;

/** `*One` values that spell out the 1 instead of carrying `{count}`. */
function spelledOutOnes(messages: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [key, value] of messages) {
    if (!key.endsWith("One")) continue;
    if (BARE_ONE.test(value) && !value.includes("{count}")) {
      offenders.push(key);
    }
  }
  return offenders.sort();
}

/**
 * `t("<key>One")` without a `count` param, for a key whose value needs
 * `{count}`: no params at all, or an inline params object that lacks it.
 */
function directCallsWithoutCount(
  sources: ReadonlyArray<{ file: string; text: string }>,
  needsCount: ReadonlySet<string>,
): string[] {
  const call = /\bt\(\s*"([\w.]+One)"\s*(?:,\s*\{([^}]*)\})?\s*,?\s*\)/g;
  const offenders: string[] = [];
  for (const { file, text } of sources) {
    for (const match of text.matchAll(call)) {
      const params = match[2];
      if (params !== undefined && /\bcount\b/.test(params)) continue;
      if (needsCount.has(match[1]!)) offenders.push(`${file}: ${match[1]}`);
    }
  }
  return offenders.sort();
}

describe("plural One strings", () => {
  const wide = localesWithWideOne();

  it("finds the locales whose one is not just 1", () => {
    expect(wide).toEqual(expect.arrayContaining(["ru", "fr", "pt-BR"]));
    expect(wide).not.toContain("en");
    expect(wide).not.toContain("pl");
  });

  it("says 21 days in Russian, not 1", () => {
    const { t } = getServerTranslator("ru");
    expect(
      t(pluralKey("timeline.symptoms.days", 21, "ru"), { count: 21 }),
    ).toBe("за 21 день");
  });

  it("gives every One string in those locales the count", () => {
    const offenders = wide.flatMap((locale) =>
      spelledOutOnes(bundle(locale)).map((key) => `${locale}: ${key}`),
    );
    expect(offenders).toEqual([]);
  });

  it("passes the count wherever such a key is called directly", () => {
    const needsCount = new Set<string>();
    for (const locale of wide) {
      for (const [key, value] of bundle(locale)) {
        if (key.endsWith("One") && value.includes("{count}")) {
          needsCount.add(key);
        }
      }
    }
    expect(needsCount.size).toBeGreaterThan(0);
    const sources = readSourceFolder("src", {
      floor: 1000,
      include: (rel) =>
        !rel.includes("__tests__") && !rel.includes("generated/"),
    }).map(([file, text]) => ({ file, text }));
    expect(directCallsWithoutCount(sources, needsCount)).toEqual([]);
  });

  it("would catch a spelled-out one and a call without the count", () => {
    expect(
      spelledOutOnes(
        new Map([
          ["timeline.symptoms.daysOne", "за 1 день"],
          ["timeline.symptoms.daysOther", "за {count} дней"],
          ["a.bOne", "за {count} день"],
          ["a.cOne", "Скрыто (11)"],
        ]),
      ),
    ).toEqual(["timeline.symptoms.daysOne"]);
    expect(
      directCallsWithoutCount(
        [
          { file: "x.tsx", text: 'n === 1 ? t("a.bOne") : t("a.bOther")' },
          { file: "y.tsx", text: 't("a.bOne", { hours: h })' },
          { file: "z.tsx", text: 't("a.bOne", { count: n, hours: h })' },
        ],
        new Set(["a.bOne"]),
      ),
    ).toEqual(["x.tsx: a.bOne", "y.tsx: a.bOne"]);
  });
});
