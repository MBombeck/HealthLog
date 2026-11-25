/**
 * Names a plain object answers for without ever having been given them.
 *
 * A parser that looks up a table with text from a file (`TABLE[code]`) gets
 * `Object.prototype` back for `"__proto__"` and the `Object` constructor for
 * `"constructor"`; one that counts into a `{}` under such a key replaces the
 * counter object's prototype, or writes onto `Object.prototype` itself when
 * the lookup and the write are two steps (`(m[k] ??= { n: 0 }).n += 1`).
 * Every parser of outside input is fed these names as codes, keys, headers
 * and units, and must neither throw nor leave a trace on the shared
 * prototypes.
 */
import fc from "fast-check";
import { expect } from "vitest";

export const PROTOTYPE_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__defineGetter__",
  "isPrototypeOf",
] as const;

/** One of {@link PROTOTYPE_KEYS}, in its own spelling or upper-cased. */
export const prototypeKey: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...PROTOTYPE_KEYS),
  fc.constantFrom(...PROTOTYPE_KEYS).map((k) => k.toUpperCase()),
);

/** Mostly a prototype key, sometimes ordinary text. */
export function withPrototypeKeys(
  ordinary: fc.Arbitrary<string>,
): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 2, arbitrary: prototypeKey },
    { weight: 1, arbitrary: ordinary },
  );
}

const SHARED = [
  Object.prototype,
  Array.prototype,
  Function.prototype,
  String.prototype,
  Number.prototype,
] as const;

function ownNames(target: object): string[] {
  return Reflect.ownKeys(target)
    .map((k) => String(k))
    .sort();
}

/** The own property names of the shared prototypes right now. */
export function snapshotPrototypes(): string[][] {
  return SHARED.map(ownNames);
}

/**
 * Asserts the shared prototypes carry the same own properties as in
 * `before`, and that a fresh object still inherits nothing enumerable.
 */
export function expectPrototypesUntouched(before: string[][]): void {
  expect(snapshotPrototypes()).toEqual(before);
  const probe: Record<string, unknown> = {};
  const inherited: string[] = [];
  for (const key in probe) inherited.push(key);
  expect(inherited).toEqual([]);
}
