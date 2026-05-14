/**
 * v1.4.25 W21 Fix-N — unified dose-string → mg parser.
 *
 * Replaces two near-identical helpers previously hand-rolled inside
 * `<DrugLevelChart>` (`parseDoseMg`) and the titration route
 * (`parseDoseString`). The DrugLevelChart variant returned `NaN` for
 * unparseable strings; the titration variant returned `null`. Both
 * code paths now go through this module — the legacy null-returning
 * shape is preserved as `parseDoseMgOrNull` so the titration route
 * keeps its "no current step" semantics.
 *
 * Accepts comma OR dot as decimal separator (Marc-memory: the German
 * UI lets the user type "0,25 mg"). Trailing unit text after the
 * number is ignored — the parser only owns the numeric extraction.
 */

/**
 * Parse a dose string like "7.5 mg" → 7.5 or "0,25" → 0.25. Returns
 * `NaN` when the string carries no recognisable number (e.g. "as
 * needed") so callers can use `Number.isFinite` for the gate.
 */
export function parseDoseMg(input: string): number {
  if (!input) return Number.NaN;
  const match = input.match(/([0-9]+(?:[.,][0-9]+)?)/);
  if (!match) return Number.NaN;
  return Number.parseFloat(match[1].replace(",", "."));
}

/**
 * Same as `parseDoseMg` but returns `null` instead of `NaN` for the
 * unparseable case. The titration route reads this as "no current
 * step" — null signals "we couldn't resolve a dose" rather than "the
 * dose is zero".
 */
export function parseDoseMgOrNull(input: string): number | null {
  const value = parseDoseMg(input);
  return Number.isFinite(value) ? value : null;
}
