/**
 * v1.4.30 — `POST /api/admin/drain-per-sample-cumulative` real-
 * Postgres integration. The library-level helper rides
 * `tests/integration/drain-per-sample-cumulative.test.ts`; this
 * suite pins the route's admin gate + payload shape + audit log
 * trail end-to-end.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const ADMIN_USER_ID = "user-admin-drain";
const STANDARD_USER_ID = "user-standard-drain";

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
  await getPrismaClient().user.createMany({
    data: [
      {
        id: ADMIN_USER_ID,
        username: "admin-drain",
        email: "admin-drain@example.test",
        role: "ADMIN",
        timezone: "Europe/Berlin",
      },
      {
        id: STANDARD_USER_ID,
        username: "standard-drain",
        email: "standard-drain@example.test",
        role: "USER",
        timezone: "Europe/Berlin",
      },
    ],
  });
});

async function setSessionFor(userId: string): Promise<void> {
  const session = await getPrismaClient().session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", session.id);
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/admin/drain-per-sample-cumulative",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/admin/drain-per-sample-cumulative (real Postgres)", () => {
  it("returns 403 when the session belongs to a standard (non-admin) user", async () => {
    await setSessionFor(STANDARD_USER_ID);
    const { POST } = await import(
      "@/app/api/admin/drain-per-sample-cumulative/route"
    );
    const res = await POST(makeRequest({ dryRun: true }));
    expect(res.status).toBe(403);
  });

  it("dry-runs by default and reports buckets without writing", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: STANDARD_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 1200,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-uuid-1",
        },
        {
          userId: STANDARD_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 800,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T14:00:00.000Z"),
          externalId: "hk-uuid-2",
        },
      ],
    });

    await setSessionFor(ADMIN_USER_ID);
    const { POST } = await import(
      "@/app/api/admin/drain-per-sample-cumulative/route"
    );
    // No body = dryRun defaults to true.
    const res = await POST(makeRequest({ userId: STANDARD_USER_ID }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        dryRun: boolean;
        totals: { bucketsCollapsed: number };
      };
    };
    expect(json.data.dryRun).toBe(true);
    expect(json.data.totals.bucketsCollapsed).toBe(1);

    // DB unchanged.
    const remaining = await prisma.measurement.findMany({
      where: { userId: STANDARD_USER_ID, type: "ACTIVITY_STEPS" },
    });
    expect(remaining).toHaveLength(2);
  });

  it("commits when dryRun=false is passed explicitly", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: STANDARD_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 1200,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-uuid-1",
        },
        {
          userId: STANDARD_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 800,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T14:00:00.000Z"),
          externalId: "hk-uuid-2",
        },
      ],
    });

    await setSessionFor(ADMIN_USER_ID);
    const { POST } = await import(
      "@/app/api/admin/drain-per-sample-cumulative/route"
    );
    const res = await POST(
      makeRequest({ userId: STANDARD_USER_ID, dryRun: false }),
    );
    expect(res.status).toBe(200);

    const remaining = await prisma.measurement.findMany({
      where: { userId: STANDARD_USER_ID, type: "ACTIVITY_STEPS" },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].value).toBe(2000);
    expect(remaining[0].externalId).toBe(
      "stats:HKQuantityTypeIdentifierStepCount:2026-05-16",
    );
  });
});
