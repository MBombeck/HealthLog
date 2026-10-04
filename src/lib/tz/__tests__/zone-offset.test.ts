/**
 * The hourly offset memo must give the same wall clock as asking Intl
 * directly, for every instant, including the hours around a transition and
 * zones whose transitions do not fall on a UTC hour.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { formatInUserTz, tzOffsetMinutes, userDayKey } from "../format";
import { wallClockInTz } from "../wall-clock";
import { __resetZoneOffsetCacheForTests, zoneOffsetMs } from "../zone-offset";

const ZONES = [
  "UTC",
  "Europe/Berlin",
  "America/New_York",
  "America/St_Johns",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "Asia/Kathmandu",
  "Asia/Kolkata",
  "Africa/Casablanca",
  "America/Sao_Paulo",
];

const REFERENCE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  weekday: "short",
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// One reference formatter per zone: building a fresh Intl.DateTimeFormat for
// each of ~36k comparisons pushed the test past its timeout on CI runners.
const referenceFormatters = new Map<string, Intl.DateTimeFormat>();

function reference(date: Date, tz: string) {
  let fmt = referenceFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      ...REFERENCE_OPTIONS,
      timeZone: tz,
    });
    referenceFormatters.set(tz, fmt);
  }
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const hour = Number(get("hour")) % 24;
  const wall = {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    wall,
    offsetMinutes: Math.round((asIfUtc - date.getTime()) / 60000),
    dayKey: `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`,
    datetime: `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`,
  };
}

/** Instants every 7 min 13.5 s across two days around each 2026 transition. */
function instantsAroundTransitions(): Date[] {
  const anchors = [
    Date.UTC(2026, 2, 28), // EU spring forward (29 Mar)
    Date.UTC(2026, 9, 24), // EU fall back (25 Oct)
    Date.UTC(2026, 2, 7), // US spring forward (8 Mar)
    Date.UTC(2026, 9, 31), // US fall back (1 Nov)
    Date.UTC(2026, 3, 4), // Lord Howe / Chatham autumn (4-5 Apr)
    Date.UTC(2026, 8, 26), // Chatham spring (27 Sep)
    Date.UTC(2026, 9, 3), // Lord Howe spring (3 Oct 15:30 UTC) / Chatham (27 Sep)
  ];
  const out: Date[] = [];
  for (const anchor of anchors) {
    for (let t = anchor; t < anchor + 2 * 86_400_000; t += 433_500) {
      out.push(new Date(t));
    }
  }
  return out;
}

beforeEach(() => {
  __resetZoneOffsetCacheForTests();
});

describe("zone offset memo", () => {
  it("matches Intl for every instant around the transitions", () => {
    const instants = instantsAroundTransitions();
    for (const tz of ZONES) {
      for (const date of instants) {
        const ref = reference(date, tz);
        expect(wallClockInTz(date, tz)).toEqual(ref.wall);
        expect(tzOffsetMinutes(date, tz)).toBe(ref.offsetMinutes);
        expect(userDayKey(date, tz)).toBe(ref.dayKey);
        expect(formatInUserTz(date, tz, "datetime")).toBe(ref.datetime);
      }
    }
  }, 20_000);

  it("matches Intl on a warm memo for scattered instants across decades", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const from = Date.UTC(1972, 0, 1);
    const span = Date.UTC(2060, 0, 1) - from;
    for (let i = 0; i < 4000; i++) {
      const date = new Date(from + Math.floor(next() * span));
      const tz = ZONES[i % ZONES.length];
      // Twice: the first read fills the hour, the second reads the memo.
      for (let pass = 0; pass < 2; pass++) {
        const ref = reference(date, tz);
        expect(wallClockInTz(date, tz)).toEqual(ref.wall);
        expect(tzOffsetMinutes(date, tz)).toBe(ref.offsetMinutes);
        expect(userDayKey(date, tz)).toBe(ref.dayKey);
      }
    }
  });

  it("refuses an hour that contains a transition", () => {
    // Europe/Berlin springs forward at 01:00 UTC on 29 March 2026.
    expect(
      zoneOffsetMs(new Date(Date.UTC(2026, 2, 29, 1, 30)), "Europe/Berlin"),
    ).toBe(2 * 3_600_000);
    // Lord Howe springs forward half an hour at 15:30 UTC on 3 October:
    // the 15:00 UTC hour straddles it and stays on the formatter path,
    // on both sides of the change.
    expect(
      zoneOffsetMs(
        new Date(Date.UTC(2026, 9, 3, 15, 10)),
        "Australia/Lord_Howe",
      ),
    ).toBeNull();
    for (const minute of [10, 29, 30, 45]) {
      const at = new Date(Date.UTC(2026, 9, 3, 15, minute));
      expect(wallClockInTz(at, "Australia/Lord_Howe")).toEqual(
        reference(at, "Australia/Lord_Howe").wall,
      );
    }
  });

  it("leaves out-of-range and invalid inputs to the formatter path", () => {
    expect(
      zoneOffsetMs(new Date(Date.UTC(1950, 0, 1)), "Europe/Berlin"),
    ).toBeNull();
    expect(zoneOffsetMs(new Date(Number.NaN), "Europe/Berlin")).toBeNull();
    expect(() => wallClockInTz(new Date(), "Not/A_Zone")).toThrow(RangeError);
    // The formatter reads a missing date as "now"; the memo must not turn
    // that into a TypeError.
    const now = reference(new Date(), "Europe/Berlin").wall;
    const loose = wallClockInTz(undefined as unknown as Date, "Europe/Berlin");
    expect(loose.year).toBe(now.year);
    expect(loose.day).toBe(now.day);
  });
});
