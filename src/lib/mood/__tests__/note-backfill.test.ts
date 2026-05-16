import { describe, expect, it } from "vitest";

import { extractNoteAndSlimTags } from "../note-backfill";

describe("extractNoteAndSlimTags", () => {
  it("extracts the first note:<text> entry and slims the tag array", () => {
    expect(
      extractNoteAndSlimTags(JSON.stringify(["coffee", "note:slept poorly", "workout"])),
    ).toEqual({
      note: "slept poorly",
      newTags: JSON.stringify(["coffee", "workout"]),
    });
  });

  it("returns null tags when the slimmed array is empty", () => {
    expect(extractNoteAndSlimTags(JSON.stringify(["note:lonely entry"]))).toEqual({
      note: "lonely entry",
      newTags: null,
    });
  });

  it("returns note=null when no entry starts with note:", () => {
    expect(extractNoteAndSlimTags(JSON.stringify(["coffee", "workout"]))).toEqual({
      note: null,
      newTags: JSON.stringify(["coffee", "workout"]),
    });
  });

  it("extracts only the first note:... entry; further note-prefixed entries stay as tags", () => {
    expect(
      extractNoteAndSlimTags(JSON.stringify(["note:first", "note:second"])),
    ).toEqual({
      note: "first",
      newTags: JSON.stringify(["note:second"]),
    });
  });

  it("returns the input string when it is not valid JSON", () => {
    expect(extractNoteAndSlimTags("not-a-json-array")).toEqual({
      note: null,
      newTags: "not-a-json-array",
    });
  });

  it("returns the input string when the JSON is not an array", () => {
    expect(extractNoteAndSlimTags(JSON.stringify({ note: "x" }))).toEqual({
      note: null,
      newTags: JSON.stringify({ note: "x" }),
    });
  });

  it("preserves the note prefix text exactly (no trim, no decode)", () => {
    expect(
      extractNoteAndSlimTags(JSON.stringify(["note: with leading space "])),
    ).toEqual({
      note: " with leading space ",
      newTags: null,
    });
  });
});
