// The zh-CN typography rules from #1528, made mechanical.
//
// The maintainer asked for a zh-CN-scoped guard rather than a rule for every
// bundle, because these are Chinese conventions rather than universal ones, and
// for the pass over the bundle that turns it green in the same change.
//
// Four rules:
//
// 1. No space before a measure word. A number and the word counting it are one
//    word in Chinese: "3天", not "3 天". The count arrives as a placeholder
//    (`{count}`), as an ICU plural body's `#`, or as digits written out.
// 2. The ellipsis is full: "……" (U+2026 twice), not "…". A single one reads as
//    a trailing fragment in Chinese typesetting.
// 3. Lists are separated by "、" (U+3001), not by a half-width comma. A comma
//    between two Han characters is the shape a machine translation leaves.
// 4. 「」 and 『』 are exempt. They are the Chinese quote marks, and the
//    glyph guard's ban on dashes and middle dots has nothing to say about them;
//    the exemption exists so nobody "corrects" them to “”.
//
// Every rule is scoped to `zh-CN.json`. The other bundles are held to the rules
// their languages need, and a Japanese or Korean bundle would want different
// measure-word behaviour again.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MESSAGES_DIR = join(__dirname, "../../messages");
const BUNDLE = "zh-CN.json";

/**
 * The measure words the bundle actually uses, plus the ones a future string is
 * likely to reach for. Longest first so "分钟" wins over "分" and "个月" over
 * "月" when both could match at the same offset.
 */
const MEASURE_WORDS = [
  "分钟",
  "小时",
  "毫升",
  "毫克",
  "公斤",
  "千米",
  "公里",
  "个月",
  "秒钟",
  "天",
  "个",
  "条",
  "次",
  "周",
  "月",
  "年",
  "岁",
  "倍",
  "份",
  "张",
  "片",
  "粒",
  "步",
  "米",
  "克",
  "秒",
  "页",
  "名",
  "位",
  "项",
  "处",
  "段",
  "篇",
  "句",
  "字",
  "行",
  "分",
  "时",
  "度",
].sort((a, b) => b.length - a.length);

/**
 * A count: a placeholder (`{count}`, `{total}`, `{count, plural, other {#}}`),
 * an ICU plural body's `#`, or digits as written.
 */
const COUNT = String.raw`(?:\{[^{}]*\}|#|[0-9]+(?:[.,][0-9]+)?)`;

/** Spaces and the no-break space a translation tool likes to insert. */
const SPACE = String.raw`[ \u00a0\u2009\u202f]+`;

