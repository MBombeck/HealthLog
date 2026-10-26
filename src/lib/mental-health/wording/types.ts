/**
 * The shape of one questionnaire's wording in one app language.
 *
 * Questionnaire text lives in code, not in `messages/*.json`: a translator
 * working through the bundles must never see an item, let alone machine-
 * translate one, because changing a word in a validated instrument changes
 * what it measures. Every entry says what it is. A validated entry reproduces
 * a published translation word for word and names it in `source`; an
 * unvalidated entry is a translation written for HealthLog, faithful to the
 * English and on the same scale, and the surfaces say so beside it.
 */

import type { InstrumentId } from "../instruments";

/** Answer labels keyed by the score each one carries. */
export type AnchorSet = Readonly<Record<number, string>>;

/** The anchor group every item of a single-scale instrument uses. */
export const SINGLE_ANCHOR_GROUP = "all";

interface WordingText {
  /**
   * The text the source form prints above its items, keyed by the stem id
   * the instrument definition names per item (`stemIds`).
   */
  stems: Readonly<Record<string, string>>;
  /** The scored items in the order the instrument presents them. */
  items: readonly string[];
  /**
   * Answer labels per anchor group: `all` for a single-scale instrument, the
   * group names of `optionGroups` for one with item-specific anchors (SCI).
   */
  anchors: Readonly<Record<string, AnchorSet>>;
  /** The PHQ-9's unscored follow-up question and its four answers. */
  functional?: { title: string; anchors: AnchorSet };
}

export interface ValidatedWording extends WordingText {
  validated: true;
  /**
   * The published version reproduced: who made it, the document and where it
   * was read from, and its terms of use.
   */
  source: string;
}

export interface UnvalidatedWording extends WordingText {
  validated: false;
}

export type InstrumentWording = ValidatedWording | UnvalidatedWording;

/** Every questionnaire's wording in one language. */
export type LocaleWording = Readonly<Record<InstrumentId, InstrumentWording>>;

/**
 * Which text an administration was answered in, stored on the row:
 * - `validated`: the published validated version for the reader's language
 *   (the English original for an English reader);
 * - `unvalidated_translation`: HealthLog's own translation, for a language
 *   without a validated version;
 * - `original_en`: the English original, chosen by a reader whose language
 *   has its own text (or whose language the app does not ship).
 */
export const ASSESSMENT_WORDINGS = [
  "validated",
  "unvalidated_translation",
  "original_en",
] as const;
export type AssessmentWording = (typeof ASSESSMENT_WORDINGS)[number];

export function isAssessmentWording(
  value: string | null,
): value is AssessmentWording {
  return (ASSESSMENT_WORDINGS as readonly (string | null)[]).includes(value);
}
