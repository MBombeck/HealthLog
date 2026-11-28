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
 * no primitive yet, and the forms of the managed-profile pages. Every file
 * that keeps one says why in `REASONS`, and the set of reasons has to match
 * the set of files measured.
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

/**
 * Why each file that keeps a raw `<label>` keeps it. One line per file; a
 * file without a reason fails, and so does a reason for a file with none.
 * The shared wordings are named once so a sweep can find every use.
 */
const CHECKBOX_ROW = "wraps a checkbox and its text; no checkbox-row primitive";
const RADIO_CARD = "wraps a radio option card; no radio-row primitive";
const STATUS_SWITCH =
  "the card header's status switch with its on/off word; the word is a click target and SwitchRow does not stand in the status slot";
const REASONS: Record<string, string> = {
  "components/admin/backups/restore-dialog.tsx": CHECKBOX_ROW,
  "components/auth/mfa-login-step.tsx": CHECKBOX_ROW,
  "components/insights/coach-panel/sources-rail.tsx":
    "a list row whose switch trades places with a pending spinner",
  "components/labs/biomarker-merge-sheet.tsx":
    "wraps a checkbox list row and its marker name; no checkbox-row primitive",
  "components/labs/lab-unit-input.tsx": CHECKBOX_ROW,
  "components/labs/ocr-review-dialog.tsx": "the file picker's drop zone",
  "components/labs/ocr-row-editor.tsx":
    "a touch target around the row's confirm checkbox",
  "components/medications/scheduling/cadence-picker.tsx": RADIO_CARD,
  "components/medications/wizard/steps/step2-class.tsx": RADIO_CARD,
  "components/medications/wizard/steps/step3-dose.tsx": CHECKBOX_ROW,
  "components/medications/wizard/steps/step5-cadence.tsx": RADIO_CARD,
  "components/onboarding/choice-chip.tsx":
    "wraps a radio or checkbox chip; no choice primitive",
  "components/records/audit-c-panel.tsx":
    "wraps a radio and its answer; no radio-row primitive",
  "components/records/life-circumstances-fields.tsx": CHECKBOX_ROW,
  "components/settings/access/grant-invite-card.tsx":
    "wraps a radio or checkbox with its sentence; no primitive",
  "components/settings/apple-health-mirror-token.tsx":
    "a compact switch inside a token table cell, and a checkbox with its text",
  "components/settings/coach-nudge-card.tsx": STATUS_SWITCH,
  "components/settings/injection-sites-card.tsx": CHECKBOX_ROW,
  "components/settings/low-stock-card.tsx": STATUS_SWITCH,
  "components/settings/mood-reminder-card.tsx": STATUS_SWITCH,
  "components/settings/notification-content-card.tsx": STATUS_SWITCH,
  "components/settings/report-selection/leaf-grid.tsx": CHECKBOX_ROW,
  "components/settings/security-sessions-card.tsx": CHECKBOX_ROW,
  "components/vaccinations/custom-vaccine-sheet.tsx": CHECKBOX_ROW,
};

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

  it("names a reason for every file that keeps a raw <label>, and none more", () => {
    const measured = Object.keys(measure()).sort();
    const reasoned = Object.keys(REASONS).sort();
    requireFloor("files with a raw <label>", measured, 1);
    expect(
      measured.filter((path) => !(path in REASONS)),
      "A file keeps a raw <label> without a reason. Move it to FieldGroup, SwitchRow or Label, or say in REASONS why its markup differs on purpose.",
    ).toEqual([]);
    expect(
      reasoned.filter((path) => !measured.includes(path)),
      "A reason for a file that no longer has a raw <label>. Remove its REASONS entry.",
    ).toEqual([]);
    for (const path of reasoned) {
      expect(REASONS[path].trim(), path).not.toBe("");
    }
  });
});
