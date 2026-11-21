/**
 * Matching and ranking for the record search, shared by the MCP `search` tool
 * and the in-app search (`POST /api/search`). Pure: no database, no crypto.
 *
 * Folding. A field and a query are compared after the body-sites service's
 * folding (`normalizeSearchText`: Unicode compatibility form, marks stripped,
 * lower case, whitespace collapsed) plus the German spellings a keyboard
 * without umlauts produces: "ß" reads as "ss", and "ae", "oe", "ue" read as
 * "a", "o", "u". Both sides fold the same way, so "Schulter" finds
 * "schulter", "Hüfte" finds "huefte" and "Fuß" finds "fuss".
 *
 * Ranking. Every query word scores the best field it hits (a title, label,
 * site, reason or practitioner counts more than a kind word or a side, which
 * counts more than a note or an indexed-text hit). Results order by how many
 * query words they matched, then by score, then by a fixed kind order, then
 * newest first, then by id: the same query over the same record always
 * returns the same list, which is what the MCP offset cursor relies on.
 */
import { tokenise } from "@/lib/documents/content-index";
import { expandQueryTokens } from "@/lib/documents/search-synonyms";
import { normalizeSearchText } from "@/lib/encounters/procedures";

/** Query words that take part in matching; the rest are ignored. */
export const MAX_QUERY_WORDS = 8;
/** Record results one MCP search can return in total, across its kinds. */
export const MAX_RECORD_RESULTS = 50;

/** Field weights: what a query word hitting that field is worth. */
export const WEIGHT = { primary: 3, secondary: 2, tertiary: 1 } as const;

export interface SearchField {
  text: string;
  weight: number;
  /**
   * Free text a person wrote (a note, a reason, an outcome). The in-app
   * search cuts its snippet from the first such field a query word hits.
   */
  body?: boolean;
}

/**
 * What the in-app search shows for a candidate. The MCP wire ignores it; it
 * builds its own English title from the same row.
 */
export interface CandidateHit {
  /** The group the hit is listed under. */
  kind: string;
  /** The record's own id (without the `kind:` prefix the MCP ids carry). */
  recordId: string;
  /** The record's own name, or null when the kind's label names it. */
  title: string | null;
  /** Short context: a practitioner, a body site, a dose. Plain values. */
  context: string[];
  /** The record's calendar day, `YYYY-MM-DD`, or null. */
  day: string | null;
  /** In-app path that opens the record. */
  path: string;
  /** For a note: which kind of entry it was written on. */
  source?: string;
}

export interface SearchCandidate {
  id: string;
  title: string;
  url: string;
  /** Tie-break order between kinds; lower sorts first. */
  kindOrder: number;
  /** Epoch ms of the record's own date, newest first on a tie. */
  date: number | null;
  fields: SearchField[];
  /** Query words the blind content index matched (documents only). */
  contentWords?: ReadonlySet<string>;
  /** True for the record kinds; bounds `MAX_RECORD_RESULTS`. */
  record?: boolean;
  /** Display data for the in-app search. */
  hit?: CandidateHit;
}

// ── Folding ──────────────────────────────────────────────────────────

/**
 * The German keyboard spellings, folded onto the plain vowel. Applied to text
 * that `normalizeSearchText` already folded, so "ä" is "a" by now and only
 * the typed digraph is left to fold.
 */
function foldGerman(folded: string): string {
  return folded
    .replace(/ß/g, "ss")
    .replace(/ae/g, "a")
    .replace(/oe/g, "o")
    .replace(/ue/g, "u");
}

/** The form a field and a query are compared in. */
export function foldForMatch(text: string): string {
  return foldGerman(normalizeSearchText(text));
}

/**
 * Words the index tokeniser keeps but a search box does not need. The
 * tokeniser's own list already drops the common function words.
 */
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  "mein",
  "meine",
  "meinen",
  "meinem",
  "meiner",
  "mine",
  "our",
  "all",
  "any",
  "some",
  "last",
  "latest",
  "recent",
  "letzte",
  "letzten",
  "letzter",
  "letztes",
  "show",
  "find",
  "list",
  "get",
]);

/**
 * Body parts, German and English, for matching a body site or a label. A site
 * is typed in the owner's language and the question often arrives in another,
 * so "knee" has to find "Knie". Search-time only; the document vault's synonym
 * list is left as it is. Same normal form as the tokeniser: lower case,
 * accents stripped.
 */
const BODY_PART_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["knee", "knees", "knie", "kniegelenk"],
  ["shoulder", "shoulders", "schulter", "schultergelenk"],
  ["hip", "hips", "hufte", "huftgelenk"],
  ["ankle", "sprunggelenk", "knochel"],
  ["foot", "feet", "fuss"],
  ["hand", "hands", "hande"],
  ["wrist", "handgelenk"],
  ["elbow", "ellbogen", "ellenbogen"],
  ["back", "rucken", "wirbelsaule", "spine"],
  ["neck", "nacken", "hals"],
  ["head", "kopf"],
  ["eye", "eyes", "auge", "augen"],
  ["ear", "ears", "ohr", "ohren"],
  ["tooth", "teeth", "zahn", "zahne"],
  ["heart", "herz"],
  ["lung", "lungs", "lunge"],
  ["stomach", "magen"],
  ["bowel", "colon", "darm"],
  ["skin", "haut"],
  ["arm", "arms", "arme"],
  ["leg", "legs", "bein", "beine"],
  ["finger", "fingers"],
  ["toe", "toes", "zeh", "zehe", "zehen"],
  ["breast", "brust"],
  ["thyroid", "schilddruse"],
];

