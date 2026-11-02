/**
 * Free-text reference-range parser for the range a lab report prints beside a
 * value.
 *
 * A report states its window in prose, not in columns: "3,5 - 5,0", "< 5",
 * "bis 5,0", "≥ 3,5", "150.000 - 400.000 /µl", or a word like "negativ" that
 * carries no window at all. The document-reading path and the manual entry
 * form both hand that string here.
 *
 * The contract is deliberately asymmetric:
 *
 *  - KEEPING the printed string is mandatory. `text` always carries what the
 *    report said, whitespace-normalised and length-capped, whether or not a
 *    bound could be derived from it. A window this parser cannot read is not
 *    a window that gets thrown away.
 *  - DERIVING bounds is best-effort and refuses on ambiguity. A string that
 *    does not match one of the notations below yields `low: null, high: null`
 *    beside the text. Absence reads as absence — the parser never picks a
 *    plausible bound out of a string it did not understand, because a fake
 *    window silently reclassifies a reading as normal or abnormal.
 *
 * Notations read (comma- or dot-decimal):
 *
 *   two-sided   3.5-5.0 · 3,5 – 5,0 · 3,5 bis 5,0 · 3.5 to 5.0 · 3,5 ... 5,0
 *               von 3,5 bis 5,0 · 3,5 à 5,0 · de 3,5 a 5,0 · da 3,5 a 5,0 ·
 *               od 3,5 do 5,0 · [3,5 - 5,0] · (3.5-5.0)
 *   upper only  < 5 · ≤ 5 · <= 5 · bis 5,0 · bis zu 5,0 · max. 5,0 ·
 *               kleiner 5 · unter 5 · up to 5.0 · less than 5 · jusqu'à 5,0 ·
 *               hasta 5,0 · fino a 5,0 · do 5,0 · poniżej 5,0
 *   lower only  > 3.5 · ≥ 3,5 · >= 3.5 · ab 3,5 · min. 3,5 · mindestens 3,5 ·
 *               größer 3,5 · über 3,5 · at least 3.5 · à partir de 3,5 ·
 *               desde 3,5 · da 3,5 · od 3,5 · powyżej 3,5
 *
 * WHY THE VOCABULARY IS TABULATED AND NOT DERIVED. Elsewhere in the app, a
 * matcher that has to recognise a word list in six languages builds its index
 * out of `messages/<locale>.json`, so a seventh locale works the day its
 * bundle lands. That does not apply here. "jusqu'à", "hasta", "fino a" and
 * "do" are prose a LAB printed on a sheet of paper; the app owns no string
 * they could be derived from, and the language of the report has nothing to do
 * with the language of the UI — a French self-hoster running the app in
 * English still receives French reports. So the table below is hand-written,
 * every locale's prose is tried against every input at once, and the honest
 * cost is written down: a report printed in a language absent from the table
 * yields text-only. `RANGE_PROSE` is keyed by the shipped `Locale` union
 * precisely so that adding a locale to `locales` fails to compile until
 * someone has answered "and how does that language print a range?".
 *
 * Units are read, never converted. A window may carry the unit the report
 * printed it in; when the caller states the reading's own unit and the two
 * disagree, the bounds are refused and only the text survives. Converting
 * mmol/L into mg/dL needs a per-analyte factor, so doing it here would be the
 * parser deciding what the report meant.
 */
import { type Locale } from "@/lib/i18n/config";
import {
  normaliseApostrophes,
  stripDiacritics,
} from "@/lib/i18n/fold-for-match";

/** What a printed range yielded. `text` is set whenever the input was non-empty. */
export interface ParsedReferenceRange {
  /** Lower bound, or null when the notation states none / could not be read. */
  low: number | null;
  /** Upper bound, or null when the notation states none / could not be read. */
  high: number | null;
  /** The printed string, whitespace-normalised and capped. Never null here. */
  text: string;
}

/**
 * Storage cap for the verbatim string. A reference-range cell is a few
 * characters; anything longer is a mis-segmented paragraph, and truncating it
 * keeps a runaway transcription out of the column.
 */
export const SOURCE_REFERENCE_TEXT_MAX = 120;

