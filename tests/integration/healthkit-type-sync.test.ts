/**
 * Per-type HealthKit arrival ledger (#1173), against real Postgres.
 *
 * The Apple Health card used to show only when each type's newest SAMPLE was
 * taken. A type the phone hands over only on "Sync all" can carry a reading
 * from this morning and still never arrive in the background, so the card
 * needs when the server RECEIVED each type and under which trigger. These
 * cases pin the batch route's write, the duplicate rule for
 * `lastNewSampleAt`, the scoped-credential exclusion, and the status read
 * that serves it, including the newest-sample probe that replaced the
 * grouped read.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-healthkit-type-sync-32-bytes-minimum-123456";

const { hashToken } = await import("@/lib/auth/hmac");

const USER_ID = "user-healthkit-type-sync";

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
      id: USER_ID,
      username: "healthkit-type-sync",
      email: "healthkit-type-sync@example.test",
      timezone: "UTC",
    },
  });
});

async function armSession(): Promise<void> {
  const session = await getPrismaClient().session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

function entry(
  hkIdentifier: string,
  value: number,
  unit: string,
  at: string,
  externalId: string,
) {
  return { hkIdentifier, value, unit, startDate: at, endDate: at, externalId };
}

async function postBatch(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { POST } = await import("@/app/api/measurements/batch/route");
  return POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const T1 = "2026-10-01T06:00:00.000Z";
const T2 = "2026-10-01T07:00:00.000Z";

describe("per-type arrival ledger (#1173)", () => {
  it("records each type a batch carried, with its trigger", async () => {
    await armSession();
    const res = await postBatch({
      syncTrigger: "manual",
      entries: [
        entry("HKQuantityTypeIdentifierBodyMass", 70, "kg", T1, "uuid-w1"),
        entry(
          "HKQuantityTypeIdentifierHeartRate",
          61,
          "count/min",
          T1,
          "uuid-p1",
        ),
        entry(
          "HKQuantityTypeIdentifierHeartRate",
          63,
          "count/min",
          T2,
          "uuid-p2",
        ),
      ],
    });
    expect(res.status).toBe(200);

    const rows = await getPrismaClient().healthKitTypeSync.findMany({
      where: { userId: USER_ID },
      orderBy: { type: "asc" },
    });
    expect(rows.map((row) => row.type).sort()).toEqual(["PULSE", "WEIGHT"]);
    for (const row of rows) {
      expect(row.lastTrigger).toBe("manual");
      expect(row.lastNewSampleAt?.toISOString()).toBe(
        row.lastReceivedAt.toISOString(),
      );
      // Stored as the instant it is, whatever zone the process runs in.
      expect(Math.abs(row.lastReceivedAt.getTime() - Date.now())).toBeLessThan(
        60_000,
      );
    }
  });

  it("moves the arrival but keeps the last new value on a duplicates-only re-send", async () => {
    await armSession();
    const weight = entry(
      "HKQuantityTypeIdentifierBodyMass",
      70,
      "kg",
      T1,
      "uuid-w1",
    );
    await postBatch({ syncTrigger: "foreground", entries: [weight] });
    const first = await getPrismaClient().healthKitTypeSync.findUniqueOrThrow({
      where: { userId_type: { userId: USER_ID, type: "WEIGHT" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await postBatch({ syncTrigger: "background", entries: [weight] });
    const second = await getPrismaClient().healthKitTypeSync.findUniqueOrThrow({
      where: { userId_type: { userId: USER_ID, type: "WEIGHT" } },
    });

    expect(second.lastTrigger).toBe("background");
    expect(second.lastReceivedAt.getTime()).toBeGreaterThan(
      first.lastReceivedAt.getTime(),
    );
    expect(second.lastNewSampleAt?.toISOString()).toBe(
      first.lastNewSampleAt?.toISOString(),
    );
  });

  it("stores a missing trigger as null rather than keeping the previous one", async () => {
    await armSession();
    await postBatch({
      syncTrigger: "push",
      entries: [
        entry("HKQuantityTypeIdentifierBodyMass", 70, "kg", T1, "uuid-w1"),
      ],
    });
    await postBatch({
      entries: [
        entry("HKQuantityTypeIdentifierBodyMass", 71, "kg", T2, "uuid-w2"),
      ],
    });
    const row = await getPrismaClient().healthKitTypeSync.findUniqueOrThrow({
      where: { userId_type: { userId: USER_ID, type: "WEIGHT" } },
    });
    expect(row.lastTrigger).toBeNull();
  });

  it("records nothing for MANUAL rows or for a scoped credential", async () => {
    await armSession();
    await postBatch({
      syncTrigger: "foreground",
      entries: [
        {
          ...entry(
            "HKQuantityTypeIdentifierBodyMass",
            70,
            "kg",
            T1,
            "manual-w1",
          ),
          source: "MANUAL",
        },
      ],
    });
    cookieJar.clear();

    const raw = `hlk_typesync_${"0".repeat(48)}`;
    await getPrismaClient().apiToken.create({
      data: {
        userId: USER_ID,
        name: "bridge",
        tokenHash: hashToken(raw),
        permissions: ["measurements:write"],
      },
    });
    headerJar.set("authorization", `Bearer ${raw}`);
    const res = await postBatch(
      {
        syncTrigger: "background",
        entries: [
          entry("HKQuantityTypeIdentifierBodyMass", 72, "kg", T2, "uuid-b1"),
        ],
      },
      { authorization: `Bearer ${raw}` },
    );
    expect(res.status).toBe(200);

    expect(
      await getPrismaClient().healthKitTypeSync.count({
        where: { userId: USER_ID },
      }),
    ).toBe(0);
  });

  it("serves the arrival facts beside the newest live sample", async () => {
    await armSession();
    await postBatch({
      syncTrigger: "manual",
      entries: [
        entry(
          "HKQuantityTypeIdentifierRespiratoryRate",
          14,
          "count/min",
          T1,
          "uuid-r1",
        ),
        entry(
          "HKQuantityTypeIdentifierRespiratoryRate",
          15,
          "count/min",
          T2,
          "uuid-r2",
        ),
      ],
    });
    // A type that came only from the export import: live rows, no arrival.
    await getPrismaClient().measurement.create({
      data: {
        userId: USER_ID,
        type: "WEIGHT",
        value: 70,
        unit: "kg",
        measuredAt: new Date(T1),
        source: "APPLE_HEALTH",
        externalId: "xml-w1",
      },
    });
    // The newest respiratory row is a tombstone; the read must skip it.
    await getPrismaClient().measurement.updateMany({
      where: { userId: USER_ID, externalId: "uuid-r2" },
      data: { deletedAt: new Date() },
    });

    const { GET } = await import("@/app/api/integrations/healthkit/route");
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/integrations/healthkit"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        metricFreshness: Array<{
          type: string;
          lastSeenAt: string;
          lastReceivedAt?: string | null;
          lastTrigger?: string | null;
        }>;
      };
    };
    const byType = Object.fromEntries(
      body.data.metricFreshness.map((row) => [row.type, row]),
    );
    expect(byType.RESPIRATORY_RATE.lastSeenAt).toBe(T1);
    expect(byType.RESPIRATORY_RATE.lastTrigger).toBe("manual");
    expect(byType.RESPIRATORY_RATE.lastReceivedAt).toEqual(expect.any(String));
    expect(byType.WEIGHT).toMatchObject({
      lastSeenAt: T1,
      lastReceivedAt: null,
      lastTrigger: null,
    });
  });
});
