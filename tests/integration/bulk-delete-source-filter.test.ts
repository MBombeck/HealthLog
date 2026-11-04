/**
 * v1.15.13 — bulk soft-delete + source filter, real-Postgres integration.
 *
 * Covers, against the real testcontainer:
 *   - `POST /api/measurements/bulk-delete` soft-deletes only the caller's
 *     rows; a foreign id is a silent no-op (no existence leak), bumps
 *     `syncVersion`, sets `deletedAt`, and the count reflects owned rows
 *     only.
 *   - Idempotency replay returns the same `deleted` count without
 *     re-mutating (a second distinct call would re-bump syncVersion).
 *   - `POST /api/mood-entries/bulk-delete` mirrors the same contract.
 *   - `sourceEq` (measurements) + `source` (mood) narrow the list reads.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_A = "user-bulkdel-a";
const USER_B = "user-bulkdel-b";

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

async function seedUser(id: string, username: string) {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: { id, username, email: `${username}@example.test`, timezone: "UTC" },
  });
}

async function loginAs(id: string) {
  const session = await getPrismaClient().session.create({
    data: { userId: id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", session.id);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await seedUser(USER_A, "bulkdel-a");
  await seedUser(USER_B, "bulkdel-b");
});

function postReq(path: string, body: unknown, idempotencyKey?: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/measurements/bulk-delete (real Postgres)", () => {
  it("soft-deletes owned rows, skips a foreign id, bumps syncVersion", async () => {
    const prisma = getPrismaClient();
    const now = new Date();
    const mine = await prisma.measurement.createManyAndReturn({
      data: [
        {
          userId: USER_A,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          source: "MANUAL",
          measuredAt: now,
        },
        {
          userId: USER_A,
          type: "WEIGHT",
          value: 81,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date(now.getTime() - 1000),
        },
      ],
    });
    const theirs = await prisma.measurement.create({
      data: {
        userId: USER_B,
        type: "WEIGHT",
        value: 70,
        unit: "kg",
        source: "MANUAL",
        measuredAt: now,
      },
    });

    await loginAs(USER_A);
    const { POST } = await import("@/app/api/measurements/bulk-delete/route");
    const res = await POST(
      postReq("/api/measurements/bulk-delete", {
        ids: [mine[0].id, mine[1].id, theirs.id],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: number } };
    // Only the two owned rows count; the foreign id is a silent no-op.
    expect(body.data.deleted).toBe(2);

    const minedAfter = await prisma.measurement.findMany({
      where: { id: { in: [mine[0].id, mine[1].id] } },
    });
    for (const row of minedAfter) {
      expect(row.deletedAt).not.toBeNull();
      // Measurement.syncVersion defaults to 1; one bulk delete bumps it to 2.
      expect(row.syncVersion).toBe(2);
    }
    // The other user's row is untouched (default syncVersion = 1).
    const theirsAfter = await prisma.measurement.findUnique({
      where: { id: theirs.id },
    });
    expect(theirsAfter!.deletedAt).toBeNull();
    expect(theirsAfter!.syncVersion).toBe(1);
  });

  it("idempotency replay returns the cached count without re-mutating", async () => {
    const prisma = getPrismaClient();
    const row = await prisma.measurement.create({
      data: {
        userId: USER_A,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(),
      },
    });

    await loginAs(USER_A);
    const { POST } = await import("@/app/api/measurements/bulk-delete/route");
    const key = "idem-meas-bulk-1";

    const first = await POST(
      postReq("/api/measurements/bulk-delete", { ids: [row.id] }, key),
    );
    expect(first.status).toBe(200);
    expect(
      ((await first.json()) as { data: { deleted: number } }).data.deleted,
    ).toBe(1);

    // Replay with the SAME key → cached body, same count, no re-mutation.
    const replay = await POST(
      postReq("/api/measurements/bulk-delete", { ids: [row.id] }, key),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(
      ((await replay.json()) as { data: { deleted: number } }).data.deleted,
    ).toBe(1);

    // Measurement.syncVersion defaults to 1; the single real delete bumped
    // it to 2 and the replay did NOT re-run the mutation (so it stays 2).
    const after = await prisma.measurement.findUnique({
      where: { id: row.id },
    });
    expect(after!.syncVersion).toBe(2);
  });

  it("rejects a >200-id batch with 422", async () => {
    await loginAs(USER_A);
    const { POST } = await import("@/app/api/measurements/bulk-delete/route");
    const ids = Array.from({ length: 201 }, (_, i) => `id-${i}`);
    const res = await POST(postReq("/api/measurements/bulk-delete", { ids }));
    expect(res.status).toBe(422);
  });
});

describe("POST /api/mood-entries/bulk-delete (real Postgres)", () => {
  it("soft-deletes owned rows, skips a foreign id, bumps syncVersion", async () => {
    const prisma = getPrismaClient();
    const mine = await prisma.moodEntry.createManyAndReturn({
      data: [
        {
          userId: USER_A,
          date: "2026-01-01",
          mood: "GUT",
          score: 4,
          source: "MANUAL",
          moodLoggedAt: new Date("2026-01-01T08:00:00Z"),
          tz: "UTC",
        },
        {
          userId: USER_A,
          date: "2026-01-02",
          mood: "OKAY",
          score: 3,
          source: "MANUAL",
          moodLoggedAt: new Date("2026-01-02T08:00:00Z"),
          tz: "UTC",
        },
      ],
    });
    const theirs = await prisma.moodEntry.create({
      data: {
        userId: USER_B,
        date: "2026-01-01",
        mood: "LAUSIG",
        score: 1,
        source: "MANUAL",
        moodLoggedAt: new Date("2026-01-01T09:00:00Z"),
        tz: "UTC",
      },
    });

    await loginAs(USER_A);
    const { POST } = await import("@/app/api/mood-entries/bulk-delete/route");
    const res = await POST(
      postReq("/api/mood-entries/bulk-delete", {
        ids: [mine[0].id, mine[1].id, theirs.id],
      }),
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { deleted: number } }).data.deleted,
    ).toBe(2);

    const after = await prisma.moodEntry.findMany({
      where: { id: { in: [mine[0].id, mine[1].id] } },
    });
    for (const row of after) {
      expect(row.deletedAt).not.toBeNull();
      expect(row.syncVersion).toBe(1);
    }
    const theirsAfter = await prisma.moodEntry.findUnique({
      where: { id: theirs.id },
    });
    expect(theirsAfter!.deletedAt).toBeNull();
  });
});

describe("source filter narrows the list reads (real Postgres)", () => {
  it("measurements sourceEq returns only the matching source", async () => {
    const prisma = getPrismaClient();
    const now = new Date();
    await prisma.measurement.createMany({
      data: [
        {
          userId: USER_A,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          source: "MANUAL",
          measuredAt: now,
        },
        {
          userId: USER_A,
          type: "WEIGHT",
          value: 81,
          unit: "kg",
          source: "WITHINGS",
          measuredAt: new Date(now.getTime() - 1000),
        },
        {
          userId: USER_A,
          type: "WEIGHT",
          value: 82,
          unit: "kg",
          source: "WITHINGS",
          measuredAt: new Date(now.getTime() - 2000),
        },
      ],
    });

    await loginAs(USER_A);
    const { GET } = await import("@/app/api/measurements/route");
    const res = await GET(
      new NextRequest("http://localhost/api/measurements?sourceEq=WITHINGS"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        measurements: Array<{ source: string }>;
        meta: { total: number };
      };
    };
    expect(body.data.measurements).toHaveLength(2);
    expect(body.data.measurements.every((m) => m.source === "WITHINGS")).toBe(
      true,
    );
    expect(body.data.meta.total).toBe(2);
  });

  it("mood source returns only the matching source", async () => {
    const prisma = getPrismaClient();
    await prisma.moodEntry.createMany({
      data: [
        {
          userId: USER_A,
          date: "2026-01-01",
          mood: "GUT",
          score: 4,
          source: "MANUAL",
          moodLoggedAt: new Date("2026-01-01T08:00:00Z"),
          tz: "UTC",
        },
        {
          userId: USER_A,
          date: "2026-01-02",
          mood: "OKAY",
          score: 3,
          source: "TELEGRAM",
          moodLoggedAt: new Date("2026-01-02T08:00:00Z"),
          tz: "UTC",
        },
      ],
    });

    await loginAs(USER_A);
    const { GET } = await import("@/app/api/mood-entries/route");
    const res = await GET(
      new NextRequest("http://localhost/api/mood-entries?source=TELEGRAM"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ source: string }>; meta: { total: number } };
    };
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.entries[0].source).toBe("TELEGRAM");
    expect(body.data.meta.total).toBe(1);
  });
});
