/**
 * Structural guard on the focus treatment of text-entry fields.
 *
 * A text field shows focus by its border alone: `border-input` turns the
 * neutral `input-focus` tone (a foreground-based grey, at least 3:1 on the
 * background in both themes). No colour ring, no purple. The ring was the
 * loudest thing on a form, and for a text field it is on for every mouse
 * click too, because `:focus-visible` always matches a field that takes
 * typed input. Buttons, links, checkboxes and switches keep their rings;
 * they are not in scope here.
 *
 * The one ring a field still draws is the destructive one on an invalid
 * field that has focus (`aria-invalid:focus-visible:ring-[3px]`): its border
 * is already red, so the ring is what tells focus apart there.
 *
 * Two checks:
 *
 *   1. Every text-entry primitive (and the Coach composer) uses the token.
 *   2. Every class string in `src/` that styles a text field (it names
 *      `border-input`, the focus token, or a `placeholder:` colour) carries no focus ring and no
 *      primary/ring-coloured focus border. The sweep must find a floor of
 *      such strings, so a matcher that stops matching fails instead of
 *      passing on nothing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** Text-entry primitives and the hand-built text fields that own a focus style. */
const TEXT_FIELD_FILES = [
  "src/components/ui/input.tsx",
  "src/components/ui/textarea.tsx",
  "src/components/ui/select.tsx",
  "src/components/ui/native-select.tsx",
  "src/components/ui/date-field.tsx",
  "src/components/ui/time-field.tsx",
  "src/components/ui/calendar.tsx",
  "src/components/insights/coach-panel/coach-input.tsx",
  "src/components/cycle/cycle-settings.tsx",
  "src/components/records/about-me-note-manager.tsx",
  "src/components/records/conditions-manager.tsx",
  "src/components/records/allergy-free-text-note.tsx",
];

const FOCUS_VARIANT = /(^|:)(focus|focus-visible|focus-within|has-focus)(:|$)/;
const BANNED_UTILITY =
  /^(ring(-\[[^\]]+\]|-\d+)?$|ring-(ring|primary|offset)|border-(ring|primary)|outline-(ring|primary))/;

/** Focus tokens in a class string that put a ring or a colour border on focus. */
function bannedFocusTokens(classString: string): string[] {
  return classString.split(/\s+/).filter((token) => {
    if (!token.includes(":")) return false;
    const parts = token.split(":");
    const utility = parts.pop()!;
    const variants = parts.join(":");
    if (!FOCUS_VARIANT.test(variants)) return false;
    // The invalid field's destructive focus ring is the documented exception.
    if (/(^|:)aria-invalid(:|$)/.test(variants)) return false;
    return BANNED_UTILITY.test(utility);
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "generated" || name === "__tests__") continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(path);
  }
  return out;
}

const STRING_LITERAL = /"([^"\n]*)"|`([^`]*)`|'([^'\n]*)'/g;
const TEXT_FIELD_MARKER =
  /(^|\s)(border-input|placeholder:text-)|border-input-focus/;

describe("text-field focus", () => {
  it("the detector flags a ring and a purple border, and spares the exceptions", () => {
    expect(
      bannedFocusTokens(
        "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-within:border-primary/50 focus-within:ring-2 has-focus:border-ring focus-visible:ring-offset-2",
      ),
    ).toHaveLength(6);
    expect(
      bannedFocusTokens(
        "focus-visible:border-input-focus aria-invalid:focus-visible:ring-[3px] focus-visible:outline-none aria-invalid:ring-destructive/20",
      ),
    ).toEqual([]);
  });

  it.each(TEXT_FIELD_FILES)("%s uses the neutral focus border", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    expect(source).toContain("border-input-focus");
    expect(source).not.toMatch(/ring-primary/);
  });

  it("no class string that styles a text field draws a focus ring", () => {
    const offenders: string[] = [];
    let fieldStrings = 0;
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(STRING_LITERAL)) {
        const literal = match[1] ?? match[2] ?? match[3] ?? "";
        if (!TEXT_FIELD_MARKER.test(literal)) continue;
        fieldStrings++;
        const bad = bannedFocusTokens(literal);
        if (bad.length > 0)
          offenders.push(`${relative(ROOT, file)}: ${bad.join(" ")}`);
      }
    }
    // The primitives alone account for more than this; fewer means the
    // matcher went blind, not that the fields went away.
    expect(fieldStrings).toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });
});
