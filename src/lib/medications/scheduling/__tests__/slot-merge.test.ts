import { describe, expect, it } from "vitest";

import { partitionSlotDuplicates } from "../slot-merge";

const at = (iso: string) => new Date(iso);

function row(
  id: string,
  over: Partial<{
    takenAt: Date | null;
    skipped: boolean;
    createdAt: Date | null;
    slot: string;
    live: boolean;
  }> = {},
) {
  return {
    id,
    takenAt: over.takenAt ?? null,
    skipped: over.skipped ?? false,
    createdAt: over.createdAt ?? null,
    slot: over.slot ?? "s1",
    live: over.live ?? true,
  };
}

function keptIds(rows: ReturnType<typeof row>[]) {
  const { kept, merged } = partitionSlotDuplicates(
    rows,
    (r) => r.slot,
    (r) => r.live,
  );
  return {
    kept: [...kept].map((r) => r.id).sort(),
    merged: [...merged].map((r) => r.id).sort(),
  };
}

describe("the slot merge rule (the rule of migration 0515)", () => {
  it("keeps a take over a skip over a pending row", () => {
    expect(
      keptIds([
        row("pending", { createdAt: at("2026-01-01T06:00:00Z") }),
        row("skip", { skipped: true, createdAt: at("2026-01-01T06:30:00Z") }),
        row("take", {
          takenAt: at("2026-01-01T07:05:00Z"),
          createdAt: at("2026-01-01T07:05:00Z"),
        }),
      ]),
    ).toEqual({ kept: ["take"], merged: ["pending", "skip"] });
  });

  it("reads a take that is also skipped as a skip", () => {
    expect(
      keptIds([
        row("both", { takenAt: at("2026-01-01T07:00:00Z"), skipped: true }),
        row("take", { takenAt: at("2026-01-01T07:10:00Z") }),
      ]).kept,
    ).toEqual(["take"]);
  });

  it("breaks a tie by the oldest row, then the id", () => {
    const t = at("2026-01-01T07:00:00Z");
    expect(
      keptIds([
        row("b", { takenAt: t, createdAt: at("2026-01-01T07:01:00Z") }),
        row("a", { takenAt: t, createdAt: at("2026-01-01T07:02:00Z") }),
      ]).kept,
    ).toEqual(["b"]);
    expect(
      keptIds([
        row("b", { takenAt: t, createdAt: t }),
        row("a", { takenAt: t, createdAt: t }),
      ]).kept,
    ).toEqual(["a"]);
  });

  it("leaves tombstones and rows of other slots alone", () => {
    expect(
      keptIds([
        row("gone", { takenAt: at("2026-01-01T07:00:00Z"), live: false }),
        row("here", { skipped: true }),
        row("other", { slot: "s2" }),
      ]),
    ).toEqual({ kept: ["here", "other"], merged: [] });
  });
});
