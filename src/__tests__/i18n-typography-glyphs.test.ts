import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The stricter sibling of the dot-separator guard (i18n-no-dot-separator). That guard catches
 * a spaced separator; this one looks at every arrow, dash and middle dot in
 * the bundles, spaced or not, and admits only the forms that are typography
 * rather than a stand-in for words:
 *
 * - U+2192 (arrow) never. A menu path is written "Settings > Account", the
 *   way the release notes write it; a change is "from 80 kg to 78 kg", an
 *   order is a comma list.
 * - U+2014 (em dash) never, except in a bundle whose language requires it as
 *   punctuation (`EM_DASH_BUNDLES`) and for a key in `ALLOWED`.
 * - U+2013 (en dash) only unspaced between two operands: a range ("3–5",
 *   "{low}–{high}", "07:00–09:00", "A–Z") or a compound ("doctor–patient").
 *   A dash with a space on either side, or at either end, is a pause the
 *   sentence should have said with a comma or a colon.
 * - U+00B7 (middle dot) only unspaced between two letters: a unit product
 *   ("mL/(kg·min)", "k·MAD") or the Korean enumeration mark ("근육·뼈").
 *
 * A key that genuinely needs another form goes into `ALLOWED` with the reason
 * next to it. An allowed key that no longer holds a flagged glyph fails, so
 * the list cannot go stale.
 */

const MESSAGES_DIR = join(__dirname, "../../messages");

/** Key path -> why the glyph is right there. Applies to every bundle. */
const ALLOWED: Record<string, string> = {
  "insights.ecg.meta.unknown":
    "empty-cell glyph: the whole value is the dash, shown where no value exists",
  "clinicianView.noAdherence":
    "empty-cell glyph: the whole value is the dash, shown where no value exists",
  "cycle.ring.dayUnknown":
    "empty-cell glyph: the whole value is the dash, shown where no value exists",
};

/**
 * Russian sets the em dash where English has a copula or a comma
 * ("Сводка — это ..."), so it is punctuation there, not a fragment join. The
 * same exemption stands in the dot-separator guard.
 */
const EM_DASH_BUNDLES = new Set(["ru.json"]);

const OPERAND_BEFORE = /[\p{L}\p{N}}%)°]/u;
const OPERAND_AFTER = /[\p{L}\p{N}{(±]/u;
const LETTER = /\p{L}/u;

/** Every offending glyph in `value`, as "glyph@index". */
function flaggedGlyphs(value: string, emDashAllowed: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const before = value[i - 1] ?? "";
    const after = value[i + 1] ?? "";
    if (ch === "→") out.push(`→@${i}`);
    else if (ch === "—" && !emDashAllowed) out.push(`—@${i}`);
    else if (
      ch === "–" &&
      !(OPERAND_BEFORE.test(before) && OPERAND_AFTER.test(after))
    ) {
      out.push(`–@${i}`);
    } else if (ch === "·" && !(LETTER.test(before) && LETTER.test(after))) {
      out.push(`·@${i}`);
    }
  }
  return out;
}

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

describe("the glyph rule itself", () => {
  it.each([
    "Settings > Account",
    "3–5 times",
    "{low}–{high} {unit}",
    "07:00–09:00",
    "Name (A–Z)",
    "95–100 %",
    "the doctor–patient conversation",
    "mL/(kg·min)",
    "근육·뼈·장기",
  ])("admits %j", (value) => {
    expect(flaggedGlyphs(value, false)).toEqual([]);
  });

  it.each([
    "Settings → Account",
    "{start} kg → {end} kg",
    "— Default —",
    "Could not save — try again",
    "Saved – done",
    "–5",
    "Added {date} · {size}",
    "Weight ·body fat",
  ])("flags %j", (value) => {
    expect(flaggedGlyphs(value, false)).not.toEqual([]);
  });

  it("admits the em dash only where the bundle allows it", () => {
    expect(flaggedGlyphs("Курс {start} — {end}", true)).toEqual([]);
    expect(flaggedGlyphs("Курс {start} — {end} →", true)).toEqual(["→@21"]);
  });
});

describe("message bundles hold no arrow, em dash, stray en dash or stray middle dot", () => {
  it("finds the bundles", () => {
    expect(bundles.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of bundles) {
    const values = flatten(
      JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8")),
      "",
      new Map(),
    );
    const emDashAllowed = EM_DASH_BUNDLES.has(file);

    it(`${file} walks a non-empty set of strings`, () => {
      expect(values.size).toBeGreaterThan(1000);
    });

    it(`${file} has no flagged glyph outside the allowlist`, () => {
      const offenders = [...values]
        .filter(
          ([key, value]) =>
            !(key in ALLOWED) && flaggedGlyphs(value, emDashAllowed).length > 0,
        )
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
      expect(offenders).toEqual([]);
    });

    it(`${file} has no stale allowlist entry`, () => {
      const stale = Object.keys(ALLOWED).filter(
        (key) => flaggedGlyphs(values.get(key) ?? "", false).length === 0,
      );
      expect(stale).toEqual([]);
    });
  }
});
