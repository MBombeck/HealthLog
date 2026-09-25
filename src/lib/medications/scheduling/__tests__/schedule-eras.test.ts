/**
 * v1.16.3 — schedule-era segmentation (effective dating).
 *
 * Pins the era-split engine: a schedule replace archives the old state as a
 * revision, and every historical surface mints past days against the
 * schedule that was live THEN. Covers the boundary rule (anchor decides era,
 * tails uncut), DST across an era boundary, a rolling-cadence era, the
 * zero-revision pass-through, the write-attribution era pick, and the
 * material-change gate the write path uses.
 */
import { describe, expect, it } from "vitest";

import {
  attributeTakenToSlot,
  type AttributeIntakeMedication,
} from "@/lib/medications/scheduling/attribute-intake";
import { buildBandsForSchedules } from "@/lib/medications/scheduling/band-minter";
import { reconstructDoseHistory } from "@/lib/medications/scheduling/dose-history";
import type {
  CanonicalSchedule,
  RecurrenceContext,
} from "@/lib/medications/scheduling/recurrence";
import {
  buildBandsForSchedulesWithEras,
  canonicalSchedulesFromRevision,
  schedulesMateriallyDiffer,
  segmentRangeIntoEras,
  toRevisionPayloadEntry,
  type ScheduleRevisionEntry,
  type ScheduleRevisionLike,
} from "@/lib/medications/scheduling/schedule-eras";

const TZ = "Europe/Berlin";

function canonical(partial: Partial<CanonicalSchedule>): CanonicalSchedule {
  return {
    id: "live-1",
    rrule: "FREQ=DAILY",
    rollingIntervalDays: null,
    timesOfDay: [],
    daysOfWeek: null,
    windowStart: "08:00",
    windowEnd: "08:00",
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    doseWindows: null,
    ...partial,
  };
}

function entry(partial: Partial<ScheduleRevisionEntry>): ScheduleRevisionEntry {
  return {
    timesOfDay: ["07:00", "19:00"],
    windowStart: "07:00",
    windowEnd: "19:00",
    daysOfWeek: null,
    rrule: "FREQ=DAILY",
    rollingIntervalDays: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    doseWindows: null,
    label: null,
    dose: null,
    reminderGraceMinutes: null,
    ...partial,
  };
}

const createdAt = new Date("2026-05-01T08:00:00.000Z");
// The replace happened on 31 May at 10:00 UTC (12:00 Berlin).
const replaceAt = new Date("2026-05-31T10:00:00.000Z");

const medication = {
  id: "med-1",
  startsOn: null,
  endsOn: null,
  oneShot: false,
  createdAt,
};

const ctx: RecurrenceContext = {
  medication,
  timeZone: TZ,
  lastIntakeAt: null,
};

const oldEraRevision: ScheduleRevisionLike = {
  id: "rev-1",
  validFrom: createdAt,
  validUntil: replaceAt,
  payload: [entry({})],
};

const liveSchedule = canonical({
  timesOfDay: ["09:00", "21:00"],
  windowStart: "09:00",
  windowEnd: "21:00",
});

