/**
 * Lab values read out of a lab report's text by rule, with no model.
 *
 * The text is what the document vault already holds for a document: its PDF
 * text layer, or what OCR on the server read off a scan. Most lab reports
 * print one reading per line, as a table:
 *
 *     Natrium          141     mmol/l     135 - 145
 *     Kreatinin        1,08 H  mg/dl      0,70 - 1,20
 *     Hemoglobin       14.6    g/dL       13.5-17.5
 *     CRP              < 0,5   mg/l       < 5,0
 *     TSH              2,31    0,27 - 4,20   mU/l
 *
 * so a line is read as: the analyte name, the value (a number, a number
 * behind `<` or `>`, or a word such as "negativ"), a printed flag that is
 * dropped, the unit, and the reference range printed beside it. The range
 * may also stand before the unit. Columns are runs of spaces, as the text
 * layer and OCR with preserved interword spaces both give them.
 *
 * What it will not do, on purpose, as the model path will not either:
 *   - interpret: a flag the lab printed (H, L, +, *, arrows) is dropped, never
 *     turned into "high" or "low", and a value is never compared to its range;
 *   - guess a code: there is no LOINC code unless the report printed one, and
 *     the catalog carries none, so `code` stays empty;
 *   - convert a unit: the unit is the one printed, spelled as printed, except
 *     for the few OCR misreadings named in `OCR_UNIT_REPAIRS`, and a repaired
 *     unit sends the row to review.
 *
 * Which lines count. A line whose name is a marker the app knows in any of
 * its languages (`catalogKeyForName`, built from `messages/*.json` and the
 * alias lists) counts with a value alone. Any other line needs a unit this
 * module recognises AND a range that reduces to bounds; a line with a number
 * and nothing else is a phone number, a page number or a date, and is left
 * out. The person reviews every row before anything is saved, so a row left
 * out costs typing, and a row wrongly read costs a careful look; the rule
 * leans towards leaving out.
 *
 * Pure: no I/O, no clock. Script-agnostic: a name is letters of any script,
 * so a Russian or Korean text layer reads as well as a German one.
 */
import { stripDiacritics } from "@/lib/i18n/fold-for-match";

import { catalogKeyForName } from "./analyte-match";
import { parseReferenceRange } from "./parse-reference-range";

/** Why a row needs a closer look than its confidence alone says. */
export type LabRowDoubt =
  /** The unit was an OCR misreading repaired here (`Tsd/pl` → `Tsd/µl`). */
  | "unit-repaired"
  /** A number like `1.080` that reads as a decimal or with a thousands mark. */
  | "ambiguous-number"
  /** No unit was printed, or none this module recognises. */
  | "no-unit";

export interface LabTextRow {
  /** The analyte name as printed, without leaders, bullets or a trailing colon. */
  label: string;
  /** The numeric result, or null for a text result. */
  value: number | null;
  /** The result as text: a word ("negativ") or a bound ("< 0,5"). */
  valueText: string | null;
  unit: string | null;
  /** The printed range, verbatim (whitespace collapsed), or null. */
  referenceText: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The line the row was read from, trimmed, and where it starts in the text. */
  line: string;
  lineOffset: number;
  /** The catalog marker the name is, when it is one. */
  catalogKey: string | null;
  /** 0..1, by how much of the row the rules recognised. */
  confidence: number;
  doubts: LabRowDoubt[];
}

export interface LabTextReading {
  rows: LabTextRow[];
  /** The report's date (YYYY-MM-DD) when a dated line says so, else null. */
  reportDate: string | null;
}

export interface LabTextOptions {
  /** The text came from OCR: unit misreadings are repaired, confidence is lower. */
  ocr?: boolean;
  /** Stop after this many rows. */
  maxRows?: number;
}

/** A line longer than this is prose, not a table row. */
const MAX_LINE_LENGTH = 240;

/** A name longer than this is a sentence. */
const MAX_LABEL_LENGTH = 80;

// ── Numbers ───────────────────────────────────────────────────────────────

