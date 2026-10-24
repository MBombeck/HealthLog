/**
 * A logged weekly injection must stop being announced — and a genuinely
 * missed one must still become overdue.
 *
 * The rolling retrospective grid anchors an expected slot AT each logged
 * intake instant, so the open-overdue search got a band back for the dose the
 * user had just taken. That band was tested for "has the user acted on it?"
 * against the intake row's `scheduledFor`, which for a late take is the SLOT
 * anchor days away from `takenAt` — the two never matched, the band read open,
 * and the card announced the already-injected GLP-1 dose as overdue.
 *
 * The test drives the REAL assembly rather than hand-picking a `scheduledFor`:
 * the write path (`resolveSlotForWriteByBand`, over a fake Prisma holding the
 * real row shapes) decides what the server persists, and the read path
 * (`toResolvedSlotMark` + `computeDisplayDue`, wired with the same feeder
 * queries `list-read.ts` and the MCP schedule tool run) decides what the card
 * announces. Both ends and the pipe between them.
 */
import { describe, expect, it, vi } from "vitest";

import {
  computeDisplayDue,
  OVERDUE_LOOKBACK_MS,
  toResolvedSlotMark,
  type ResolvedSlotMark,
} from "../next-due";
import { resolveSlotForWriteByBand } from "../slot-upsert";
import type { WorkerMedicationRow, WorkerScheduleRow } from "../worker-helpers";

const TZ = "Europe/Berlin";
const DAY_MS = 24 * 60 * 60 * 1000;

const medication: WorkerMedicationRow = {
  id: "med-1",
  startsOn: new Date("2026-06-02T00:00:00.000Z"),
  endsOn: null,
  endedAt: null,
  oneShot: false,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
};

/** Weekly GLP-1 injection: rolling every 7 days at 09:00 Berlin. */
const schedule: WorkerScheduleRow = {
  id: "sched-1",
  windowStart: "09:00",
  windowEnd: "10:00",
  daysOfWeek: null,
  timesOfDay: ["09:00"],
  reminderGraceMinutes: null,
  rrule: null,
  rollingIntervalDays: 7,
  scheduleType: "SCHEDULED",
  cyclicOnWeeks: null,
  cyclicOffWeeks: null,
  doseWindows: null,
};

/** One persisted `MedicationIntakeEvent`, in the shape both paths read. */
interface Row {
  scheduledFor: Date;
  takenAt: Date;
}

type BandClient = Parameters<typeof resolveSlotForWriteByBand>[0]["client"];

/**
 * Fake Prisma over an in-memory row list, answering exactly the two queries
 * `loadAttributeMedication` + `rollingIntakeInstantsIfNeeded` issue.
 */
function makeClient(rows: Row[]): BandClient {
  return {
    medication: {
      findFirst: vi.fn(async () => ({
        ...medication,
        schedules: [schedule],
        scheduleRevisions: [],
      })),
    },
    medicationIntakeEvent: {
      // Latest non-tombstoned takenAt — the rolling anchor.
      findFirst: vi.fn(async () => {
        const sorted = [...rows].sort(
          (a, b) => b.takenAt.getTime() - a.takenAt.getTime(),
        );
        return sorted[0] ? { takenAt: sorted[0].takenAt } : null;
      }),
      // Non-skipped takes at or before `around`, ascending.
      findMany: vi.fn(async (args: { where: { takenAt: { lte: Date } } }) =>
        [...rows]
          .filter(
            (r) => r.takenAt.getTime() <= args.where.takenAt.lte.getTime(),
          )
          .sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime())
          .map((r) => ({ takenAt: r.takenAt })),
      ),
    },
  } as unknown as BandClient;
}

/** Log a take through the REAL write-path attribution and persist the row. */
async function logTake(rows: Row[], takenAt: Date): Promise<Row> {
  const attribution = await resolveSlotForWriteByBand({
    userId: "u1",
    medicationId: medication.id,
    userTz: TZ,
    takenAt,
    now: takenAt,
    client: makeClient(rows),
  });
  // The intake routes persist `attribution.slotInstant ?? takenAt` verbatim.
  const row: Row = {
    scheduledFor: attribution.slotInstant ?? takenAt,
    takenAt,
  };
  rows.push(row);
  return row;
}

/** The card's verdict, wired exactly as `list-read.ts` / the MCP tool wire it. */
function readDisplayDue(rows: Row[], now: Date) {
  const lastIntakeAt =
    rows.length === 0
      ? null
      : rows.reduce((a, b) => (a.takenAt > b.takenAt ? a : b)).takenAt;
  const windowStart = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);
  const windowEnd = new Date(now.getTime() + 2 * DAY_MS);
  const resolvedSlots: ResolvedSlotMark[] = rows
    .filter(
      (r) =>
        r.scheduledFor.getTime() >= windowStart.getTime() &&
        r.scheduledFor.getTime() <= windowEnd.getTime(),
    )
    .map(toResolvedSlotMark);

  return computeDisplayDue({
    medication,
    schedules: [schedule],
    now,
    userTz: TZ,
    lastIntakeAt,
    resolvedSlots,
    eraStart: null,
  });
}

describe("weekly rolling dose — taken vs missed", () => {
  it("stops announcing a weekly dose the user has logged", async () => {
    const rows: Row[] = [];
    // First shot: Tue 21 July, 09:00 Berlin.
    await logTake(rows, new Date("2026-07-21T07:00:00.000Z"));
    // The next slot falls Tue 28 July; the user injects four days late,
    // Sat 1 August 09:00 Berlin. The band model credits that to the 28 July
    // slot, so the persisted row's `scheduledFor` sits four days from its
    // `takenAt` — the divergence the open-overdue search must survive.
    const late = await logTake(rows, new Date("2026-08-01T07:00:00.000Z"));
    expect(late.scheduledFor.toISOString()).toBe("2026-07-28T07:00:00.000Z");

    // Read the card the next morning.
    const display = readDisplayDue(rows, new Date("2026-08-02T08:00:00.000Z"));

    expect(display?.overdue).toBe(false);
    // Next injection is a full cycle after the shot actually taken.
    expect(display?.at.toISOString()).toBe("2026-08-08T07:00:00.000Z");
  });

  it("still flags a weekly dose the user genuinely missed", async () => {
    const rows: Row[] = [];
    await logTake(rows, new Date("2026-07-21T07:00:00.000Z"));

    // Nothing logged since. Two days past the 28 July slot it is open and
    // overdue — inside the four-day catch-up tail, so still takeable.
    const display = readDisplayDue(rows, new Date("2026-07-30T08:00:00.000Z"));

    expect(display?.overdue).toBe(true);
    expect(display?.at.toISOString()).toBe("2026-07-28T07:00:00.000Z");
  });
});
