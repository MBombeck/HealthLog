import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Typography in the message bundles: one walk, three rules. Every arrow,
 * dash and middle dot in the bundles, spaced or not, is held to the forms
 * that are typography rather than a stand-in for words, the spaced
 * separator is refused outright, and the ellipsis is one glyph.
 *
 * Glyphs:
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
 *
 * Spaced separator: "Added {date} · {size}" or "Could not save — try again"
 * reads as fragments; the dash or dot stands in for a comma, a colon or a
 * full stop. A space, then U+00B7, U+2014 or U+2013, then a space, fails in
 * every bundle and for every key, `ALLOWED` included. Russian may set the
 * spaced dash as punctuation; its spaced middle dot still fails.
 *
 * Ellipsis: the typographic "…" (U+2026). Four bundles once carried three
 * ASCII full stops in the same keys ("Cargando estado..."), and one stacked
 * both ("Cargando…..."). Two placeholders are exempt: they show the opening
 * characters of a key the operator pastes ("sk-...", "BElx..."), where the
 * dots are part of the sample, not a pause.
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

const SPACED_DOT = " · ";
const SPACED_DASHES = [" — ", " – "] as const;

function hasSpacedSeparator(value: string, dashAllowed: boolean): boolean {
  if (value.includes(SPACED_DOT)) return true;
  return !dashAllowed && SPACED_DASHES.some((dash) => value.includes(dash));
}

const KEY_SAMPLE = /^(sk-|BElx)\.\.\./;

const badEllipsis = (value: string) =>
  !KEY_SAMPLE.test(value) && (/\.\.\./.test(value) || /…\./.test(value));

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

  it("refuses a spaced separator, the spaced dash only where the bundle has no use for it", () => {
    expect(hasSpacedSeparator("Added {date} · {size}", false)).toBe(true);
    expect(hasSpacedSeparator("Could not save — try again", false)).toBe(true);
    expect(hasSpacedSeparator("Saved – done", false)).toBe(true);
    expect(hasSpacedSeparator("Курс {start} — {end}", true)).toBe(false);
    expect(hasSpacedSeparator("Добавлено {date} · {size}", true)).toBe(true);
    expect(hasSpacedSeparator("70–100 mmHg", false)).toBe(false);
  });

  it("writes the ellipsis as one glyph", () => {
    expect(badEllipsis("Cargando estado...")).toBe(true);
    expect(badEllipsis("Cargando…...")).toBe(true);
    expect(badEllipsis("Postpone…")).toBe(false);
    expect(badEllipsis("sk-...")).toBe(false);
  });

  it("admits the em dash only where the bundle allows it", () => {
    expect(flaggedGlyphs("Курс {start} — {end}", true)).toEqual([]);
    expect(flaggedGlyphs("Курс {start} — {end} →", true)).toEqual(["→@21"]);
  });
});

describe("message bundles hold no arrow, em dash, stray en dash, stray middle dot, spaced separator or ASCII ellipsis", () => {
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

    it(`${file} has no flagged glyph outside the allowlist, no spaced separator and no "..."`, () => {
      const offenders = [...values]
        .filter(
          ([key, value]) =>
            (!(key in ALLOWED) &&
              flaggedGlyphs(value, emDashAllowed).length > 0) ||
            hasSpacedSeparator(value, emDashAllowed) ||
            badEllipsis(value),
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
