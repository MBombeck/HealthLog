import { describe, expect, it } from "vitest";

import type { DocumentSourceResultDto } from "@/lib/documents/sources/types";

import {
  deletedSourceIds,
  heldBadgeLabel,
  isPickable,
  runLabel,
  runOutcome,
} from "../picker-rows";

function row(
  over: Partial<DocumentSourceResultDto> = {},
): DocumentSourceResultDto {
  return {
    sourceId: "41",
    title: "Blood test",
    date: null,
    tags: [],
    sizeBytes: null,
    state: "new",
    documentId: null,
    ...over,
  };
}

const t = (key: string) => key;

describe("isPickable", () => {
  it("ticks a new row and a deleted one (asking for it back)", () => {
    expect(isPickable(row(), false)).toBe(true);
    expect(isPickable(row({ state: "deleted", documentId: "d1" }), false)).toBe(
      true,
    );
    expect(isPickable(row({ state: "deleted" }), false)).toBe(true);
  });

  it("ticks an imported row only when the pick links it or hands it on", () => {
    const imported = row({ state: "imported", documentId: "d1" });
    expect(isPickable(imported, false)).toBe(false);
    expect(isPickable(imported, true)).toBe(true);
  });
});

describe("deletedSourceIds", () => {
  it("names exactly the rows held as deleted, which the import revives", () => {
    const ids = deletedSourceIds([
      row({ sourceId: "1" }),
      row({ sourceId: "2", state: "deleted", documentId: "d2" }),
      row({ sourceId: "3", state: "imported", documentId: "d3" }),
      row({ sourceId: "4", state: "deleted" }),
    ]);
    expect([...ids].sort()).toEqual(["2", "4"]);
  });
});

describe("heldBadgeLabel", () => {
  it("tells a document still in Recently deleted from one removed for good", () => {
    expect(heldBadgeLabel(t, row({ state: "deleted", documentId: "d1" }))).toBe(
      "documents.sourcePicker.stateInTrash",
    );
    expect(heldBadgeLabel(t, row({ state: "deleted" }))).toBe(
      "documents.sourcePicker.stateDeleted",
    );
    expect(heldBadgeLabel(t, row({ state: "imported", documentId: "d" }))).toBe(
      "documents.sourcePicker.stateImported",
    );
  });
});

describe("a restored row", () => {
  it("reads as restored, linked or not", () => {
    expect(runLabel(t, { state: "restored", linked: false })).toBe(
      "documents.sourcePicker.result.restored",
    );
    expect(runLabel(t, { state: "restored", linked: true })).toBe(
      "documents.sourcePicker.result.restoredLinked",
    );
  });

  it("counts toward a successful run", () => {
    expect(runOutcome({ imported: 1, present: 0, failed: 0 })).toBe("success");
  });
});
