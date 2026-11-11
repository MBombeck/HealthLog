/**
 * A vaccination and an allergy onset carry a date, not a time of day: a dose
 * is stored at UTC midnight on its date, an onset typed in the form at noon
 * UTC. The day view, the day index and the timeline used to read both as
 * instants in the person's zone, so west of UTC a dose sat on the previous
 * day, and the day view printed a clock time nobody entered ("01:00" for a
 * dose in Berlin).
 *
 * The rows below are filtered by the window each reader asks for, so the
 * assertions read which day a row lands on, not how the query is spelled.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { tables } = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
}));

function inWindow(value: unknown, window: unknown): boolean {
  if (window === undefined) return true;
  if (!(value instanceof Date)) return false;
  const { gte, lt } = window as { gte?: Date; lt?: Date };
  return (!gte || value >= gte) && (!lt || value < lt);
}

vi.mock("@/lib/db", () => {
  const model = (name: string) => ({
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      return (tables[name] ?? []).filter(
        (row) =>
          inWindow(row.occurredAt, where.occurredAt) &&
          inWindow(row.onsetAt, where.onsetAt),
      );
    },
  });
  return {
    prisma: new Proxy({} as Record<string, unknown>, {
      get: (_target, name: string) => model(name),
    }),
  };
});

vi.mock("@/lib/day/daily-stats", () => ({
  readLocalDaysWithReadings: async () => [],
}));
vi.mock("@/lib/day/notable", () => ({ loadNotableRange: async () => [] }));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: async () => null,
}));

import { RECORD_SECTION_READERS, type DayFrame } from "@/lib/day/records";
import { loadDayIndex } from "@/lib/day/day-index";
import { loadSinceLastVisit } from "@/lib/day/visit-preparation";
import type { DaySectionKey } from "@/lib/day/contract";
import type { DayAccess } from "@/lib/day/sections";
import { LANE_READERS, type TimelineAccess } from "@/lib/timeline/lanes";
import { MODULE_KEYS } from "@/lib/modules/gate";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import { shiftDateKey } from "@/lib/tz/format";

const TZ = "America/New_York";

function frame(day: string): DayFrame {
  return {
    userId: "u1",
    day,
    tz: TZ,
    dayStart: startOfLocalDayKey(day, TZ),
    dayEnd: startOfLocalDayKey(shiftDateKey(day, 1), TZ),
    documentsReadable: false,
  };
}

beforeEach(() => {
  tables.vaccinationRecord = [
    {
      id: "dose-1",
      occurredAt: new Date("2026-11-11T00:00:00.000Z"),
      vaccineName: "Influenza",
      antigenSlug: null,
      doseNumber: null,
      noteEncrypted: null,
      customVaccine: null,
    },
  ];
  tables.allergy = [
    {
      id: "allergy-1",
      substance: "Penicillin",
      onsetAt: new Date("2026-11-11T12:00:00.000Z"),
      severity: null,
      status: "ACTIVE",
    },
  ];
});

describe("the day view", () => {
  it("files a dose and an allergy onset under their own date west of UTC", async () => {
    const dose = await RECORD_SECTION_READERS.vaccinations!(
      frame("2026-11-11"),
    );
    const onset = await RECORD_SECTION_READERS.allergies!(frame("2026-11-11"));
    expect(dose.events.map((e) => e.id)).toEqual(["dose-1"]);
    expect(onset.events.map((e) => e.id)).toEqual(["allergy-1"]);

    const before = await RECORD_SECTION_READERS.vaccinations!(
      frame("2026-11-10"),
    );
    expect(before.events).toEqual([]);
  });

  it("gives neither a clock time", async () => {
    const dose = await RECORD_SECTION_READERS.vaccinations!(
      frame("2026-11-11"),
    );
    const onset = await RECORD_SECTION_READERS.allergies!(frame("2026-11-11"));
    expect(dose.events[0].at).toBeNull();
    expect(onset.events[0].at).toBeNull();
  });
});

describe("the day index", () => {
  it("marks the date itself, not the evening before", async () => {
    const access = {
      readable: new Set<DaySectionKey>(["vaccinations", "allergies"]),
      notShared: [],
      modules: {},
      moduleOff: [],
    } as unknown as DayAccess;
    const index = await loadDayIndex({
      recordId: "u1",
      from: "2026-11-01",
      to: "2026-11-30",
      access,
      tz: TZ,
    });
    expect(index.days).toEqual({
      "2026-11-11": ["allergies", "vaccinations"],
    });
  });
});

describe("the visit preparation", () => {
  it("lists a dose under its own date", async () => {
    const window = await loadSinceLastVisit({
      recordId: "u1",
      access: {
        readable: new Set<DaySectionKey>(["vaccinations"]),
        notShared: [],
        modules: {},
        moduleOff: [],
      } as unknown as DayAccess,
      tz: TZ,
      today: "2026-11-30",
      from: "2026-11-11",
      to: "2026-11-30",
    });
    expect(window.changes.map((c) => [c.date, c.kind])).toEqual([
      ["2026-11-11", "vaccination"],
    ]);
  });
});

describe("the timeline", () => {
  it("starts a dose and an allergy on their own date", async () => {
    const laneFrame = {
      userId: "u1",
      tz: TZ,
      access: {
        modules: Object.fromEntries(
          MODULE_KEYS.map((key) => [key, true]),
        ) as TimelineAccess["modules"],
        domainVisible: () => true,
        owner: true,
      },
    };
    const doses = await LANE_READERS.vaccinations(laneFrame);
    const allergies = await LANE_READERS.allergies(laneFrame);
    expect(doses.items[0].start).toBe("2026-11-11");
    expect(allergies.items[0].start).toBe("2026-11-11");
  });
});
