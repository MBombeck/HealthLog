/**
 * v1.42 (#613) — the readiness inventory's reading order and card rule, and
 * the life-event form's checks and request bodies.
 */
import { describe, expect, it } from "vitest";

import type { LifeEventDTO } from "@/lib/day/contract";

import {
  alignToPrecision,
  createBody,
  draftFromEvent,
  emptyDraft,
  updateBody,
  validateDraft,
  withPrecision,
} from "../life-event-draft";
import {
  orderedReadinessLanes,
  readinessGaps,
  readinessTally,
  showReadinessCard,
} from "../readiness-model";
import { readiness } from "./timeline-fixture";

describe("readiness", () => {
  it("reads carrying lanes first, then thin, then empty", () => {
    expect(orderedReadinessLanes(readiness()).map((l) => l.status)).toEqual([
      "carries",
      "carries",
      "carries",
      "thin",
      "empty",
      "empty",
    ]);
  });

  it("offers one link per gap, in reading order", () => {
    expect(readinessGaps(readiness()).map((g) => g.key)).toEqual([
      "medicationsWithoutStart",
      "lifeEventsEmpty",
      "vaccinationsEmpty",
    ]);
  });

  it("counts the carrying lanes, never a score", () => {
    expect(readinessTally(readiness())).toEqual({ carrying: 3, total: 6 });
  });

  it("shows the card while a thin or empty lane has a link, until closed", () => {
    expect(showReadinessCard(readiness(), false)).toBe(true);
    expect(showReadinessCard(readiness(), true)).toBe(false);
    expect(showReadinessCard(undefined, false)).toBe(false);
    const allCarry = readiness({
      lanes: readiness().lanes.map((l) => ({
        ...l,
        status: "carries" as const,
        gaps: [],
      })),
    });
    expect(showReadinessCard(allCarry, false)).toBe(false);
  });
});

const STORED: LifeEventDTO = {
  id: "le-1",
  category: "HOME",
  startDate: "2023-09-01",
  endDate: null,
  precision: "MONTH",
  title: "Umzug",
  note: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("life-event draft", () => {
  it("asks for a title and a kind before anything is sent", () => {
    expect(validateDraft(emptyDraft("2026-10-07"))).toEqual({
      title: "titleRequired",
      category: "categoryRequired",
    });
  });

  it("refuses an end before the start and an over-long title", () => {
    const draft = {
      ...emptyDraft("2026-10-07"),
      title: "x".repeat(121),
      category: "WORK" as const,
      end: "2026-01-01",
    };
    expect(validateDraft(draft)).toEqual({
      title: "titleTooLong",
      end: "endBeforeStart",
    });
  });

  it("refuses a date that is not a calendar date", () => {
    const draft = {
      ...emptyDraft("2026-02-30"),
      title: "a",
      category: "OTHER" as const,
    };
    expect(validateDraft(draft).start).toBe("dateRequired");
  });

  it("aligns both ends when the precision changes", () => {
    expect(alignToPrecision("2023-09-17", "MONTH")).toBe("2023-09-01");
    expect(alignToPrecision("2023-09-17", "YEAR")).toBe("2023-01-01");
    const draft = withPrecision(
      { ...emptyDraft("2023-09-17"), end: "2024-02-11" },
      "MONTH",
    );
    expect([draft.start, draft.end]).toEqual(["2023-09-01", "2024-02-01"]);
  });

  it("sends a trimmed body, a blank note as null", () => {
    const body = createBody({
      ...emptyDraft("2023-09-17"),
      title: "  Umzug nach Bochum ",
      category: "HOME",
      precision: "MONTH",
      note: "   ",
    });
    expect(body).toEqual({
      category: "HOME",
      precision: "MONTH",
      startDate: "2023-09-01",
      endDate: null,
      title: "Umzug nach Bochum",
      note: null,
    });
  });

  it("patches only what changed, dates and precision together", () => {
    const draft = draftFromEvent(STORED);
    expect(updateBody(STORED, draft)).toEqual({});
    expect(
      updateBody(STORED, { ...draft, title: "Umzug nach Bochum" }),
    ).toEqual({
      title: "Umzug nach Bochum",
    });
    expect(updateBody(STORED, withPrecision(draft, "YEAR"))).toEqual({
      precision: "YEAR",
      startDate: "2023-01-01",
      endDate: null,
    });
    expect(
      updateBody({ ...STORED, note: "alt" }, { ...draft, note: "" }),
    ).toEqual({
      note: null,
    });
  });
});
