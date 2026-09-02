/**
 * The `MeasurementSource` value rows written through the ingest token carry.
 *
 * A leaf module with no imports, for the same reason `scopes.ts` next door is
 * one: the two write routes, the edit gate, the Zod source enum and the
 * integration suites all read this string, and none of them should inherit an
 * import graph to get it. `MCP_SOURCE` (`@/lib/mcp/writes.ts`) is module-local
 * because it has exactly one writer; this one does not, and two sibling
 * declarations of the same literal is the drift a shared leaf exists to avoid.
 *
 * Not folded into `scopes.ts`. A provenance label living in a file named
 * `scopes.ts` is one somebody later imports "because it was there", and the
 * two answer different questions: one is what a credential may do, the other
 * is what a row came from.
 *
 * No client may name it. It is deliberately absent from
 * `WRITABLE_MEASUREMENT_SOURCES` and from the batch route's `batchSourceEnum`,
 * so the only way a row acquires it is the server resolving it from the
 * credential that carried the write — which is the whole point: a source a
 * client could assert would prove nothing about where the reading came from.
 */

/** Provenance for a measurement pushed in under `measurements:write`. */
export const EXTERNAL_SOURCE = "EXTERNAL" as const;
