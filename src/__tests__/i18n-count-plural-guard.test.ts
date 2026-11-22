import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import { formatMessage, hasPluralBlock } from "@/lib/i18n/format-message";
import { allMessages } from "@/lib/i18n/shared-resolve";

/**
 * Every count string agrees with its number.
 *
 * "Opened 1 times" and "1 devices bound" shipped because a `{count}` string
 * was written once in its plural form and never asked what it says for one.
 * In Russian and Polish the same string is wrong for most numbers, since 2-4
 * and 5-20 take different forms there. A string whose `{count}` stands before
 * a noun therefore carries an ICU plural block (`format-message.ts`), or it
 * belongs to the `<base>One / Few / Other` key family that `tCount` resolves.
 *
 * The English value decides whether a count needs a block: when the count is
 * followed by "of" or "or", by punctuation, by a bracket, or by nothing, it
 * stands alone ("3 of 5", "Delete (3)", "skipped 3×") and no noun has to agree
 * with it. Everything else needs a block or an entry in `STANDALONE` saying
 * why it does not.
 *
 * Once English has a block, every locale must have one, and every block must
 * parse with an `other` branch. Russian and Polish blocks carry `one`, `few`
 * and `many`, the three forms an integer can take there.
 */

const STANDALONE: Record<string, string> = {
  "nav.dueCount": "the count follows a label and stands alone",
  "dashboard.staleHint": "abbreviated unit (d), which does not inflect",
  "settings.integrationPill.minutesAgo": "abbreviated unit (min)",
  "settings.integrationPill.hoursAgo": "abbreviated unit (h)",
  "settings.integrationPill.daysAgo": "abbreviated unit (d)",
  "cycle.history.periodDays": "abbreviated unit (d)",
  "settings.integrationFreshness.quiet": "the count stands with an adjective",
  "achievements.remainingUnlocks": "the count stands with an adjective",
  "admin.versionMigrations.pending":
    "the count stands with an adjective before a list",
  "dataList.selected": "the count stands with a participle",
  "documents.selection.count": "the count stands with a participle",
  "labs.ocr.saveSelected": "the count stands with a participle",
  "mentalHealth.wizard.keyboardHint": "a key range, not a number of things",
  "admin.invites.redeemedByMore": "'+ N more' after a name",
  "insights.coach.docScope.chattingAboutMore": "'and N more' after titles",
  "insights.bloodGlucose.clinical.learningBody":
    "'N over D days': the noun agrees with the day count",
  "admin.section.encryption.columnsShow": "'N with rows' inside brackets",
};

function flatten(
  node: unknown,
  prefix = "",
  out = new Map<string, string>(),
): Map<string, string> {
  if (typeof node === "string") out.set(prefix, node);
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

const bundles = new Map(
  locales.map((locale) => [locale, flatten(allMessages[locale])]),
);
const en = bundles.get("en")!;

const TIERED = /(One|Few|Other)$/;

/** The count in `value` stands alone: no noun right after it to agree. */
function countStandsAlone(value: string): boolean {
  const after = /\{count\}(.{0,12})/.exec(value)?.[1] ?? "";
  if (/^\s+(of|or)\b/.test(after)) return true;
  return !/^\s*[\p{L}]/u.test(after);
}

/** English `{count}` strings that need a plural block and have none. */
function missingPlural(
  messages: ReadonlyMap<string, string>,
  standalone: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const [key, value] of messages) {
    if (TIERED.test(key) || !value.includes("{count}")) continue;
    if (hasPluralBlock(value)) continue;
    if (countStandsAlone(value) || key in standalone) continue;
    out.push(key);
  }
  return out.sort();
}