const COMPARATOR = /^(?:<=|>=|[<>≤≥])$/u;
/** A value token: an optional comparator (group 1) and the number (group 2). */
const VALUE_TOKEN = /^(<=|>=|[<>≤≥])?(\d{1,7}(?:[.,]\d{1,6})*)[*!↑↓]?$/u;

type DecimalMark = "comma" | "dot" | null;

/**
 * A printed number, or null for one that is not a plain reading (a date, a
 * version string). A separator before exactly three digits (`1.080`,
 * `1,250`) can be a decimal or a thousands mark: the document's own decimal
 * mark decides, and where the document has none the number is read as a
 * decimal and `ambiguous`, which sends the row to review.
 */
export function readLabNumber(
  raw: string,
  decimal: DecimalMark,
): { value: number; ambiguous: boolean } | null {
  if (/^\d+$/u.test(raw)) return { value: Number(raw), ambiguous: false };
  const grouped = /^\d{1,3}([.,])\d{3}$/u.exec(raw);
  if (grouped) {
    const sep = grouped[1];
    const asDecimal =
      decimal === null ||
      (decimal === "comma" && sep === ",") ||
      (decimal === "dot" && sep === ".");
    const value = asDecimal
      ? Number(raw.replace(",", "."))
      : Number(raw.replace(sep, ""));
    // Read by the document's own mark when it has one; in doubt without.
    return { value, ambiguous: decimal === null };
  }
  if (/^\d+,\d+$/u.test(raw)) {
    return { value: Number(raw.replace(",", ".")), ambiguous: false };
  }
  if (/^\d+\.\d+$/u.test(raw)) return { value: Number(raw), ambiguous: false };
  // 1.234,5 and 1,234.5: both marks, so neither is in doubt.
  if (/^\d{1,3}(?:\.\d{3})+,\d+$/u.test(raw)) {
    return {
      value: Number(raw.replace(/\./gu, "").replace(",", ".")),
      ambiguous: false,
    };
  }
  if (/^\d{1,3}(?:,\d{3})+\.\d+$/u.test(raw)) {
    return { value: Number(raw.replace(/,/gu, "")), ambiguous: false };
  }
  // 150.000.000 is grouped; anything else with two marks is not a reading.
  if (/^\d{1,3}(?:[.]\d{3}){2,}$/u.test(raw)) {
    return { value: Number(raw.replace(/\./gu, "")), ambiguous: false };
  }
  if (/^\d{1,3}(?:[,]\d{3}){2,}$/u.test(raw)) {
    return { value: Number(raw.replace(/,/gu, "")), ambiguous: false };
  }
  return null;
}

/** The decimal mark the document's numbers use, when they agree. */
function documentDecimalMark(lines: readonly string[]): DecimalMark {
  let comma = 0;
  let dot = 0;
  for (const line of lines) {
    // Dates and times are not decimals.
    const cleaned = line
      .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/gu, " ")
      .replace(/\b\d{1,2}:\d{2}\b/gu, " ");
    for (const m of cleaned.matchAll(/\d[.,]\d+/gu)) {
      // A three-digit group says nothing on its own.
      if (/^\d[.,]\d{3}$/u.test(m[0])) continue;
      if (m[0].includes(",")) comma += 1;
      else dot += 1;
    }
  }
  if (comma === 0 && dot === 0) return null;
  if (comma >= dot * 3) return "comma";
  if (dot >= comma * 3) return "dot";
  return null;
}

// ── Units ─────────────────────────────────────────────────────────────────

/**
 * The parts a lab unit is made of, folded (lower case, `µ` for every micro
 * sign). A unit is one of `SINGLE_UNITS`, or two or three of these joined by
 * slashes. Picolitre is missing on purpose: no lab reports in it, and OCR
 * reads `µl` as `pl` (see `OCR_UNIT_REPAIRS`).
 */
