/**
 * v1.16.16 (iOS #17) — `processWhoopNotification` enqueue tests (mocked).
 *
 * A `*.updated` webhook must enqueue the per-resource sync job carrying the
 * resource id so the worker can do a targeted fetch-by-id refresh (landing the
 * exact record immediately rather than waiting for the next overlap window).
 * The existing 200-always + unknown-user + delete-soft-delete contract is
 * preserved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findUnique,
  bossSend,
  updateMany,
  deleteMany,
  findMany,
  afterMutation,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  bossSend: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
  afterMutation: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    whoopConnection: { findUnique: (...a: unknown[]) => findUnique(...a) },
    measurement: {
      updateMany: (...a: unknown[]) => updateMany(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
    workout: { deleteMany: (...a: unknown[]) => deleteMany(...a) },
  },
}));

vi.mock("@/lib/rollups/after-measurement-mutation", () => ({
  afterMeasurementMutation: (...a: unknown[]) => afterMutation(...a),
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: (...a: unknown[]) => bossSend(...a) }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/api-response", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => ({ setAuth: vi.fn(), addWarning: vi.fn() }),
}));

import {
  deletedResourceExternalIdFilter,
  processWhoopNotification,
} from "../webhook-handler";
import {
  mapRecovery,
  mapSleep,
  WHOOP_RECOVERY_FIELD_TAGS,
} from "@/lib/whoop/map";
import { type WhoopRecovery, type WhoopSleep } from "@/lib/whoop/wire-types";
import type { Prisma } from "@/generated/prisma/client";

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ userId: "user-1" });
  bossSend.mockResolvedValue("job-id");
  findMany.mockResolvedValue([]);
  afterMutation.mockResolvedValue(undefined);
});

describe("processWhoopNotification — fetch-by-id enqueue", () => {
  it("enqueues the workout queue with the resource id", async () => {
    const res = await processWhoopNotification({
      user_id: 42,
      id: "w-123",
      type: "workout.updated",
    });

    expect(res.status).toBe(200);
    expect(bossSend).toHaveBeenCalledWith("whoop-workout-sync", {
      userId: "user-1",
      resourceId: "w-123",
    });
  });

  it("carries a numeric resource id as a string", async () => {
    await processWhoopNotification({
      user_id: 42,
      id: 9981,
      type: "recovery.updated",
    });

    expect(bossSend).toHaveBeenCalledWith("whoop-recovery-sync", {
      userId: "user-1",
      resourceId: "9981",
    });
  });

  it("returns 200 for an unknown user without enqueuing", async () => {
    findUnique.mockResolvedValue(null);

    const res = await processWhoopNotification({
      user_id: 7,
      id: "w-1",
      type: "workout.updated",
    });

    expect(res.status).toBe(200);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("soft-deletes on a *.deleted event (no enqueue)", async () => {
    updateMany.mockResolvedValue({ count: 3 });
    deleteMany.mockResolvedValue({ count: 1 });

    const res = await processWhoopNotification({
      user_id: 42,
      id: "w-123",
      type: "workout.deleted",
    });

    expect(res.status).toBe(200);
    expect(bossSend).not.toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalled();
  });

  // Watched red: with the `afterMeasurementMutation` call removed from
  // the delete branch this test fails on the hook assertion — the
  // pre-fix behaviour (soft-delete with no rollup recompute) is exactly
  // the ghost-aggregate bug.
  it("collects the affected (type, measuredAt) pairs before the soft-delete and fires the rollup hook", async () => {
    const measuredAt = new Date("2026-05-10T08:00:00.000Z");
    findMany.mockResolvedValue([{ type: "SLEEP_DURATION", measuredAt }]);
    updateMany.mockResolvedValue({ count: 1 });

    const res = await processWhoopNotification({
      user_id: 42,
      id: "s-9",
      type: "sleep.deleted",
    });

    expect(res.status).toBe(200);
    // The pre-image read happens BEFORE the destructive updateMany —
    // afterwards the (type, measuredAt) pairs are unreadable.
    expect(findMany.mock.invocationCallOrder[0]).toBeLessThan(
      updateMany.mock.invocationCallOrder[0],
    );
    expect(afterMutation).toHaveBeenCalledWith(
      "user-1",
      [{ type: "SLEEP_DURATION", measuredAt }],
      { source: "sync", label: "whoop.webhook" },
    );
  });
});

// One night as WHOOP v2 models it: a sleep and the recovery scored from it.
// Both key their rows off the sleep UUID, which is also the id the recovery
// webhook carries.
const SLEEP: WhoopSleep = {
  id: "sleep-uuid",
  cycle_id: 991,
  user_id: 42,
  created_at: "2026-06-01T05:00:00.000Z",
  updated_at: "2026-06-01T07:00:00.000Z",
  start: "2026-05-31T23:00:00.000Z",
  end: "2026-06-01T07:00:00.000Z",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 8 * 3_600_000,
      total_awake_time_milli: 30 * 60_000,
      total_light_sleep_time_milli: 4 * 3_600_000,
      total_slow_wave_sleep_time_milli: 90 * 60_000,
      total_rem_sleep_time_milli: 2 * 3_600_000,
      disturbance_count: 4,
    },
    sleep_needed: {
      baseline_milli: 8 * 3_600_000,
      need_from_sleep_debt_milli: 0,
      need_from_recent_strain_milli: 0,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: 15,
    sleep_performance_percentage: 90,
    sleep_consistency_percentage: 80,
    sleep_efficiency_percentage: 92,
  },
};
const RECOVERY: WhoopRecovery = {
  cycle_id: 991,
  sleep_id: "sleep-uuid",
  user_id: 42,
  created_at: "2026-06-01T07:00:00.000Z",
  updated_at: "2026-06-01T07:05:00.000Z",
  score_state: "SCORED",
  score: {
    user_calibrating: false,
    recovery_score: 70,
    resting_heart_rate: 52,
    hrv_rmssd_milli: 61,
    spo2_percentage: 96,
    skin_temp_celsius: 33.4,
  },
};
const SLEEP_IDS = mapSleep(SLEEP).map(
  (m) => m.externalId ?? `${SLEEP.id}:${m.fieldTag}`,
);
const RECOVERY_IDS = mapRecovery(RECOVERY).map(
  (m) => `${RECOVERY.sleep_id}:${m.fieldTag}`,
);

/** The subset of Prisma's StringFilter semantics the filter uses. */
function matches(filter: Prisma.StringFilter, id: string): boolean {
  if (filter.in && !(filter.in as string[]).includes(id)) return false;
  if (filter.notIn && (filter.notIn as string[]).includes(id)) return false;
  if (filter.startsWith && !id.startsWith(filter.startsWith as string)) {
    return false;
  }
  return true;
}