/** The option selectors of each plural block on `count`, or null if broken. */
function blockSelectors(value: string): string[][] | null {
  const out: string[][] = [];
  const head = /\{count\s*,\s*plural\s*,/g;
  for (const match of value.matchAll(head)) {
    let depth = 0;
    let end = -1;
    for (let i = match.index; i < value.length; i++) {
      if (value[i] === "{") depth++;
      else if (value[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    const body = value.slice(match.index + match[0].length, end);
    const selectors: string[] = [];
    let level = 0;
    let token = "";
    for (const ch of body) {
      if (ch === "{") {
        if (level === 0) selectors.push(token.trim());
        level++;
        token = "";
      } else if (ch === "}") level--;
      else if (level === 0) token += ch;
    }
    out.push(selectors);
  }
  return out;
}

const REQUIRED: Partial<Record<string, string[]>> = {
  ru: ["one", "few", "many", "other"],
  pl: ["one", "few", "many", "other"],
};

describe("count strings agree with their number", () => {
  it("the classifier fails on the strings that shipped wrong", () => {
    const broken = new Map([
      ["a.opened", "Opened {count} times, last {when}."],
      ["a.devices", "{count} devices bound"],
      ["a.alone", "Delete ({count})"],
      ["a.of", "{count} of {total} days"],
      ["a.fixed", "{count, plural, one {# device} other {# devices}}"],
      ["a.tieredOne", "{count} device"],
    ]);
    expect(missingPlural(broken, {})).toEqual(["a.devices", "a.opened"]);
    expect(missingPlural(broken, { "a.opened": "test" })).toEqual([
      "a.devices",
    ]);
  });

  it("every English count before a noun uses a plural block", () => {
    const englishCounts = [...en].filter(([, v]) => v.includes("{count"));
    expect(englishCounts.length).toBeGreaterThan(300);
    const offenders = missingPlural(en, STANDALONE);
    expect(
      offenders,
      `Write these as {count, plural, one {…} other {…}} in every locale, or add them to STANDALONE with a reason:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every STANDALONE entry is still a live, block-free count string", () => {
    const stale = Object.keys(STANDALONE).filter((key) => {
      const value = en.get(key);
      return !value || !value.includes("{count}") || hasPluralBlock(value);
    });
    expect(stale).toEqual([]);
  });

  it.each(locales)(
    "%s has a plural block wherever English has one",
    (locale) => {
      const bundle = bundles.get(locale)!;
      const blocks = [...en].filter(([, v]) => hasPluralBlock(v));
      expect(blocks.length).toBeGreaterThan(100);
      const missing = blocks
        .filter(([key]) => !hasPluralBlock(bundle.get(key) ?? ""))
        .map(([key]) => key);
      expect(missing).toEqual([]);
    },
  );

  it.each(locales)("%s plural blocks parse and carry their forms", (locale) => {
    const bundle = bundles.get(locale)!;
    const required = REQUIRED[locale] ?? ["other"];
    const broken: string[] = [];
    for (const [key, value] of bundle) {
      if (!hasPluralBlock(value)) continue;
      const blocks = blockSelectors(value);
      if (!blocks || blocks.length === 0) {
        broken.push(`${key}: unbalanced`);
        continue;
      }
      for (const selectors of blocks) {
        const lacking = required.filter((s) => !selectors.includes(s));
        if (lacking.length) broken.push(`${key}: lacks ${lacking.join(",")}`);
      }
      // A rendered value never leaks the block syntax, and for any number but
      // 1 it names the number. A branch may say "once" for 1, but in French
      // and Portuguese "one" also holds 0 and in Russian 21 and 101, so a
      // branch without `#` would read "once" for those.
      for (const n of [0, 1, 2, 3, 5, 11, 21, 22, 101]) {
        const out = formatMessage(value, { count: n }, locale);
        if (/plural\s*,|#/.test(out)) broken.push(`${key}: renders ${out}`);
        const exact = new RegExp(`=${n}\\s*\\{`).test(value);
        if (n !== 1 && !exact && !out.includes(String(n))) {
          broken.push(`${key}: ${n} reads "${out}"`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
