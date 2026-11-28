/**
 * The checks behind `e2e/no-repeated-text.spec.ts`, as pure functions over
 * what the page reported, so a unit test can feed them a fixture
 * (`src/__tests__/repeated-text-guard.test.ts`) and prove they find what
 * they are meant to find.
 *
 * A page says one thing once. Two kinds of repeat are refused:
 *
 * - a visible text block of three words or more that stands twice in
 *   `<main>` (a subtitle and an empty text saying the same, a sentence under
 *   every card);
 * - a section heading or card title that is the page title again.
 *
 * Data rows are exempt: two readings may look alike. The collector in the
 * spec leaves out everything inside a list item, a table row or user content,
 * but keeps their hint texts.
 */

export interface TextBlock {
  /** The block's visible text. */
  text: string;
  /** Where it came from, for the failure message (`p`, `h2`, `card-title`). */
  kind: string;
}

export interface RepeatReport {
  /** Text blocks of three words or more that occur more than once. */
  repeats: Array<{ text: string; count: number; kinds: string[] }>;
  /** Headings or card titles equal to the page title. */
  titleEchoes: string[];
  /** Fewer blocks than the floor: the collector found too little to judge. */
  tooFew: boolean;
}

/** A page with fewer text blocks (of any length) than this proves nothing by passing. */
export const MIN_BLOCKS = 2;
/** Shorter blocks (a label, a unit, "Edit") may repeat. */
export const MIN_WORDS = 3;

export function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function words(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Words that carry letters, leaving out the clock's AM and PM: a date, a time
 * or a count ("11/28/2026, 04:05 AM", "0 / 1") is a value, and two values may
 * be equal.
 */
function proseWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w) && !/^(am|pm)$/i.test(w)).length;
}

export function findRepeats(
  blocks: readonly TextBlock[],
  h1: string | null,
  headings: readonly TextBlock[],
): RepeatReport {
  const byText = new Map<
    string,
    { text: string; count: number; kinds: string[] }
  >();
  for (const block of blocks) {
    const key = normalise(block.text);
    if (proseWords(key) < MIN_WORDS) continue;
    const hit = byText.get(key);
    if (hit) {
      hit.count += 1;
      hit.kinds.push(block.kind);
    } else {
      byText.set(key, {
        text: block.text.trim(),
        count: 1,
        kinds: [block.kind],
      });
    }
  }
  const title = h1 ? normalise(h1) : "";
  const titleEchoes = title
    ? headings
        .filter((h) => normalise(h.text) === title)
        .map((h) => `${h.kind}: ${h.text.trim()}`)
    : [];
  return {
    repeats: [...byText.values()].filter((r) => r.count > 1),
    titleEchoes,
    tooFew: blocks.filter((b) => words(b.text) > 0).length < MIN_BLOCKS,
  };
}
