/**
 * Integration suite for `DELETE /api/measurements/by-external-ids` —
 * the iOS deletion-sync endpoint. Asserts the contract the iOS client
 * relies on for HealthKit reconciliation:
 *   - Happy path: matching rows are SOFT-deleted (v1.7.0 — `deletedAt`
 *     set + `syncVersion` bumped, row retained), deletedCount equals the
 *     number freshly tombstoned. Tombstoned rows are invisible to normal
 *     reads but still present in the table for the tombstone feed.
 *   - Cross-user 404 guard: another user's rows that happen to share an
 *     externalId remain untouched (live).
 *   - Empty array: returns 200 with deletedCount = 0 (not a failure).
 *   - Batch size cap: 501 externalIds returns 422 with a documented
 *     errorCode so the client can surface the diagnostic.
 *   - Replay idempotency: a second delete of the same externalIds is a
 *     no-op (deletedCount 0) because the rows are already tombstoned.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-batch-delete-test";
const OTHER_USER_ID = "user-batch-delete-other";

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
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "batch-delete",
      email: "batch-delete@example.test",
    },
  });
  await getPrismaClient().user.create({
    data: {
      id: OTHER_USER_ID,
      username: "batch-delete-other",
      email: "batch-delete-other@example.test",
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

function makeRequest(body: { externalIds: string[] }): NextRequest {
  return new NextRequest("http://localhost/api/measurements/by-external-ids", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Hash an externalId into a stable minute offset (0..1023) so two
// rows seeded with different externalIds land on different
// `measuredAt` values. The W17b/c unique index now covers
// (user_id, type, measured_at, source, sleep_stage) with NULLs not
// distinct, so all-same-instant fixtures collide; spreading by
// minute keeps the fixture deterministic without sacrificing the
// "owned by the caller" intent of the test.
function minuteOffsetFor(externalId: string): number {
  let h = 0;
  for (let i = 0; i < externalId.length; i++) {
    h = (h * 31 + externalId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 1024;
}

async function seedMeasurement(opts: {
  userId: string;
  externalId: string;
  value?: number;
}): Promise<void> {
  const base = new Date("2026-05-09T07:30:00.000Z").getTime();
  const measuredAt = new Date(base + minuteOffsetFor(opts.externalId) * 60_000);
  await getPrismaClient().measurement.create({
    data: {
      userId: opts.userId,
      type: "WEIGHT",
      value: opts.value ?? 80,
      unit: "kg",
      source: "APPLE_HEALTH",
      measuredAt,
      externalId: opts.externalId,
    },
  });
}

describe("DELETE /api/measurements/by-external-ids (real Postgres)", () => {
  it("soft-deletes matching rows owned by the caller and returns deletedCount", async () => {
    const { DELETE } =
      await import("@/app/api/measurements/by-external-ids/route");

    await seedMeasurement({ userId: TEST_USER_ID, externalId: "uuid-del-1" });
    await seedMeasurement({ userId: TEST_USER_ID, externalId: "uuid-del-2" });
    await seedMeasurement({
      userId: TEST_USER_ID,
      externalId: "uuid-keep-3",
    });

    const response = await DELETE(
      makeRequest({ externalIds: ["uuid-del-1", "uuid-del-2"] }),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { deletedCount: number } };
    expect(json.data.deletedCount).toBe(2);

    // v1.7.0 — rows are SOFT-deleted, so all three rows still exist in
    // the table. The two targeted rows carry a non-null `deletedAt` (and
    // a bumped `syncVersion`); the untouched row stays live.
    const all = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
      orderBy: { externalId: "asc" },
    });
    expect(all).toHaveLength(3);

    const live = all.filter((r) => r.deletedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.externalId).toBe("uuid-keep-3");

    const tombstoned = all.filter((r) => r.deletedAt !== null);
    expect(tombstoned.map((r) => r.externalId).sort()).toEqual([
      "uuid-del-1",
      "uuid-del-2",
    ]);
    // syncVersion bumped from the default 1 to 2 on tombstone.
    for (const row of tombstoned) {
      expect(row.syncVersion).toBe(2);
    }
  });

  it("never tombstones rows owned by another user (cross-user 404 guard)", async () => {
    const { DELETE } =
      await import("@/app/api/measurements/by-external-ids/route");

    // Two users own rows with the same externalId; deleting via the
    // logged-in user must only tombstone that user's row.
    await seedMeasurement({ userId: TEST_USER_ID, externalId: "uuid-shared" });
    await seedMeasurement({
      userId: OTHER_USER_ID,
      externalId: "uuid-shared",
      value: 70,
    });

    const response = await DELETE(
      makeRequest({ externalIds: ["uuid-shared"] }),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { deletedCount: number } };
    expect(json.data.deletedCount).toBe(1);

    const callerRows = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(callerRows).toHaveLength(1);
    expect(callerRows[0]?.deletedAt).not.toBeNull();

    // The other user's row must stay live (deletedAt null) and untouched.
    const otherRows = await getPrismaClient().measurement.findMany({
      where: { userId: OTHER_USER_ID },
    });
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.externalId).toBe("uuid-shared");
    expect(otherRows[0]?.deletedAt).toBeNull();
  });

  it("accepts an empty externalIds array as a no-op", async () => {
    const { DELETE } =
      await import("@/app/api/measurements/by-external-ids/route");

    await seedMeasurement({ userId: TEST_USER_ID, externalId: "uuid-keep" });

    const response = await DELETE(makeRequest({ externalIds: [] }));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { deletedCount: number } };
    expect(json.data.deletedCount).toBe(0);

    const stored = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.deletedAt).toBeNull();
  });

  it("is idempotent on replay — a second delete tombstones zero rows", async () => {
    const { DELETE } =
      await import("@/app/api/measurements/by-external-ids/route");

    await seedMeasurement({ userId: TEST_USER_ID, externalId: "uuid-replay" });

    const first = await DELETE(makeRequest({ externalIds: ["uuid-replay"] }));
    const firstJson = (await first.json()) as {
      data: { deletedCount: number };
    };
    expect(firstJson.data.deletedCount).toBe(1);

    const second = await DELETE(makeRequest({ externalIds: ["uuid-replay"] }));
    const secondJson = (await second.json()) as {
      data: { deletedCount: number };
    };
    // Already tombstoned — the `deletedAt: null` guard matches nothing,
    // so the replay is a no-op and syncVersion does not bump again.
    expect(secondJson.data.deletedCount).toBe(0);

    const row = await getPrismaClient().measurement.findFirst({
      where: { userId: TEST_USER_ID, externalId: "uuid-replay" },
    });
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.syncVersion).toBe(2);
  });

  it("returns 422 with measurement.delete.too_large when batch exceeds the cap", async () => {
    const { DELETE } =
      await import("@/app/api/measurements/by-external-ids/route");

    const externalIds: string[] = [];
    for (let i = 0; i < 501; i++) {
      externalIds.push(`uuid-cap-${i}`);
    }

    const response = await DELETE(makeRequest({ externalIds }));
    expect(response.status).toBe(422);
    const json = (await response.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(json.error).toMatch(/500/);
    expect(json.meta?.errorCode).toBe("measurement.delete.too_large");
  });
});
