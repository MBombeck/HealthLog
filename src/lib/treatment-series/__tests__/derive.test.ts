import { describe, expect, it } from "vitest";

import {
  deriveSeriesStatus,
  sessionNumbers,
  summarizeSessions,
  type SeriesSessionFact,
} from "../derive";

const NOW = new Date("2026-11-24T10:00:00.000Z");
const at = (iso: string) => new Date(iso);

const sessions: SeriesSessionFact[] = [
  { id: "a", occurredAt: at("2026-11-10T08:00:00Z"), status: "DONE" },
  { id: "b", occurredAt: at("2026-11-12T08:00:00Z"), status: "CANCELLED" },
  { id: "c", occurredAt: at("2026-11-14T08:00:00Z"), status: "DONE" },
  { id: "d", occurredAt: at("2026-11-16T08:00:00Z"), status: "NO_SHOW" },
  { id: "e", occurredAt: at("2026-11-26T08:00:00Z"), status: "PLANNED" },
  { id: "f", occurredAt: at("2026-11-28T08:00:00Z"), status: "PLANNED" },
];

describe("summarizeSessions", () => {
  it("counts what took place, what is booked and what used up nothing", () => {
    const s = summarizeSessions(sessions, NOW);
    expect(s).toEqual({
      done: 2,
      booked: 2,
      cancelled: 2,
      firstSessionAt: at("2026-11-10T08:00:00Z"),
      lastSessionAt: at("2026-11-14T08:00:00Z"),
      nextSessionAt: at("2026-11-26T08:00:00Z"),
    });
  });

  it("does not count a booked session whose time has passed as ahead", () => {
    const s = summarizeSessions(
      [{ id: "x", occurredAt: at("2026-11-20T08:00:00Z"), status: "PLANNED" }],
      NOW,
    );
    expect(s.booked).toBe(0);
    expect(s.nextSessionAt).toBeNull();
  });
});

describe("deriveSeriesStatus", () => {
  const open = { plannedSessions: 6, validUntil: null, endedOn: null };
  it("is planned until a session took place, then active", () => {
    expect(deriveSeriesStatus(open, 0, "2026-11-24")).toBe("PLANNED");
    expect(deriveSeriesStatus(open, 1, "2026-11-24")).toBe("ACTIVE");
  });
  it("completes once every planned session took place", () => {
    expect(deriveSeriesStatus(open, 6, "2026-11-24")).toBe("COMPLETED");
  });
  it("expires after its last valid day with sessions left, not on it", () => {
    const valid = { ...open, validUntil: "2026-11-24" };
    expect(deriveSeriesStatus(valid, 2, "2026-11-24")).toBe("ACTIVE");
    expect(deriveSeriesStatus(valid, 2, "2026-11-25")).toBe("EXPIRED");
  });
  it("is completed once ended, even with sessions left or expired", () => {
    const ended = { ...open, validUntil: "2026-11-01", endedOn: "2026-10-30" };
    expect(deriveSeriesStatus(ended, 2, "2026-11-24")).toBe("COMPLETED");
  });
  it("keeps an end set for a later day out of it until then", () => {
    const later = { ...open, endedOn: "2026-12-01" };
    expect(deriveSeriesStatus(later, 2, "2026-11-24")).toBe("ACTIVE");
  });
  it("never completes an open-ended series by count", () => {
    const unbounded = {
      plannedSessions: null,
      validUntil: null,
      endedOn: null,
    };
    expect(deriveSeriesStatus(unbounded, 40, "2026-11-24")).toBe("ACTIVE");
  });
});

describe("sessionNumbers", () => {
  it("numbers taken and booked sessions in time order and skips the rest", () => {
    expect(Object.fromEntries(sessionNumbers(sessions))).toEqual({
      a: 1,
      c: 2,
      e: 3,
      f: 4,
    });
  });
  it("breaks a tie on the instant by id, so the numbering is stable", () => {
    const tie = at("2026-11-10T08:00:00Z");
    const numbers = sessionNumbers([
      { id: "z", occurredAt: tie, status: "DONE" },
      { id: "m", occurredAt: tie, status: "DONE" },
    ]);
    expect([numbers.get("m"), numbers.get("z")]).toEqual([1, 2]);
  });
});
