/**
 * Concurrent-write race coverage for `POST /api/workouts/batch`.
 *
 * Mirrors the v1.4.25 W10 fix-C reconciliation pattern that landed for
 * the measurements batch endpoint
 * (`tests/integration/measurements-batch.test.ts` — the
 * `keeps per-entry status in sync with aggregate counts under a
 * concurrent-write race` case). When two batches with overlapping
 * `(userId, source, externalId)` tuples land in parallel, only one
 * row per tuple may exist in the DB after the dust settles, and each
 * response body's per-entry envelope MUST sum to its own aggregate
 * counts so the iOS sync cursor can advance unambiguously.
 *
 * Pulled into its own file so the contention assertion remains
 * isolated from the broader workout-batch surface — the W10 fix was a
 * one-line invariant that took two hours of audit work to expose, and
 * regressions on it would be near-invisible in a mixed-purpose file.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-workout-race-test";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "workout-race",
      email: "workout-race@example.test",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

interface WorkoutFixture {
  sportType: string;
  startedAt: string;
  endedAt: string;
  source: string;
  externalId: string;
}

function makeRequest(body: { workouts: WorkoutFixture[] }): NextRequest {
  return new NextRequest("http://localhost/api/workouts/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function workout(
  externalId: string,
  minuteOffset: number,
  source = "APPLE_HEALTH",
): WorkoutFixture {
  return {
    sportType: "running",
    startedAt: new Date(2026, 4, 14, 6, minuteOffset).toISOString(),
    endedAt: new Date(2026, 4, 14, 7, minuteOffset).toISOString(),
    source,
    externalId,
  };
}

describe("POST /api/workouts/batch — concurrent-write race", () => {
  // v1.4.25 W10 reconcile (senior-dev H-1 parity for workouts).
  //
  // Two batches with overlapping `(userId, source, externalId)` tuples
  // posted in parallel MUST resolve to exactly one DB row per tuple
  // (the composite unique index enforces it; createMany.skipDuplicates
  // absorbs the duplicate-key conflicts). What can go wrong is the
  // per-entry envelope: the original pattern compared "rows we
  // attempted" vs "rows now in the DB" — but every attempted row is
  // present after the call (either we wrote it or the other batch did),
  // so the diff is always zero and the envelope drifts out of sync
  // with the aggregate counts under contention. The fix trusts
  // `createMany.count` for the aggregate `insertedCount` and downgrades
  // exactly that many "inserted" statuses to "duplicate", so the per-
  // entry envelope sums match the aggregate counts — the invariant the
  // iOS sync cursor relies on to checkpoint correctly.
  it("keeps per-entry status in sync with aggregate counts under contention", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    const sharedWorkouts = (): WorkoutFixture[] =>
      Array.from({ length: 6 }, (_, i) => workout(`hk-uuid-race-${i}`, i));

    const [first, second] = await Promise.all([
      POST(makeRequest({ workouts: sharedWorkouts() })),
      POST(makeRequest({ workouts: sharedWorkouts() })),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstJson = (await first.json()) as {
      data: {
        processed: number;
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string }>;
      };
    };
    const secondJson = (await second.json()) as typeof firstJson;

    // Invariant 1 — per-entry statuses sum to the aggregate counts.
    // Before the W10 fix-C the comparable measurements test failed
    // under contention because the no-op reconciliation left the
    // envelope out of sync with the counts.
    for (const json of [firstJson, secondJson]) {
      const insertedEntries = json.data.entries.filter(
        (e) => e.status === "inserted",
      ).length;
      const duplicateEntries = json.data.entries.filter(
        (e) => e.status === "duplicate",
      ).length;
      const skippedEntries = json.data.entries.filter(
        (e) => e.status === "skipped",
      ).length;
      expect(insertedEntries).toBe(json.data.inserted);
      expect(duplicateEntries).toBe(json.data.duplicates);
      expect(insertedEntries + duplicateEntries + skippedEntries).toBe(
        json.data.processed,
      );
    }

    // Invariant 2 — counts non-negative. A naive "downgrade and also
    // decrement" implementation could otherwise produce a negative
    // `inserted` count under specific commit orderings.
    expect(firstJson.data.inserted).toBeGreaterThanOrEqual(0);
    expect(secondJson.data.inserted).toBeGreaterThanOrEqual(0);

    // Invariant 3 — DB ends with at most 6 rows (composite unique
    // index enforces single-copy) and the two responses' inserted
    // counts sum to the row count actually present. Cross-validates
    // that `createMany.count` is the truth source for the aggregate.
    const stored = await getPrismaClient().workout.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored.length).toBeLessThanOrEqual(6);
    expect(firstJson.data.inserted + secondJson.data.inserted).toBe(
      stored.length,
    );
  });

  it("two batches with one overlapping externalId resolve to a single DB row each", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    // Batch A — a cross-source pair one minute apart plus one shared key.
    // The v1.4.42 `dedupeWorkoutBatch` picker collapses the Apple Health +
    // Manual pair (same activity, within the 90 s window) to one
    // surviving row, leaving 2 effective rows per batch.
    const batchA: WorkoutFixture[] = [
      workout("hk-uuid-only-a-0", 1),
      workout("hk-uuid-only-a-1", 2, "MANUAL"),
      workout("hk-uuid-shared", 10),
    ];
    // Batch B — same cross-source shape, different externalIds for the
    // unique pair but the SAME shared key.
    const batchB: WorkoutFixture[] = [
      workout("hk-uuid-only-b-0", 21),
      workout("hk-uuid-only-b-1", 22, "MANUAL"),
      workout("hk-uuid-shared", 10),
    ];

    const [resA, resB] = await Promise.all([
      POST(makeRequest({ workouts: batchA })),
      POST(makeRequest({ workouts: batchB })),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const aJson = (await resA.json()) as {
      data: { processed: number; inserted: number; duplicates: number };
    };
    const bJson = (await resB.json()) as typeof aJson;

    // Three unique tuples land in the DB after write-time cross-source
    // dedup + the composite unique index: one survivor from A's minute-1/2
    // pair, one survivor from B's minute-21/22 pair, and one shared-key row
    // (either as A's "inserted" or B's "inserted" — never both). The
    // sum of the two batches' inserted counts equals the row count.
    expect(aJson.data.inserted + bJson.data.inserted).toBe(3);
    // The two canonical drops plus the losing shared-key insert must be
    // observable as duplicates rather than being counted as inserts.
    expect(aJson.data.duplicates + bJson.data.duplicates).toBe(3);
    for (const json of [aJson, bJson]) {
      expect(json.data.inserted + json.data.duplicates).toBe(
        json.data.processed,
      );
    }

    const stored = await getPrismaClient().workout.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toHaveLength(3);
    const sharedRows = stored.filter((r) => r.externalId === "hk-uuid-shared");
    expect(sharedRows).toHaveLength(1);
  });
});
