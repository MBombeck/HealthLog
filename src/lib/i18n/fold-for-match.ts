/**
 * Character folds used when app text has to be matched against text a PERSON
 * or a LAB typed, rather than compared byte-for-byte.
 *
 * Every matcher that reads a shipped translation and looks for it in stored
 * or transcribed text needs the same tolerances — case, accents, the
 * apostrophe a word processor curled, and the fullwidth forms a Chinese or
 * Japanese report prints for ASCII — and every matcher that grows its own
 * copy of them drifts from the others. One home, so "Perte d'appétit" typed
 * with a straight quote meets the bundle's "Perte d’appétit", and a French
 * report's "jusqu'à" meets a table written "jusqu'a".
 *
 * The folds are one-directional and deliberately NOT transliteration: German
 * "ue" does not fold onto "ü", "ß" is left alone (it has no canonical
 * decomposition), and the Polish "ł" is a single codepoint NFD does not touch.
 * That is fine — what has to agree is a shipped string with itself as a person
 * retyped it, not two spellings of the same word.
 *
 * Client-safe: no message bundles are imported here, so a client component may
 * use these. Building an index OVER the bundles is a server concern and lives
 * in `./shared-resolve`.
 *
 * ## Why there is a second fold, and when to reach for it
 *
 * `./localised-label-index` carries `foldLabel`, and the two disagree ON
 * PURPOSE rather than by accident. That one decomposes with NFKD, maps "ß" to
 * "ss" and "œ" to "oe", and joins with "_"; this one decomposes with NFD,
 * leaves "ß" alone, and joins with spaces.
 *
 * The difference is who typed the text. Here the other side of the comparison
 * is a shipped label a person retyped, or prose a lab printed, so tolerating a
 * DIFFERENT SPELLING would be reaching beyond what the fold can honestly
 * claim. There, someone is naming a metric to an assistant in their own words,
 * and "Suessstoff" for "Süßstoff" is the same request; the wider fold earns
 * its keep because the caller is composing, not reproducing.
 *
 * Keep them apart. Whichever you pick, apply it to BOTH sides of the
 * comparison — a fold on one side only is an exact-string match in a
 * disguise.
 */

/** Curly, modifier and backtick apostrophes a keyboard or word processor emits. */
const APOSTROPHES = /[\u2018\u2019\u02bc\u00b4`']/gu;

/** Combining marks left behind by an NFD decomposition. */
const COMBINING_MARKS = /[\u0300-\u036f]/gu;

/**
 * The fullwidth ASCII block, U+FF01–U+FF5E: the same characters as `!` through
 * `~`, set wide for use beside Han and Kana.
 */
const FULLWIDTH_ASCII = /[\uff01-\uff5e]/gu;

/** The ideographic space, U+3000. `\s` already matches it; this names it. */
const IDEOGRAPHIC_SPACE = /\u3000/gu;

/**
 * Drop accents by decomposing and removing the combining marks: "é" → "e",
 * "ż" → "z", "Ü" → "U". Punctuation, case and spacing survive untouched, so
 * this is the fold to use where the surrounding characters carry meaning — a
 * printed range's "3,5-5,0", a unit's "mg/dL".
 */
export function stripDiacritics(raw: string): string {
  // Recomposed with NFC after the strip because NFD splits Hangul into JAMO,
  // and jamo are not in the COMBINING_MARKS range, so they survive: without
  // this the folded form of "목표" is a jamo sequence that no precomposed
  // literal in any table can match. Latin/Polish/German folds are unaffected —
  // the combining marks are already gone, so there is nothing to recompose.
  return raw.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
}

/** Collapse every apostrophe variant onto the straight ASCII one. */
export function normaliseApostrophes(raw: string): string {
  return raw.replace(APOSTROPHES, "'");
}

/**
 * Fold the fullwidth rendering of ASCII onto ASCII: "３．５" → "3.5",
 * "ｍｍｏｌ／Ｌ" → "mmol/L", "７０％" → "70%", and the ideographic space onto an
 * ordinary one.
 *
 * A report printed in Chinese or Japanese sets digits, the decimal dot, a
 * range hyphen and a unit in the fullwidth block. Those codepoints mean exactly
 * what their ASCII twins mean and nothing else, so this is a spelling tolerance
 * rather than a translation — the fullwidth "、" and "。" stay untouched,
 * because they are punctuation rather than a wide rendering of an ASCII mark.
 *
 * Deliberately not NFKC, which would also rewrite compatibility characters
 * whose meaning differs ("①" → "1", "㈱" → "(株)") and turn a one-sentence rule
 * into a Unicode compatibility table. Han and Kana are untouched: they have no
 * ASCII twin to fold onto.
 */
export function foldFullWidthToAscii(raw: string): string {
  return raw
    .replace(FULLWIDTH_ASCII, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(IDEOGRAPHIC_SPACE, " ");
}

/**
 * Fold a label to its comparison form: lower case, no accents, and every
 * apostrophe / hyphen / underscore / slash reduced to a single space.
 *
 * This is the fold for whole LABELS — a tag, an analyte name, a qualitative
 * result term — where internal punctuation is noise. Apply it identically to
 * both sides of a comparison; a fold applied to only one side is an
 * exact-string match wearing a disguise.
 */
export function foldForMatch(raw: string): string {
  return stripDiacritics(raw.toLowerCase())
    .replace(APOSTROPHES, " ")
    .replace(/[-_/]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
