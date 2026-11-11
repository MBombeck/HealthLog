/**
 * Spelling-level comparison of lab units.
 *
 * A reading may only be stored under a marker whose unit it actually is in, so
 * the write paths compare the unit a reading arrives with against the unit the
 * marker is tracked in. This module answers one narrow question: are these two
 * strings the same unit written two ways?
 *
 * It resolves spelling, never magnitude. Two spellings are treated as equal
 * only where no reading of either could mean a different quantity:
 *
 *   - whitespace around the slash (`mg / dL`),
 *   - the micro prefix (`µg/L`, `μg/L` with the Greek mu, `ug/L`, `mcg/L`),
 *   - the case of the litre in the denominator (`mmol/l`, `mg/dl`, `mg/DL`),
 *   - a unit printed entirely in capitals (`MG/DL`, `MMOL/L`), but only for the
 *     short list of units where capitals cannot denote another real unit.
 *
 * Case is otherwise significant, on purpose. `mIU/L` and `MIU/L` differ by a
 * factor of a billion (a lone capital M is mega, a lowercase m is milli), and
 * `g/L` (grams) is not `G/L` (the 10^9/L of a blood count). A unit this module
 * does not recognise is compared exactly, so an unfamiliar spelling surfaces as
 * a mismatch rather than being guessed at.
 *
 * A lab's note that a value was calculated rather than measured (`g/dL
 * (calc)`, `(berechnet)`) is not part of the unit and is dropped first; see
 * `withoutLabUnitAnnotation`.
 *
 * Pure and dependency-free.
 */

/**
 * A trailing note in brackets that says the lab calculated the value. Some
 * reports print it in the unit column, and a read that copies the column
 * verbatim then minted a marker in "g/dL (calc)", which refused the next
 * report's plain "g/dL". Only these words are dropped, so a bracket that
 * carries meaning stays and still surfaces as a mismatch.
 */
const CALCULATED_NOTE =
  /\s*\((?:calc\.?|calculated|computed|berechnet|ber\.?)\)\s*$/i;

/**
 * The unit without a trailing calculated-value note, trimmed: `g/dL (calc)`
 * reads `g/dL`, and a unit that was only the note reads `""`.
 */
export function withoutLabUnitAnnotation(raw: string): string {
  return raw.replace(CALCULATED_NOTE, "").trim();
}

/** Units that may be recognised when printed entirely in capitals. */
const SHOUTED_UNITS: ReadonlyMap<string, string> = new Map(
  [
    "mg/dL",
    "g/dL",
    "ng/dL",
    "µg/dL",
    "mmol/L",
    "µmol/L",
    "nmol/L",
    "pmol/L",
    "ng/mL",
    "pg/mL",
    "µg/L",
    "mEq/L",
    "IU/L",
    "U/L",
    "fL",
  ].map((unit) => [unit.toLowerCase(), unit]),
);

const MICRO_SIGNS = /[µμ]/g;
/** What may follow a spelled-out micro prefix: g, mol, IU, U, L, kat, Eq. */
const MICRO_BEFORE = "(?=g|mol|IU|U|L|l|kat|Eq|eq)";
const MICRO_BEFORE_LOWER = "(?=g|mol|iu|u|l|kat|eq)";

function foldSpacing(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/");
}

function foldMicro(text: string, lookahead: string): string {
  const unified = text.replace(MICRO_SIGNS, "µ");
  // A spelled-out prefix counts only at the start of the unit or straight after
  // a slash, and only in front of a unit that takes it. `u/L` (enzyme units)
  // and `U/L` therefore stay as they are.
  const prefix = new RegExp(`(^|/)(?:u|mc)${lookahead}`, "g");
  return unified.replace(prefix, "$1µ");
}

/** `/l`, `/dl`, `/ml`, `/µl` in any case → `/L`, `/dL`, `/mL`, `/µL`. */
function foldLitre(text: string): string {
  return text.replace(
    /\/([dmµ]?)l$/i,
    (_, prefix: string) => `/${prefix.toLowerCase()}L`,
  );
}

/**
 * The comparison form of a lab unit: the same string for every spelling that
 * means the same thing, and the (trimmed) string itself otherwise.
 */
export function normaliseLabUnit(raw: string): string {
  const spaced = foldSpacing(withoutLabUnitAnnotation(raw));

  const hasLowercase = /[a-zµμ]/.test(spaced);
  const hasUppercase = /[A-Z]/.test(spaced);
  if (hasUppercase && !hasLowercase) {
    const lowered = foldMicro(spaced.toLowerCase(), MICRO_BEFORE_LOWER);
    const known = SHOUTED_UNITS.get(lowered);
    if (known) return known;
  }

  return foldLitre(foldMicro(spaced, MICRO_BEFORE));
}

/** Whether two strings name the same lab unit (see the module comment). */
export function sameLabUnit(a: string, b: string): boolean {
  return normaliseLabUnit(a) === normaliseLabUnit(b);
}