describe("deletedResourceExternalIdFilter — one night, two resources", () => {
  it("pins the recovery field-tag list to what the mapper emits", () => {
    expect(new Set(mapRecovery(RECOVERY).map((m) => m.fieldTag))).toEqual(
      new Set(WHOOP_RECOVERY_FIELD_TAGS),
    );
  });

  it("a recovery deletion removes the recovery and leaves the night's sleep", () => {
    const filter = deletedResourceExternalIdFilter("recovery", "sleep-uuid");
    expect(SLEEP_IDS.length).toBeGreaterThan(5);
    expect(RECOVERY_IDS.filter((id) => matches(filter, id))).toEqual(
      RECOVERY_IDS,
    );
    expect(SLEEP_IDS.filter((id) => matches(filter, id))).toEqual([]);
  });

  it("a sleep deletion removes the sleep and leaves its recovery", () => {
    const filter = deletedResourceExternalIdFilter("sleep", "sleep-uuid");
    expect(SLEEP_IDS.filter((id) => matches(filter, id))).toEqual(SLEEP_IDS);
    expect(RECOVERY_IDS.filter((id) => matches(filter, id))).toEqual([]);
  });

  it("a recovery.deleted webhook passes the exact-id match to both reads", async () => {
    updateMany.mockResolvedValue({ count: 5 });
    await processWhoopNotification({
      user_id: 42,
      id: "sleep-uuid",
      type: "recovery.deleted",
    });
    const expected = {
      in: WHOOP_RECOVERY_FIELD_TAGS.map((t) => `sleep-uuid:${t}`),
    };
    expect(findMany.mock.calls[0][0].where.externalId).toEqual(expected);
    expect(updateMany.mock.calls[0][0].where.externalId).toEqual(expected);
  });
});
