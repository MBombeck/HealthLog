/**
 * Separator glyphs out of model-written prose, before it is screened, graded
 * and stored.
 *
 * The app's own copy joins facts with a comma, a colon or a real phrase,
 * never with a middle dot or a dash (`i18n-typography-glyphs.test.ts`,
 * `ui-code-no-dash-separator.test.ts`). Model text is the one source of
 * on-screen prose those guards cannot reach: a briefing headline came back
 * as "Nothing needs fixing — the work now is to keep it up", and the
 * dashboard showed it beside lines that never use the glyph. Prompting
 * against it is not enough, since providers ignore style rules at random,
 * so the reply is normalised once, where it leaves the provider, and every
 * later step (the safety screen, number grounding, the stored row, the
 * Coach citing it) sees the same text the person reads.
 *
 * What changes:
 *   - a dash between two figures, spaced or not ("3 – 5", "3—5"), becomes
 *     the unspaced en dash a range is written with ("3–5"), so a range never
 *     turns into a list;
 *   - a spaced middle dot, em dash or en dash (" · ", " — ", " – ") becomes
 *     ", ";
 *   - an em dash set between two words without spaces ("steady—good")
 *     becomes ", ".
 *
 * What stays:
 *   - a range ("97.2–99.8", "Mon–Fri"): an unspaced en dash is how a range
 *     is written;
 *   - a dot inside a unit ("mL/(kg·min)");
 *   - code: a fenced block or an inline code span is passed through as it
 *     came;
 *   - line structure, numbers and every other character;
 *   - Russian dashes: Russian uses the dash where English puts a comma or a
 *     copula ("Сводка за неделю — всё спокойно"), the same reason the ru
 *     bundle is exempt from the bundle guard. A reply with Cyrillic letters
 *     keeps its dashes; its middle dots still go.
 *
 * Applied where a narrative reply leaves its provider: `runBriefingCompletion`
 * (comprehensive insights, the daily briefing), `runStatusCompletion`
 * (status notes, derived assessments, workout notes, period narratives) and
 * the Coach's `guardReply`. The Coach reply is assembled and guarded in full
 * before its first token frame leaves, and the stored row is written from
 * the same text, so the message reads the same while it arrives and after a
 * reload.
 */

const CYRILLIC = /[Ѐ-ӿ]/;
const SPACED_DOT = /[ \t]+·[ \t]+/g;
const SPACED_DASH = /[ \t]+[—–][ \t]+/g;
const WORD_EM_DASH = /(\p{L})—(\p{L})/gu;
/** A dash between two figures: a range, spaced or not. */
const FIGURE_DASH = /(\d)[ \t]*[—–][ \t]*(?=\d)/g;
/** A fenced code block or an inline code span, captured so `split` keeps it. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/** Marks a replaced separator until the punctuation after it is known. */
const MARK = "\uE000";

export function plainSeparators(text: string): string {
  if (!text) return text;
  const keepDashes = CYRILLIC.test(text);
  // Odd entries are code (a fenced block or an inline span), kept verbatim.
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : plainProse(part, keepDashes)))
    .join("");
}

function plainProse(text: string, keepDashes: boolean): string {
  let out = text.replace(SPACED_DOT, MARK);
  if (!keepDashes) {
    out = out
      .replace(FIGURE_DASH, "$1–")
      .replace(SPACED_DASH, MARK)
      .replace(WORD_EM_DASH, `$1${MARK}$2`);
  }
  // A separator right before punctuation would leave ", ." or ", ,": the
  // mark there is dropped and the punctuation kept. Every other mark is a
  // comma. Text that had no separator is returned unchanged.
  return out.replace(/\uE000(?=[.,;:!?])/g, "").replace(/\uE000/g, ", ");
}