const BODY_PART_BY_WORD: ReadonlyMap<string, ReadonlyArray<string>> = (() => {
  const map = new Map<string, string[]>();
  for (const group of BODY_PART_GROUPS) {
    for (const word of group) map.set(word, [...group]);
  }
  return map;
})();

/** A query word's alternatives: the vault's synonyms plus body parts. */
function synonymsOf(word: string): string[] {
  const out = new Set(
    [
      ...expandQueryTokens([word]),
      ...(BODY_PART_BY_WORD.get(word) ??
        BODY_PART_BY_WORD.get(foldGerman(word)) ??
        []),
    ].map(foldGerman),
  );
  out.delete(foldGerman(word));
  return [...out];
}

/**
 * The words of a query that take part in matching: folded, split, short and
 * filler words dropped, deduplicated, capped. These are also the words the
 * blind document index is asked for, so they keep the tokeniser's own form.
 */
export function queryWords(query: string): string[] {
  return tokenise(normalizeSearchText(query))
    .filter((word) => !QUERY_STOPWORDS.has(word))
    .slice(0, MAX_QUERY_WORDS);
}

interface PreparedField {
  folded: string;
  tokens: ReadonlySet<string>;
  weight: number;
}

function prepareField(field: SearchField): PreparedField {
  const folded = foldForMatch(field.text);
  return {
    folded,
    tokens: new Set(folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean)),
    weight: field.weight,
  };
}

export interface CandidateScore {
  /** Query words that hit anything. */
  matched: number;
  /** Sum of each matched word's best field weight, plus the phrase bonus. */
  score: number;
  /** The whole query appears as typed inside one field. */
  phrase: boolean;
}

/** Bonus for the whole query appearing inside one field. */
const PHRASE_BONUS = 5;

/** Query words shorter than this match whole words or word starts only. */
export const MIN_SUBSTRING_WORD = 4;

/**
 * Whether a query word hits a field by its own spelling. A word of four
 * letters or more may sit anywhere ("knee" in "kneecap"); a shorter one has
 * to start a word, so "arm" finds "Arm" and "Armpit" but not "Darm" or "warm".
 */
function hitsField(field: PreparedField, word: string): boolean {
  if (word.length >= MIN_SUBSTRING_WORD) return field.folded.includes(word);
  for (const token of field.tokens) if (token.startsWith(word)) return true;
  return false;
}

/**
 * Score one candidate against the query.
 *
 * A word hits a field when the field contains it (so "knee" finds "Knee
 * replacement") or when one of its curated synonyms is a whole word of the
 * field (so "Zucker" finds "glucose"). Synonyms match whole words only: they
 * are wider than the word the person typed, and a substring match on them
 * would find "rate" inside "moderate".
 */
export function scoreCandidate(
  candidate: Pick<SearchCandidate, "fields" | "contentWords">,
  words: readonly string[],
  foldedQuery: string,
): CandidateScore {
  const fields = candidate.fields
    .filter((f) => f.text.trim().length > 0)
    .map(prepareField);
  const query = foldGerman(foldedQuery);
  let matched = 0;
  let score = 0;
  for (const word of words) {
    const folded = foldGerman(word);
    const synonyms = synonymsOf(word);
    let best = 0;
    for (const field of fields) {
      if (field.weight <= best) continue;
      if (
        hitsField(field, folded) ||
        synonyms.some((s) => field.tokens.has(s))
      ) {
        best = field.weight;
      }
    }
    if (best < WEIGHT.tertiary && candidate.contentWords?.has(word)) {
      best = WEIGHT.tertiary;
    }
    if (best > 0) {
      matched += 1;
      score += best;
    }
  }
  const phrase =
    query.length > 0 &&
    fields.some((field) =>
      query.includes(" ")
        ? field.folded.includes(query)
        : hitsField(field, query),
    );
  if (phrase) score += PHRASE_BONUS;
  return { matched, score, phrase };
}

/** Whether a scored candidate stays in the result at all. */
export function isHit(score: CandidateScore): boolean {
  return score.matched > 0 || score.phrase;
}

/**
 * Filter and order candidates for one query. Pure and deterministic.
 *
 * An empty query keeps every candidate. Otherwise a candidate stays when a
 * query word hit it or the whole query appears in one of its fields (the
 * substring match the older search kinds were built on, kept so a short
 * query like "hr" still finds what it found before).
 */
