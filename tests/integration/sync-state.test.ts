/**
 * v1.4.30 — `GET /api/sync/state` real-Postgres integration.
 *
 * The endpoint is the iOS SyncMode handshake. Asserts:
 *   - first call returns `lastSyncedAt: null` then writes the
 *     checkpoint
 *   - subsequent call sees the previous checkpoint
 *   - measurement counters distinguish live vs tombstoned rows
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-sync-state";

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
      username: "sync-state",
      email: "sync-state@example.test",
      timezone: "Europe/Berlin",
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

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/sync/state", { method: "GET" });
}

describe("GET /api/sync/state (real Postgres)", () => {
  it("returns lastSyncedAt: null on the first call and writes the checkpoint", async () => {
    const { GET } = await import("@/app/api/sync/state/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        userId: string;
        timezone: string;
        lastSyncedAt: string | null;
        serverNow: string;
        measurements: { lastUpdatedAt: string | null; liveCount: number; tombstonedCount: number };
      };
    };
    expect(json.data.userId).toBe(TEST_USER_ID);
    expect(json.data.timezone).toBe("Europe/Berlin");
    expect(json.data.lastSyncedAt).toBeNull();
    expect(json.data.measurements.liveCount).toBe(0);
    expect(json.data.measurements.tombstonedCount).toBe(0);

    // Server-side, lastSyncedAt now carries a value.
    const after = await getPrismaClient().user.findUnique({
      where: { id: TEST_USER_ID },
      select: { lastSyncedAt: true },
    });
    expect(after?.lastSyncedAt).not.toBeNull();
  });

  it("returns the previous checkpoint on the second call", async () => {
    const { GET } = await import("@/app/api/sync/state/route");
    await GET(makeRequest());
    const res = await GET(makeRequest());
    const json = (await res.json()) as {
      data: { lastSyncedAt: string | null };
    };
    expect(json.data.lastSyncedAt).not.toBeNull();
  });

  it("distinguishes live vs tombstoned measurement counts", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 64,
          unit: "bpm",
          source: "MANUAL",
          measuredAt: new Date("2026-05-16T10:00:00.000Z"),
        },
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 70,
          unit: "bpm",
          source: "MANUAL",
          measuredAt: new Date("2026-05-16T11:00:00.000Z"),
          deletedAt: new Date("2026-05-16T12:00:00.000Z"),
        },
      ],
    });

    const { GET } = await import("@/app/api/sync/state/route");
    const res = await GET(makeRequest());
    const json = (await res.json()) as {
      data: { measurements: { liveCount: number; tombstonedCount: number } };
    };
    expect(json.data.measurements.liveCount).toBe(1);
    expect(json.data.measurements.tombstonedCount).toBe(1);
  });
});
