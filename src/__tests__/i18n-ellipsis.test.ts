import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * One ellipsis: the typographic "…" (U+2026). The English and German bundles
 * already wrote it everywhere; four bundles carried three ASCII full stops in
 * the same keys ("Cargando estado..."), and one stacked both
 * ("Cargando…..."), so the same loading line looked different by language.
 *
 * Two placeholders are exempt: they show the opening characters of a key the
 * operator pastes ("sk-...", "BElx..."), where the three dots are part of
 * the sample, not a pause.
 */

const MESSAGES_DIR = join(__dirname, "../../messages");
const KEY_SAMPLE = /^(sk-|BElx)\.\.\./;

function strings(obj: unknown, out: string[] = []): string[] {
  if (typeof obj === "string") out.push(obj);
  else if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) strings(v, out);
  }
  return out;
}

const badEllipsis = (value: string) =>
  !KEY_SAMPLE.test(value) && (/\.\.\./.test(value) || /…\./.test(value));

describe("message bundles write the ellipsis as one glyph", () => {
  const bundles = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json"));

  it("finds the bundles", () => {
    expect(bundles.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of bundles) {
    it(`${file} has no "..." and no "…."`, () => {
      const values = strings(
        JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8")),
      );
      expect(values.filter(badEllipsis)).toEqual([]);
    });
  }

  it("matches what it is written for", () => {
    expect(badEllipsis("Cargando estado...")).toBe(true);
    expect(badEllipsis("Cargando…...")).toBe(true);
    expect(badEllipsis("Postpone…")).toBe(false);
    expect(badEllipsis("sk-...")).toBe(false);
  });
});
