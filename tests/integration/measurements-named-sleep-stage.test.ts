/**
 * `POST /api/measurements` with a named `sleepStage`, against real Postgres.
 *
 * A bridge (Tasker, Home Assistant) sends one segment with the stage by name
 * and its narrow `measurements:write` token. What this pins:
 *
 *   - the row is the row the batch route writes for the same segment:
 *     SLEEP_DURATION, minutes, `measuredAt` at the segment's end, the stage;
 *   - re-posting the same segment is one row, whether the bridge sends an id
 *     or not, and whichever of the two routes it used first;
 *   - a corrected start updates the row instead of adding a second one;
 *   - the scoped token's source rule still holds: rows carry EXTERNAL, and a
 *     body naming any source is refused;
 *   - a body the shape does not describe is a 422 with every issue listed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-named-sleep-stage-ingest-32-bytes-min-0123456789";

const { hashToken } = await import("@/lib/auth/hmac");

const USER_ID = "user-named-sleep-stage";

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

const { POST } = await import("@/app/api/measurements/route");
const { POST: POST_BATCH } = await import("@/app/api/measurements/batch/route");

let token = "";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "named-sleep",
      email: "named-sleep@example.test",
      timezone: "UTC",
    },
  });
  token = `hlk_sleepstage_${"0".repeat(48)}`;
  await prisma.apiToken.create({
    data: {
      userId: USER_ID,
      name: "bridge",
      tokenHash: hashToken(token),
      permissions: ["measurements:write"],
    },
  });
  headerJar.set("authorization", `Bearer ${token}`);
});

function post(body: unknown, url = "https://health.example/api/measurements") {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const END = new Date(Date.now() - 6 * 3_600_000);
END.setUTCSeconds(0, 0);
const START = new Date(END.getTime() - 42 * 60_000);

function rows() {
  return getPrismaClient().measurement.findMany({
    where: { userId: USER_ID, type: "SLEEP_DURATION" },
    orderBy: { measuredAt: "asc" },
  });
}

type Created = {
  data: {
    id: string;
    status: string;
    type: string;
    value: number;
    unit: string;
    sleepStage: string | null;
    source: string;
    measuredAt: string;
    externalId: string | null;
  };
};

describe("POST /api/measurements — named sleep stage", () => {
  it("stores a start/end segment as the batch route would", async () => {
    const res = await POST(
      post({
        type: "SLEEP_DURATION",
        sleepStage: "REM",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    expect(body.data).toMatchObject({
      status: "inserted",
      type: "SLEEP_DURATION",
      value: 42,
      unit: "minutes",
      sleepStage: "REM",
      source: "EXTERNAL",
      measuredAt: END.toISOString(),
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      value: 42,
      unit: "minutes",
      sleepStage: "REM",
      source: "EXTERNAL",
    });
    expect(row!.measuredAt.toISOString()).toBe(END.toISOString());
    expect(row!.externalId).toBe(
      `sleep-stage:REM:${START.toISOString()}/${END.toISOString()}`,
    );
  });

  it("accepts the end-and-length form and lands on the same row", async () => {
    const first = await POST(
      post({
        type: "SLEEP_DURATION",
        sleepStage: "DEEP",
        measuredAt: END.toISOString(),
        value: 42,
      }),
    );
    expect(first.status).toBe(201);
    const second = await POST(
      post({
        type: "SLEEP_DURATION",
        sleepStage: "DEEP",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
      }),
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as Created).data.status).toBe("duplicate");
    expect(await rows()).toHaveLength(1);
  });

  it("answers a re-post of the same segment with the stored row, not a second one", async () => {
    const body = {
      type: "SLEEP_DURATION",
      sleepStage: "CORE",
      startDate: START.toISOString(),
      endDate: END.toISOString(),
    };
    const first = (await (await POST(post(body))).json()) as Created;
    const again = await POST(post(body));
    expect(again.status).toBe(200);
    const second = (await again.json()) as Created;
    expect(second.data.status).toBe("duplicate");
    expect(second.data.id).toBe(first.data.id);
    expect(await rows()).toHaveLength(1);
  });

  it("updates the row when the same segment comes back with a corrected start", async () => {
    await POST(
      post({
        type: "SLEEP_DURATION",
        sleepStage: "AWAKE",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
      }),
    );
    const corrected = await POST(
      post({
        type: "SLEEP_DURATION",
        sleepStage: "AWAKE",
        startDate: new Date(START.getTime() + 12 * 60_000).toISOString(),
        endDate: END.toISOString(),
      }),
    );
    expect(corrected.status).toBe(200);
    expect(((await corrected.json()) as Created).data.status).toBe("updated");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.value).toBe(30);
  });

  it("keeps two stages that end at the same instant apart", async () => {
    for (const sleepStage of ["IN_BED", "ASLEEP"]) {
      const res = await POST(
        post({
          type: "SLEEP_DURATION",
          sleepStage,
          startDate: START.toISOString(),
          endDate: END.toISOString(),
        }),
      );
      expect(res.status).toBe(201);
    }
    expect((await rows()).map((r) => r.sleepStage).sort()).toEqual([
      "ASLEEP",
      "IN_BED",
    ]);
  });

  it("dedupes against the batch route: same source, same id, one row", async () => {
    const externalId = "tasker-night-1-rem";
    const viaBatch = await POST_BATCH(
      post(
        {
          entries: [
            {
              hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
              value: 42,
              unit: "min",
              startDate: START.toISOString(),
              endDate: END.toISOString(),
              sleepStage: 5,
              externalId,
            },
          ],
        },
        "https://health.example/api/measurements/batch",
      ),
    );
    expect(viaBatch.status).toBe(200);
    const viaNamed = await POST(
      post({
        type: "SLEEP_DURATION",
        sleepStage: "REM",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
        externalId,
      }),
    );
    expect(viaNamed.status).toBe(200);
    expect(((await viaNamed.json()) as Created).data.status).toBe("duplicate");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ sleepStage: "REM", source: "EXTERNAL" });
  });

  it("keeps a bridge segment apart from the same reading from Apple Health", async () => {
    // A scoped credential's rows carry their own source (EXTERNAL), so a
    // bridge and the phone reporting the same night are two sources, and
    // the sleep source priority picks one per night. Only MANUAL and
    // APPLE_HEALTH merge as one reading.
    await getPrismaClient().measurement.create({
      data: {
        userId: USER_ID,
        type: "SLEEP_DURATION",
        value: 42,
        unit: "minutes",
        source: "APPLE_HEALTH",
        measuredAt: END,
        sleepStage: "REM",
        externalId: "hk-uuid-1",
      },
    });
    const res = await POST(
      post({
        type: "SLEEP_DURATION",
        sleepStage: "REM",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
      }),
    );
    expect(res.status).toBe(201);
    const all = await rows();
    expect(all.map((r) => r.source).sort()).toEqual([
      "APPLE_HEALTH",
      "EXTERNAL",
    ]);
  });

  it("refuses a body naming MANUAL from the scoped token", async () => {
    const res = await POST(
      post({
        type: "SLEEP_DURATION",
        sleepStage: "REM",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
        source: "MANUAL",
      }),
    );
    expect(res.status).toBe(422);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses APPLE_HEALTH from the scoped token", async () => {
    const res = await POST(
      post({
        type: "SLEEP_DURATION",
        sleepStage: "REM",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
        source: "APPLE_HEALTH",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe(
      "measurement.create.source_not_permitted",
    );
    expect(await rows()).toHaveLength(0);
  });

  it("refuses an unknown stage, a missing end, a mismatched value and an unstable id, listing each", async () => {
    for (const body of [
      {
        type: "SLEEP_DURATION",
        sleepStage: "LIGHT",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
      },
      {
        type: "SLEEP_DURATION",
        sleepStage: "REM",
        startDate: START.toISOString(),
      },
      {
        type: "SLEEP_DURATION",
        sleepStage: "REM",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
        value: 90,
      },
      {
        type: "SLEEP_DURATION",
        sleepStage: "REM",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
        externalId: "0xdeadbeef",
      },
      {
        type: "WEIGHT",
        sleepStage: "REM",
        measuredAt: END.toISOString(),
        value: 70,
      },
    ]) {
      const res = await POST(post(body));
      expect(res.status).toBe(422);
      const parsed = (await res.json()) as {
        details?: { issues: unknown[] };
        meta?: { errorCode?: string };
      };
      expect(parsed.meta?.errorCode).toBe("measurement.create.invalid");
      expect(parsed.details?.issues.length).toBeGreaterThan(0);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("leaves the plain single create untouched", async () => {
    const res = await POST(
      post({
        type: "SLEEP_DURATION",
        value: 420,
        measuredAt: END.toISOString(),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: Record<string, unknown>;
    };
    expect(body.data).not.toHaveProperty("status");
    expect(body.data.sleepStage).toBeNull();
  });
});
