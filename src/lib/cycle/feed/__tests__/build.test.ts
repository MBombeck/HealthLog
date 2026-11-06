/**
 * #1350 — building a feed's body from the record's rows: the record's own
 * day, zone and language; a hash that moves only with the content; and the
 * goal and cold-start gates on the fertile window.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    cycleProfile: { findUnique: vi.fn() },
    menstrualCycle: { findMany: vi.fn() },
    cycleDayLog: { findMany: vi.fn() },
    measurement: { findMany: vi.fn() },
  },
}));

const localeSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: localeSpy,
}));

import { prisma } from "@/lib/db";
import { addDays } from "@/lib/cycle/day-math";
import { renderIcs } from "@/lib/cycle/ics";

import { buildCycleFeed, feedLocale } from "../build";
import { DISCREET_SUMMARY } from "../events";
import { FEED, SUBJECT, profileRow, regularCycles } from "./fixtures";

const db = prisma as unknown as {
  cycleProfile: { findUnique: ReturnType<typeof vi.fn> };
  menstrualCycle: { findMany: ReturnType<typeof vi.fn> };
  cycleDayLog: { findMany: ReturnType<typeof vi.fn> };
  measurement: { findMany: ReturnType<typeof vi.fn> };
};

// The last start lands on 2026-10-20, so the next period is due mid-November.
const FIRST = "2025-11-18";
const NOW = new Date("2026-11-06T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  db.cycleProfile.findUnique.mockResolvedValue(profileRow());
  db.menstrualCycle.findMany.mockResolvedValue(regularCycles(FIRST));
  db.cycleDayLog.findMany.mockResolvedValue([]);
  db.measurement.findMany.mockResolvedValue([]);
});

describe("buildCycleFeed", () => {
  it("serves the projected periods with discreet titles by default", async () => {
    const built = await buildCycleFeed(FEED, SUBJECT, NOW);
    expect(built.projectionState).toBe("OK");
    expect(built.calendar.name).toBe("HealthLog");
    expect(built.calendar.events.length).toBe(3);
    for (const e of built.calendar.events) {
      expect(e.summary).toBe(DISCREET_SUMMARY);
    }
  });

  it("hashes the same inputs on the same day to the same value", async () => {
    const a = await buildCycleFeed(FEED, SUBJECT, NOW);
    const b = await buildCycleFeed(
      FEED,
      SUBJECT,
      new Date("2026-11-06T18:00:00.000Z"),
    );
    expect(b.contentHash).toBe(a.contentHash);
    // The events keep their UIDs across rebuilds.
    expect(b.calendar.events.map((e) => e.uid)).toEqual(
      a.calendar.events.map((e) => e.uid),
    );
  });

  it("moves the hash when a cycle is deleted", async () => {
    const before = await buildCycleFeed(FEED, SUBJECT, NOW);
    db.menstrualCycle.findMany.mockResolvedValue(
      regularCycles(FIRST).slice(0, -1),
    );
    const after = await buildCycleFeed(FEED, SUBJECT, NOW);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it("moves the hash when a day roll takes the forecast past its band", async () => {
    const before = await buildCycleFeed(FEED, SUBJECT, NOW);
    const late = await buildCycleFeed(
      FEED,
      SUBJECT,
      new Date("2026-12-15T12:00:00.000Z"),
    );
    expect(late.projectionState).toBe("LATE");
    expect(late.calendar.events).toEqual([]);
    expect(late.contentHash).not.toBe(before.contentHash);
  });

  it("reads today in the record's zone, not in UTC", async () => {
    // Find the next period's band end, then ask at 23:30 UTC on that day: in
    // Berlin it is already the following day, which is past the band.
    const onTime = await buildCycleFeed(FEED, SUBJECT, NOW);
    const first = onTime.calendar.events[0];
    // DTEND is the band end plus the period length; recover the band end.
    const bandEnd = addDays(first.endExclusive, -5);
    const lateEvening = new Date(`${bandEnd}T23:30:00.000Z`);

    const utc = await buildCycleFeed(
      FEED,
      { ...SUBJECT, timezone: "UTC" },
      lateEvening,
    );
    const berlin = await buildCycleFeed(FEED, SUBJECT, lateEvening);
    expect(utc.projectionState).toBe("OK");
    expect(berlin.projectionState).toBe("LATE");
  });

  it("names nothing when the prediction is switched off, and history still works", async () => {
    db.cycleProfile.findUnique.mockResolvedValue(
      profileRow("GENERAL_HEALTH", { predictionEnabled: false }),
    );
    const off = await buildCycleFeed(
      { ...FEED, historyCycles: 3 },
      SUBJECT,
      NOW,
    );
    expect(off.projectionState).toBe("OFF");
    expect(off.calendar.events).toHaveLength(3);
    const starts = off.calendar.events.map((e) => e.start);
    expect(starts.at(-1)).toBe("2026-10-20");
  });

  it("treats raw-chart mode as no forecast", async () => {
    db.cycleProfile.findUnique.mockResolvedValue(
      profileRow("GENERAL_HEALTH", { rawChartMode: true }),
    );
    const built = await buildCycleFeed(FEED, SUBJECT, NOW);
    expect(built.projectionState).toBe("OFF");
    expect(built.calendar.events).toEqual([]);
  });

  describe("the fertile window", () => {
    it("is added for TRYING_TO_CONCEIVE when asked for", async () => {
      db.cycleProfile.findUnique.mockResolvedValue(
        profileRow("TRYING_TO_CONCEIVE"),
      );
      const built = await buildCycleFeed(
        { ...FEED, includeFertile: true, titleMode: "DESCRIPTIVE" },
        SUBJECT,
        NOW,
      );
      expect(
        built.calendar.events.filter(
          (e) => e.summary === "Fertile window (estimate)",
        ),
      ).toHaveLength(1);
    });

    it("is never added for AVOID_PREGNANCY, whatever the option says", async () => {
      db.cycleProfile.findUnique.mockResolvedValue(
        profileRow("AVOID_PREGNANCY"),
      );
      const built = await buildCycleFeed(
        { ...FEED, includeFertile: true, titleMode: "DESCRIPTIVE" },
        SUBJECT,
        NOW,
      );
      expect(built.calendar.events.map((e) => e.summary)).not.toContain(
        "Fertile window (estimate)",
      );
      expect(built.calendar.events).toHaveLength(3);
    });

    it("is withheld while the engine is still learning", async () => {
      db.cycleProfile.findUnique.mockResolvedValue(
        profileRow("TRYING_TO_CONCEIVE"),
      );
      db.menstrualCycle.findMany.mockResolvedValue(
        regularCycles("2026-09-22", 3),
      );
      const built = await buildCycleFeed(
        { ...FEED, includeFertile: true, titleMode: "DESCRIPTIVE" },
        SUBJECT,
        NOW,
      );
      expect(built.projectionState).toBe("LEARNING");
      expect(built.calendar.events.map((e) => e.summary)).toEqual([
        "Period (estimate)",
      ]);
    });
  });

  it("uses the record's stored language for descriptive titles", async () => {
    const built = await buildCycleFeed(
      { ...FEED, titleMode: "DESCRIPTIVE" },
      { ...SUBJECT, locale: "de" },
      NOW,
    );
    expect(built.calendar.name).toBe("Zyklus (HealthLog)");
    expect(built.calendar.events[0].summary).toBe("Periode (Schätzung)");
  });

  it("falls back to the instance default for a null locale and never asks the request", async () => {
    expect(feedLocale(null)).toBe("en");
    expect(feedLocale("xx")).toBe("en");
    const built = await buildCycleFeed(
      { ...FEED, titleMode: "DESCRIPTIVE" },
      { ...SUBJECT, locale: null },
      NOW,
    );
    expect(built.calendar.events[0].summary).toBe("Period (estimate)");
    // A provider's Accept-Language must never reach the choice.
    expect(localeSpy).not.toHaveBeenCalled();
  });

  it("renders the descriptive description with the likely start and the band", async () => {
    const built = await buildCycleFeed(
      { ...FEED, titleMode: "DESCRIPTIVE" },
      SUBJECT,
      NOW,
    );
    const body = renderIcs(built.calendar, NOW);
    expect(body).toMatch(
      /DESCRIPTION:Most likely start [^\\\r]+\\, ±\d+ days?\r\n/,
    );
  });
});