describe("segmentRangeIntoEras", () => {
  it("returns a single live era when no revisions exist", () => {
    const range = {
      from: new Date("2026-05-10T00:00:00.000Z"),
      to: new Date("2026-06-10T00:00:00.000Z"),
    };
    const eras = segmentRangeIntoEras(range, [], [liveSchedule]);
    expect(eras).toHaveLength(1);
    expect(eras[0].live).toBe(true);
    expect(eras[0].from).toEqual(range.from);
    expect(eras[0].to).toEqual(range.to);
  });

  it("splits the range at validUntil with the revision schedules first", () => {
    const range = {
      from: new Date("2026-05-10T00:00:00.000Z"),
      to: new Date("2026-06-10T00:00:00.000Z"),
    };
    const eras = segmentRangeIntoEras(range, [oldEraRevision], [liveSchedule]);
    expect(eras).toHaveLength(2);
    expect(eras[0].live).toBe(false);
    expect(eras[0].schedules[0].timesOfDay).toEqual(["07:00", "19:00"]);
    // Anchor-boundary rule: the archived era ends 1 ms short of validUntil.
    expect(eras[0].to.getTime()).toBe(replaceAt.getTime() - 1);
    expect(eras[1].live).toBe(true);
    expect(eras[1].from).toEqual(replaceAt);
  });

  it("drops a revision era that does not intersect the range", () => {
    const range = {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-10T00:00:00.000Z"),
    };
    const eras = segmentRangeIntoEras(range, [oldEraRevision], [liveSchedule]);
    expect(eras).toHaveLength(1);
    expect(eras[0].live).toBe(true);
  });

  it("skips a superseded revision — only its correction mints an era", () => {
    const range = {
      from: new Date("2026-05-10T00:00:00.000Z"),
      to: new Date("2026-06-10T00:00:00.000Z"),
    };
    // The recorded archive was corrected: the original points at the
    // MANUAL correction and must no longer mint.
    const superseded: ScheduleRevisionLike = {
      ...oldEraRevision,
      supersededByRevisionId: "rev-fix",
    };
    const correction: ScheduleRevisionLike = {
      id: "rev-fix",
      validFrom: createdAt,
      validUntil: replaceAt,
      payload: [
        entry({
          timesOfDay: ["06:00"],
          windowStart: "06:00",
          windowEnd: "06:00",
        }),
      ],
      supersededByRevisionId: null,
    };
    const eras = segmentRangeIntoEras(
      range,
      [superseded, correction],
      [liveSchedule],
    );
    expect(eras).toHaveLength(2);
    expect(eras[0].live).toBe(false);
    expect(eras[0].schedules[0].timesOfDay).toEqual(["06:00"]);
    expect(eras[1].live).toBe(true);
  });

  it("falls back to a single live era when every revision is superseded", () => {
    const range = {
      from: new Date("2026-05-10T00:00:00.000Z"),
      to: new Date("2026-06-10T00:00:00.000Z"),
    };
    const superseded: ScheduleRevisionLike = {
      ...oldEraRevision,
      supersededByRevisionId: "rev-gone",
    };
    const eras = segmentRangeIntoEras(range, [superseded], [liveSchedule]);
    expect(eras).toHaveLength(1);
    expect(eras[0].live).toBe(true);
    expect(eras[0].from).toEqual(range.from);
  });
});

describe("segmentRangeIntoEras — before the first revision (#1028)", () => {
  it("covers the stretch before the medication's creation with the first era", () => {
    // A slot before the creation must still mint so a dose recorded on it
    // meets its slot; without a revision it mints against the live rows,
    // with one it mints against the schedule that was live first.
    const range = {
      from: new Date("2026-04-30T00:00:00.000Z"),
      to: new Date("2026-06-10T00:00:00.000Z"),
    };
    const eras = segmentRangeIntoEras(range, [oldEraRevision], [liveSchedule]);
    expect(eras).toHaveLength(2);
    expect(eras[0].live).toBe(false);
    expect(eras[0].from).toEqual(range.from);
    expect(eras[0].schedules[0].timesOfDay).toEqual(["07:00", "19:00"]);
    expect(eras[1].from).toEqual(replaceAt);
  });
});

