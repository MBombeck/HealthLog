/**
 * A form field's name is a `Label` from the kit, reached through
 * `FieldGroup` (a name over a control) or `SwitchRow` (a name beside a
 * switch). A raw `<label>` is neither.
 *
 * Three shapes named a field: `FieldGroup`, a `Label` stacked by hand, and
 * a raw `<label>` with whatever classes its author picked. The raw ones
 * disagreed with the rest on everything a name has: no colon where every
 * other field has one, 12 px beside 14 px in the same card, a 4 px gap to
 * the control instead of 8 px, normal weight instead of medium. Two fields in
 * one card looked like two forms.
 *
 * This is a ratchet over the raw ones: each file that still has one is in
 * `baselines/raw-labels.json` with its count. A new one fails, a file whose
 * count rises fails, and a count that falls has to be written back
 * (`RATCHET_WRITE=1`), so the number only goes down. What remains is mostly
 * a `<label>` wrapped around a checkbox or a radio and its text, which has
 * no primitive yet, and the forms of the managed-profile pages.
 *
 * Not matched (stated, not hidden): a field named by a `<p>` or a `<span>`
 * with no label element at all. That is an accessibility defect of its own
 * and reads differently in a sweep.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runRatchet, writeBackHint } from "./helpers/ratchet";
import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(__dirname, "..");
const GUARD = "src/__tests__/form-field-ratchet.test.ts";

function rawLabels(source: string): number {
  return (stripComments(source).match(/<label\b/g) ?? []).length;
}

function measure(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of walkSourceFiles(SRC, {
    floor: 1200,
    extensions: [".tsx"],
  })) {
    if (!/^(components|app)\//.test(path)) continue;
    if (path.startsWith("components/ui/") || path.includes("__tests__/")) {
      continue;
    }
    const n = rawLabels(readSourceText(join(SRC, path)));
    if (n > 0) counts[path] = n;
  }
  return counts;
}

describe("form field anatomy", () => {
  it("counts the element and not its mentions", () => {
    expect(
      rawLabels(
        '<label htmlFor="a" className="grid gap-1 text-sm">Name</label>',
      ),
    ).toBe(1);
    expect(
      rawLabels('// a <label> in a comment\n<Label htmlFor="a">Name</Label>'),
    ).toBe(0);
    expect(rawLabels('<FieldGroup htmlFor="a" label="Name" />')).toBe(0);
  });

  it("lets no raw <label> in, and lets none grow", () => {
    const measured = measure();
    requireFloor("files with a raw <label>", Object.keys(measured), 1);
    const result = runRatchet("raw-labels.json", measured, {
      comment:
        "Raw <label> elements per file under src/components and src/app, outside src/components/ui. Maintained by src/__tests__/form-field-ratchet.test.ts.",
    });
    expect(
      result.grew,
      "A raw <label> that is new or one more than its file had. Name the field through FieldGroup (a name over a control) or SwitchRow (a name beside a switch).",
    ).toEqual([]);
    expect(result.stale, writeBackHint(GUARD)).toEqual([]);
  });
});
