/**
 * v1.4.36 W3 T4 — `compactSections` helper for the AI prompt body.
 *
 * The features payload (and the Coach snapshot, transitively) carries
 * conditionally-populated blocks: `medications`, `bucketedMeasurements`,
 * `historicalComparison`, the per-metric aggregates, etc. Empty blocks
 * have two failure modes once they hit the prompt:
 *
 *   1. The serialised JSON includes a labelled-empty key (`"sleep": []`
 *      or `"medications": []`) which the model occasionally narrates as
 *      "there are no medications in your data" even when the user
 *      explicitly excluded them — wasted prompt budget and a misleading
 *      framing.
 *   2. Some downstream prose composers render the block label without
 *      checking row count, producing the v1.4.35 "Hier sind die
 *      Schlafdaten: [keine]" anti-pattern Marc flagged in W3.
 *
 * `compactSections` walks the object once and drops any property whose
 * value is:
 *   - an empty array
 *   - an empty object (no own enumerable keys)
 *   - undefined
 *
 * It runs a single shallow pass at the top level — that's enough for
 * the features + snapshot shapes today. We do NOT recurse into nested
 * objects because the legitimate empty values inside e.g.
 * `coverage: { count: 0, … }` should stay readable (count 0 IS the
 * signal). A future call site that needs deep-compaction can opt in
 * via the `deep` flag.
 */

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isEmpty(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Return a shallow copy of `blocks` with every empty key dropped.
 * `null` values are preserved — null carries the semantic "field
 * exists but is unknown", which is different from "block doesn't
 * exist". Set `deep: true` to recurse into nested plain objects.
 */
export function compactSections<T extends PlainObject>(
  blocks: T,
  options: { deep?: boolean } = {},
): T {
  const out: PlainObject = {};
  for (const [key, value] of Object.entries(blocks)) {
    let folded = value;
    if (options.deep && isPlainObject(value)) {
      folded = compactSections(value, options);
    }
    if (isEmpty(folded)) continue;
    out[key] = folded;
  }
  return out as T;
}
