/**
 * A day leaving for a model (v1.42, #613): no life event, no note, no
 * document name, and a switched-off module named as such.
 */
import { describe, expect, it } from "vitest";

import { MODEL_EXCLUDED_DAY_SECTIONS, type DayResponse } from "../contract";
import { projectDayForModel } from "../model-projection";

const day: DayResponse = {
  date: "2026-03-29",
  tz: "Europe/Berlin",
  counts: { values: 1, entries: 3 },
  running: [
    {
      kind: "lifeEvent",
      section: "lifeEvents",
      id: "le1",
      title: "Parental leave",
      sub: "FAMILY",
      since: "2026-03-01",
      until: "2026-06-30",
      dayIndex: 29,
      dayCount: 122,
      href: null,
    },
    {
      kind: "medication",
      section: "medications",
      id: "m1",
      title: "Ramipril",
      sub: "5 mg",
      since: "2026-01-01",
      until: null,
      dayIndex: 88,
      dayCount: null,
      href: "/medications/m1",
    },
  ],
  values: [
    {
      type: "WEIGHT",
      value: 80,
      unit: "kg",
      at: "2026-03-29T06:00:00.000Z",
      source: "MANUAL",
      band: null,
    },
  ],
  events: [
    {
      at: null,
      kind: "lifeEvent",
      section: "lifeEvents",
      id: "le2",
      title: "Grandmother died",
      meta: "LOSS",
      note: "private words",
      docs: [],
      href: null,
    },
    {
      at: "2026-03-29T09:00:00.000Z",
      kind: "visit",
      section: "visits",
      id: "v1",
      title: "Check-up",
      meta: "ROUTINE",
      note: "outcome text",
      docs: [{ id: "d1", name: "scan-of-letter.pdf" }],
      href: "/checkups?visit=v1",
    },
    {
      at: "2026-03-29T10:00:00.000Z",
      kind: "mood",
      section: "mood",
      id: "mo1",
      title: "GUT",
      meta: "4",
      note: "a note",
      docs: [],
      href: null,
    },
  ],
  notable: [],
  sections: { cycle: { available: false, reason: "not_shared" } },
};

describe("model projection", () => {
  const projected = projectDayForModel(day, ["environment", "lifeEvents"]);
  const text = JSON.stringify(projected);

  it("drops every model-excluded section, wherever it appears", () => {
    for (const section of MODEL_EXCLUDED_DAY_SECTIONS) {
      expect(text).not.toContain(`"${section}"`);
    }
    expect(text).not.toContain("Parental leave");
    expect(text).not.toContain("Grandmother");
    expect(projected.counts.entries).toBe(2);
  });

  it("drops notes and document names", () => {
    expect(text).not.toContain("private words");
    expect(text).not.toContain("outcome text");
    expect(text).not.toContain("a note");
    expect(text).not.toContain("scan-of-letter");
  });

  it("names a switched-off module and an unshared section", () => {
    expect(projected.unavailable).toEqual([
      { section: "environment", reason: "module_disabled" },
      { section: "cycle", reason: "not_shared" },
    ]);
  });

  it("wraps the person's own words when asked to", () => {
    const fenced = projectDayForModel(day, [], (v) => `[${v}]`);
    expect(fenced.running[0].title).toBe("[Ramipril]");
    expect(fenced.events[1].title).toBe("[GUT]");
  });
});

describe("free text that never reaches a model", () => {
  const withDocument: DayResponse = {
    ...day,
    events: [
      ...day.events,
      {
        at: null,
        kind: "document",
        section: "documents",
        id: "doc1",
        title: "Befund Dr. Example Mustermann 2026.pdf",
        meta: "LAB_REPORT",
        note: null,
        docs: [],
        href: "/documents?doc=doc1",
      },
      {
        at: "2026-03-29T11:00:00.000Z",
        kind: "procedure",
        section: "visits",
        id: "v2",
        title: "Dr. Example Mustermann",
        meta: "PROCEDURE",
        note: null,
        docs: [],
        href: "/checkups?visit=v2",
      },
    ],
  };
  const projected = projectDayForModel(withDocument, [], (v) => `[${v}]`);
  const text = JSON.stringify(projected);

  it("sends a document's kind instead of its name", () => {
    expect(text).not.toContain("Befund");
    expect(projected.events.find((e) => e.kind === "document")?.title).toBe(
      "LAB_REPORT",
    );
  });

  it("sends a visit's kind instead of its reason or practitioner", () => {
    expect(text).not.toContain("Check-up");
    expect(text).not.toContain("Mustermann");
    expect(
      projected.events
        .filter((e) => e.section === "visits")
        .map((e) => e.title),
    ).toEqual(["visit", "procedure"]);
  });
});

describe("caller exclusions", () => {
  const projected = projectDayForModel(day, [], undefined, {
    sections: new Set(["mood", "medications"]),
    types: new Set(["WEIGHT"]),
  });

  it("leaves out excluded sections and types without naming them", () => {
    const text = JSON.stringify(projected);
    expect(text).not.toContain("Ramipril");
    expect(text).not.toContain("GUT");
    expect(text).not.toContain("WEIGHT");
    expect(projected.counts).toEqual({ values: 0, entries: 1 });
    expect(projected.unavailable.map((u) => u.section)).not.toContain("mood");
  });
});
