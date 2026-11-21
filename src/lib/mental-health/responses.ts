/**
 * The stored answers of one screener administration, decoded fail-soft.
 *
 * Shared by the detail read, which serves the answers, and the list, which
 * serves only whether they are there (`itemsUnavailable`), so the two cannot
 * disagree about a row. A row whose blob does not decrypt, whose answers do
 * not fit the instrument, or that was stored score-only (an Apple Health
 * PHQ-9 / GAD-7 sent without its answers) has no items.
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import type { InstrumentDefinition } from "@/lib/mental-health/instruments";

export interface DecodedResponses {
  /** Per-item answers in presentation order, or null when unreadable. */
  items: number[] | null;
  /** The unscored PHQ-9 functional follow-up, when it was answered. */
  functionalDifficulty: number | null;
  itemsUnavailable: boolean;
}

const UNAVAILABLE: DecodedResponses = {
  items: null,
  functionalDifficulty: null,
  itemsUnavailable: true,
};

/**
 * Decrypt + decode the stored `{ items, functionalDifficulty?, schema: 1 }`
 * blob, fail-soft. Every answer is re-checked against the instrument's own
 * ceiling before it is served: the write path validated exactly these bounds,
 * so anything outside them is corruption, not data.
 */
export function decodeResponses(
  buf: Uint8Array,
  def: InstrumentDefinition,
): DecodedResponses {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptFromBytes(buf));
  } catch (err) {
    // Undecryptable payload (key gap / corruption): fail soft but log it
    // (F-CRYPTO-2) so a systemic key gap surfaces instead of reading blank.
    getEvent()?.addWarning(
      `assessment responses decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNAVAILABLE;
  }
  if (typeof parsed !== "object" || parsed === null) return UNAVAILABLE;
  const { items, functionalDifficulty } = parsed as {
    items?: unknown;
    functionalDifficulty?: unknown;
  };
  // A score-only administration (an Apple Health PHQ-9 / GAD-7 sent without
  // its answers) stores `items: null` on purpose: there is nothing to show,
  // and nothing drifted.
  if (items === null) return UNAVAILABLE;
  const valid =
    Array.isArray(items) &&
    items.length === def.itemCount &&
    items.every(
      (v) => Number.isInteger(v) && (v as number) >= 0 && v <= def.itemMax,
    );
  if (!valid) {
    getEvent()?.addWarning(
      "assessment responses shape drifted from the instrument definition",
    );
    return UNAVAILABLE;
  }
  return {
    items: items as number[],
    functionalDifficulty:
      Number.isInteger(functionalDifficulty) &&
      (functionalDifficulty as number) >= 0 &&
      (functionalDifficulty as number) <= 3
        ? (functionalDifficulty as number)
        : null,
    itemsUnavailable: false,
  };
}