describe("buildBandsForSchedulesWithEras", () => {
  const range = {
    from: new Date("2026-05-20T00:00:00.000Z"),
    to: new Date("2026-06-05T00:00:00.000Z"),
  };

  function mintedBands() {
    const groups = buildBandsForSchedulesWithEras({
      medication,
      schedules: [liveSchedule],
      revisions: [oldEraRevision],
      ctx,
      userTz: TZ,
      range,
      now: range.to,
    });
    return groups.flatMap((g) => (g.hasExpectedSlots ? g.bands : []));
  }

  it("mints 07:00/19:00 before the boundary and 09:00/21:00 after", () => {
    const bands = mintedBands();
    const before = bands.filter((b) => b.at.getTime() < replaceAt.getTime());
    const after = bands.filter((b) => b.at.getTime() >= replaceAt.getTime());
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    expect(new Set(before.map((b) => b.timeOfDay))).toEqual(
      new Set(["07:00", "19:00"]),
    );
    expect(new Set(after.map((b) => b.timeOfDay))).toEqual(
      new Set(["09:00", "21:00"]),
    );
    // The new times must not exist before the boundary at all.
    expect(
      before.some((b) => b.timeOfDay === "09:00" || b.timeOfDay === "21:00"),
    ).toBe(false);
  });

  it("is a pass-through with zero revisions", () => {
    const direct = buildBandsForSchedules({
      medication,
      schedules: [liveSchedule],
      ctx,
      userTz: TZ,
      range,
      now: range.to,
    });
    const viaEras = buildBandsForSchedulesWithEras({
      medication,
      schedules: [liveSchedule],
      revisions: [],
      ctx,
      userTz: TZ,
      range,
      now: range.to,
    });
    expect(viaEras).toEqual(direct);
  });

  it("binds an old-era take on-time to the old 07:00 slot and keeps history compliance positive", () => {
    const bands = mintedBands();
    // A take at 07:05 Berlin (05:05 UTC) on 25 May — inside the old era.
    const takenAt = new Date("2026-05-25T05:05:00.000Z");
    const rows = reconstructDoseHistory(
      bands,
      [{ scheduledFor: takenAt, takenAt, skipped: false }],
      range.to,
      null,
    );
    const takenRows = rows.filter((r) => r.status === "taken_on_time");
    expect(takenRows).toHaveLength(1);
    expect(takenRows[0].timeOfDay).toBe("07:00");
    const taken = rows.filter(
      (r) => r.status === "taken_on_time" || r.status === "taken_late",
    ).length;
    expect(taken).toBeGreaterThan(0);
  });

  it("keeps local slot times correct across a DST transition inside an era", () => {
    // Berlin springs forward on 2026-03-29. Old era covers the transition.
    const dstCreated = new Date("2026-03-20T08:00:00.000Z");
    const dstReplace = new Date("2026-04-02T10:00:00.000Z");
    const dstMed = { ...medication, createdAt: dstCreated };
    const dstCtx: RecurrenceContext = { ...ctx, medication: dstMed };
    const groups = buildBandsForSchedulesWithEras({
      medication: dstMed,
      schedules: [liveSchedule],
      revisions: [
        {
          id: "rev-dst",
          validFrom: dstCreated,
          validUntil: dstReplace,
          payload: [
            entry({
              timesOfDay: ["07:00"],
              windowStart: "07:00",
              windowEnd: "07:00",
            }),
          ],
        },
      ],
      ctx: dstCtx,
      userTz: TZ,
      range: {
        from: new Date("2026-03-25T00:00:00.000Z"),
        to: new Date("2026-04-05T00:00:00.000Z"),
      },
      now: new Date("2026-04-05T00:00:00.000Z"),
    });
    const bands = groups.flatMap((g) => (g.hasExpectedSlots ? g.bands : []));
    // 07:00 Berlin is 06:00 UTC before the transition, 05:00 UTC after.
    const mar28 = bands.find((b) =>
      b.at.toISOString().startsWith("2026-03-28"),
    );
    const mar30 = bands.find((b) =>
      b.at.toISOString().startsWith("2026-03-30"),
    );
    expect(mar28?.at.toISOString()).toBe("2026-03-28T06:00:00.000Z");
    expect(mar30?.at.toISOString()).toBe("2026-03-30T05:00:00.000Z");
    // After the replace the live 09:00/21:00 schedule mints (09:00 = 07:00Z).
    const apr03 = bands.filter((b) =>
      b.at.toISOString().startsWith("2026-04-03"),
    );
    expect(apr03.map((b) => b.timeOfDay).sort()).toEqual(["09:00", "21:00"]);
  });

  it("mints a rolling era from the archived rolling schedule", () => {
    // Old era: weekly rolling injection. Live: daily oral.
    const rollingRevision: ScheduleRevisionLike = {
      id: "rev-roll",
      validFrom: createdAt,
      validUntil: replaceAt,
      payload: [
        entry({
          timesOfDay: ["08:00"],
          windowStart: "08:00",
          windowEnd: "08:00",
          rrule: null,
          rollingIntervalDays: 7,
        }),
      ],
    };
    const intakeInstants = [
      new Date("2026-05-05T06:00:00.000Z"),
      new Date("2026-05-12T06:10:00.000Z"),
      new Date("2026-05-19T05:55:00.000Z"),
    ];
    const groups = buildBandsForSchedulesWithEras({
      medication,
      schedules: [liveSchedule],
      revisions: [rollingRevision],
      ctx,
      userTz: TZ,
      range: {
        from: new Date("2026-05-01T00:00:00.000Z"),
        to: new Date("2026-06-05T00:00:00.000Z"),
      },
      now: new Date("2026-06-05T00:00:00.000Z"),
      intakeInstants,
    });
    const rollingGroup = groups.find((g) =>
      g.scheduleId.startsWith("rev:rev-roll"),
    );
    expect(rollingGroup?.family).toBe("weekly");
    // Each logged intake anchors one band inside the old era.
    expect(rollingGroup?.bands.length).toBeGreaterThanOrEqual(3);
    expect(
      rollingGroup?.bands.every((b) => b.at.getTime() < replaceAt.getTime()),
    ).toBe(true);
  });
});

