/**
 * Fill a message template: `{param}` placeholders and ICU plural blocks.
 *
 * A count string written as `"{count} devices bound"` reads "1 devices bound"
 * for one device, and in Russian or Polish it is wrong for most numbers,
 * because those languages have separate forms for 2-4 and for 5-20. A
 * template can therefore carry an ICU plural block instead:
 *
 *   "{count, plural, one {# device bound} other {# devices bound}}"
 *
 * The branch comes from `Intl.PluralRules` for the locale the template was
 * read from: an exact `=N` selector first, then the CLDR category (`zero`,
 * `one`, `two`, `few`, `many`), then `other`, which every block must carry.
 * Inside a branch `#` stands for the count and `{param}` placeholders work
 * as anywhere else. Only `plural` is understood; a `select` or nested format
 * is not part of the bundle grammar.
 *
 * Substitution is literal. A parameter value is inserted as it is and never
 * scanned again, so a display name holding `{x}` or `$'` reads as written
 * (`interpolation-is-literal.test.ts`). A placeholder without a parameter is
 * left in the text, which is what the translators did before this module.
 */
import type { Locale } from "./config";
import { resolveIntlLocale } from "@/lib/format-locale";

type Params = Record<string, string | number> | undefined;

const rulesCache = new Map<Locale, Intl.PluralRules | null>();

function rulesFor(locale: Locale): Intl.PluralRules | null {
  if (!rulesCache.has(locale)) {
    let rules: Intl.PluralRules | null = null;
    try {
      rules = new Intl.PluralRules(resolveIntlLocale(locale));
    } catch {
      rules = null;
    }
    rulesCache.set(locale, rules);
  }
  return rulesCache.get(locale) ?? null;
}

/**
 * A count passed as a string ("1.234", "1 234") is a formatted integer: drop
 * the grouping so the plural category is taken from the number itself.
 */
function countValue(raw: string | number): number {
  if (typeof raw === "number") return raw;
  const digits = raw.replace(/[\s  .,']/g, "");
  return /^-?\d+$/.test(digits) ? Number(digits) : Number.NaN;
}

/** Index of the brace that closes the one opened at `open`, or -1. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `selector {body}` pairs of a plural block's option list. */
function parseOptions(text: string): Map<string, string> | null {
  const options = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) break;
    const match = /^(=\d+|zero|one|two|few|many|other)\s*\{/.exec(
      text.slice(i),
    );
    if (!match) return null;
    const open = i + match[0].length - 1;
    const close = closingBrace(text, open);
    if (close < 0) return null;
    options.set(match[1]!, text.slice(open + 1, close));
    i = close + 1;
  }
  return options.has("other") ? options : null;
}

function selectBranch(
  options: Map<string, string>,
  count: number,
  locale: Locale,
): string {
  const exact = options.get(`=${count}`);
  if (exact !== undefined) return exact;
  if (Number.isFinite(count)) {
    const category = rulesFor(locale)?.select(count);
    if (category && options.has(category)) return options.get(category)!;
  }
  return options.get("other")!;
}

const PLURAL_HEAD = /^\{(\w+)\s*,\s*plural\s*,/;
const PLACEHOLDER = /^\{(\w+)\}/;

function render(
  template: string,
  params: Params,
  locale: Locale,
  hash: string | null,
): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === "#" && hash !== null) {
      out += hash;
      i++;
      continue;
    }
    if (ch === "{") {
      const rest = template.slice(i);
      const plural = PLURAL_HEAD.exec(rest);
      if (plural) {
        const close = closingBrace(template, i);
        const options =
          close < 0
            ? null
            : parseOptions(template.slice(i + plural[0].length, close));
        const raw = params?.[plural[1]!];
        if (options && close >= 0 && raw !== undefined) {
          const branch = selectBranch(options, countValue(raw), locale);
          out += render(branch, params, locale, String(raw));
          i = close + 1;
          continue;
        }
      }
      const placeholder = PLACEHOLDER.exec(rest);
      if (placeholder) {
        const value = params?.[placeholder[1]!];
        out += value === undefined ? placeholder[0] : String(value);
        i += placeholder[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function formatMessage(
  template: string,
  params: Params,
  locale: Locale,
): string {
  if (!params) return template;
  return render(template, params, locale, null);
}

/** True when a template carries an ICU plural block on `param`. */
export function hasPluralBlock(template: string, param = "count"): boolean {
  return new RegExp(`\\{${param}\\s*,\\s*plural\\s*,`).test(template);
}