export function rankCandidates(
  candidates: readonly SearchCandidate[],
  query: string,
  maxRecords: number = MAX_RECORD_RESULTS,
): SearchCandidate[] {
  const foldedQuery = normalizeSearchText(query);
  const words = queryWords(query);
  const scored = candidates.flatMap((candidate) => {
    if (!foldedQuery) {
      return [{ candidate, matched: 0, score: 0 }];
    }
    const s = scoreCandidate(candidate, words, foldedQuery);
    if (!isHit(s)) return [];
    return [{ candidate, matched: s.matched, score: s.score }];
  });
  scored.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.score - a.score ||
      a.candidate.kindOrder - b.candidate.kindOrder ||
      (b.candidate.date ?? 0) - (a.candidate.date ?? 0) ||
      (a.candidate.id < b.candidate.id
        ? -1
        : a.candidate.id > b.candidate.id
          ? 1
          : 0),
  );
  let records = 0;
  return scored.flatMap(({ candidate }) => {
    if (!candidate.record) return [candidate];
    records += 1;
    return records <= maxRecords ? [candidate] : [];
  });
}

// ── Highlighting and snippets ────────────────────────────────────────

/** A half-open `[start, end)` character range of the original text. */
export type MarkRange = [number, number];

export interface MarkedText {
  text: string;
  /** Ranges of `text` a query word matched, sorted and disjoint. */
  marks: MarkRange[];
}

/**
 * Fold `text` the way `foldForMatch` does, keeping for every folded character
 * the range of the original it came from. The two have different lengths
 * ("ß" becomes two characters, "ue" one), so a match found in the folded form
 * is mapped back through this table.
 */
function foldWithMap(text: string): {
  folded: string;
  from: number[];
  to: number[];
} {
  // One entry per UTF-16 unit of the folded string, so an index `indexOf`
  // returns can be looked up directly, astral characters included.
  const units: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  // Whether the vowel at that position has already taken in its "e".
  const absorbed: boolean[] = [];
  let index = 0;
  for (const ch of text) {
    const end = index + ch.length;
    let piece = ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    if (/\s/u.test(ch)) piece = " ";
    piece = piece.replace(/ß/g, "ss");
    for (const out of piece) {
      const prev = units.length - 1;
      // "ae", "oe", "ue" fold onto the vowel: the "e" widens the vowel's
      // source range instead of adding a character.
      if (
        out === "e" &&
        prev >= 0 &&
        /[aou]/.test(units[prev]) &&
        !absorbed[prev]
      ) {
        to[prev] = end;
        absorbed[prev] = true;
        continue;
      }
      for (let k = 0; k < out.length; k++) {
        units.push(out[k]);
        from.push(index);
        to.push(end);
        absorbed.push(false);
      }
    }
    index = end;
  }
  return { folded: units.join(""), from, to };
}

/**
 * The ranges of `text` the query's words hit by their own spelling, under the
 * same rules as the matcher: a word of four letters or more anywhere, a
 * shorter one only at the start of a word. Synonym hits are not marked (the
 * text holds a different word), so a result can match with nothing marked.
 */
export function markMatches(text: string, query: string): MarkRange[] {
  // The matcher's words; a query too short for the tokeniser ("Hb") is
  // found by the phrase rule, so it is marked by its folded self.
  const tokens = queryWords(query);
  const words = [
    ...new Set(
      (tokens.length > 0 ? tokens : foldForMatch(query).split(" ")).map((w) =>
        foldGerman(w),
      ),
    ),
  ].filter((w) => w.length >= 2);
  if (words.length === 0 || text.length === 0) return [];
  const { folded, from, to } = foldWithMap(text);
  const ranges: MarkRange[] = [];
  for (const word of words) {
    let at = folded.indexOf(word);
    while (at !== -1) {
      const startsWord = at === 0 || !/[\p{L}\p{N}]/u.test(folded[at - 1]);
      if (word.length >= MIN_SUBSTRING_WORD || startsWord) {
        ranges.push([from[at], to[at + word.length - 1]]);
      }
      at = folded.indexOf(word, at + 1);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: MarkRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** `text` with its marks for `query`. */
export function marked(text: string, query: string): MarkedText {
  return { text, marks: markMatches(text, query) };
}

/** Characters a snippet holds at most, before the ellipses. */
export const SNIPPET_CHARS = 140;
/** Characters a snippet keeps ahead of its first mark. */
const SNIPPET_LEAD = 40;

/**
 * A short window of free text around its first match, whitespace collapsed,
 * cut at word boundaries and marked with "…" where it was cut. Null when the
 * query hits nothing in the text by its own spelling.
 */
export function snippetOf(
  raw: string,
  query: string,
  max: number = SNIPPET_CHARS,
): MarkedText | null {
  const text = raw.replace(/\s+/g, " ").trim();
  const marks = markMatches(text, query);
  if (marks.length === 0) return null;
  if (text.length <= max) return { text, marks };
  let start = Math.max(0, marks[0][0] - SNIPPET_LEAD);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < marks[0][0]) start = space + 1;
  }
  let end = Math.min(text.length, start + max);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > marks[0][1]) end = space;
  }
  const lead = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const shift = lead.length - start;
  return {
    text: `${lead}${text.slice(start, end)}${tail}`,
    marks: marks
      .filter(([s, e]) => s >= start && e <= end)
      .map(([s, e]) => [s + shift, e + shift] as MarkRange),
  };
}
