/**
 * v1.42.2 — the auto-mark-taken pass.
 *
 * Pins:
 *   * which slots are due, across cadences (daily, several times a day,
 *     legacy weekdays, every-other-week RRULE, rolling, cyclic), honouring
 *     start / end dates and pause eras, and across the Europe/Berlin DST
 *     changes (the wall-clock time stays, the UTC instant moves);
 *   * the floor: never a slot before the option was switched on, before the
 *     medication existed, or beyond the catch-up window;
 *   * the precedence on one slot: a take / skip / auto-miss / removal by the
 *     person always wins, a take logged near the slot claims it, a pending
 *     placeholder is converted in place, otherwise a row is created;
 *   * the pass end to end over a fake client: one row per slot, a second
 *     pass records nothing, a hand-skipped slot is left alone, the follow-up
 *     hooks run once per recorded dose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/medications/inventory/consumption", () => ({
  consumeForIntake: vi.fn(async () => undefined),
}));
vi.mock("@/lib/medications/dose-day-refresh", () => ({
  refreshDoseSlot: vi.fn(async () => undefined),
  dayKeyForScheduledFor: (at: Date, tz: string) =>
    at.toLocaleDateString("sv-SE", { timeZone: tz }),
}));
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/medications/lifecycle", () => ({
  reconcileOneShotState: vi.fn(async () => "noop"),
}));

import { consumeForIntake } from "@/lib/medications/inventory/consumption";
import { refreshDoseSlot } from "@/lib/medications/dose-day-refresh";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import {
  INTAKE_AUTO_TAKE_LOOKBACK_MS,
  autoTakeFloor,
  decideSlot,
  dueAutoTakeSlots,
  isInPauseEra,
  runIntakeAutoTakePass,
} from "../intake-auto-take";
import {
  INTAKE_AUTO_TAKE_CRON,
  INTAKE_AUTO_TAKE_QUEUE,
} from "../intake-auto-take-queue";
import { autoTakeOwnedFrom } from "../intake-auto-skip";
import { autoTakeRollingAnchor } from "@/lib/medications/auto-take";
import { computeDisplayDue } from "@/lib/medications/scheduling/next-due";

const TZ = "Europe/Berlin";

interface ScheduleInput {
  id?: string;
  timesOfDay?: string[];
  rrule?: string | null;
  daysOfWeek?: string | null;
  rollingIntervalDays?: number | null;
  scheduleType?: "SCHEDULED" | "PRN" | "CYCLIC";
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
}

function schedule(input: ScheduleInput = {}) {
  const times = input.timesOfDay ?? ["19:00"];
  return {
    id: input.id ?? "s1",
    windowStart: times[0],
    windowEnd: times[0],
    daysOfWeek: input.daysOfWeek ?? null,
    timesOfDay: times,
    reminderGraceMinutes: null,
    rrule:
      input.rrule === undefined
        ? input.rollingIntervalDays
          ? null
          : "FREQ=DAILY"
        : input.rrule,
    rollingIntervalDays: input.rollingIntervalDays ?? null,
    scheduleType: input.scheduleType ?? "SCHEDULED",
    cyclicOnWeeks: input.cyclicOnWeeks ?? null,
    cyclicOffWeeks: input.cyclicOffWeeks ?? null,
    doseWindows: null,
  };
}

function medication(
  overrides: Partial<{
    id: string;
    userId: string;
    startsOn: Date | null;
    endsOn: Date | null;
    oneShot: boolean;
    createdAt: Date;
    autoMarkTakenSince: Date | null;
    schedules: ReturnType<typeof schedule>[];
    pauseEras: { pausedAt: Date; resumedAt: Date | null }[];
  }> = {},
) {
  return {
    id: overrides.id ?? "m1",
    userId: overrides.userId ?? "u1",
    startsOn: overrides.startsOn ?? null,
    endsOn: overrides.endsOn ?? null,
    endedAt: null,
    oneShot: overrides.oneShot ?? false,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    autoMarkTakenSince:
      overrides.autoMarkTakenSince === undefined
        ? new Date("2026-01-01T00:00:00Z")
        : overrides.autoMarkTakenSince,
    schedules: overrides.schedules ?? [schedule()],
    scheduleRevisions: [],
    pauseEras: overrides.pauseEras ?? [],
    user: { timezone: TZ },
  };
}

function slotsIso(
  med: ReturnType<typeof medication>,
  from: string,
  to: string,
  lastIntakeAt: Date | null = null,
): string[] {
  return dueAutoTakeSlots({
    medication: med,
    userTz: TZ,
    floor: new Date(from),
    now: new Date(to),
    lastIntakeAt,
  }).map((o) => o.at.toISOString());
}

describe("intake-auto-take — contract", () => {
  it("runs on its own queue, every 15 minutes off the other passes", () => {
    expect(INTAKE_AUTO_TAKE_QUEUE).toBe("intake-auto-take");
    expect(INTAKE_AUTO_TAKE_CRON).toBe("10,25,40,55 * * * *");
  });
});

describe("dueAutoTakeSlots — cadences", () => {
  it("daily 19:00: one slot per evening whose time has passed", () => {
    // 2026-06-10 is CEST (UTC+2): 19:00 local = 17:00Z.
    expect(
      slotsIso(medication(), "2026-06-08T00:00:00Z", "2026-06-10T16:59:00Z"),
    ).toEqual(["2026-06-08T17:00:00.000Z", "2026-06-09T17:00:00.000Z"]);
    expect(
      slotsIso(medication(), "2026-06-08T00:00:00Z", "2026-06-10T17:00:00Z"),
    ).toContain("2026-06-10T17:00:00.000Z");
  });

  it("several times a day: each time is its own slot", () => {
    const med = medication({
      schedules: [schedule({ timesOfDay: ["08:00", "13:00", "19:00"] })],
    });
    expect(
      slotsIso(med, "2026-06-10T00:00:00Z", "2026-06-10T12:00:00Z"),
    ).toEqual(["2026-06-10T06:00:00.000Z", "2026-06-10T11:00:00.000Z"]);
  });

  it("legacy weekdays (Mon/Wed/Fri) skip the other days", () => {
    const med = medication({
      schedules: [schedule({ rrule: null, daysOfWeek: "1,3,5" })],
    });
    // Mon 2026-06-08 .. Sun 2026-06-14.
    expect(
      slotsIso(med, "2026-06-08T00:00:00Z", "2026-06-14T23:00:00Z"),
    ).toEqual([
      "2026-06-08T17:00:00.000Z",
      "2026-06-10T17:00:00.000Z",
      "2026-06-12T17:00:00.000Z",
    ]);
  });

  it("every other week (RRULE INTERVAL=2) honours the stride", () => {
    const med = medication({
      startsOn: new Date("2026-06-01T00:00:00Z"),
      schedules: [schedule({ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" })],
    });
    expect(
      slotsIso(med, "2026-06-01T00:00:00Z", "2026-06-30T00:00:00Z"),
    ).toEqual([
      "2026-06-01T17:00:00.000Z",
      "2026-06-15T17:00:00.000Z",
      "2026-06-29T17:00:00.000Z",
    ]);
  });

  it("cyclic 1 week on / 1 week off drops the off week", () => {
    const med = medication({
      startsOn: new Date("2026-06-01T00:00:00Z"),
      schedules: [
        schedule({
          scheduleType: "CYCLIC",
          cyclicOnWeeks: 1,
          cyclicOffWeeks: 1,
        }),
      ],
    });
    const slots = slotsIso(med, "2026-06-01T00:00:00Z", "2026-06-15T00:00:00Z");
    expect(slots).toHaveLength(7);
    expect(slots[6]).toBe("2026-06-07T17:00:00.000Z");
  });

  it("rolling every 7 days counts from the last taken dose", () => {
    const med = medication({
      schedules: [schedule({ rollingIntervalDays: 7, timesOfDay: ["09:00"] })],
    });
    const last = new Date("2026-06-01T07:00:00Z"); // 09:00 CEST
    expect(
      slotsIso(med, "2026-06-02T00:00:00Z", "2026-06-10T00:00:00Z", last),
    ).toEqual(["2026-06-08T07:00:00.000Z"]);
    // Not due yet → nothing.
    expect(
      slotsIso(med, "2026-06-02T00:00:00Z", "2026-06-08T06:59:00Z", last),
    ).toEqual([]);
  });

  it("start and end dates bound the slots", () => {
    const med = medication({
      startsOn: new Date("2026-06-09T00:00:00Z"),
      endsOn: new Date("2026-06-10T00:00:00Z"),
    });
    expect(
      slotsIso(med, "2026-06-01T00:00:00Z", "2026-06-20T00:00:00Z"),
    ).toEqual(["2026-06-09T17:00:00.000Z", "2026-06-10T17:00:00.000Z"]);
  });

  it("a PRN schedule has no slot to record", () => {
    const med = medication({
      schedules: [schedule({ scheduleType: "PRN", rrule: null })],
    });
    expect(
      slotsIso(med, "2026-06-01T00:00:00Z", "2026-06-20T00:00:00Z"),
    ).toEqual([]);
  });

  it("a slot inside a pause era is dropped, an open era runs to now", () => {
    const med = medication({
      pauseEras: [
        {
          pausedAt: new Date("2026-06-09T00:00:00Z"),
          resumedAt: new Date("2026-06-10T00:00:00Z"),
        },
      ],
    });
    expect(
      slotsIso(med, "2026-06-08T00:00:00Z", "2026-06-10T23:00:00Z"),
    ).toEqual(["2026-06-08T17:00:00.000Z", "2026-06-10T17:00:00.000Z"]);
    const now = new Date("2026-06-12T00:00:00Z");
    expect(
      isInPauseEra(
        new Date("2026-06-11T17:00:00Z"),
        [{ pausedAt: new Date("2026-06-11T00:00:00Z"), resumedAt: null }],
        now,
      ),
    ).toBe(true);
  });
});

describe("dueAutoTakeSlots — DST in Europe/Berlin", () => {
  it("autumn change: 19:00 stays 19:00 local, the UTC instant moves an hour", () => {
    // Clocks go back on Sun 2026-10-25 at 03:00 CEST.
    expect(
      slotsIso(medication(), "2026-10-24T00:00:00Z", "2026-10-26T23:00:00Z"),
    ).toEqual([
      "2026-10-24T17:00:00.000Z",
      "2026-10-25T18:00:00.000Z",
      "2026-10-26T18:00:00.000Z",
    ]);
  });

  it("spring change: 19:00 stays 19:00 local across the short night", () => {
    // Clocks go forward on Sun 2026-03-29 at 02:00 CET.
    expect(
      slotsIso(medication(), "2026-03-28T00:00:00Z", "2026-03-30T23:00:00Z"),
    ).toEqual([
      "2026-03-28T18:00:00.000Z",
      "2026-03-29T17:00:00.000Z",
      "2026-03-30T17:00:00.000Z",
    ]);
  });

  it("the changeover night yields exactly one slot for an early-morning dose", () => {
    const med = medication({
      schedules: [schedule({ timesOfDay: ["02:30"] })],
    });
    const autumn = slotsIso(
      med,
      "2026-10-25T00:00:00Z",
      "2026-10-25T12:00:00Z",
    );
    expect(autumn).toHaveLength(1);
    const spring = slotsIso(
      med,
      "2026-03-29T00:00:00Z",
      "2026-03-29T12:00:00Z",
    );
    expect(spring).toHaveLength(1);
  });
});

describe("autoTakeFloor — never before the option was switched on", () => {
  it("takes the latest of switch-on, creation and the catch-up window", () => {
    const now = new Date("2026-06-20T12:00:00Z");
    const since = new Date("2026-06-20T17:30:00Z");
    expect(
      autoTakeFloor({
        autoMarkTakenSince: since,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        now,
      }),
    ).toEqual(since);
    expect(
      autoTakeFloor({
        autoMarkTakenSince: new Date("2026-01-01T00:00:00Z"),
        createdAt: new Date("2026-02-01T00:00:00Z"),
        now,
      }).getTime(),
    ).toBe(now.getTime() - INTAKE_AUTO_TAKE_LOOKBACK_MS);
  });

  it("switched on at 19:30 leaves that evening's 19:00 slot alone", () => {
    const med = medication({
      autoMarkTakenSince: new Date("2026-06-10T17:30:00Z"),
    });
    const now = new Date("2026-06-11T18:00:00Z");
    const floor = autoTakeFloor({
      autoMarkTakenSince: med.autoMarkTakenSince!,
      createdAt: med.createdAt,
      now,
    });
    expect(
      dueAutoTakeSlots({
        medication: med,
        userTz: TZ,
        floor,
        now,
        lastIntakeAt: null,
      }).map((o) => o.at.toISOString()),
    ).toEqual(["2026-06-11T17:00:00.000Z"]);
  });
});

describe("decideSlot — the person's record always wins", () => {
  const at = new Date("2026-06-10T17:00:00Z");
  const base = {
    scheduledFor: at,
    takenAt: null as Date | null,
    skipped: false,
    autoMissed: false,
    deletedAt: null as Date | null,
  };

  it("creates when nothing is on the slot", () => {
    expect(decideSlot(at, [], null)).toEqual({ kind: "create" });
  });

  it("converts a pending placeholder in place", () => {
    expect(decideSlot(at, [{ ...base, id: "p" }], null)).toEqual({
      kind: "convert",
      rowId: "p",
    });
  });

  it("leaves a taken, skipped or auto-missed slot", () => {
    for (const row of [
      { ...base, id: "t", takenAt: new Date("2026-06-10T17:20:00Z") },
      { ...base, id: "s", skipped: true },
      { ...base, id: "a", autoMissed: true },
    ]) {
      expect(decideSlot(at, [row, { ...base, id: "p" }], null)).toEqual({
        kind: "leave",
        reason: "actioned",
      });
    }
  });

  it("leaves a slot whose only row the person removed", () => {
    expect(
      decideSlot(at, [{ ...base, id: "x", deletedAt: new Date() }], null),
    ).toEqual({ kind: "leave", reason: "removed" });
  });

  it("leaves a slot claimed by a take logged inside its band", () => {
    const band = {
      earlyStart: new Date("2026-06-10T15:00:00Z"),
      overdueEnd: new Date("2026-06-10T21:00:00Z"),
    };
    const early = {
      ...base,
      id: "e",
      scheduledFor: new Date("2026-06-10T15:40:00Z"),
      takenAt: new Date("2026-06-10T15:40:00Z"),
    };
    expect(decideSlot(at, [early], band)).toEqual({
      kind: "leave",
      reason: "taken_nearby",
    });
    // A take outside the band does not claim it.
    expect(
      decideSlot(
        at,
        [
          {
            ...early,
            scheduledFor: new Date("2026-06-10T07:00:00Z"),
            takenAt: new Date("2026-06-10T07:00:00Z"),
          },
        ],
        band,
      ),
    ).toEqual({ kind: "create" });
  });
});

describe("autoTakeOwnedFrom — the auto-miss pass yields the owned slots", () => {
  const now = Date.parse("2026-06-20T12:00:00Z");
  it("owns slots from switch-on, inside the catch-up window", () => {
    expect(
      autoTakeOwnedFrom(
        {
          active: true,
          pausedAt: null,
          autoMarkTaken: true,
          autoMarkTakenSince: new Date("2026-06-19T00:00:00Z"),
        },
        now,
      ),
    ).toEqual(new Date("2026-06-19T00:00:00Z"));
    expect(
      autoTakeOwnedFrom(
        {
          active: true,
          pausedAt: null,
          autoMarkTaken: true,
          autoMarkTakenSince: new Date("2026-01-01T00:00:00Z"),
        },
        now,
      )?.getTime(),
    ).toBe(now - INTAKE_AUTO_TAKE_LOOKBACK_MS);
  });

  it("owns nothing while off or paused", () => {
    const since = new Date("2026-06-19T00:00:00Z");
    expect(
      autoTakeOwnedFrom(
        {
          active: true,
          pausedAt: null,
          autoMarkTaken: false,
          autoMarkTakenSince: since,
        },
        now,
      ),
    ).toBeNull();
    expect(
      autoTakeOwnedFrom(
        {
          active: true,
          pausedAt: new Date(),
          autoMarkTaken: true,
          autoMarkTakenSince: since,
        },
        now,
      ),
    ).toBeNull();
  });
});

// ── the pass over a fake client ───────────────────────────────────────

interface FakeRow {
  id: string;
  userId: string;
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  autoMissed: boolean;
  autoRecorded: boolean;
  deletedAt: Date | null;
  source: string;
  syncVersion: number;
  attributionSource?: "AUTO" | "USER_PIN";
}

function fakeClient(meds: ReturnType<typeof medication>[], rows: FakeRow[]) {
  let seq = 0;
  const inRange = (d: Date | null, r?: { gte?: Date; lte?: Date }) =>
    !!d &&
    (!r?.gte || d.getTime() >= r.gte.getTime()) &&
    (!r?.lte || d.getTime() <= r.lte.getTime());
  const client = {
    medication: {
      findMany: vi.fn(async () => meds),
    },
    medicationIntakeEvent: {
      findMany: vi.fn(
        async (args: {
          where: {
            medicationId: string;
            OR: [
              { scheduledFor: { gte: Date; lte: Date } },
              { takenAt: { gte: Date; lte: Date } },
            ];
          };
        }) =>
          rows.filter(
            (r) =>
              r.medicationId === args.where.medicationId &&
              (inRange(r.scheduledFor, args.where.OR[0].scheduledFor) ||
                inRange(r.takenAt, args.where.OR[1].takenAt)),
          ),
      ),
      findFirst: vi.fn(async (args: { where: { medicationId: string } }) => {
        const taken = rows
          .filter(
            (r) =>
              r.medicationId === args.where.medicationId &&
              r.deletedAt === null &&
              r.takenAt !== null,
          )
          .sort((a, b) => b.takenAt!.getTime() - a.takenAt!.getTime());
        return taken[0] ? { takenAt: taken[0].takenAt } : null;
      }),
      updateMany: vi.fn(
        async (args: {
          where: { id: string };
          data: { takenAt: Date; autoRecorded: boolean };
        }) => {
          const row = rows.find(
            (r) =>
              r.id === args.where.id &&
              r.deletedAt === null &&
              r.takenAt === null &&
              !r.skipped &&
              !r.autoMissed,
          );
          if (!row) return { count: 0 };
          row.takenAt = args.data.takenAt;
          row.autoRecorded = args.data.autoRecorded;
          row.syncVersion += 1;
          return { count: 1 };
        },
      ),
      create: vi.fn(
        async (args: {
          data: Omit<
            FakeRow,
            "id" | "deletedAt" | "syncVersion" | "autoMissed"
          >;
        }) => {
          const row: FakeRow = {
            id: `new-${++seq}`,
            autoMissed: false,
            deletedAt: null,
            syncVersion: 0,
            ...args.data,
          };
          rows.push(row);
          return { id: row.id };
        },
      ),
    },
    medicationInventoryItem: {},
    $transaction: vi.fn(),
  };
  return client as unknown as Parameters<typeof runIntakeAutoTakePass>[0];
}

function row(partial: Partial<FakeRow> & { id: string; scheduledFor: Date }) {
  return {
    userId: "u1",
    medicationId: "m1",
    takenAt: null,
    skipped: false,
    autoMissed: false,
    autoRecorded: false,
    deletedAt: null,
    source: "REMINDER",
    syncVersion: 0,
    ...partial,
  };
}

describe("runIntakeAutoTakePass — over a fake client", () => {
  beforeEach(() => {
    vi.mocked(consumeForIntake).mockClear();
    vi.mocked(refreshDoseSlot).mockClear();
    vi.mocked(queueMedicationIntakeSync).mockClear();
  });

  it("records each due slot once, converts the placeholder, leaves the skip", async () => {
    const med = medication({
      autoMarkTakenSince: new Date("2026-06-08T10:00:00Z"),
    });
    const rows: FakeRow[] = [
      // Mon 19:00: a pending placeholder the projector minted.
      row({ id: "p1", scheduledFor: new Date("2026-06-08T17:00:00Z") }),
      // Tue 19:00: skipped by hand.
      row({
        id: "s1",
        scheduledFor: new Date("2026-06-09T17:00:00Z"),
        skipped: true,
        source: "WEB",
      }),
    ];
    const client = fakeClient([med], rows);
    const now = Date.parse("2026-06-10T17:20:00Z"); // Wed, after 19:00

    const first = await runIntakeAutoTakePass(client, { nowMs: now });
    expect(first.recordedCount).toBe(2);
    expect(first.convertedCount).toBe(1);

    const live = rows.filter((r) => r.deletedAt === null);
    const bySlot = new Map<string, FakeRow[]>();
    for (const r of live) {
      const key = r.scheduledFor.toISOString();
      bySlot.set(key, [...(bySlot.get(key) ?? []), r]);
    }
    expect(bySlot.get("2026-06-08T17:00:00.000Z")).toHaveLength(1);
    expect(bySlot.get("2026-06-08T17:00:00.000Z")![0]).toMatchObject({
      id: "p1",
      autoRecorded: true,
      takenAt: new Date("2026-06-08T17:00:00Z"),
    });
    expect(bySlot.get("2026-06-09T17:00:00.000Z")![0]).toMatchObject({
      id: "s1",
      skipped: true,
      takenAt: null,
      autoRecorded: false,
    });
    expect(bySlot.get("2026-06-10T17:00:00.000Z")).toHaveLength(1);
    expect(bySlot.get("2026-06-10T17:00:00.000Z")![0]).toMatchObject({
      autoRecorded: true,
      source: "REMINDER",
    });

    // Follow-ups once per recorded dose; one wake per user.
    expect(consumeForIntake).toHaveBeenCalledTimes(2);
    expect(queueMedicationIntakeSync).toHaveBeenCalledTimes(1);

    // Idempotent: a second pass records nothing and writes nothing.
    vi.mocked(consumeForIntake).mockClear();
    const second = await runIntakeAutoTakePass(client, { nowMs: now + 60_000 });
    expect(second.recordedCount).toBe(0);
    expect(consumeForIntake).not.toHaveBeenCalled();
    expect(rows).toHaveLength(3);
  });

  it("does not touch history before the option was switched on", async () => {
    const med = medication({
      autoMarkTakenSince: new Date("2026-06-10T17:30:00Z"),
    });
    const rows: FakeRow[] = [];
    const client = fakeClient([med], rows);
    const result = await runIntakeAutoTakePass(client, {
      nowMs: Date.parse("2026-06-10T22:00:00Z"),
    });
    expect(result.recordedCount).toBe(0);
    expect(rows).toEqual([]);
  });

  it("does not record a slot whose dose the person logged early", async () => {
    const med = medication({
      autoMarkTakenSince: new Date("2026-06-10T00:00:00Z"),
    });
    const rows: FakeRow[] = [
      // Taken by hand at 18:30 local, bound to the 19:00 slot.
      row({
        id: "t1",
        scheduledFor: new Date("2026-06-10T17:00:00Z"),
        takenAt: new Date("2026-06-10T16:30:00Z"),
        source: "WEB",
      }),
    ];
    const client = fakeClient([med], rows);
    const result = await runIntakeAutoTakePass(client, {
      nowMs: Date.parse("2026-06-10T18:00:00Z"),
    });
    expect(result.recordedCount).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it("a rolling cadence catches up one interval after another", async () => {
    const med = medication({
      autoMarkTakenSince: new Date("2026-06-01T00:00:00Z"),
      schedules: [schedule({ rollingIntervalDays: 2, timesOfDay: ["09:00"] })],
    });
    const rows: FakeRow[] = [
      row({
        id: "t0",
        scheduledFor: new Date("2026-06-01T07:00:00Z"),
        takenAt: new Date("2026-06-01T07:00:00Z"),
        source: "WEB",
      }),
    ];
    const client = fakeClient([med], rows);
    const result = await runIntakeAutoTakePass(client, {
      nowMs: Date.parse("2026-06-06T08:00:00Z"),
    });
    // 06-03 and 06-05 at 09:00 CEST.
    expect(result.recordedCount).toBe(2);
    expect(
      rows
        .filter((r) => r.autoRecorded)
        .map((r) => r.scheduledFor.toISOString())
        .sort(),
    ).toEqual(["2026-06-03T07:00:00.000Z", "2026-06-05T07:00:00.000Z"]);
  });
});

// ── a rolling cadence under auto-take never stalls ────────────────────

describe("runIntakeAutoTakePass — rolling cadence keeps moving", () => {
  const weekly = () =>
    schedule({ rollingIntervalDays: 7, timesOfDay: ["09:00"] });
  const autoRecordedSlots = (rows: FakeRow[]) =>
    rows
      .filter((r) => r.autoRecorded && r.deletedAt === null)
      .map((r) => r.scheduledFor.toISOString())
      .sort();

  it("a first dose before the floor is passed over, the next one recorded", async () => {
    // Created at 12:00 CEST, after that day's 09:00 slot, no start date:
    // the first rolling dose lies before the floor.
    const med = medication({
      createdAt: new Date("2026-06-10T10:00:00Z"),
      autoMarkTakenSince: new Date("2026-06-10T10:00:00Z"),
      schedules: [weekly()],
    });
    const rows: FakeRow[] = [];
    const client = fakeClient([med], rows);

    const early = await runIntakeAutoTakePass(client, {
      nowMs: Date.parse("2026-06-12T08:00:00Z"),
    });
    expect(early.recordedCount).toBe(0);

    const due = await runIntakeAutoTakePass(client, {
      nowMs: Date.parse("2026-06-17T07:20:00Z"),
    });
    expect(due.recordedCount).toBe(1);
    expect(autoRecordedSlots(rows)).toEqual(["2026-06-17T07:00:00.000Z"]);
  });

  it("switched on while the weekly dose is overdue: the overdue dose stays, the cadence moves on", async () => {
    const med = medication({
      autoMarkTakenSince: new Date("2026-06-10T12:00:00Z"),
      schedules: [weekly()],
    });
    const rows: FakeRow[] = [
      row({
        id: "t0",
        scheduledFor: new Date("2026-06-01T07:00:00Z"),
        takenAt: new Date("2026-06-01T07:00:00Z"),
        source: "WEB",
      }),
    ];
    const client = fakeClient([med], rows);
    const result = await runIntakeAutoTakePass(client, {
      nowMs: Date.parse("2026-06-15T08:00:00Z"),
    });
    // 06-08 lies before the switch-on and is never backfilled.
    expect(result.recordedCount).toBe(1);
    expect(autoRecordedSlots(rows)).toEqual(["2026-06-15T07:00:00.000Z"]);
  });

  it("a skipped rolling auto dose counts as handled: the next one is recorded", async () => {
    const med = medication({
      autoMarkTakenSince: new Date("2026-06-01T00:00:00Z"),
      schedules: [weekly()],
    });
    const rows: FakeRow[] = [
      row({
        id: "t0",
        scheduledFor: new Date("2026-06-01T07:00:00Z"),
        takenAt: new Date("2026-06-01T07:00:00Z"),
        source: "WEB",
      }),
      row({
        id: "s1",
        scheduledFor: new Date("2026-06-08T07:00:00Z"),
        skipped: true,
        source: "WEB",
      }),
    ];
    const client = fakeClient([med], rows);
    const result = await runIntakeAutoTakePass(client, {
      nowMs: Date.parse("2026-06-15T08:00:00Z"),
    });
    expect(result.recordedCount).toBe(1);
    expect(autoRecordedSlots(rows)).toEqual(["2026-06-15T07:00:00.000Z"]);
    expect(rows.find((r) => r.id === "s1")).toMatchObject({
      skipped: true,
      takenAt: null,
    });
  });

  it("a removed rolling auto dose stays removed and the next one is recorded", async () => {
    const med = medication({
      autoMarkTakenSince: new Date("2026-06-01T00:00:00Z"),
      schedules: [weekly()],
    });
    const rows: FakeRow[] = [
      row({
        id: "t0",
        scheduledFor: new Date("2026-06-01T07:00:00Z"),
        takenAt: new Date("2026-06-01T07:00:00Z"),
        source: "WEB",
      }),
      row({
        id: "gone",
        scheduledFor: new Date("2026-06-08T07:00:00Z"),
        takenAt: new Date("2026-06-08T07:00:00Z"),
        autoRecorded: true,
        deletedAt: new Date("2026-06-08T09:00:00Z"),
      }),
    ];
    const client = fakeClient([med], rows);
    const result = await runIntakeAutoTakePass(client, {
      nowMs: Date.parse("2026-06-15T08:00:00Z"),
    });
    expect(result.recordedCount).toBe(1);
    expect(autoRecordedSlots(rows)).toEqual(["2026-06-15T07:00:00.000Z"]);
    expect(
      rows.filter(
        (r) => r.scheduledFor.toISOString() === "2026-06-08T07:00:00.000Z",
      ),
    ).toHaveLength(1);
  });

  it("a worker down for more than a week catches up on the rhythm, not the stale slot", async () => {
    const med = medication({
      autoMarkTakenSince: new Date("2026-05-01T00:00:00Z"),
      schedules: [weekly()],
    });
    const rows: FakeRow[] = [
      row({
        id: "t0",
        scheduledFor: new Date("2026-05-25T07:00:00Z"),
        takenAt: new Date("2026-05-25T07:00:00Z"),
        source: "WEB",
      }),
    ];
    const client = fakeClient([med], rows);
    // Ten days after the 06-01 dose fell due: it is outside the catch-up
    // window, 06-08 is inside it.
    const result = await runIntakeAutoTakePass(client, {
      nowMs: Date.parse("2026-06-11T08:00:00Z"),
    });
    expect(result.recordedCount).toBe(1);
    expect(autoRecordedSlots(rows)).toEqual(["2026-06-08T07:00:00.000Z"]);
  });

  it("the card's next due is the slot the job records", async () => {
    const med = medication({
      createdAt: new Date("2026-06-10T10:00:00Z"),
      autoMarkTakenSince: new Date("2026-06-10T10:00:00Z"),
      schedules: [weekly()],
    });
    const now = new Date("2026-06-12T08:00:00Z");
    const anchor = autoTakeRollingAnchor({
      medication: med,
      userTz: TZ,
      floor: autoTakeFloor({
        autoMarkTakenSince: med.autoMarkTakenSince!,
        createdAt: med.createdAt,
        now,
      }),
      now,
      lastIntakeAt: null,
      rows: [],
    });
    const display = computeDisplayDue({
      medication: med,
      schedules: med.schedules,
      now,
      userTz: TZ,
      lastIntakeAt: anchor,
      resolvedSlots: [],
    });
    expect(display?.at.toISOString()).toBe("2026-06-17T07:00:00.000Z");

    const rows: FakeRow[] = [];
    await runIntakeAutoTakePass(fakeClient([med], rows), {
      nowMs: Date.parse("2026-06-17T07:20:00Z"),
    });
    expect(autoRecordedSlots(rows)).toEqual([display!.at.toISOString()]);
  });
});

// ── a take bound to another slot never claims this one ───────────────

describe("runIntakeAutoTakePass — nearby takes of another slot", () => {
  const twiceDaily = () =>
    medication({
      autoMarkTakenSince: new Date("2026-06-10T00:00:00Z"),
      schedules: [schedule({ timesOfDay: ["08:00", "20:00"] })],
    });
  // 2026-06-10 (CEST): 08:00 = 06:00Z, 20:00 = 18:00Z; 19:00 = 17:00Z.
  const MORNING = new Date("2026-06-10T06:00:00Z");
  const EVENING = "2026-06-10T18:00:00.000Z";
  const autoSlots = (rows: FakeRow[]) =>
    rows.filter((r) => r.autoRecorded).map((r) => r.scheduledFor.toISOString());

  it("the morning dose pinned and taken at 19:00 leaves the evening dose due", async () => {
    const rows: FakeRow[] = [
      row({
        id: "pin",
        scheduledFor: MORNING,
        takenAt: new Date("2026-06-10T17:00:00Z"),
        attributionSource: "USER_PIN",
        source: "WEB",
      }),
    ];
    await runIntakeAutoTakePass(fakeClient([twiceDaily()], rows), {
      nowMs: Date.parse("2026-06-10T18:20:00Z"),
    });
    expect(autoSlots(rows)).toEqual([EVENING]);
  });

  it("the same without a pin: a take on the morning slot is the morning's", async () => {
    const rows: FakeRow[] = [
      row({
        id: "late",
        scheduledFor: MORNING,
        takenAt: new Date("2026-06-10T17:00:00Z"),
        source: "WEB",
      }),
    ];
    await runIntakeAutoTakePass(fakeClient([twiceDaily()], rows), {
      nowMs: Date.parse("2026-06-10T18:20:00Z"),
    });
    expect(autoSlots(rows)).toEqual([EVENING]);
  });

  it("an ad-hoc take at 19:00 still claims the evening dose", async () => {
    const at19 = new Date("2026-06-10T17:00:00Z");
    const rows: FakeRow[] = [
      // The morning dose, taken on time.
      row({
        id: "am",
        scheduledFor: MORNING,
        takenAt: MORNING,
        source: "WEB",
      }),
      row({ id: "adhoc", scheduledFor: at19, takenAt: at19, source: "WEB" }),
    ];
    await runIntakeAutoTakePass(fakeClient([twiceDaily()], rows), {
      nowMs: Date.parse("2026-06-10T18:20:00Z"),
    });
    expect(autoSlots(rows)).toEqual([]);
  });

  it("decideSlot: a pinned row elsewhere is not nearby, an ad-hoc one is", () => {
    const band = {
      earlyStart: new Date("2026-06-10T15:00:00Z"),
      overdueEnd: new Date("2026-06-10T21:00:00Z"),
    };
    const evening = new Date(EVENING);
    const taken = new Date("2026-06-10T17:00:00Z");
    const base = {
      takenAt: taken,
      skipped: false,
      autoMissed: false,
      deletedAt: null,
    };
    expect(
      decideSlot(
        evening,
        [
          {
            ...base,
            id: "p",
            scheduledFor: new Date("2026-06-09T12:00:00Z"),
            attributionSource: "USER_PIN",
          },
        ],
        band,
      ),
    ).toEqual({ kind: "create" });
    expect(
      decideSlot(evening, [{ ...base, id: "a", scheduledFor: taken }], band),
    ).toEqual({ kind: "leave", reason: "taken_nearby" });
  });
});

// ── one bad row never stops the pass ──────────────────────────────────

describe("runIntakeAutoTakePass — per-medication isolation", () => {
  it("a medication whose follow-up throws is skipped, the next one still runs", async () => {
    const broken = medication({
      id: "m-broken",
      autoMarkTakenSince: new Date("2026-06-10T00:00:00Z"),
    });
    const fine = medication({
      id: "m-fine",
      autoMarkTakenSince: new Date("2026-06-10T00:00:00Z"),
    });
    const rows: FakeRow[] = [];
    vi.mocked(consumeForIntake).mockImplementationOnce(async () => {
      throw new Error("inventory unavailable");
    });
    const result = await runIntakeAutoTakePass(
      fakeClient([broken, fine], rows),
      { nowMs: Date.parse("2026-06-10T17:20:00Z") },
    );
    expect(result.failedCount).toBe(1);
    expect(
      rows.filter((r) => r.medicationId === "m-fine" && r.autoRecorded),
    ).toHaveLength(1);
  });

  it("a stored zone the runtime refuses falls back instead of throwing", async () => {
    const med = {
      ...medication({ autoMarkTakenSince: new Date("2026-06-10T00:00:00Z") }),
      user: { timezone: "Mars/Olympus_Mons" },
    };
    const rows: FakeRow[] = [];
    const result = await runIntakeAutoTakePass(fakeClient([med], rows), {
      nowMs: Date.parse("2026-06-10T20:00:00Z"),
    });
    expect(result.failedCount).toBe(0);
    expect(result.recordedCount).toBe(1);
  });
});