describe("write-attribution era pick", () => {
  it("attributes an old takenAt against the era live at that instant", () => {
    const med: AttributeIntakeMedication = {
      id: "med-1",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt,
      schedules: [
        {
          id: "live-1",
          windowStart: "09:00",
          windowEnd: "21:00",
          daysOfWeek: null,
          timesOfDay: ["09:00", "21:00"],
          reminderGraceMinutes: null,
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
          scheduleType: "SCHEDULED",
          cyclicOnWeeks: null,
          cyclicOffWeeks: null,
          doseWindows: null,
        },
      ],
      scheduleRevisions: [oldEraRevision],
    };
    // Editing a take back to 25 May 07:10 Berlin (05:10 UTC) — old era.
    const takenAt = new Date("2026-05-25T05:10:00.000Z");
    const result = attributeTakenToSlot({
      medication: med,
      userTz: TZ,
      takenAt,
      now: new Date("2026-06-05T00:00:00.000Z"),
    });
    expect(result.slotInstant?.toISOString()).toBe("2026-05-25T05:00:00.000Z");
    expect(result.status).toBe("on_time");
    // The same instant against the live-only schedules would NOT be a
    // 07:00-slot match — the revision is what fixes the attribution.
    const liveOnly = attributeTakenToSlot({
      medication: { ...med, scheduleRevisions: [] },
      userTz: TZ,
      takenAt,
      now: new Date("2026-06-05T00:00:00.000Z"),
    });
    expect(liveOnly.slotInstant?.toISOString()).not.toBe(
      "2026-05-25T05:00:00.000Z",
    );
  });
});

describe("canonicalSchedulesFromRevision", () => {
  it("rebuilds canonical schedules with synthetic ids and tolerates malformed payloads", () => {
    const schedules = canonicalSchedulesFromRevision(oldEraRevision);
    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).toBe("rev:rev-1:0");
    expect(schedules[0].timesOfDay).toEqual(["07:00", "19:00"]);
    expect(
      canonicalSchedulesFromRevision({ ...oldEraRevision, payload: "garbage" }),
    ).toEqual([]);
    expect(
      canonicalSchedulesFromRevision({ ...oldEraRevision, payload: [null] }),
    ).toHaveLength(1);
  });
});

describe("schedulesMateriallyDiffer", () => {
  it("ignores label/dose changes and row order", () => {
    const a = [entry({ label: "Morgens" }), entry({ timesOfDay: ["12:00"] })];
    const b = [
      entry({ timesOfDay: ["12:00"], dose: "2" }),
      entry({ label: "Abends" }),
    ];
    expect(schedulesMateriallyDiffer(a, b)).toBe(false);
  });

  it("ignores timesOfDay ordering", () => {
    expect(
      schedulesMateriallyDiffer(
        [entry({ timesOfDay: ["19:00", "07:00"] })],
        [entry({ timesOfDay: ["07:00", "19:00"] })],
      ),
    ).toBe(false);
  });

  it("flags a times change, a count change, and a doseWindows change", () => {
    expect(
      schedulesMateriallyDiffer(
        [entry({})],
        [entry({ timesOfDay: ["09:00", "21:00"] })],
      ),
    ).toBe(true);
    expect(schedulesMateriallyDiffer([entry({})], [entry({}), entry({})])).toBe(
      true,
    );
    expect(
      schedulesMateriallyDiffer(
        [entry({})],
        [
          entry({
            doseWindows: [{ timeOfDay: "07:00", start: "06:30", end: "08:30" }],
          }),
        ],
      ),
    ).toBe(true);
  });

  it("round-trips through toRevisionPayloadEntry", () => {
    const row = {
      timesOfDay: ["07:00", "19:00"],
      windowStart: "07:00",
      windowEnd: "19:00",
      daysOfWeek: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      scheduleType: "SCHEDULED" as const,
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
      doseWindows: null,
      label: "Alt",
      dose: null,
      reminderGraceMinutes: null,
    };
    expect(
      schedulesMateriallyDiffer([toRevisionPayloadEntry(row)], [entry({})]),
    ).toBe(false);
  });
});
