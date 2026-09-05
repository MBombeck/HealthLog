import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A formatter that spells a date out of numbers has to say whose order it
 * spells it in.
 *
 * `timezone-explicit-formatter-guard.test.ts` asks the neighbouring question —
 * WHICH day is this — and a site answers it by passing `timeZone`. Answering
 * that one says nothing about the second: `new Intl.DateTimeFormat("en-US", {
 * timeZone: tz, day: "2-digit", month: "2-digit" })` names its calendar and
 * still prints 04/18 to a person who set the profile to day-first. That is
 * issue #922 — a reporter moved the profile off MM/DD/YYYY, the entry form
 * followed, the chart axes and the measurements list did not, and every
 * timezone check on those surfaces was green throughout.
 *
 * Two ratchets:
 *
 *   1. Every `makeFormatters` / `makeBucketLabelFormatters` construction is
 *      inspected for a hard-coded "AUTO" in the DATE-ORDER slot. The compiler
 *      now demands the argument (the `= "AUTO"` default is gone), so the only
 *      way left to drop the preference is to type the literal — which reads
 *      like a decision and usually is not one.
 *   2. Every raw `Intl.DateTimeFormat` / `toLocaleDateString` whose options
 *      render an ORDER-BEARING numeric date must take its locale from the
 *      preference (`resolveDateLocale` / `dateOrderLocale`), or be listed
 *      below with a reason.
 *
 * What "order-bearing" excludes, deliberately:
 *
 *   - A TEXTUAL month ("short" / "long"). The preference pins numeric field
 *     order by rendering through a canonical locale (de-DE / en-US / en-CA),
 *     and a textual month rendered through those would change the month
 *     NAME's language — which belongs to the UI locale, not to this setting.
 *     `makeFormatters().monthShort` already stays on the UI locale for the
 *     same reason.
 *   - `formatToParts()`. It hands back the fields and the caller reassembles
 *     them, so there is no rendered order to get wrong. This is the shape
 *     almost every calendar-day KEY in this tree is written in.
 *
 * What it cannot see, written down so the next reader does not assume
 * otherwise: a date assembled by hand out of `getUTCDate()` / `getMonth()`
 * and a template literal, a formatter built in one file and rendered in
 * another, and a locale argument that reaches the preference through a
 * variable this matcher does not recognise by name. It is a source-shape
 * ratchet, and its job is to make a new bare formatter arguable in writing
 * before it ships — not to prove the tree is clean.
 */

const REPO_ROOT = resolve(__dirname, "../..");

const SOURCE_FILES = (): string[] =>
  execFileSync(
    "grep",
    [
      "-rlE",
      "new Intl\\.DateTimeFormat|\\.toLocale(Date|Time)String\\(|makeFormatters\\(|makeBucketLabelFormatters\\(",
      "src",
      "--include=*.ts",
      "--include=*.tsx",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes("__tests__"));

/** The argument list starting at the `(` at or after `from`, plus its end. */
function argumentList(
  source: string,
  from: number,
): { args: string; end: number } {
  const open = source.indexOf("(", from);
  if (open === -1) return { args: "", end: from };
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return { args: source.slice(open, i + 1), end: i + 1 };
    }
  }
  return { args: source.slice(open), end: source.length };
}

/** Top-level comma split of an argument list including its parentheses. */
export function splitArguments(list: string): string[] {
  const body = list.slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of body) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/**
 * True when the option bag renders a date whose FIELD ORDER is visible: a
 * numeric month next to a numeric day or a year. A textual month carries its
 * own order in the language and is not this preference's business.
 */
export function isOrderBearing(options: string): boolean {
  const numericMonth = /\bmonth\s*:\s*["'](?:2-digit|numeric)["']/.test(
    options,
  );
  if (!numericMonth) return false;
  return /\bday\s*:/.test(options) || /\byear\s*:/.test(options);
}

/**
 * `toLocaleDateString` with no field options at all renders the locale's
 * DEFAULT full numeric date — every field, in the locale's own order. That
 * is as order-bearing as an explicit `{ day, month, year }` bag and it was
 * the shape the first draft of this matcher walked straight past.
 */
export function rendersLocaleDefaultDate(args: string): boolean {
  return !/\b(day|month|year|weekday|hour|minute|second|dateStyle|timeStyle)\s*:/.test(
    args,
  );
}

