/**
 * The shared write ceiling, against Postgres, on routes that never call it.
 *
 * The bucket is charged where the caller is resolved, so the routes below
 * carry no limiter of their own; a PATCH and a DELETE on an `[id]` met none
 * before. What has to hold: a write is counted, a read is not, a spent bucket
 * refuses with the published code and the headers that describe it and
 * writes nothing, and a bulk route on its own bucket keeps working while the
 * shared one is spent. A POST that reads (`readOverPost`) is not counted on
 * either resolver, and a bucket that cannot be read lets the write through
 * while the limiter itself still fails for its other callers.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  RECORD_WRITE_BUCKET_PREFIX,
  RECORD_WRITE_LIMIT,
} from "@/lib/rate-limit";

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

const USER_ID = "user-write-meter";
const BUCKET = `${RECORD_WRITE_BUCKET_PREFIX}:${USER_ID}`;

async function bucketCount(): Promise<number> {
  const row = await getPrismaClient().rateLimit.findUnique({
    where: { key: BUCKET },
  });
  return row?.count ?? 0;
}

async function spendBucket(): Promise<void> {
  await getPrismaClient().rateLimit.upsert({
    where: { key: BUCKET },
    create: {
      key: BUCKET,
      count: RECORD_WRITE_LIMIT,
      resetAt: new Date(Date.now() + 60_000),
    },
    update: {
      count: RECORD_WRITE_LIMIT,
      resetAt: new Date(Date.now() + 60_000),
    },
  });
}

let allergyId: string;

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "write-meter",
      email: "write-meter@example.test",
      timezone: "UTC",
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  const allergy = await prisma.allergy.create({
    data: {
      userId: USER_ID,
      substance: "Pollen",
      category: "ENVIRONMENT",
      type: "ALLERGY",
      status: "ACTIVE",
    },
  });
  allergyId = allergy.id;
});

function patchAllergy(body: unknown) {
  return import("@/app/api/allergies/[id]/route").then(({ PATCH }) =>
    PATCH(
      new NextRequest(`http://localhost/api/allergies/${allergyId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: allergyId }) },
    ),
  );
}

describe("the shared write bucket on routes without a limiter of their own", () => {
  it("counts a PATCH and a DELETE, and not a GET", async () => {
    const { GET, DELETE } = await import("@/app/api/allergies/[id]/route");

    const read = await GET(
      new NextRequest(`http://localhost/api/allergies/${allergyId}`),
      { params: Promise.resolve({ id: allergyId }) },
    );
    expect(read.status).toBe(200);
    expect(await bucketCount()).toBe(0);

    expect((await patchAllergy({ substance: "Birch pollen" })).status).toBe(
      200,
    );
    expect(await bucketCount()).toBe(1);

    const gone = await DELETE(
      new NextRequest(`http://localhost/api/allergies/${allergyId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: allergyId }) },
    );
    expect(gone.status).toBe(200);
    expect(await bucketCount()).toBe(2);
  });

  it("refuses a write once the bucket is spent, says why, and writes nothing", async () => {
    await spendBucket();

    const res = await patchAllergy({ substance: "Birch pollen" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("record_write.rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(
      String(RECORD_WRITE_LIMIT),
    );

    const row = await getPrismaClient().allergy.findUniqueOrThrow({
      where: { id: allergyId },
    });
    expect(row.substance).toBe("Pollen");
  });

  it("keeps a bulk route on its own bucket working while the shared one is spent", async () => {
    await spendBucket();
    const { POST } = await import("@/app/api/measurements/batch/route");
    const res = await POST(
      new NextRequest("http://localhost/api/measurements/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 72.4,
              unit: "kg",
              startDate: new Date(Date.now() - 3_600_000).toISOString(),
              endDate: new Date(Date.now() - 3_600_000).toISOString(),
              externalId: "uuid-write-meter-weight-1",
            },
          ],
        }),
      }),
    );
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(
      await getPrismaClient().measurement.count({ where: { userId: USER_ID } }),
    ).toBe(1);
  });
});

describe("what the shared bucket does not count", () => {
  async function postThrough(options?: { readOverPost: true }) {
    const { apiHandler, requireAuth } = await import("@/lib/api-handler");
    const { apiSuccess } = await import("@/lib/api-response");
    const POST = apiHandler(async (_request: NextRequest) => {
      const { user } = await requireAuth(undefined, options);
      return apiSuccess({ id: user.id });
    });
    return POST(
      new NextRequest("http://localhost/api/probe", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("leaves a read-over-POST through requireAuth uncounted", async () => {
    expect((await postThrough({ readOverPost: true })).status).toBe(200);
    expect(await bucketCount()).toBe(0);
  });

  it("counter-check: the same POST without the declaration is counted", async () => {
    expect((await postThrough()).status).toBe(200);
    expect(await bucketCount()).toBe(1);
  });
});

describe("a bucket that cannot be read", () => {
  it("lets the write through instead of answering 500, and the limiter still fails for its own callers", async () => {
    const prisma = getPrismaClient();
    const { checkRateLimit } = await import("@/lib/rate-limit");
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "rate_limits" RENAME TO "rate_limits_away"`,
    );
    try {
      const res = await patchAllergy({ substance: "Birch pollen" });
      expect(res.status, await res.clone().text()).toBe(200);
      const row = await prisma.allergy.findUniqueOrThrow({
        where: { id: allergyId },
      });
      expect(row.substance).toBe("Birch pollen");

      // A login or sign-up limit calls the limiter directly: no fail-open.
      await expect(
        checkRateLimit("auth:login:probe", 5, 60_000),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "rate_limits_away" RENAME TO "rate_limits"`,
      );
    }
  });
});
