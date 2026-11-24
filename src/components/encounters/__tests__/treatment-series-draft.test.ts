import { describe, expect, it } from "vitest";

import {
  draftFromSeries,
  emptySeriesDraft,
  seriesDraftToBody,
} from "../treatment-series-draft";

describe("seriesDraftToBody", () => {
  it("saves with a title and a start day and nothing else", () => {
    const body = seriesDraftToBody({
      ...emptySeriesDraft(),
      title: "  Physiotherapy  ",
      startsOn: "2026-11-24",
    });
    expect(body).toMatchObject({
      title: "Physiotherapy",
      startsOn: "2026-11-24",
      plannedSessions: null,
      validUntil: null,
      prescriberId: null,
      performerId: null,
      episodeId: null,
      note: null,
    });
  });

  it("refuses no title, a count outside 1 to 500 and a window ending early", () => {
    const base = { ...emptySeriesDraft(), title: "x", startsOn: "2026-11-24" };
    expect(seriesDraftToBody({ ...base, title: " " })).toBeNull();
    expect(seriesDraftToBody({ ...base, plannedSessions: "0" })).toBeNull();
    expect(seriesDraftToBody({ ...base, plannedSessions: "501" })).toBeNull();
    expect(seriesDraftToBody({ ...base, validUntil: "2026-11-23" })).toBeNull();
    expect(seriesDraftToBody({ ...base, plannedSessions: "6" })).toMatchObject({
      plannedSessions: 6,
    });
  });

  it("round-trips a series read into the same body", () => {
    const draft = draftFromSeries({
      id: "s1",
      title: "Radiation",
      kind: "PROCEDURE",
      plannedSessions: 20,
      startsOn: "2026-11-01",
      validUntil: "2026-12-31",
      endedOn: null,
      status: "ACTIVE",
      sessions: { done: 3, booked: 1, cancelled: 0, remaining: 17 },
      firstSessionAt: null,
      lastSessionAt: null,
      nextSessionAt: null,
      prescriber: null,
      performer: null,
      condition: { id: "e1", label: "Condition", date: null, redacted: false },
      note: "morning slots",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(seriesDraftToBody(draft)).toEqual({
      title: "Radiation",
      kind: "PROCEDURE",
      plannedSessions: 20,
      startsOn: "2026-11-01",
      validUntil: "2026-12-31",
      prescriberId: null,
      performerId: null,
      episodeId: "e1",
      note: "morning slots",
    });
  });
});