const MEASURE = MEASURE_WORDS.map((w) =>
  w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|");

const SPACED_MEASURE = new RegExp(`${COUNT}${SPACE}(?=${MEASURE})`, "u");

/** The same shape, keeping both sides, for the message. */
const SPACED_MEASURE_REPORT = new RegExp(`(${COUNT})${SPACE}(${MEASURE})`, "u");

/** A single U+2026 that is not part of a "……" pair. */
const LONE_ELLIPSIS = /(?<!…)(…)(?!…)/u;

/** A half-width comma sitting between two Han characters. */
const HAN_COMMA = /[\u4e00-\u9fff],[ ]?[\u4e00-\u9fff]/u;

interface Entry {
  key: string;
  value: string;
}

/**
 * Walk the bundle the same way the glyph guard does: ICU plural bodies are
 * part of the value they sit in, so a nested `#条` is caught by the walk over
 * the string rather than by a separate pass.
 */
function flatten(node: unknown, prefix: string, out: Entry[]): Entry[] {
  if (typeof node === "string") {
    out.push({ key: prefix, value: node });
    return out;
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

const ENTRIES = flatten(
  JSON.parse(readFileSync(join(MESSAGES_DIR, BUNDLE), "utf8")),
  "",
  [],
);

function spacedMeasure(value: string): string | null {
  const m = value.match(SPACED_MEASURE_REPORT);
  return m ? `"${m[0]}"` : null;
}

function loneEllipsis(value: string): boolean {
  return LONE_ELLIPSIS.test(value);
}

function hanComma(value: string): string | null {
  const m = value.match(/([\u4e00-\u9fff],[ ]?[\u4e00-\u9fff])/u);
  return m ? `"${m[1]}"` : null;
}

describe("zh-CN typography: the rules, on their own", () => {
  it("flags a space before a measure word, whatever the count looks like", () => {
    expect(spacedMeasure("仅显示最近 {count} 条")).not.toBeNull();
    expect(spacedMeasure("3 天")).not.toBeNull();
    expect(spacedMeasure("{hours} 小时 {minutes} 分")).not.toBeNull();
    expect(spacedMeasure("{count, plural, other {# 条测量}}")).not.toBeNull();
    expect(spacedMeasure("{total} 个中的 {done} 个")).not.toBeNull();
    expect(spacedMeasure("至少 12 个字符")).not.toBeNull();
  });

  it("accepts the written form", () => {
    expect(spacedMeasure("仅显示最近 {count}条")).toBeNull();
    expect(spacedMeasure("3天")).toBeNull();
    expect(spacedMeasure("{count, plural, other {#条测量}}")).toBeNull();
    expect(spacedMeasure("至少 12个字符")).toBeNull();
  });

  it("leaves a Latin unit's space alone", () => {
    // These are not measure words: "82 kg" keeps its space, and so does a
    // dilution, a pressure and a percentage.
    expect(spacedMeasure("82 kg")).toBeNull();
    expect(spacedMeasure("120 mmHg")).toBeNull();
    expect(spacedMeasure("5 %")).toBeNull();
    expect(spacedMeasure("10 mg/dL")).toBeNull();
  });

  it("flags a single ellipsis and accepts a full one", () => {
    expect(loneEllipsis("加载中…")).toBe(true);
    expect(loneEllipsis("如果……那么")).toBe(false);
    expect(loneEllipsis("没有省略号")).toBe(false);
  });

  it("flags a comma between Han characters and accepts the enumeration mark", () => {
    expect(hanComma("体重,身高")).not.toBeNull();
    expect(hanComma("体重、身高")).toBeNull();
    expect(hanComma("1,5 mg")).toBeNull();
  });

  it("keeps 「」 and 『』 untouched", () => {
    // The exemption rule: the guard has no opinion about them, so a value that
    // uses them passes every check above.
    const value = "「如果……那么」计划，包含『到期』一项";
    expect(spacedMeasure(value)).toBeNull();
    expect(loneEllipsis(value)).toBe(false);
    expect(hanComma(value)).toBeNull();
  });
});

describe("zh-CN typography: the bundle", () => {
  it("walks a non-empty set of strings", () => {
    expect(ENTRIES.length).toBeGreaterThan(10000);
  });

  it("has no space before a measure word", () => {
    const offenders = ENTRIES.map((e) => {
      const found = spacedMeasure(e.value);
      return found === null ? null : `${e.key} = ${found}`;
    }).filter((v): v is string => v !== null);
    expect(offenders).toEqual([]);
  });

  it("writes the ellipsis in full", () => {
    const offenders = ENTRIES.filter((e) => loneEllipsis(e.value)).map(
      (e) => e.key,
    );
    expect(offenders).toEqual([]);
  });

  it("separates lists with 、 rather than a half-width comma", () => {
    const offenders = ENTRIES.map((e) => {
      const found = hanComma(e.value);
      return found === null ? null : `${e.key} = ${found}`;
    }).filter((v): v is string => v !== null);
    expect(offenders).toEqual([]);
  });

  it("leaves both Chinese quote styles to the writer", () => {
    // The bundle writes “” today and no 「」, and this guard has no opinion on
    // which pair a sentence is set in — that is what the exemption asks for, so
    // the check is that neither style trips a rule.
    const withDouble = ENTRIES.filter((e) => /[“”]/.test(e.value));
    expect(withDouble.length).toBeGreaterThan(100);
    for (const entry of withDouble) {
      expect(spacedMeasure(entry.value), entry.key).toBeNull();
      expect(loneEllipsis(entry.value), entry.key).toBe(false);
      expect(hanComma(entry.value), entry.key).toBeNull();
    }

    const hanQuoted = "「如果……那么」计划，包含『到期』一项";
    expect(spacedMeasure(hanQuoted)).toBeNull();
    expect(loneEllipsis(hanQuoted)).toBe(false);
    expect(hanComma(hanQuoted)).toBeNull();
  });
});