const UNIT_PARTS = new Set([
  // mass
  "g",
  "mg",
  "µg",
  "ug",
  "mcg",
  "ng",
  "pg",
  "fg",
  "kg",
  // amount
  "mol",
  "mmol",
  "µmol",
  "umol",
  "nmol",
  "pmol",
  "fmol",
  "meq",
  "mval",
  "osm",
  "mosm",
  "mosmol",
  // activity
  "u",
  "iu",
  "ie",
  "mu",
  "miu",
  "mie",
  "µu",
  "uu",
  "µiu",
  "uiu",
  "ku",
  "kiu",
  "kat",
  "µkat",
  "nkat",
  // volume
  "l",
  "dl",
  "ml",
  "µl",
  "ul",
  "nl",
  "fl",
  // counts
  "tsd",
  "mio",
  "gpt",
  "tpt",
  "t",
  "zellen",
  "cells",
  "10^3",
  "10^6",
  "10^9",
  "10^12",
  "x10^3",
  "x10^6",
  "x10^9",
  "x10^12",
  // time, area, length
  "h",
  "24h",
  "min",
  "s",
  "sec",
  "d",
  "m²",
  "m2",
  "1,73",
  "1.73",
  "1,73m²",
  "1.73m²",
  "1,73m2",
  "1.73m2",
  "mm",
  "cm",
]);

/** Units that stand alone, without a slash. */
const SINGLE_UNITS = new Set([
  "%",
  "‰",
  "fl",
  "pg",
  "s",
  "sec",
  "sek",
  "ratio",
  "index",
  "mmhg",
  "g",
  "mg",
  "µg",
  "ng",
  "kg",
  "u",
  "iu",
  "ie",
  "mu",
  "miu",
  "mie",
  "mmol",
  "µmol",
  "nmol",
  "pmol",
  "mol",
  "tsd",
  "mio",
]);

/**
 * OCR misreadings of a unit part, repaired only on OCR'd text: the micro
 * sign read as `p`, and a lower-case `l` read as a capital `I`.
 */
const OCR_UNIT_REPAIRS: ReadonlyMap<string, string> = new Map([
  ["pl", "µl"],
  ["i", "l"],
  ["di", "dl"],
  ["mi", "ml"],
  ["µi", "µl"],
  ["pmoi", "µmol"],
  ["pg/i", "pg/l"],
]);

function foldUnit(raw: string): string {
  return raw
    .replace(/[μ]/gu, "µ")
    .replace(/[×]/gu, "x")
    .replace(/10\*(\d)/gu, "10^$1")
    .replace(/10e(\d)/giu, "10^$1")
    .toLowerCase();
}

/** The printed unit when `raw` is one, as printed or repaired. */
function readUnit(
  raw: string,
  ocr: boolean,
): { unit: string; repaired: boolean } | null {
  // A bracketed note after the unit ("(calc)", "(FEU)") stays with it.
  const bare = raw.replace(/\s*\([^()]*\)$/u, "");
  if (bare === "" || bare.length > 24) return null;
  const folded = foldUnit(bare);
  if (isUnit(folded)) return { unit: raw, repaired: false };
  if (!ocr) return null;
  const parts = folded.split("/");
  const repairedParts = parts.map((part) => OCR_UNIT_REPAIRS.get(part) ?? part);
  const repaired = repairedParts.join("/");
  if (repaired === folded || !isUnit(repaired)) return null;
  // Rebuild in the printed spelling, with only the misread parts swapped.
  const printed = bare
    .split("/")
    .map((part, i) => (repairedParts[i] !== parts[i] ? repairedParts[i] : part))
    .join("/");
  return { unit: printed + raw.slice(bare.length), repaired: true };
}

function isUnit(folded: string): boolean {
  if (SINGLE_UNITS.has(folded)) return true;
  // "mm/h" for the sedimentation rate, "mosm/kg".
  const parts = folded.split("/");
  if (parts.length < 2 || parts.length > 3) return false;
  return parts.every((part, i) =>
    // A leading slash ("/µl", "/nl") is a count per volume.
    i === 0 && part === "" ? true : UNIT_PARTS.has(part),
  );
}

