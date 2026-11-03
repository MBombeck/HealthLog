/**
 * Integration test for `GET /api/admin/host-metrics` (v1.4.16 phase B3).
 *
 * Asserts:
 *   - requireAdmin gating (403 for non-admin, 401 anonymous)
 *   - default 2h window filters out older rows
 *   - bytes-per-second derivation for disk counters across consecutive
 *     samples (incl. negative-delta resets and null disk fields)
 *   - response shape (samples + meta)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedAdminSession() {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "host-metrics-admin",
      email: "host-metrics-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: admin.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

async function seedNonAdminSession() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "host-metrics-user",
      email: "host-metrics-user@example.test",
      role: "USER",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function callRoute(query = "") {
  const { GET } = await import("@/app/api/admin/host-metrics/route");
  const url = `http://localhost/api/admin/host-metrics${query ? `?${query}` : ""}`;
  return GET(new Request(url) as unknown as Parameters<typeof GET>[0]);
}

describe("GET /api/admin/host-metrics", () => {
  it("rejects anonymous requests with 401", async () => {
    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it("rejects non-admin sessions with 403", async () => {
    await seedNonAdminSession();
    const res = await callRoute();
    expect(res.status).toBe(403);
  });

  it("returns rows within the default 2h window, ordered ascending", async () => {
    await seedAdminSession();
    const prisma = getPrismaClient();

    const now = Date.now();
    // Three rows: 5h ago (filtered out), 90m ago (kept), 30m ago (kept).
    await prisma.hostMetric.createMany({
      data: [
        {
          capturedAt: new Date(now - 5 * 60 * 60_000),
          loadAvg1: 0.1,
          loadAvg5: 0.1,
          loadAvg15: 0.1,
          memUsedBytes: BigInt(1_000_000),
          memTotalBytes: BigInt(8_000_000),
          diskReadBytes: null,
          diskWriteBytes: null,
        },
        {
          capturedAt: new Date(now - 90 * 60_000),
          loadAvg1: 0.5,
          loadAvg5: 0.4,
          loadAvg15: 0.3,
          memUsedBytes: BigInt(2_000_000),
          memTotalBytes: BigInt(8_000_000),
          diskReadBytes: null,
          diskWriteBytes: null,
        },
        {
          capturedAt: new Date(now - 30 * 60_000),
          loadAvg1: 0.7,
          loadAvg5: 0.5,
          loadAvg15: 0.4,
          memUsedBytes: BigInt(4_000_000),
          memTotalBytes: BigInt(8_000_000),
          diskReadBytes: null,
          diskWriteBytes: null,
        },
      ],
    });

    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        samples: Array<{
          capturedAt: string;
          loadAvg1: number;
          memUsedPercent: number;
          diskReadBps: number | null;
          diskWriteBps: number | null;
        }>;
        meta: { since: string; count: number; memTotalBytes: number };
      };
    };

    expect(body.data.samples).toHaveLength(2);
    expect(body.data.samples[0].loadAvg1).toBe(0.5);
    expect(body.data.samples[1].loadAvg1).toBe(0.7);
    // 4_000_000 / 8_000_000 = 50%
    expect(body.data.samples[1].memUsedPercent).toBe(50);
    expect(body.data.meta.since).toBe("2h");
    expect(body.data.meta.count).toBe(2);
    expect(body.data.meta.memTotalBytes).toBe(8_000_000);
  });

  it("derives diskReadBps/diskWriteBps from cumulative byte counters", async () => {
    await seedAdminSession();
    const prisma = getPrismaClient();

    const t0 = new Date(Date.now() - 60 * 60_000); // 1h ago
    const t1 = new Date(t0.getTime() + 60_000); //   59m ago
    const t2 = new Date(t1.getTime() + 60_000); //   58m ago

    await prisma.hostMetric.createMany({
      data: [
        {
          capturedAt: t0,
          loadAvg1: 0,
          loadAvg5: 0,
          loadAvg15: 0,
          memUsedBytes: BigInt(1),
          memTotalBytes: BigInt(2),
          // 1 GiB read, 0.5 GiB written cumulatively at t0.
          diskReadBytes: BigInt(1_073_741_824),
          diskWriteBytes: BigInt(536_870_912),
        },
        {
          capturedAt: t1,
          loadAvg1: 0,
          loadAvg5: 0,
          loadAvg15: 0,
          memUsedBytes: BigInt(1),
          memTotalBytes: BigInt(2),
          // +60 MiB read, +30 MiB written in 60s → 1 MiB/s and 0.5 MiB/s.
          diskReadBytes: BigInt(1_073_741_824 + 60 * 1_048_576),
          diskWriteBytes: BigInt(536_870_912 + 30 * 1_048_576),
        },
        {
          capturedAt: t2,
          loadAvg1: 0,
          loadAvg5: 0,
          loadAvg15: 0,
          memUsedBytes: BigInt(1),
          memTotalBytes: BigInt(2),
          // Counter reset (e.g. host reboot) → bps must be null, not negative.
          diskReadBytes: BigInt(0),
          diskWriteBytes: BigInt(0),
        },
      ],
    });

    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        samples: Array<{
          diskReadBps: number | null;
          diskWriteBps: number | null;
        }>;
      };
    };

    expect(body.data.samples).toHaveLength(3);
    // First row has no predecessor — disk fields are null.
    expect(body.data.samples[0].diskReadBps).toBeNull();
    expect(body.data.samples[0].diskWriteBps).toBeNull();
    // Second row: 60 MiB / 60s = 1 MiB/s ≈ 1_048_576 B/s.
    expect(body.data.samples[1].diskReadBps).toBe(1_048_576);
    expect(body.data.samples[1].diskWriteBps).toBe(524_288);
    // Third row: counter reset → both fields null.
    expect(body.data.samples[2].diskReadBps).toBeNull();
    expect(body.data.samples[2].diskWriteBps).toBeNull();
  });

  it("respects the ?since= preset", async () => {
    await seedAdminSession();
    const prisma = getPrismaClient();
    const now = Date.now();

    await prisma.hostMetric.createMany({
      data: [
        {
          capturedAt: new Date(now - 90 * 60_000), // 90m ago — outside 30m
          loadAvg1: 0.5,
          loadAvg5: 0.5,
          loadAvg15: 0.5,
          memUsedBytes: BigInt(1),
          memTotalBytes: BigInt(2),
          diskReadBytes: null,
          diskWriteBytes: null,
        },
        {
          capturedAt: new Date(now - 10 * 60_000), // 10m ago — inside 30m
          loadAvg1: 0.7,
          loadAvg5: 0.5,
          loadAvg15: 0.5,
          memUsedBytes: BigInt(1),
          memTotalBytes: BigInt(2),
          diskReadBytes: null,
          diskWriteBytes: null,
        },
      ],
    });

    const res = await callRoute("since=30m");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        samples: Array<{ loadAvg1: number }>;
        meta: { since: string; count: number };
      };
    };
    expect(body.data.meta.since).toBe("30m");
    expect(body.data.samples).toHaveLength(1);
    expect(body.data.samples[0].loadAvg1).toBe(0.7);
  });

  it("returns 200 with an empty list when no samples have been written yet", async () => {
    await seedAdminSession();
    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        samples: unknown[];
        meta: { since: string; count: number; memTotalBytes: number };
      };
    };
    expect(body.data.samples).toEqual([]);
    expect(body.data.meta.count).toBe(0);
    expect(body.data.meta.memTotalBytes).toBe(0);
  });
});
