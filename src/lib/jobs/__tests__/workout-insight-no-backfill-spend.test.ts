import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cost claim, proved against a fixture rather than asserted about intent.
 *
 * "Historical inserted workouts produce zero provider calls" is the single
 * property this fixture proves. Every ingest path is also a backfill path: a
 * ten-year Apple export or a catch-up after downtime. Existing-row re-syncs are
 * stopped earlier by statement-level insertion identity in each writer.
 *
 * So this walks the REAL chain end to end with only the edges mocked:
 *
 *     emitInsertedWorkoutArrival / emitDataArrival   (real classifier)
 *   → boss.send                                        (counted)
 *   → runDataArrival                                   (real worker)
 *   → enqueueWorkoutInsight                            (counted)
 *
 * Nothing in the middle is stubbed, so a future edit that weakens the recency
 * test or the spine's dispatch shows up here as a non-zero count rather than
 * as a passing test about a mock.
 */

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => undefined),
}));
// The iOS data wake is an edge of its own (devices, the relay), not part of
// the arrival chain this file walks.
vi.mock("@/lib/push-relay/data-changed", () => ({
  noteDataChanged: vi.fn(async () => {}),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({ resolveModuleMap: vi.fn() }));
// The spine's provider-free prefilter (`aiWorkNotRuledOut`) runs for real; only
// its operator-switch read is an edge.
vi.mock("@/lib/feature-flags", () => ({ loadAssistantSwitches: vi.fn() }));
vi.mock("@/lib/tz/resolver", () => ({ resolveUserTimezone: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
}));
vi.mock("@/lib/jobs/workout-insight-generate-shared", async (orig) => {
  const actual =
    await orig<typeof import("@/lib/jobs/workout-insight-generate-shared")>();
  return {
    ...actual,
    enqueueWorkoutInsight: vi.fn(async () => ({
      enqueued: true,
    })),
  };
});

import {
  emitInsertedWorkoutArrival,
  type InsertedWorkoutArrivalRow,
} from "@/lib/arrivals/workout-emit";
import { DATA_ARRIVAL_QUEUE } from "@/lib/arrivals/emit-shared";
import { runDataArrival } from "../data-arrival";
import { enqueueWorkoutInsight } from "@/lib/jobs/workout-insight-generate-shared";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { resolveModuleMap } from "@/lib/modules/gate";
import { loadAssistantSwitches } from "@/lib/feature-flags";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import type { DataArrival } from "@/lib/arrivals/types";

const USER = "user-1";
const TZ = "Europe/Berlin";
/** Fixed "now" so the fixture's relative dates are stable under any TZ. */
const NOW = new Date("2026-07-18T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

/** Rows the spine's `boss.send` was given, in order. */
let sent: Array<{ queue: string; payload: DataArrival }>;

/** One workout row returned by an INSERT statement. */
function inserted(startedAt: Date): InsertedWorkoutArrivalRow {
  return {
    id: `w-${startedAt.getTime()}`,
    startedAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  vi.mocked(getGlobalBoss).mockReturnValue({
    send: vi.fn(async (queue: string, payload: DataArrival) => {
      sent.push({ queue, payload });
      return "job-id";
    }),
  } as never);
  vi.mocked(resolveModuleMap).mockResolvedValue({
    workouts: true,
    insights: true,
  } as never);
  vi.mocked(loadAssistantSwitches).mockResolvedValue({
    enabled: true,
    coach: true,
    briefing: true,
    insightStatus: true,
    documentAi: true,
  });
  vi.mocked(resolveUserTimezone).mockResolvedValue(TZ);
});

/** A prisma double whose reaction claim always succeeds. */
function claimingPrisma() {
  return {
    arrivalReaction: {
      createMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  } as never;
}

describe("Activity Insight — a backfill spends nothing", () => {
  it("a three-year Apple export replay emits zero arrivals", async () => {
    // 750 sessions, one every ~36 hours going back from three days ago. The
    // export lands them all at once; every one of them is history.
    const FIXTURE_SIZE = 750;
    for (let i = 0; i < FIXTURE_SIZE; i++) {
      const startedAt = new Date(NOW.getTime() - (3 + i * 1.5) * MS_PER_DAY);
      await emitInsertedWorkoutArrival(USER, inserted(startedAt), "apple", NOW);
    }

    expect(sent).toHaveLength(0);
    expect(enqueueWorkoutInsight).not.toHaveBeenCalled();
  });

  it("one genuinely fresh session emits exactly one arrival and one generation", async () => {
    // The positive control. Without it every count above passes vacuously —
    // a broken emit path would report zero for the happy case too.
    const fresh = inserted(new Date(NOW.getTime() - 2 * 3600_000));
    await emitInsertedWorkoutArrival(USER, fresh, "apple", NOW);

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({
      userId: USER,
      kind: "workout",
      refId: fresh.id,
      count: 1,
    });

    const outcome = await runDataArrival(claimingPrisma(), sent[0].payload);
    expect(outcome.status).toBe("processed");
    expect(enqueueWorkoutInsight).toHaveBeenCalledTimes(1);
    expect(enqueueWorkoutInsight).toHaveBeenCalledWith({
      userId: USER,
      workoutId: fresh.id,
    });
  });

  it("the whole fixture together yields exactly one generation", async () => {
    // 750 historical inserts + 1 fresh insert. Existing-row provider re-syncs
    // never call this seam and are covered at each writer.
    const rows: Array<{ row: InsertedWorkoutArrivalRow; source: string }> = [];
    for (let i = 0; i < 750; i++) {
      rows.push({
        row: inserted(new Date(NOW.getTime() - (3 + i * 1.5) * MS_PER_DAY)),
        source: "apple",
      });
    }
    rows.splice(400, 0, {
      row: inserted(new Date(NOW.getTime() - 2 * 3600_000)),
      source: "apple",
    });

    for (const { row, source } of rows) {
      await emitInsertedWorkoutArrival(USER, row, source, NOW);
    }

    expect(rows).toHaveLength(751);
    const arrivalJobs = sent.filter(
      ({ queue }) => queue === DATA_ARRIVAL_QUEUE,
    );
    expect(arrivalJobs).toHaveLength(1);

    // Snapshot only the spine jobs. Processing one appends downstream
    // reaction-line work to `sent`; iterating that live, growing array would
    // feed a different queue's payload back into this worker forever.
    for (const job of arrivalJobs) {
      await runDataArrival(claimingPrisma(), job.payload);
    }
    expect(enqueueWorkoutInsight).toHaveBeenCalledTimes(1);
  });
});
