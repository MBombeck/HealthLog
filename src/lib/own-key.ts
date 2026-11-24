/**
 * Lookups and maps keyed by text that came from outside: a file, a request
 * body or query, a stored JSON preference, a third-party payload.
 *
 * A plain object answers for keys it was never given. `TABLE["constructor"]`
 * is the `Object` function and `TABLE["__proto__"]` is `Object.prototype`,
 * so a lookup that expects "an entry or undefined" gets neither. A write
 * under `"__proto__"` replaces the object's prototype instead of adding an
 * entry, and a two-step write (`(m[k] ??= { n: 0 }).n += 1`) lands on
 * `Object.prototype` itself, which every object in the process shares.
 *
 * Every table read and every map write keyed by such text goes through one
 * of these instead: `ownValue` / `hasOwnKey` for a fixed table, `ownRecord`
 * (a prototype-less object) or a `Map` for a map built at run time.
 * `src/__tests__/prototype-key-guard.test.ts` flags the plain form in the
 * parser and input-handling directories.
 */

/** The entry a table holds for `key` itself, never one it inherits. */
export function ownValue<V>(
  table: { readonly [key: string]: V | undefined },
  key: string,
): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Whether `key` is one of the table's own keys. */
export function hasOwnKey<T extends object>(
  table: T,
  key: PropertyKey,
): key is keyof T {
  return Object.hasOwn(table, key);
}

declare const OWN_RECORD: unique symbol;

/**
 * A map with no prototype. The brand exists only in the type, so a binding
 * keeps saying what it is when it is passed on or returned, and the guard
 * can tell it from a plain `{}`; nothing at run time carries it.
 */
export type OwnRecord<V> = Record<string, V> & { readonly [OWN_RECORD]: true };

/**
 * An empty map with no prototype: every key, `"__proto__"` included, is an
 * ordinary entry, and a key never written reads as `undefined`.
 */
export function ownRecord<V>(): OwnRecord<V> {
  return Object.create(null) as OwnRecord<V>;
}