// ── Flags and words ───────────────────────────────────────────────────────

/** A flag a lab prints beside a value. Dropped, never read. */
const FLAG_TOKEN =
  /^(?:[HL]{1,2}|\+{1,3}|-{1,2}|\*{1,3}|!{1,2}|↑{1,2}|↓{1,2}|\([+-]\)|\(?[HL]\)?)$/u;

/**
 * Text results a report prints in the value column, folded. A text result
 * counts only for a marker the app knows, since "normal" or "negativ" alone
 * on a line can be anything.
 */
const QUALITATIVE_WORDS = new Set([
  "negativ",
  "negative",
  "neg",
  "neg.",
  "positiv",
  "positive",
  "pos",
  "pos.",
  "nachweisbar",
  "detected",
  "negatif",
  "positif",
  "negativo",
  "positivo",
  "ujemny",
  "dodatni",
  "negatief",
  "positief",
  "отрицательно",
  "положительно",
  "음성",
  "양성",
]);

/** "nicht nachweisbar", "not detected", "non rilevabile", … as one result. */
const QUALITATIVE_PHRASES = [
  "nicht nachweisbar",
  "not detected",
  "non detecte",
  "no detectado",
  "non rilevabile",
  "nie wykryto",
  "niet aantoonbaar",
  "nao detectado",
  "не обнаружено",
];