/** True when the locale argument is derived from the user's preference. */
export function isPreferenceDrivenLocale(localeArg: string): boolean {
  return /resolveDateLocale\s*\(|dateOrderLocale\s*\(|\bdateLocale\b/.test(
    localeArg,
  );
}

interface Site {
  file: string;
  line: number;
}

interface Scan {
  /** Order-bearing raw renderers that do not take the preference. */
  bare: Site[];
  /** Order-bearing raw renderers that do. */
  pinned: Site[];
  /** Formatter constructions passing a literal "AUTO" date order. */
  literalAuto: Site[];
  /** Formatter constructions passing a real preference. */
  threaded: Site[];
}

const RAW_PATTERNS = [
  /new Intl\.DateTimeFormat\s*\(/g,
  /\.toLocale(?:Date|Time)String\s*\(/g,
];
const BUILDER_PATTERN = /\b(makeFormatters|makeBucketLabelFormatters)\s*\(/g;

/** The argument index that carries the date-order preference. */
const DATE_ORDER_ARG: Record<string, number> = {
  makeFormatters: 3,
  makeBucketLabelFormatters: 1,
};

function scan(): Scan {
  const out: Scan = { bare: [], pinned: [], literalAuto: [], threaded: [] };
  for (const file of SOURCE_FILES()) {
    const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
    const lineOf = (index: number) => source.slice(0, index).split("\n").length;

    for (const pattern of RAW_PATTERNS) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
        const { args, end } = argumentList(source, m.index + m[0].length - 1);
        const defaultDate =
          m[0].includes("toLocaleDateString") && rendersLocaleDefaultDate(args);
        if (!isOrderBearing(args) && !defaultDate) continue;
        // `.formatToParts(...)` produces fields, not an ordered string.
        if (/^\s*\.formatToParts\s*\(/.test(source.slice(end))) continue;
        const parts = splitArguments(args);
        const site = { file, line: lineOf(m.index) };
        if (isPreferenceDrivenLocale(parts[0] ?? "")) out.pinned.push(site);
        else out.bare.push(site);
      }
    }

    BUILDER_PATTERN.lastIndex = 0;
    for (
      let m = BUILDER_PATTERN.exec(source);
      m !== null;
      m = BUILDER_PATTERN.exec(source)
    ) {
      // Skip the declarations and the import lines themselves.
      const lineStart = source.lastIndexOf("\n", m.index) + 1;
      const prefix = source.slice(lineStart, m.index);
      if (/\b(export\s+)?function\s*$/.test(prefix) || /^import\b/.test(prefix))
        continue;
      const { args } = argumentList(source, m.index + m[0].length - 1);
      const parts = splitArguments(args);
      const index = DATE_ORDER_ARG[m[1]];
      const supplied = parts[index];
      if (supplied === undefined) continue;
      const site = { file, line: lineOf(m.index) };
      if (/^"AUTO"$|^'AUTO'$/.test(supplied)) out.literalAuto.push(site);
      else out.threaded.push(site);
    }
  }
  return out;
}

/**
 * Order-bearing numeric renderers that are correct without the preference.
 * Every entry says why. Keep it an inventory of exceptions, not a parking
 * space: a new one has to be argued for in writing before it can ship.
 *
 * Every entry here is the same shape — a CALENDAR-DAY KEY. The string is a
 * map key, a dedup key, a request payload or a DOM attribute; nobody reads
 * it, so it has no order to get wrong and pinning it to a user preference
 * would make the key move when the preference did.
 */
const RAW_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: "src/app/api/measurement-reminders/[id]/snooze/route.ts",
    why: "An ISO day probe split back into numbers to do day arithmetic on the postpone target. Never rendered.",
  },
  {
    file: "src/components/ui/calendar.tsx",
    why: "The `data-day` attribute on a calendar cell. It identifies a cell to the DOM, it does not spell a date to a reader.",
  },
  {
    file: "src/components/medications/dose-history-ledger-compute.ts",
    why: "The `yyyy-MM-dd` key the ledger groups doses by. The heading a reader sees is rendered separately, through the preference-aware `formatDateWithWeekdaySmart`.",
  },
  {
    file: "src/components/medications/dose-history-ledger.tsx",
    why: "The same key shape for `today`, compared against those buckets. A comparison, not a label.",
  },
  {
    file: "src/components/charts/health-chart.tsx",
    why: "`makeDayKeyFormatter` — the per-row bucketing key. Its fields are read back through `formatToParts` and reassembled as `YYYY-MM-DD`.",
  },
  {
    file: "src/components/measurement-reminders/vorsorge-section.tsx",
    why: "The ISO day the postpone request writes to the API. A wire value, and the wire format is ISO whatever the reader prefers.",
  },
  {
    file: "src/lib/gamification/achievements.ts",
    why: "The day key streak arithmetic counts on.",
  },
  {
    file: "src/lib/charts/bucket-time-series.ts",
    why: "Bucket boundary arithmetic. The bucket LABELS are a separate step and go through `makeBucketLabelFormatters`.",
  },
  {
    file: "src/lib/ai/prompts/insight-generator.ts",
    why: "An ISO day inside a model prompt. The model reads ISO; the user never sees this string.",
  },
  {
    file: "src/lib/jobs/measurement-reminder.ts",
    why: "The local day in the notification dedup key. Changing it with a display preference would re-send a claimed reminder.",
  },
  {
    file: "src/lib/jobs/reminder/medication-reminder-check.ts",
    why: "The same dedup key, plus the ISO day carried in notification metadata for the per-slot message ledger.",
  },
  {
    file: "src/lib/i18n/relative-time.ts",
    why: "The en-CA day keys that decide today / yesterday. A comparison between two keys, never printed.",
  },
  {
    file: "src/lib/tz/resolver.ts",
    why: "The Berlin day formatter the zone arithmetic itself is built on.",
  },
];

/**
 * Formatter constructions that hard-code "AUTO" for the date order because
 * there is genuinely no user preference to reach for. Empty today, and that
 * is the point: the compiler demands the argument, so an entry here is a
 * written admission that a surface renders in the locale default.
 */
const AUTO_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [];

describe("numeric dates render in the user's field order", () => {
  const found = scan();

  it("finds order-bearing sites at all (the guard must not pass vacuously)", () => {
    // If any of these drops to zero the matcher has stopped matching and
    // every assertion below became free. `pinned` proves the guard can
    // recognise a CORRECT site, not only flag every site it sees.
    expect(found.bare.length + found.pinned.length).toBeGreaterThan(10);
    expect(found.pinned.length).toBeGreaterThan(0);
    expect(found.threaded.length).toBeGreaterThan(5);
  });

  it("has no unexplained numeric date outside the user's field order", () => {
    const unexplained = found.bare.filter(
      (h) => !RAW_ALLOWLIST.some((a) => a.file === h.file),
    );
    if (unexplained.length > 0) {
      throw new Error(
        `${unexplained.length} formatter call(s) spell a numeric date without the user's field order:\n\n` +
          unexplained.map((h) => `  ${h.file}:${h.line}`).join("\n") +
          "\n\nA profile set to day-first still reads 04/18 here. Render through " +
          "`useFormatters()` (client), `makeFormatters(locale, tz, timeFormat, dateFormat)` " +
          "(server), or `resolveDateLocale(pref, locale)` for a bare `Intl` call. " +
          "If the string is a calendar-day KEY rather than a label, add the file to " +
          "RAW_ALLOWLIST in this test with the reason.",
      );
    }
  });

  it("has no formatter construction that hard-codes AUTO for the date order", () => {
    // The compiler already demands the argument. This catches the other half:
    // typing the literal to make it compile, which reads like a decision.
    const unexplained = found.literalAuto.filter(
      (h) => !AUTO_ALLOWLIST.some((a) => a.file === h.file),
    );
    expect(
      unexplained.map((h) => `${h.file}:${h.line}`),
      "a formatter was built with a hard-coded AUTO date order; pass the user's preference or add the file to AUTO_ALLOWLIST with a reason",
    ).toEqual([]);
  });

  it("carries no allowlist entry that no longer has a bare formatter", () => {
    // A stale exception documents a decision about code that has moved on,
    // and quietly covers whatever lands in that file next.
    for (const entry of RAW_ALLOWLIST) {
      expect(
        found.bare.some((h) => h.file === entry.file),
        `stale allowlist entry — ${entry.file} no longer has a bare order-bearing formatter`,
      ).toBe(true);
    }
    for (const entry of AUTO_ALLOWLIST) {
      expect(
        found.literalAuto.some((h) => h.file === entry.file),
        `stale allowlist entry — ${entry.file} no longer hard-codes AUTO`,
      ).toBe(true);
    }
  });

  it("keeps the preference parameters mandatory on makeFormatters", () => {
    // The ratchets above both read CALL SITES, and a call site that simply
    // stops passing the argument is invisible to them — it is the compiler
    // that catches that, and only while the parameter has no default. Put
    // the default back and every dropped preference compiles again, silently,
    // which is the exact state issue #922 shipped in. So pin the signature.
    const source = readFileSync(
      resolve(REPO_ROOT, "src/lib/format-locale.ts"),
      "utf8",
    );
    const signature = source.slice(
      source.indexOf("export function makeFormatters("),
      source.indexOf("): Formatters {"),
    );
    expect(signature, "makeFormatters signature not found").toContain(
      "dateFormat",
    );
    expect(
      /dateFormat\s*:\s*DateFormatPreference\s*=/.test(signature),
      "dateFormat has a default again — every caller that forgets it now compiles silently",
    ).toBe(false);
    expect(
      /timeFormat\s*:\s*TimeFormatPreference\s*=/.test(signature),
      "timeFormat has a default again — same failure mode, one preference over",
    ).toBe(false);
  });

  it("tells an order-bearing option bag from a textual one", () => {
    // The distinction the whole guard rests on. A textual month carries its
    // order in the language and is the UI locale's business, not this
    // preference's — pinning it to de-DE would rename "Apr" to "Apr." and
    // "February" to "Februar" for an English reader.
    expect(isOrderBearing('{ day: "2-digit", month: "2-digit" }')).toBe(true);
    expect(isOrderBearing('{ month: "numeric", year: "numeric" }')).toBe(true);
    expect(isOrderBearing('{ day: "numeric", month: "short" }')).toBe(false);
    expect(isOrderBearing('{ month: "long", year: "numeric" }')).toBe(false);
    expect(isOrderBearing('{ weekday: "short" }')).toBe(false);
    expect(isOrderBearing('{ hour: "2-digit", minute: "2-digit" }')).toBe(
      false,
    );
    // A bare `toLocaleDateString` renders every field in the locale's order.
    expect(rendersLocaleDefaultDate("()")).toBe(true);
    expect(rendersLocaleDefaultDate('("sv-SE", { timeZone: tz })')).toBe(true);
    expect(rendersLocaleDefaultDate('("en", { weekday: "short" })')).toBe(
      false,
    );
  });

  it("recognises a preference-driven locale argument", () => {
    expect(isPreferenceDrivenLocale("resolveDateLocale(pref, locale)")).toBe(
      true,
    );
    expect(isPreferenceDrivenLocale("dateLocale")).toBe(true);
    expect(isPreferenceDrivenLocale('"en-US"')).toBe(false);
    expect(isPreferenceDrivenLocale("resolveIntlLocale(locale)")).toBe(false);
  });

  it("reads the date-order argument out of the right slot", () => {
    // `makeFormatters(locale, tz, timeFormat, dateFormat)` — the preference
    // is the FOURTH argument, and an off-by-one here would read the hour
    // cycle instead and report every correct site as a violation.
    expect(
      splitArguments('(locale, userTimezone, "AUTO", dateFormat)')[
        DATE_ORDER_ARG.makeFormatters
      ],
    ).toBe("dateFormat");
    expect(
      splitArguments('(locale, "UTC", "AUTO", "AUTO")')[
        DATE_ORDER_ARG.makeFormatters
      ],
    ).toBe('"AUTO"');
    expect(
      splitArguments("(locale, dateFormat)")[
        DATE_ORDER_ARG.makeBucketLabelFormatters
      ],
    ).toBe("dateFormat");
    // Commas inside a nested call or object must not shift the slot.
    expect(
      splitArguments('(locale, resolveTz({ a: 1, b: 2 }), "AUTO", pref)')[
        DATE_ORDER_ARG.makeFormatters
      ],
    ).toBe("pref");
  });
});
