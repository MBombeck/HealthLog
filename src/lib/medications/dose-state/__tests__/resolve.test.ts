import { describe, expect, it } from "vitest";

import { legacyDoseStatus, resolveDoseState } from "../resolve";

const at = (hm: string) => new Date(`2026-11-21T${hm}:00.000Z`);
const BAND = {
  at: at("08:00"),
  earlyStart: at("06:00"),
  onTimeStart: at("07:00"),
  onTimeEnd: at("09:00"),
  overdueEnd: at("12:00"),
};

describe("resolveDoseState", () => {
  it("walks pending, due, overdue and missed by the band, not by fixed minutes", () => {
    expect(resolveDoseState(BAND, null, at("06:30")).state).toBe("pending");
    expect(resolveDoseState(BAND, null, at("07:00")).state).toBe("due");
    expect(resolveDoseState(BAND, null, at("09:00")).state).toBe("due");
    expect(resolveDoseState(BAND, null, at("09:01")).state).toBe("overdue");
    expect(resolveDoseState(BAND, null, at("12:00")).state).toBe("overdue");
    const missed = resolveDoseState(BAND, null, at("12:01"));
    expect(missed.state).toBe("missed");
    expect(missed.lateTakeCounts).toBe(true);
  });

  it("an auto-missed row is missed whatever the clock", () => {
    expect(
      resolveDoseState(
        BAND,
        { takenAt: null, skipped: false, autoMissed: true },
        at("08:00"),
      ).state,
    ).toBe("missed");
  });

  it("an outcome wins over the clock and over the auto-miss stamp", () => {
    const late = resolveDoseState(
      BAND,
      {
        takenAt: at("10:00"),
        skipped: false,
        autoMissed: true,
        takenVia: "INTEGRATION",
      },
      at("23:00"),
    );
    expect(late).toMatchObject({
      state: "taken_late",
      takenVia: "INTEGRATION",
      lateTakeCounts: false,
    });
    expect(
      resolveDoseState(
        BAND,
        { takenAt: at("06:30"), skipped: false },
        at("23:00"),
      ).state,
    ).toBe("taken");
    expect(
      resolveDoseState(BAND, { takenAt: null, skipped: true }, at("08:00"))
        .state,
    ).toBe("skipped");
  });

  it("publishes the band's instants", () => {
    const r = resolveDoseState(BAND, null, at("08:00"));
    expect(r.slotInstant).toEqual(BAND.at);
    expect(r.dueAt).toEqual(BAND.onTimeStart);
    expect(r.overdueSince).toEqual(BAND.onTimeEnd);
    expect(r.missedAfter).toEqual(BAND.overdueEnd);
  });

  it("keeps the older wire vocabulary for currentDose.status", () => {
    expect(legacyDoseStatus("pending")).toBe("upcoming");
    expect(legacyDoseStatus("due")).toBe("on_time_window");
    expect(legacyDoseStatus("taken")).toBe("taken_on_time");
    expect(legacyDoseStatus("missed")).toBe("missed");
  });
});
