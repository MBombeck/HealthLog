/**
 * German KVNR (Krankenversichertennummer) validation.
 *
 * The unveränderbarer Teil of a KVNR is a 10-character identifier:
 *   - position 1:  one uppercase letter A–Z
 *   - positions 2–9: eight digits
 *   - position 10: a mod-10 check digit
 *
 * Check-digit algorithm (per the GKV-Spitzenverband specification):
 *   1. Map the leading letter to a two-digit value: A → 01, B → 02, … Z → 26.
 *   2. Concatenate that two-digit value with positions 2–9 to get a
 *      10-digit numeric base.
 *   3. Weight the ten digits alternately 1, 2, 1, 2, … from the left.
 *      When a weight-2 product is ≥ 10, replace it with its cross-sum
 *      (i.e. subtract 9 — equivalent for single-digit products).
 *   4. Sum the weighted values; the check digit is that sum mod 10.
 *   5. The computed check digit must equal position 10.
 *
 * The function is total: any malformed input (wrong length, lowercase,
 * non-letter lead, non-digit body) returns `false` rather than throwing.
 */

const KVNR_PATTERN = /^[A-Z][0-9]{9}$/;

/** Compute the expected KVNR check digit for a `letter + 8 digits` stem. */
function computeKvnrCheckDigit(letter: string, eightDigits: string): number {
  // Letter → two-digit value (A=01 … Z=26), left-padded.
  const letterValue = letter.charCodeAt(0) - "A".charCodeAt(0) + 1;
  const base = `${String(letterValue).padStart(2, "0")}${eightDigits}`;

  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    const digit = base.charCodeAt(i) - "0".charCodeAt(0);
    // Alternating 1,2,1,2,… weighting from the left.
    const weighted = i % 2 === 0 ? digit : digit * 2;
    sum += weighted >= 10 ? weighted - 9 : weighted;
  }
  return sum % 10;
}

/**
 * Validate a KVNR string. Accepts the canonical 10-character form
 * (one letter + nine digits, the last being the check digit).
 *
 * Returns `true` only when the format matches AND the trailing check
 * digit matches the computed value.
 */
export function isValidKvnr(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!KVNR_PATTERN.test(value)) return false;
  const letter = value[0];
  const eightDigits = value.slice(1, 9);
  const checkDigit = value.charCodeAt(9) - "0".charCodeAt(0);
  return computeKvnrCheckDigit(letter, eightDigits) === checkDigit;
}

/**
 * Normalise free-text KVNR input: strip whitespace + uppercase. Returns
 * the cleaned string (NOT validated — pair with `isValidKvnr`).
 */
export function normaliseKvnr(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}
