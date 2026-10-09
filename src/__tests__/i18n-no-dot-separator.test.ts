import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * No middle-dot separator in visible strings.
 *
 * A value like "Added {date} · {size}" or "Weight · body fat · muscle" reads
 * as a list of fragments rather than as the app's plain voice. Facts are
 * joined with a comma, a colon or a real phrase instead. This guard walks
 * every bundle under `messages/` and fails on any string that contains a
 * space, U+00B7 and a space. A middle dot inside a unit ("mL/(kg·min)") has
 * no surrounding spaces and is not matched.
 *
 * A key that genuinely needs the pattern goes into `ALLOWED` with the reason
 * written next to it. An allowed key that no longer contains the pattern
 * fails too, so the list cannot go stale.
 */

const MESSAGES_DIR = join(__dirname, "../../messages");
const SEPARATOR = " · ";

/** Key path -> why the separator is right there. Empty by intent. */
const ALLOWED: Record<string, string> = {};

function flatten(
  obj: unknown,
  prefix: string,
  out: Map<string, string>,
): Map<string, string> {
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else if (typeof v === "object") flatten(v, key, out);
  }
  return out;
}

const bundles = readdirSync(MESSAGES_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort();

describe("message bundles carry no ' · ' separator", () => {
  it("finds the bundles", () => {
    expect(bundles.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of bundles) {
    const values = flatten(
      JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8")),
      "",
      new Map(),
    );

    it(`${file} walks a non-empty set of strings`, () => {
      expect(values.size).toBeGreaterThan(1000);
    });

    it(`${file} has no dot separator outside the allowlist`, () => {
      const offenders = [...values]
        .filter(
          ([key, value]) => value.includes(SEPARATOR) && !(key in ALLOWED),
        )
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
      expect(offenders).toEqual([]);
    });

    it(`${file} has no stale allowlist entry`, () => {
      const stale = Object.keys(ALLOWED).filter(
        (key) => !(values.get(key) ?? "").includes(SEPARATOR),
      );
      expect(stale).toEqual([]);
    });
  }
});
