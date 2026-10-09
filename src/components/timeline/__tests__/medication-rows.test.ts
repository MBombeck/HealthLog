/**
 * v1.42 (#613) — one medication is one thing. The server sends a medication
 * as up to four kinds of item (its own span, its courses, its dose changes,
 * its pauses), all tagged with the medication's id as `group`. Drawn item by
 * item, "Mounjaro 7.5 mg" and "Mounjaro" were two bars on two rows for one
 * medication. These pin the grouping every surface reads through.
 */
import { describe, expect, it } from "vitest";

import type { TimelineItem } from "@/lib/day/contract";

import {
  doseAt,
  doseSegments,
  medicationGroups,
  medicationListItems,
  medicationPeriodItem,
  strayDoses,
} from "../medication-rows";
import { item } from "./timeline-fixture";

const TODAY = "2025-12-31";

/** A GLP-1 medication with a course, three doses and a pause. */
function mounjaro(): TimelineItem[] {
  return [
    item({
      id: "mj",
      group: "mj",
      kind: "medication",
      start: "2025-01-06",
      open: true,
      label: "Mounjaro",
      sub: "7.5 mg",
    }),
    item({
      id: "mj-course",
      group: "mj",
      kind: "course",
      start: "2025-01-06",
      open: true,
      label: "Mounjaro",
    }),
    item({
      id: "mj-25",
      group: "mj",
      kind: "doseChange",
      start: "2025-01-06",
      label: "Mounjaro",
      sub: "2.5 mg",
    }),
    item({
      id: "mj-5",
      group: "mj",
      kind: "doseChange",
      start: "2025-03-03",
      label: "Mounjaro",
      sub: "5 mg",
    }),
    item({
      id: "mj-75",
      group: "mj",
      kind: "doseChange",
      start: "2025-06-02",
      label: "Mounjaro",
      sub: "7.5 mg",
    }),
    item({
      id: "mj-pause",
      group: "mj",
      kind: "pause",
      start: "2025-08-01",
      end: "2025-08-20",
      label: "Mounjaro",
    }),
  ];
}

/** A standing medication without courses and with one dose change. */
function ramipril(): TimelineItem[] {
  return [
    item({
      id: "rp",
      group: "rp",
      kind: "medication",
      start: "2024-02-01",
      open: true,
      label: "Ramipril",
      sub: "5 mg",
    }),
    item({
      id: "rp-5",
      group: "rp",
      kind: "doseChange",
      start: "2025-04-14",
      label: "Ramipril",
      sub: "5 mg",
    }),
  ];
}

describe("medicationGroups", () => {
  it("makes one group per medication, however many items it arrives as", () => {
    const groups = medicationGroups([...ramipril(), ...mounjaro()]);
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ["rp", "Ramipril"],
      ["mj", "Mounjaro"],
    ]);
    const mj = groups[1];
    // The course is the stretch it was taken; its own span is not drawn
    // beside it.
    expect(mj.periods.map((p) => p.id)).toEqual(["mj-course"]);
    expect(mj.doses.map((d) => d.id)).toEqual(["mj-25", "mj-5", "mj-75"]);
    expect(mj.pauses.map((p) => p.id)).toEqual(["mj-pause"]);
    // Without a course, the medication's own span is the stretch.
    expect(groups[0].periods.map((p) => p.id)).toEqual(["rp"]);
  });

  it("keeps an item without a group on its own", () => {
    const groups = medicationGroups([
      item({ id: "a", kind: "course", start: "2025-01-01", end: "2025-02-01" }),
      item({ id: "b", kind: "course", start: "2025-03-01", end: "2025-04-01" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["a", "b"]);
  });
});

describe("dose segments", () => {
  it("cuts a stretch at each dose change and names each piece's dose", () => {
    const [mj] = medicationGroups(mounjaro());
    const pieces = doseSegments(mj, mj.periods[0]);
    expect(
      pieces.map(({ start, end, dose }) => ({ start, end, dose })),
    ).toEqual([
      { start: "2025-01-06", end: "2025-03-02", dose: "2.5 mg" },
      { start: "2025-03-03", end: "2025-06-01", dose: "5 mg" },
      { start: "2025-06-02", end: null, dose: "7.5 mg" },
    ]);
    expect(pieces.map((p) => [p.first, p.last])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
  });

  it("leaves the dose before the first recorded change unnamed", () => {
    const [rp] = medicationGroups(ramipril());
    expect(doseSegments(rp, rp.periods[0]).map((p) => p.dose)).toEqual([
      null,
      "5 mg",
    ]);
    expect(doseAt(rp, "2024-06-01")).toBeNull();
    // With no dose change at all, the medication's own dose.
    const [plain] = medicationGroups([ramipril()[0]]);
    expect(doseAt(plain, "2024-06-01")).toBe("5 mg");
  });

  it("keeps a dose change outside every stretch as a mark of its own", () => {
    const items = [
      item({
        id: "c1",
        group: "vd",
        kind: "course",
        start: "2024-11-01",
        end: "2025-03-31",
        label: "Vitamin D",
      }),
      item({
        id: "vd-dose",
        group: "vd",
        kind: "doseChange",
        start: "2025-06-01",
        label: "Vitamin D",
        sub: "1000 IE",
      }),
    ];
    const [vd] = medicationGroups(items);
    expect(strayDoses(vd).map((d) => d.id)).toEqual(["vd-dose"]);
  });
});

describe("medicationListItems", () => {
  it("lists a start once, with the dose taken then, and folds a dose change on that day", () => {
    const listed = medicationListItems(mounjaro());
    expect(listed.map((i) => [i.id, i.kind, i.sub])).toEqual([
      ["mj-course", "course", "2.5 mg"],
      ["mj-5", "doseChange", "5 mg"],
      ["mj-75", "doseChange", "7.5 mg"],
      ["mj-pause", "pause", null],
    ]);
  });
});

describe("medicationPeriodItem", () => {
  const [mj] = medicationGroups(mounjaro());

  it("names a dose change in the period with the new dose, from its day", () => {
    expect(
      medicationPeriodItem(mj, "2025-03-01", "2025-03-31", TODAY),
    ).toMatchObject({
      id: "mj",
      kind: "medication",
      label: "Mounjaro",
      sub: "5 mg",
      start: "2025-03-03",
      open: true,
    });
  });

  it("names a pause in the period as a pause", () => {
    expect(
      medicationPeriodItem(mj, "2025-08-01", "2025-08-31", TODAY),
    ).toMatchObject({
      id: "mj",
      kind: "pause",
      label: "Mounjaro",
      start: "2025-08-01",
      end: "2025-08-20",
    });
  });

  it("leaves out a month where nothing happens to a running medication", () => {
    expect(
      medicationPeriodItem(mj, "2025-10-01", "2025-10-31", TODAY),
    ).toBeNull();
  });

  it("names the start month once, with the first dose", () => {
    expect(
      medicationPeriodItem(mj, "2025-01-01", "2025-01-31", TODAY),
    ).toMatchObject({ sub: "2.5 mg", start: "2025-01-06" });
  });
});
