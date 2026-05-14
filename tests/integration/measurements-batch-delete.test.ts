/**
 * Integration suite for `DELETE /api/measurements/by-external-ids` —
 * the iOS deletion-sync endpoint. Asserts the contract the iOS client
 * relies on for HealthKit reconciliation:
 *   - Happy path: matching rows are deleted, deletedCount equals the
 *     number actually removed.
 *   - Cross-user 404 guard: another user's rows that happen to share an
 *     externalId remain untouched.
 *   - Empty array: returns 200 with deletedCount = 0 (not a failure).
 *   - Batch size cap: 501 externalIds returns 422 with a documented
 *     errorCode so the client can surface the diagnostic.
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
  it("removes matching rows owned by the caller and returns deletedCount", async () => {
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

    const remaining = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
      orderBy: { externalId: "asc" },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.externalId).toBe("uuid-keep-3");
  });

  it("never deletes rows owned by another user (cross-user 404 guard)", async () => {
    const { DELETE } =
      await import("@/app/api/measurements/by-external-ids/route");

    // Two users own rows with the same externalId; deleting via the
    // logged-in user must only remove that user's row.
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
    expect(callerRows).toHaveLength(0);

    const otherRows = await getPrismaClient().measurement.findMany({
      where: { userId: OTHER_USER_ID },
    });
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.externalId).toBe("uuid-shared");
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