/** Magnitude ceiling. Beyond this a "bound" is a transcription artefact. */
const MAX_ABS_BOUND = 1e12;

/** One number token: optional sign, digits, any number of `.`/`,` groups. */
const NUM = String.raw`[+-]?\d+(?:[.,]\d+)*`;

/** How one language prints a range. Every field is a list of literal words. */
export interface RangeProse {
  /** Infix words joining two bounds: "3,5 <sep> 5,0". */
  twoSided: string[];
  /** Words that introduce a ceiling: "<prefix> 5,0". */
  upper: string[];
  /** Words that introduce a floor: "<prefix> 3,5". */
  lower: string[];
  /**
   * Words that only announce that a window follows and carry no bound of
   * their own ("von 3,5 bis 5,0"). Stripped and the input retried — never on
   * the first pass, because several of them ("da", "od", "de") are also a
   * floor prefix in their own language, and stripping first would read
   * "da 3,5" as a bare number.
   */
  filler: string[];
}

/**
 * The prose, per shipped locale. Written ALREADY FOLDED — lower case and
 * accent-free — because the input is diacritic-folded before matching, so
 * "jusqu'à", "jusqu'a" and "JUSQU'À" are one row. The German "ß" survives the
 * fold (it has no canonical decomposition), which is why "größer" appears here
 * as "großer"; its "oe"/"ss" twins are listed beside it, exactly as the
 * hand-written alternation carried them before.
 *
 * The `de` and `en` lists are the pre-existing alternation, split apart word
 * for word and nothing more — this change is about the four locales that had
 * no entry at all, and a German or English range must read the same afterwards
 * as it did before.
 *
 * Every list is applied to every input regardless of the reader's locale — see
 * the module comment for why. Multi-word entries match across any run of
 * whitespace, so a report that printed a non-breaking space still reads.
 */
