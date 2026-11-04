/**
 * v1.12.1 — native mood-entry `externalId` idempotent re-import against
 * real Postgres.
 *
 * Migration 0122 added `MoodEntry.externalId` plus the NULL-distinct
 * `@@unique([userId, source, externalId])`. This test pins the iOS-facing
 * native write paths onto that index:
 *
 *   - single `POST /api/mood-entries` with an `externalId` re-posted →
 *     one row, updated in place (no duplicate, no 409)
 *   - bulk `POST /api/mood-entries/bulk` with an `externalId` re-posted →
 *     one row, reported `duplicate`, updated in place
 *   - a NULL `externalId` keeps the legacy `(userId, date, moodLoggedAt)`
 *     wall-clock behaviour exactly
 *   - the same `externalId` under two different users is isolated (the
 *     NULL-distinct unique is per-user, so no cross-tenant collision)
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_A = "user-mood-extid-a";
const USER_B = "user-mood-extid-b";

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

async function createUserSession(userId: string, username: string) {
  await getPrismaClient().user.create({
    data: {
      id: userId,
      username,
      email: `${username}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
  return getPrismaClient().session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
});

function singleRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mood-entries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function bulkRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mood-entries/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/mood-entries — externalId idempotent re-import (real Postgres)", () => {
  it("re-posting the same externalId updates one row in place (no duplicate)", async () => {
    const session = await createUserSession(USER_A, "mood-extid-a");
    cookieJar.set("healthlog_session", session.id);
    const { POST } = await import("@/app/api/mood-entries/route");

    const first = await POST(
      singleRequest({
        mood: "OKAY",
        moodLoggedAt: "2026-05-16T08:00:00.000Z",
        externalId: "ios-uuid-1",
      }),
    );
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as {
      data: { id: string; externalId: string; mood: string };
    };
    expect(firstJson.data.externalId).toBe("ios-uuid-1");

    // Re-post the SAME externalId with a different mood + a re-rounded
    // wall-clock (10 minutes later). The row must update in place.
    const second = await POST(
      singleRequest({
        mood: "SUPER_GUT",
        moodLoggedAt: "2026-05-16T08:10:00.000Z",
        externalId: "ios-uuid-1",
      }),
    );
    expect(second.status).toBe(201);
    const secondJson = (await second.json()) as {
      data: { id: string; mood: string };
    };
    // Same primary key — updated in place, not a new row.
    expect(secondJson.data.id).toBe(firstJson.data.id);

    const rows = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER_A },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].mood).toBe("SUPER_GUT");
    expect(rows[0].score).toBe(5);
    expect(rows[0].externalId).toBe("ios-uuid-1");
    expect(rows[0].moodLoggedAt.toISOString()).toBe("2026-05-16T08:10:00.000Z");
  });

  it("keeps legacy first-write behaviour when externalId is absent", async () => {
    const session = await createUserSession(USER_A, "mood-extid-a");
    cookieJar.set("healthlog_session", session.id);
    const { POST } = await import("@/app/api/mood-entries/route");

    const body = { mood: "GUT", moodLoggedAt: "2026-05-16T09:00:00.000Z" };
    const first = await POST(singleRequest(body));
    expect(first.status).toBe(201);

    // Same (userId, date, moodLoggedAt) tuple, no externalId → the legacy
    // unique trips and the route surfaces a 409, exactly as before.
    const second = await POST(singleRequest(body));
    expect(second.status).toBe(409);

    const rows = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER_A },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBeNull();
  });

  it("isolates the same externalId across two users (no cross-tenant collision)", async () => {
    const sessionA = await createUserSession(USER_A, "mood-extid-a");
    const sessionB = await createUserSession(USER_B, "mood-extid-b");
    const { POST } = await import("@/app/api/mood-entries/route");

    cookieJar.set("healthlog_session", sessionA.id);
    const resA = await POST(
      singleRequest({
        mood: "OKAY",
        moodLoggedAt: "2026-05-16T08:00:00.000Z",
        externalId: "shared-uuid",
      }),
    );
    expect(resA.status).toBe(201);

    cookieJar.clear();
    cookieJar.set("healthlog_session", sessionB.id);
    const resB = await POST(
      singleRequest({
        mood: "LAUSIG",
        moodLoggedAt: "2026-05-16T08:00:00.000Z",
        externalId: "shared-uuid",
      }),
    );
    expect(resB.status).toBe(201);

    // Two distinct rows — one per user — despite the shared externalId.
    const rowsA = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER_A },
    });
    const rowsB = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER_B },
    });
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].mood).toBe("OKAY");
    expect(rowsB[0].mood).toBe("LAUSIG");
  });
});

describe("POST /api/mood-entries/bulk — externalId idempotent re-import (real Postgres)", () => {
  it("re-posting the same externalId reports a duplicate and updates one row", async () => {
    const session = await createUserSession(USER_A, "mood-extid-a");
    cookieJar.set("healthlog_session", session.id);
    const { POST } = await import("@/app/api/mood-entries/bulk/route");

    const first = await POST(
      bulkRequest({
        entries: [
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "ios-bulk-1",
          },
        ],
      }),
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      data: { inserted: number; entries: Array<{ externalId?: string }> };
    };
    expect(firstJson.data.inserted).toBe(1);
    expect(firstJson.data.entries[0].externalId).toBe("ios-bulk-1");

    // Re-post the same externalId with a different mood + re-rounded
    // wall-clock → duplicate, row updated in place.
    const second = await POST(
      bulkRequest({
        entries: [
          {
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-16T08:12:00.000Z",
            externalId: "ios-bulk-1",
          },
        ],
      }),
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      data: { inserted: number; duplicates: number };
    };
    expect(secondJson.data.inserted).toBe(0);
    expect(secondJson.data.duplicates).toBe(1);

    const rows = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER_A },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].mood).toBe("SUPER_GUT");
    expect(rows[0].externalId).toBe("ios-bulk-1");
    expect(rows[0].moodLoggedAt.toISOString()).toBe("2026-05-16T08:12:00.000Z");
  });

  it("keeps the legacy wall-clock key when an entry omits externalId", async () => {
    const session = await createUserSession(USER_A, "mood-extid-a");
    cookieJar.set("healthlog_session", session.id);
    const { POST } = await import("@/app/api/mood-entries/bulk/route");

    const body = {
      entries: [{ mood: "GUT", moodLoggedAt: "2026-05-16T08:00:00.000Z" }],
    };
    await POST(bulkRequest(body));
    // Re-post the identical tuple → legacy dedup classifies it duplicate.
    const second = await POST(bulkRequest(body));
    const json = (await second.json()) as {
      data: { inserted: number; duplicates: number };
    };
    expect(json.data.inserted).toBe(0);
    expect(json.data.duplicates).toBe(1);

    const rows = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER_A },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBeNull();
  });

  it("isolates the same externalId across two users on the bulk path", async () => {
    const sessionA = await createUserSession(USER_A, "mood-extid-a");
    const sessionB = await createUserSession(USER_B, "mood-extid-b");
    const { POST } = await import("@/app/api/mood-entries/bulk/route");

    cookieJar.set("healthlog_session", sessionA.id);
    await POST(
      bulkRequest({
        entries: [
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "shared-bulk",
          },
        ],
      }),
    );

    cookieJar.clear();
    cookieJar.set("healthlog_session", sessionB.id);
    const resB = await POST(
      bulkRequest({
        entries: [
          {
            mood: "LAUSIG",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "shared-bulk",
          },
        ],
      }),
    );
    const jsonB = (await resB.json()) as { data: { inserted: number } };
    // User B's first write with the shared id is a fresh insert, not a
    // duplicate of user A's row.
    expect(jsonB.data.inserted).toBe(1);

    const rowsA = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER_A },
    });
    const rowsB = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER_B },
    });
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].mood).toBe("OKAY");
    expect(rowsB[0].mood).toBe("LAUSIG");
  });
});
