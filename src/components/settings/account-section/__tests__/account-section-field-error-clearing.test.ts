/**
 * A refusal the person has already answered must not keep standing.
 *
 * The settings profile form paints one sentence per field the last save
 * declined. It cleared them only on the next submit, so a corrected
 * value sat under the reason it was refused until the person pressed
 * save again — the onboarding baseline step drops the sentence while
 * they type (`patch` in `baseline-form.tsx`) and this form did not.
 *
 * Two things have to hold, and both are checked here because either one
 * alone passes on the defect: the state rule (the edited field's
 * sentence goes, its siblings stay), and the wiring (every slot the form
 * renders actually names itself when its input changes). A helper that
 * nothing calls is exactly the shape this guard exists to catch.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PROFILE_FIELD_LABEL_KEYS } from "@/lib/profile/rejected-fields";
import { clearRejectedField } from "../account-section-utils";

const SOURCE = readFileSync(resolve(__dirname, "../index.tsx"), "utf8");

/** The slots the form renders a refusal sentence into. */
function renderedSlots(): string[] {
  return [
    ...new Set(
      [...SOURCE.matchAll(/message=\{fieldErrors\.(\w+)\}/g)].map((m) => m[1]),
    ),
  ].sort();
}

/** The slots an input clears as it is edited. */
function clearedSlots(): string[] {
  return [
    ...new Set(
      [...SOURCE.matchAll(/clearFieldError\("(\w+)"\)/g)].map((m) => m[1]),
    ),
  ].sort();
}

describe("a rejected profile field clears as it is edited", () => {
  it("drops the edited field's sentence and keeps the others", () => {
    const refused = {
      heightCm: "That value is above the range this field accepts.",
      gender: "That value is not one this field accepts.",
    };

    const afterHeightEdit = clearRejectedField(refused, "heightCm");
    expect(afterHeightEdit.heightCm).toBeUndefined();
    // The gender value was not touched, so its refusal still answers
    // the value that is still in the box.
    expect(afterHeightEdit.gender).toBe(refused.gender);

    // Editing the other field clears only its own slot in turn.
    const afterBothEdits = clearRejectedField(afterHeightEdit, "gender");
    expect(afterBothEdits).toEqual({});
    // The original map is never mutated — it is React state.
    expect(refused.heightCm).toBeDefined();
  });

  it("leaves a map with nothing in that slot untouched", () => {
    const refused = { gender: "That value is not one this field accepts." };
    // Same reference: typing in a field that was never refused must not
    // hand React a new object every keystroke.
    expect(clearRejectedField(refused, "email")).toBe(refused);
  });

  it("clears every slot the form can paint", () => {
    // A guard that matches nothing is green for the wrong reason.
    expect(renderedSlots().length).toBeGreaterThan(0);
    expect(clearedSlots()).toEqual(renderedSlots());
  });

  it("paints a slot for every field the server can refuse", () => {
    // The label map is the set of paths `applyProfileUpdate` names back
    // to this screen; a path with no slot has nowhere to land.
    expect(renderedSlots()).toEqual(
      Object.keys(PROFILE_FIELD_LABEL_KEYS).sort(),
    );
  });
});