export const RANGE_PROSE: Record<Locale, RangeProse> = {
  de: {
    twoSided: ["bis zu", "bis"],
    upper: [
      "bis zu",
      "bis",
      "max.",
      "maximal",
      "max",
      "kleiner als",
      "kleiner",
      "unter",
      "hochstens",
      "hoechstens",
    ],
    lower: [
      "ab",
      "mind.",
      "mindestens",
      "minimal",
      "min.",
      "min",
      "großer als",
      "großer",
      "groesser als",
      "groesser",
      "uber",
      "ueber",
    ],
    filler: ["von", "referenz", "ref.", "ref"],
  },
  en: {
    twoSided: ["to", "until"],
    upper: ["up to", "less than", "below"],
    lower: ["at least", "greater than", "above"],
    filler: ["from", "reference", "ref.", "ref"],
  },
  fr: {
    twoSided: ["a", "et"],
    upper: [
      "jusqu'a",
      "jusque",
      "inferieur a",
      "inferieure a",
      "moins de",
      "au plus",
      "au maximum",
    ],
    lower: [
      "a partir de",
      "superieur a",
      "superieure a",
      "plus de",
      "au moins",
      "au minimum",
    ],
    filler: [
      "de",
      "entre",
      "valeurs de reference",
      "valeur de reference",
      "intervalle de reference",
      "plage de reference",
    ],
  },
  es: {
    twoSided: ["a", "y"],
    upper: [
      "hasta",
      "menor que",
      "menor de",
      "menor a",
      "inferior a",
      "menos de",
      "como maximo",
      "maximo",
    ],
    lower: [
      "desde",
      "a partir de",
      "mayor que",
      "mayor de",
      "mayor a",
      "superior a",
      "mas de",
      "al menos",
      "como minimo",
      "minimo",
    ],
    filler: [
      "de",
      "entre",
      "valores de referencia",
      "valor de referencia",
      "rango de referencia",
      "intervalo de referencia",
    ],
  },
  it: {
    twoSided: ["a", "e"],
    upper: [
      "fino a",
      "inferiore a",
      "minore di",
      "meno di",
      "al massimo",
      "massimo",
    ],
    lower: [
      "da",
      "oltre",
      "superiore a",
      "maggiore di",
      "piu di",
      "almeno",
      "al minimo",
      "minimo",
    ],
    filler: [
      "da",
      "tra",
      "fra",
      "valori di riferimento",
      "valore di riferimento",
      "intervallo di riferimento",
    ],
  },
  pl: {
    twoSided: ["do"],
    upper: ["do", "ponizej", "mniej niz", "nie wiecej niz", "maks.", "maks"],
    lower: [
      "od",
      "powyzej",
      "wiecej niz",
      "co najmniej",
      "nie mniej niz",
      "minimum",
    ],
    filler: [
      "od",
      "zakres referencyjny",
      "wartosci referencyjne",
      "normy laboratoryjne",
    ],
  },
  nl: {
    twoSided: ["tot"],
    upper: [
      "tot",
      "onder",
      "kleiner dan",
      "minder dan",
      "hoogstens",
      "maximaal",
      "max.",
      "max",
    ],
    lower: [
      "vanaf",
      "boven",
      "groter dan",
      "meer dan",
      "minstens",
      "ten minste",
      "minimaal",
    ],
    filler: [
      "van",
      "tussen",
      "referentiewaarden",
      "referentiewaarde",
      "normaalwaarden",
      "normaalwaarde",
    ],
  }, // Korean marks a bound with a POSTPOSITION — "5.0 이하", "3.5 이상" — and the
  // matchers here are prefix-anchored, so only the prefix-shaped notation is
  // listed. A postfixed Korean range still falls through to text-only, which
  // `isUnreadableRange` reports rather than hides.
  "pt-BR": {
    twoSided: ["a", "e"],
    upper: [
      "ate",
      "menos de",
      "abaixo de",
      "inferior a",
      "maximo",
      "no maximo",
    ],
    lower: [
      "a partir de",
      "no minimo",
      "minimo",
      "acima de",
      "maior que",
      "maior de",
    ],
    filler: [
      "valores de referencia",
      "valor de referencia",
      "faixa de referencia",
    ],
  },
  ko: {
    twoSided: ["에서", "부터"],
    upper: ["최대", "최고"],
    lower: ["최소", "최저"],
    filler: ["참고치", "참고범위", "정상치", "정상범위", "기준치", "기준범위"],
  },
  // Russian lab sheets print "3,5 - 5,0", "от 3,5 до 5,0", "до 5,6",
  // "не более 5,6", "не менее 3,5" — "от"/"до" are both a bound prefix and a
  // filler, which is why they appear in all three lists.
  ru: {
    twoSided: ["до", "по"],
    upper: [
      "до",
      "не более",
      "не выше",
      "менее",
      "меньше",
      "ниже",
      "макс.",
      "макс",
      "максимум",
    ],
    lower: [
      "от",
      "не менее",
      "не ниже",
      "более",
      "больше",
      "выше",
      "мин.",
      "мин",
      "минимум",
    ],
    filler: [
      "от",
      "до",
      "референс",
      "референсные значения",
      "интервал нормы",
      "норма",
      "показатели нормы",
      "реф.",
      "реф",
    ],
  },
};

/** Escape a literal for regex use and let any run of whitespace join its words. */
function literalToPattern(word: string): string {
  return word
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(String.raw`\s+`);
}

/**
 * Alternation over every locale's list for one field, longest literal first so
 * the reader sees the specific form ahead of the prefix it contains.
 */
function proseAlternation(field: keyof RangeProse): string {
  const words = new Set<string>();
  for (const prose of Object.values(RANGE_PROSE)) {
    for (const word of prose[field]) words.add(word);
  }
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map(literalToPattern)
    .join("|");
}

/**
 * Symbolic infix separators. Kept apart from the word separators because they
 * need no surrounding whitespace, while a word separator must have it: "a",
 * "e" and "y" are one letter long, and a bare `e` that could sit between two
 * digits would read "3.5e5" as a window.
 */
// U+007E and the fullwidth U+FF5E are the separator a Korean lab prints
// ("3.5~5.0"); both are added here rather than to `twoSided` because they are
// symbols, and the symbol branch needs no surrounding whitespace.
const SYMBOL_SEP = String.raw`-|–|—|‒|~|～|…|\.{2,3}`;

