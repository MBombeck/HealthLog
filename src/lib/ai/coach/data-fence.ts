/**
 * v1.30.25 — the shared data/instruction fence for every prompt block that
 * carries user-controlled or document-sourced free text.
 *
 * Two blocks reach the Coach prompt with content the server did not author:
 *  - the self-report (about-me questionnaire) — the user's own prose, and
 *  - the SNAPSHOT — a JSON document whose leaves include lab analyte names,
 *    medication labels, illness labels, plan/reminder/fact text and workout
 *    sport names. Some of those strings did not originate with the user at
 *    all: a lab analyte name is transcribed by a model out of an UPLOADED
 *    PDF, so a hostile document can choose it.
 *
 * Escaping every leaf field separately does not scale (the snapshot is
 * assembled from a dozen builders and grows), and it cannot express the one
 * thing that actually matters: that everything inside the block is DATA and
 * never an instruction. A fence can. Each block is wrapped in unlikely
 * literal markers, the frame around it states the data/instruction contract
 * explicitly, and the content is scrubbed of EVERY known marker first — so
 * text inside one fence can neither close its own fence nor forge another
 * block's boundary and smuggle trailing lines into instruction position.
 *
 * Dependency-free on purpose: the Coach system prompt, the briefing block
 * builder and the document-extraction prompt all import from here, and the
 * fence must never drag the Prisma client into a module graph that only
 * needs prompt text.
 */

/** Fence around the user-authored self-report (about-me questionnaire). */
export const SELF_REPORT_FENCE_START = "<<<SELF_REPORT_START>>>";
export const SELF_REPORT_FENCE_END = "<<<SELF_REPORT_END>>>";

/** Fence around the Coach SNAPSHOT (server-computed figures + free-text leaves). */
export const HEALTH_DATA_FENCE_START = "<<<HEALTH_DATA_START>>>";
export const HEALTH_DATA_FENCE_END = "<<<HEALTH_DATA_END>>>";

/** Fence around OCR'd document text handed to the extraction model. */
export const DOCUMENT_TEXT_FENCE_START = "<<<DOCUMENT_TEXT_START>>>";
export const DOCUMENT_TEXT_FENCE_END = "<<<DOCUMENT_TEXT_END>>>";

/**
 * Fence around free text inside an MCP tool result. Same class of exposure as
 * the Coach snapshot — medication names/doses/treatment classes and lab
 * analyte names are user- or document-controlled, and a lab analyte name can
 * be transcribed by a model out of an uploaded PDF — but it reaches the model
 * over the MCP wire rather than through a prompt block. The write tools ride
 * that same wire, so the free text sits in the same context as a surface that
 * can mutate the record.
 */
export const USER_TEXT_FENCE_START = "<<<USER_TEXT_START>>>";
export const USER_TEXT_FENCE_END = "<<<USER_TEXT_END>>>";

/**
 * Every marker literal the codebase uses as a data/instruction boundary.
 * Content is scrubbed against the WHOLE set — not just its own pair — so a
 * hostile lab analyte name inside the SNAPSHOT cannot emit
 * `<<<SELF_REPORT_END>>>` to escape a neighbouring block.
 */
export const ALL_FENCE_MARKERS: readonly string[] = [
  SELF_REPORT_FENCE_START,
  SELF_REPORT_FENCE_END,
  HEALTH_DATA_FENCE_START,
  HEALTH_DATA_FENCE_END,
  DOCUMENT_TEXT_FENCE_START,
  DOCUMENT_TEXT_FENCE_END,
  USER_TEXT_FENCE_START,
  USER_TEXT_FENCE_END,
];

/**
 * Passes `scrubFenceMarkers` makes before it stops removing and breaks the
 * marker alphabet instead. Each pass undoes one level of nesting; real text
 * never needs a second one.
 */
const SCRUB_PASSES = 8;

/** Every fence marker, in any case and with any spacing inside the brackets. */
const FENCE_MARKER_ANY_SPELLING = new RegExp(
  ALL_FENCE_MARKERS.map(
    (marker) => `<<<\\s*${marker.slice(3, -3)}\\s*>>>`,
  ).join("|"),
  "gi",
);

/**
 * Strip every known fence marker out of `text`, so the result contains none.
 *
 * One pass is not enough: removing a marker joins the text either side of
 * it, and a marker split around another one re-forms
 * (`<<<DOCUMENT_TEXT_E<<<DOCUMENT_TEXT_END>>>ND>>>` becomes
 * `<<<DOCUMENT_TEXT_END>>>`, and so does the same split around any other
 * marker). The removal repeats until a pass changes nothing, which is the
 * proof that no marker is left. Content nested deeper than the passes is
 * not text anyone wrote, so every run of three or more angle brackets the
 * markers are built from is cut to two instead, after which no marker can
 * exist or re-form.
 */
export function scrubFenceMarkers(text: string): string {
  let out = text;
  for (let pass = 0; pass < SCRUB_PASSES; pass += 1) {
    // Any spelling of a marker: a model reads `<<<user_text_end>>>` or
    // `<<< USER_TEXT_END >>>` as the boundary just as well as the exact one.
    const next = out.replace(FENCE_MARKER_ANY_SPELLING, "");
    if (next === out) return out;
    out = next;
  }
  return out.replace(/<{3,}/g, "<<").replace(/>{3,}/g, ">>");
}

/**
 * Wrap `text` in the given marker pair after scrubbing every known marker
 * out of the content. The caller supplies the surrounding frame prose that
 * states the data/instruction contract.
 */
export function fenceBlock(start: string, end: string, text: string): string {
  return `${start}\n${scrubFenceMarkers(text)}\n${end}`;
}

/**
 * Fence the Coach SNAPSHOT payload. The snapshot is JSON, but the fence is
 * applied to the serialised string: a free-text leaf that contains a marker
 * would otherwise survive `JSON.stringify` verbatim.
 */
export function fenceHealthData(snapshotJson: string): string {
  return fenceBlock(
    HEALTH_DATA_FENCE_START,
    HEALTH_DATA_FENCE_END,
    snapshotJson,
  );
}

/** Fence OCR'd document text before it enters the extraction prompt. */
export function fenceDocumentText(text: string): string {
  return fenceBlock(DOCUMENT_TEXT_FENCE_START, DOCUMENT_TEXT_FENCE_END, text);
}

/**
 * Fence a free-text-bearing sentence in an MCP tool result. Single-line so it
 * stays readable in a host that renders the result verbatim.
 */
export function fenceUserText(text: string): string {
  return `${USER_TEXT_FENCE_START}${scrubFenceMarkers(text)}${USER_TEXT_FENCE_END}`;
}