// ── Lines ─────────────────────────────────────────────────────────────────

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokensOf(line: string): Token[] {
  return [...line.matchAll(/\S+/gu)].map((m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** The name before the value: leaders, bullets and a trailing colon gone. */
function cleanLabel(raw: string): string {
  return raw
    .replace(/[.…_]{3,}/gu, " ")
    .replace(/^[\s\-–•*·▪>]+/u, "")
    .replace(/[\s:.…_]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isLabelText(label: string): boolean {
  if (label.length < 2 || label.length > MAX_LABEL_LENGTH) return false;
  const letters = label.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2) return false;
  // A date or a time in the name column is a header line.
  if (/\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{1,2}:\d{2}/u.test(label)) return false;
  return true;
}

/** Where the unit stands: the longest run of one to three tokens that is one. */
function unitAt(
  tokens: readonly Token[],
  from: number,
  ocr: boolean,
): { unit: string; repaired: boolean; next: number } | null {
  for (let span = Math.min(3, tokens.length - from); span >= 1; span--) {
    const joined = tokens
      .slice(from, from + span)
      .map((t) => t.text)
      .join("");
    const unit = readUnit(joined, ocr);
    if (unit) return { ...unit, next: from + span };
  }
  return null;
}

function unitEndingAt(
  tokens: readonly Token[],
  end: number,
  floor: number,
  ocr: boolean,
): { unit: string; repaired: boolean; start: number } | null {
  for (let span = Math.min(3, end - floor); span >= 1; span--) {
    const joined = tokens
      .slice(end - span, end)
      .map((t) => t.text)
      .join("");
    const unit = readUnit(joined, ocr);
    if (unit) return { ...unit, start: end - span };
  }
  return null;
}

function dropFlags(tokens: readonly Token[]): Token[] {
  let first = 0;
  let last = tokens.length;
  while (first < last && FLAG_TOKEN.test(tokens[first].text)) first += 1;
  while (last > first && FLAG_TOKEN.test(tokens[last - 1].text)) last -= 1;
  return tokens.slice(first, last);
}

/**
 * A gap this wide ends the row. The range is the last column of a row, so a
 * gap after it starts something else: a second table printed beside the
 * first, or a comment column.
 */
const COLUMN_GAP = 4;

function untilColumnGap(tokens: readonly Token[]): Token[] {
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].start - tokens[i - 1].end >= COLUMN_GAP) {
      return tokens.slice(0, i);
    }
  }
  return [...tokens];
}

function joinTokens(line: string, tokens: readonly Token[]): string | null {
  if (tokens.length === 0) return null;
  return line
    .slice(tokens[0].start, tokens[tokens.length - 1].end)
    .replace(/\s+/gu, " ")
    .trim();
}

interface ValueAt {
  index: number;
  /** Tokens the value takes (a comparator can stand apart: "< 0,5"). */
  width: number;
  value: number | null;
  valueText: string | null;
  ambiguous: boolean;
}

/** The first value after a name, scanning left to right. */
function findValue(
  line: string,
  tokens: readonly Token[],
  decimal: DecimalMark,
): ValueAt | null {
  for (let i = 1; i < tokens.length; i++) {
    const label = cleanLabel(line.slice(0, tokens[i].start));
    if (!isLabelText(label)) continue;
    const token = tokens[i].text;
    const folded = stripDiacritics(token.toLowerCase());
    const phrase = QUALITATIVE_PHRASES.find((p) =>
      stripDiacritics(line.slice(tokens[i].start).toLowerCase()).startsWith(p),
    );
    if (phrase) {
      const width = phrase.split(" ").length;
      return {
        index: i,
        width,
        value: null,
        valueText: joinTokens(line, tokens.slice(i, i + width)),
        ambiguous: false,
      };
    }
    if (QUALITATIVE_WORDS.has(folded)) {
      return {
        index: i,
        width: 1,
        value: null,
        valueText: token,
        ambiguous: false,
      };
    }
    // "< 0,5" with the comparator standing apart.
    if (COMPARATOR.test(token) && i + 1 < tokens.length) {
      const next = VALUE_TOKEN.exec(tokens[i + 1].text);
      if (next && !next[1] && readLabNumber(next[2], decimal)) {
        return {
          index: i,
          width: 2,
          value: null,
          valueText: joinTokens(line, tokens.slice(i, i + 2)),
          ambiguous: false,
        };
      }
    }
    const m = VALUE_TOKEN.exec(token);
    if (!m) continue;
    const number = readLabNumber(m[2], decimal);
    if (!number) continue;
    if (m[1]) {
      return {
        index: i,
        width: 1,
        value: null,
        valueText: token.replace(/[*!↑↓]$/u, ""),
        ambiguous: false,
      };
    }
    return {
      index: i,
      width: 1,
      value: number.value,
      valueText: null,
      ambiguous: number.ambiguous,
    };
  }
  return null;
}

/** Read one line as a row, or null when it is not one. */
function readLine(
  line: string,
  offset: number,
  decimal: DecimalMark,
  ocr: boolean,
): LabTextRow | null {
  if (line.trim().length < 4 || line.length > MAX_LINE_LENGTH) return null;
  const tokens = tokensOf(line);
  if (tokens.length < 2) return null;
  const found = findValue(line, tokens, decimal);
  if (!found) return null;

  const label = cleanLabel(line.slice(0, tokens[found.index].start));
  const catalogKey = catalogKeyForName(label);
  // A text result is a reading only for a marker the app knows.
  if (found.value === null && /^\p{L}/u.test(found.valueText ?? "")) {
    if (!catalogKey) return null;
  }

  // What follows the value, printed flags dropped from both ends.
  const after = dropFlags(tokens.slice(found.index + found.width));
  let unit: { unit: string; repaired: boolean } | null = null;
  let rangeTokens: Token[] = after;
  const leading = unitAt(after, 0, ocr);
  if (leading) {
    unit = leading;
    rangeTokens = dropFlags(untilColumnGap(after.slice(leading.next)));
  } else {
    // The range before the unit: "TSH 2,31 0,27 - 4,20 mU/l".
    const trailing = unitEndingAt(after, after.length, 0, ocr);
    if (trailing) {
      unit = trailing;
      rangeTokens = dropFlags(after.slice(0, trailing.start));
    }
  }

  const rangeText = joinTokens(line, rangeTokens);
  const range = parseReferenceRange(rangeText, unit?.unit ?? null);
  const hasBounds = !!range && (range.low !== null || range.high !== null);
  if (!catalogKey && !(unit && hasBounds)) return null;
  // A text result with no window beside it has no range to keep either.
  const referenceText = range?.text ?? null;

  const doubts: LabRowDoubt[] = [];
  if (unit?.repaired) doubts.push("unit-repaired");
  if (found.ambiguous) doubts.push("ambiguous-number");
  if (!unit && found.value !== null) doubts.push("no-unit");

  let confidence = 0.5;
  if (catalogKey) confidence += 0.25;
  if (unit) confidence += 0.1;
  if (hasBounds) confidence += 0.1;
  if (ocr) confidence -= 0.1;
  confidence -= 0.15 * doubts.length;
  confidence =
    Math.round(Math.min(0.95, Math.max(0.05, confidence)) * 100) / 100;

  const lead = line.length - line.trimStart().length;
  return {
    label,
    value: found.value,
    valueText: found.valueText,
    unit: unit?.unit ?? null,
    referenceText,
    referenceLow: range?.low ?? null,
    referenceHigh: range?.high ?? null,
    line: line.trim(),
    lineOffset: offset + lead,
    catalogKey,
    confidence,
    doubts,
  };
}

// ── The report date ───────────────────────────────────────────────────────

/**
 * Words that introduce the date a sample was taken or the report written,
 * folded. A birth date is excluded by `BIRTH_WORDS` before these are tried.
 */
const DATE_WORDS =
  /(?:befund|eingang|eingangs|probeneingang|entnahme|abnahme|untersuchung|auftrag|datum|date|collected|collection|reported|received|sample|prelevement|fecha|toma|prelievo|data|pobrania|pobranie|afname|coleta|дата)/u;
const BIRTH_WORDS =
  /(?:geburt|geb\.|birth|dob|naissance|nacimiento|nascita|urodzenia|geboorte|nascimento|рождения)/u;

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) {
    return null;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The first date on a line, as YYYY-MM-DD. Day-first with dots or dashes
 * (`03.11.2026`, `03-11-2026`), ISO (`2026-11-03`), and with slashes only
 * when the order is certain (a day above 12); `03/11/2026` is left unread
 * rather than guessed.
 */
export function readLineDate(line: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/u.exec(line);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dotted = /\b(\d{1,2})[.-](\d{1,2})[.-](\d{4})\b/u.exec(line);
  if (dotted) {
    return isoDate(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]));
  }
  const slashed = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/u.exec(line);
  if (slashed) {
    const a = Number(slashed[1]);
    const b = Number(slashed[2]);
    const year = Number(slashed[3]);
    if (a > 12 && b <= 12) return isoDate(year, b, a);
    if (b > 12 && a <= 12) return isoDate(year, a, b);
  }
  return null;
}