/** Prefixes that state a ceiling only. */
const UPPER_PREFIX = `(?:<=|<|≤|${proseAlternation("upper")})`;

/** Prefixes that state a floor only. */
const LOWER_PREFIX = `(?:>=|>|≥|${proseAlternation("lower")})`;

/**
 * Trailing unit tail. Deliberately whitespace-free and comma-free: a real unit
 * symbol ("mmol/l", "mg/dL", "%", "/µl", "10^9/L") never contains either, and
 * refusing anything that does keeps a third number ("3,5 - 5,0 - 7,0") from
 * being swallowed as if it were a unit.
 */
const UNIT_TAIL = String.raw`(?:\s*([^\s,]{1,24}))?`;

const TWO_SIDED_RE = new RegExp(
  `^(${NUM})(?:\\s*(?:${SYMBOL_SEP})\\s*|\\s+(?:${proseAlternation(
    "twoSided",
  )})\\s+)(${NUM})${UNIT_TAIL}$`,
  "iu",
);
const UPPER_RE = new RegExp(`^${UPPER_PREFIX}\\s*(${NUM})${UNIT_TAIL}$`, "iu");
const LOWER_RE = new RegExp(`^${LOWER_PREFIX}\\s*(${NUM})${UNIT_TAIL}$`, "iu");

/** Leading words that only introduce the window ("von 3,5 bis 5,0"). */
const LEADING_FILLER_RE = new RegExp(
  `^(?:${proseAlternation("filler")})\\s+`,
  "iu",
);

/**
 * Read one number token into a JS number, or null when its separators are
 * ambiguous.
 *
 * Separator rules, in order:
 *   1. Both `.` and `,` present → the LAST one is the decimal mark, the other
 *      groups thousands ("1.234,56" and "1,234.56" both read as 1234.56).
 *   2. One separator kind, appearing more than once → all thousands
 *      ("1.234.567").
 *   3. One separator, appearing once, group ≠ 3 digits → decimal ("3,5").
 *   4. One separator, appearing once, group = 3 digits → ambiguous in the
 *      general case. Read as thousands only when the group is "000", which is
 *      how a German report prints a rounded count ("150.000 - 400.000 /µl");
 *      reading that as 150 would flag every normal platelet count as wildly
 *      high. Any other 3-digit group ("1.234" — 1234 or 1.234?) is refused.
 *
 * The limit of rule 4 is real: a report that prints "5.000" meaning five with
 * three decimal places is read as five thousand. The verbatim text is stored
 * either way, so the printed window is never lost — only the derived bound is.
 */
function readNumber(token: string): number | null {
  const sign = token.startsWith("-") ? -1 : 1;
  const body = token.replace(/^[+-]/u, "");

  const dots = (body.match(/\./gu) ?? []).length;
  const commas = (body.match(/,/gu) ?? []).length;

  let normalised: string;
  if (dots > 0 && commas > 0) {
    const decimalMark =
      body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
    const grouping = decimalMark === "." ? "," : ".";
    normalised = body.split(grouping).join("").replace(decimalMark, ".");
  } else if (dots + commas === 0) {
    normalised = body;
  } else if (dots > 1 || commas > 1) {
    normalised = body.replace(/[.,]/gu, "");
  } else {
    const idx = body.search(/[.,]/u);
    const group = body.slice(idx + 1);
    if (group.length !== 3) {
      normalised = `${body.slice(0, idx)}.${group}`;
    } else if (group === "000") {
      normalised = body.slice(0, idx) + group;
    } else {
      return null;
    }
  }

  const value = sign * Number(normalised);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_BOUND) return null;
  return value;
}

/** Compare a printed unit against the reading's unit, ignoring case + spaces. */
function unitsAgree(printed: string | undefined, reading: string | undefined) {
  if (!printed) return true;
  if (!reading || !reading.trim()) return true;
  const norm = (u: string) => u.replace(/\s+/gu, "").toLowerCase();
  return norm(printed) === norm(reading);
}

/**
 * Try the three notations against one candidate string. Null means none of
 * them matched; a result with both bounds null means one matched but the
 * numbers or the unit refused it, which is a final answer and not a reason to
 * retry a differently-trimmed candidate.
 */
