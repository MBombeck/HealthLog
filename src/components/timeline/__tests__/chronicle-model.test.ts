/**
 * v1.42 (#613) — the phone chronicle: newest first, grouped, empty stretches
 * said out loud, open things once in the Ongoing block, closed periods as
 * rails.
 */
import { describe, expect, it } from "vitest";

import {
  buildChronicle,
  chronicleEntries,
  standingChips,
  type ChronicleRow,
} from "../chronicle-model";
import { TODAY, fullTimeline } from "./timeline-fixture";

function headers(rows: ChronicleRow[]) {
  return rows
    .filter((r) => r.type === "header")
    .map((r) => (r.type === "header" ? r.group : ""));
}

describe("chronicleEntries", () => {
  it("lists points, period starts and period ends, newest first", () => {
    const entries = chronicleEntries(fullTimeline(), TODAY);
    const dates = entries.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    const cold = entries.filter(
      (e) => e.kind === "item" && e.item.id === "ill-5",
    );
    expect(cold.map((e) => (e.kind === "item" ? e.role : null))).toEqual([
      "end",
      "start",
    ]);
    const end = cold[0];
    expect(end.kind === "item" && end.days).toBe(9);
  });

  it("never lists anything after today", () => {
    const tl = fullTimeline();
    tl.lanes[0].items.push({
      id: "future",
      kind: "lifeEvent",
      start: "2027-01-01",
      end: null,
      open: false,
      precision: "DAY",
      startKnown: true,
      label: "x",
      sub: null,
      href: null,
    });
    expect(chronicleEntries(tl, TODAY).some((e) => e.date > TODAY)).toBe(false);
  });

  it("carries the quiet notable line", () => {
    const entries = chronicleEntries(fullTimeline(), TODAY);
    expect(entries.find((e) => e.kind === "notable")).toMatchObject({
      date: "2026-01-04",
      notable: "extremeHigh",
    });
  });
});

describe("buildChronicle", () => {
  it("folds a run of empty months into one honest gap row", () => {
    const rows = buildChronicle(fullTimeline(), TODAY, "month");
    // The last entry is the course ending on 31 March 2026: April to
    // October 2026 hold nothing.
    const gap = rows.find((r) => r.type === "gap" && r.to === "2026-10-01");
    expect(gap).toEqual({
      type: "gap",
      from: "2026-04-01",
      to: "2026-10-01",
      rails: {},
    });
    expect(headers(rows)[0]).toBe("2026-03-01");
  });

  it("keeps a course's rail through an empty stretch it spans", () => {
    const rows = buildChronicle(fullTimeline(), TODAY, "month");
    // The 2024/25 winter course runs from November to March; nothing else
    // is dated in December to February.
    const gap = rows.find((r) => r.type === "gap" && r.from === "2024-12-01");
    expect(gap?.type === "gap" && gap.rails.medications).toBe("full");
  });

  it("never shows two gap rows next to each other", () => {
    const rows = buildChronicle(fullTimeline(), TODAY, "month");
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].type === "gap" && rows[i - 1].type === "gap").toBe(false);
    }
  });

  it("groups by year when asked", () => {
    const rows = buildChronicle(fullTimeline(), TODAY, "year");
    expect(headers(rows)).toEqual([
      "2026-01-01",
      "2025-01-01",
      "2024-01-01",
      "2023-01-01",
      "2022-01-01",
      "2021-01-01",
      "2020-01-01",
      "2019-01-01",
      // The grass-pollen allergy began in 2018.
      "2018-01-01",
    ]);
  });

  it("draws a closed episode as a rail from its end row down to its start row", () => {
    const rows = buildChronicle(fullTimeline(), TODAY, "month");
    const railOf = (id: string, role: string) => {
      const row = rows.find(
        (r) =>
          r.type === "entry" &&
          r.entry.kind === "item" &&
          r.entry.item.id === id &&
          r.entry.role === role,
      );
      return row && row.type === "entry" ? row.rails.illness : undefined;
    };
    expect(railOf("ill-5", "end")).toBe("end");
    expect(railOf("ill-5", "start")).toBe("start");
    // The visit on 3 January sits inside the cold.
    const visit = rows.find(
      (r) =>
        r.type === "entry" &&
        r.entry.kind === "item" &&
        r.entry.item.id === "v-4",
    );
    expect(visit?.type === "entry" && visit.rails.illness).toBe("full");
  });

  it("is empty for a record without anything dated", () => {
    expect(
      buildChronicle(
        {
          lanes: [],
          notable: [],
          range: { from: "2026-01-01", to: "2026-12-31", dataFrom: null },
        },
        TODAY,
        "month",
      ),
    ).toEqual([]);
  });
});

describe("standingChips", () => {
  it("collects open things once and folds several allergies into one chip", () => {
    const chips = standingChips(fullTimeline());
    expect(chips.map((c) => c.id)).toEqual([
      "ill-chronic",
      "med-1",
      "allergies",
    ]);
    expect(chips.at(-1)).toMatchObject({ lane: "allergies", count: 2 });
  });

  it("lists a standing item without a start", () => {
    const tl = fullTimeline();
    tl.standing = [
      { lane: "illness", id: "pre", label: "Asthma", since: null, href: null },
    ];
    expect(standingChips(tl).map((c) => c.label)).toContain("Asthma");
  });
});
