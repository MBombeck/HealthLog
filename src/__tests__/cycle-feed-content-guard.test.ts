/**
 * #1350 — the calendar feed carries dates and a title, and nothing else.
 *
 * A calendar provider keeps everything it fetches, beyond the reach of any
 * revoke. So this seeds every kind of day-log content the record can hold —
 * a note, custom symptom labels, a basal temperature, an ovulation test, the
 * mucus and cervix signs, intercourse, contraception, a pregnancy test — as
 * recognisable sentinels on the very rows the feed reads, as if a select had
 * been widened by mistake, and asserts that no rendered body contains any of
 * them, in either title mode, with history and the fertile window on.
 *
 * Written, then broken once on purpose (a description that interpolated the
 * day's note) to prove it fails.
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

import { prisma } from "@/lib/db";
import { addDays } from "@/lib/cycle/day-math";
import { buildCycleFeed } from "@/lib/cycle/feed/build";
import { renderIcs } from "@/lib/cycle/ics";

import {
  FEED,
  SUBJECT,
  profileRow,
  regularCycles,
} from "@/lib/cycle/feed/__tests__/fixtures";

const db = prisma as unknown as {
  cycleProfile: { findUnique: ReturnType<typeof vi.fn> };
  menstrualCycle: { findMany: ReturnType<typeof vi.fn> };
  cycleDayLog: { findMany: ReturnType<typeof vi.fn> };
  measurement: { findMany: ReturnType<typeof vi.fn> };
};

const SENTINELS = {
  note: "SENTINEL-NOTE-zebra",
  noteEncrypted: "SENTINEL-CIPHER-okapi",
  symptom: "SENTINEL-SYMPTOM-quokka",
  symptomKey: "sentinel_symptom_key",
  bbt: "36.987",
  wrist: "35.4321",
  opk: "POSITIVE_LH_SURGE",
  mucus: "EGG_WHITE",
  cervix: "HIGH",
  sex: "SENTINEL-SEX-tapir",
  contraceptive: "SENTINEL-CONTRACEPTIVE-ibis",
  pregnancyTest: "SENTINEL-PREGNANCY-lynx",
  userId: "subject",
};

const FIRST = "2025-11-18";
const NOW = new Date("2026-11-06T12:00:00.000Z");

function stuffedDayLogs() {
  const cycles = regularCycles(FIRST);
  const out = [];
  for (const c of cycles) {
    for (let i = 0; i < 6; i++) {
      out.push({
        id: `log-${c.startDate}-${i}`,
        userId: SENTINELS.userId,
        date: addDays(c.startDate, i),
        flow: i < 4 ? "MEDIUM" : "NONE",
        basalBodyTempC: Number(SENTINELS.bbt),
        temperatureExcluded: false,
        ovulationTest: SENTINELS.opk,
        cervicalMucus: SENTINELS.mucus,
        cervixPosition: SENTINELS.cervix,
        cervixFirmness: null,
        cervixOpening: null,
        intermenstrualBleeding: true,
        sexualActivity: SENTINELS.sex,
        protectedSex: false,
        pregnancyTest: SENTINELS.pregnancyTest,
        progesteroneTest: SENTINELS.pregnancyTest,
        contraceptive: SENTINELS.contraceptive,
        notes: SENTINELS.note,
        notesEncrypted: SENTINELS.noteEncrypted,
        sensitiveEncrypted: SENTINELS.noteEncrypted,
        symptomLinks: [
          {
            symptom: {
              key: SENTINELS.symptomKey,
              label: SENTINELS.symptom,
            },
          },
        ],
        _count: { symptomLinks: 1 },
      });
    }
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.cycleProfile.findUnique.mockResolvedValue(
    profileRow("TRYING_TO_CONCEIVE"),
  );
  db.menstrualCycle.findMany.mockResolvedValue(regularCycles(FIRST));
  db.cycleDayLog.findMany.mockResolvedValue(stuffedDayLogs());
  db.measurement.findMany.mockResolvedValue([
    {
      measuredAt: new Date("2026-11-01T03:00:00Z"),
      value: Number(SENTINELS.wrist),
    },
  ]);
});

describe("the calendar feed body", () => {
  it.each(["DISCREET", "DESCRIPTIVE"] as const)(
    "carries no day-log content in %s mode",
    async (titleMode) => {
      const built = await buildCycleFeed(
        {
          ...FEED,
          titleMode,
          historyCycles: 12,
          horizonCycles: 6,
          includeFertile: true,
        },
        SUBJECT,
        NOW,
      );
      // Non-empty, or the assertion below would hold for nothing.
      expect(built.calendar.events.length).toBeGreaterThan(10);
      const body = renderIcs(built.calendar, NOW);
      for (const [name, value] of Object.entries(SENTINELS)) {
        expect(body, `${name} leaked into the feed`).not.toContain(value);
      }
    },
  );

  it("carries only the properties an all-day date event needs", async () => {
    const built = await buildCycleFeed(
      {
        ...FEED,
        titleMode: "DESCRIPTIVE",
        historyCycles: 6,
        includeFertile: true,
      },
      SUBJECT,
      NOW,
    );
    const body = renderIcs(built.calendar, NOW);
    const properties = new Set(
      body
        .split("\r\n")
        .filter((line) => line && !line.startsWith(" "))
        .map((line) => line.split(/[:;]/)[0]),
    );
    expect([...properties].sort()).toEqual(
      [
        "BEGIN",
        "CALSCALE",
        "CLASS",
        "DESCRIPTION",
        "DTEND",
        "DTSTAMP",
        "DTSTART",
        "END",
        "LAST-MODIFIED",
        "METHOD",
        "PRODID",
        "REFRESH-INTERVAL",
        "SUMMARY",
        "TRANSP",
        "UID",
        "VERSION",
        "X-PUBLISHED-TTL",
        "X-WR-CALNAME",
      ].sort(),
    );
  });
});