function matchNotation(
  candidate: string,
  text: string,
  unit: string | null | undefined,
): ParsedReferenceRange | null {
  const noBounds: ParsedReferenceRange = { low: null, high: null, text };

  const two = TWO_SIDED_RE.exec(candidate);
  if (two) {
    if (!unitsAgree(two[3], unit ?? undefined)) return noBounds;
    const low = readNumber(two[1]);
    const high = readNumber(two[2]);
    if (low === null || high === null) return noBounds;
    // A transposed window is a transcription error, and swapping it would be a
    // guess about which digit the lab meant. Refuse the bounds, keep the text.
    if (low > high) return noBounds;
    return { low, high, text };
  }

  const upper = UPPER_RE.exec(candidate);
  if (upper) {
    if (!unitsAgree(upper[2], unit ?? undefined)) return noBounds;
    const high = readNumber(upper[1]);
    return high === null ? noBounds : { low: null, high, text };
  }

  const lower = LOWER_RE.exec(candidate);
  if (lower) {
    if (!unitsAgree(lower[2], unit ?? undefined)) return noBounds;
    const low = readNumber(lower[1]);
    return low === null ? noBounds : { low, high: null, text };
  }

  return null;
}

/**
 * Parse the reference range a lab report printed for one reading.
 *
 * @param raw   the printed string, exactly as transcribed.
 * @param unit  the reading's own unit, when known. A printed window in a
 *              different unit yields text-only — never a converted bound.
 * @returns null when there was nothing printed at all. A non-null result with
 *          both bounds null means the report DID print something the parser
 *          could not read — see `isUnreadableRange`, which is the difference
 *          between "no window" and "a window nobody checked".
 */
export function parseReferenceRange(
  raw: string | null | undefined,
  unit?: string | null,
): ParsedReferenceRange | null {
  if (raw === null || raw === undefined) return null;
  const text = raw
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, SOURCE_REFERENCE_TEXT_MAX);
  if (text === "") return null;

  // Fold for MATCHING only — the stored text stays exactly what the report
  // printed. Accents go so a table written "jusqu'a" meets a report's
  // "jusqu'à"; the curled apostrophe a word processor emits becomes the
  // straight one the table carries. Everything else, notably the digits and
  // their separators, is left alone.
  let candidate = normaliseApostrophes(stripDiacritics(text));
  const bracketed = /^[[(](.*)[\])]$/u.exec(candidate);
  if (bracketed) candidate = bracketed[1].trim();

  // Untrimmed first. Several introducing words are also a bound prefix in
  // their own language — Italian "da", Polish "od", French "de" — so stripping
  // before matching would read "da 3,5" as a bare number with no floor.
  const direct = matchNotation(candidate, text, unit);
  if (direct) return direct;

  const trimmed = candidate.replace(LEADING_FILLER_RE, "").trim();
  if (trimmed !== candidate) {
    const viaFiller = matchNotation(trimmed, text, unit);
    if (viaFiller) return viaFiller;
  }

  // Anything else — "negativ", "siehe Befund", a bare number, prose — keeps its
  // text and states no window.
  return { low: null, high: null, text };
}

/**
 * True when the report printed a range and the parser could not derive a
 * single bound from it.
 *
 * This is the case worth naming. `null` from the parser means the report
 * stated nothing, and the reading falls back to the biomarker's own band as it
 * always did. A parsed result with two null bounds means something else
 * entirely: the lab DID state a window, on this reading, and the app is about
 * to judge the value against a different band or against none at all. Left
 * unnamed it reads identically to "no range" at every call site, which is how
 * a French account's `jusqu'à 5,0` became a reading nobody ever flagged.
 *
 * Callers are expected to SAY so rather than to guess a bound — the manual
 * form shows the reader that the string was kept but not read, and the ingest
 * paths annotate it so an unreadable notation shows up as a number in the wide
 * event instead of as silence.
 */
export function isUnreadableRange(
  parsed: ParsedReferenceRange | null | undefined,
): boolean {
  return !!parsed && parsed.low === null && parsed.high === null;
}