function reportDateOf(lines: readonly string[]): string | null {
  for (const line of lines.slice(0, 60)) {
    const folded = stripDiacritics(line.toLowerCase());
    if (!DATE_WORDS.test(folded) || BIRTH_WORDS.test(folded)) continue;
    const date = readLineDate(line);
    if (date) return date;
  }
  return null;
}

// ── The whole text ────────────────────────────────────────────────────────

/** The identity of a row for the merge: a table repeated on page two is one. */
function rowKey(row: LabTextRow): string {
  return [
    row.label.toLowerCase(),
    row.value ?? "",
    (row.valueText ?? "").toLowerCase(),
    (row.unit ?? "").toLowerCase(),
  ].join("|");
}

/** Read the lab values of a report's text. */
export function readLabValues(
  text: string,
  options: LabTextOptions = {},
): LabTextReading {
  const ocr = options.ocr === true;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const lines: { text: string; offset: number }[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lines.push({ text: line, offset });
    offset += raw.length + 1;
  }
  const decimal = documentDecimalMark(lines.map((l) => l.text));
  const rows: LabTextRow[] = [];
  const seen = new Set<string>();
  for (const { text: line, offset: at } of lines) {
    if (rows.length >= maxRows) break;
    const row = readLine(line, at, decimal, ocr);
    if (!row) continue;
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return { rows, reportDate: reportDateOf(lines.map((l) => l.text)) };
}
