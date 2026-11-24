/**
 * How deep an uploaded JSON document may nest.
 *
 * `JSON.parse` builds any depth without trouble, but much of what reads the
 * result afterwards recurses: `JSON.stringify`, a deep clone, a mapper that
 * walks a resource. A FHIR Bundle of a few hundred kilobytes, nested a few
 * hundred thousand levels inside one resource, parsed fine and then took the
 * import down with "Maximum call stack size exceeded" where the vital-sign
 * mapper stringified the resource. A real FHIR resource nests about a dozen
 * levels, so a document past {@link UPLOADED_JSON_MAX_DEPTH} is refused right
 * after parsing, before anything walks it.
 */
export const UPLOADED_JSON_MAX_DEPTH = 64;

/**
 * Whether `value` holds an array or object nested deeper than `limit` levels
 * (the value itself is level 1). Iterative, so the check cannot overflow the
 * stack it protects.
 */
export function jsonDeeperThan(
  value: unknown,
  limit: number = UPLOADED_JSON_MAX_DEPTH,
): boolean {
  const pending: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 1 },
  ];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (typeof node !== "object" || node === null) continue;
    if (depth > limit) return true;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (typeof child === "object" && child !== null) {
        pending.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return false;
}
