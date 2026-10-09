/**
 * Ranking for the command palette: what a typed query matches, and in which
 * order. Pure and dependency-free, so it can be pinned without a DOM and adds
 * nothing to a bundle beyond itself.
 *
 * Tiers, best first:
 *
 *   1. the title is the query, or starts with it;
 *   2. a word of the title starts with the query (every word of a multi-word
 *      query, each against its own word);
 *   3. the same two against a synonym;
 *   4. the query appears inside the title or a synonym;
 *   5. a typo: a word is within a small edit distance of the query (one edit
 *      from four characters, two from seven, none below that, where a short
 *      query would match half the index);
 *   6. the query's letters appear in order (`blprs` → "Blood pressure"),
 *      only from three characters.
 *
 * Text is compared case-folded and without diacritics, with `ß` as `ss`, so
 * "Gewicht", "gewicht" and "Gewícht" are one word and "Größe" finds "grosse".
 */

export interface Rankable {
  title: string;
  /** Synonyms and related words; matched one tier below the title. */
  keywords?: ReadonlyArray<string>;
}

const TIER = {
  exact: 1000,
  prefix: 900,
  wordStart: 750,
  contains: 500,
  typo: 300,
  subsequence: 100,
} as const;

/** A synonym scores this much below the same match on the title. */
const KEYWORD_PENALTY = 60;

/** Case-folded, diacritics removed, `ß` as `ss`, whitespace collapsed. */
export function normaliseSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return text.split(/[\s\-–—/(),.:;·&+]+/).filter(Boolean);
}

/** How many edits a query of this length may be away from a word. */
function typoAllowance(length: number): number {
  if (length < 4) return 0;
  if (length < 7) return 1;
  return 2;
}

/**
 * Optimal-string-alignment distance (Levenshtein plus adjacent swaps), with
 * an early exit once every cell of a row is past `max`.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

function isSubsequence(query: string, text: string): boolean {
  let at = 0;
  for (const ch of text) {
    if (ch === query[at]) at++;
    if (at === query.length) return true;
  }
  return false;
}

/** The score of one normalised field against a normalised query; 0 = none. */
function scoreField(query: string, field: string): number {
  if (field === "") return 0;
  if (field === query) return TIER.exact;
  if (field.startsWith(query)) return TIER.prefix;

  const fieldWords = words(field);
  const queryWords = words(query);
  if (
    queryWords.length > 0 &&
    queryWords.every((q) => fieldWords.some((w) => w.startsWith(q)))
  ) {
    return TIER.wordStart;
  }
  if (field.includes(query)) return TIER.contains;

  // A typo: each query word close to a word of the field, or to the start of
  // one (a typo in the middle of typing: "medik" for "medikamente" is a
  // prefix, "mdikam" is a typo of its prefix).
  const typoScore = (() => {
    let worst = 0;
    for (const q of queryWords) {
      const allowed = typoAllowance(q.length);
      if (allowed === 0) return 0;
      let best = Infinity;
      for (const w of fieldWords) {
        const whole = editDistance(q, w, allowed);
        const head =
          w.length > q.length
            ? editDistance(q, w.slice(0, q.length), allowed)
            : whole;
        best = Math.min(best, whole, head);
      }
      if (best > allowed) return 0;
      worst = Math.max(worst, best);
    }
    return TIER.typo - worst * 40;
  })();
  if (typoScore > 0) return typoScore;

  const compact = query.replace(/ /g, "");
  if (compact.length >= 3 && isSubsequence(compact, field.replace(/ /g, ""))) {
    // Denser matches first: "bp" letters close together beat letters strewn
    // across a long title.
    return TIER.subsequence - Math.min(50, field.length - compact.length);
  }
  return 0;
}

/** How well `entry` matches `query`; 0 means not at all. */
export function scoreEntry(query: string, entry: Rankable): number {
  const q = normaliseSearchText(query);
  if (q === "") return 0;
  let best = scoreField(q, normaliseSearchText(entry.title));
  for (const keyword of entry.keywords ?? []) {
    const score = scoreField(q, normaliseSearchText(keyword));
    if (score > 0) best = Math.max(best, score - KEYWORD_PENALTY);
  }
  return best;
}

/**
 * The entries that match `query`, best first. Ties keep the shorter title
 * first (the more specific page), then the order they came in.
 */
export function rankEntries<T extends Rankable>(
  query: string,
  entries: ReadonlyArray<T>,
): T[] {
  return entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(query, entry) }))
    .filter((hit) => hit.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.title.length - b.entry.title.length ||
        a.index - b.index,
    )
    .map((hit) => hit.entry);
}
