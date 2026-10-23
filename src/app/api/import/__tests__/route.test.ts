import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => {
  const prisma = {
    measurement: {
      create: vi.fn(),
      createManyAndReturn: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    moodEntry: { create: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    // A mood entry is written in a transaction with its links and context;
    // the callback runs against this same client. Given as the mock's own
    // implementation, so `resetAllMocks` keeps it.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging/context")>()),
  annotate: vi.fn(),
}));

const { encryptNoteMock } = vi.hoisted(() => ({ encryptNoteMock: vi.fn() }));

vi.mock("@/lib/crypto/note-cipher", () => ({
  encryptNote: encryptNoteMock,
}));

vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn(),
}));

vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: vi.fn(),
}));
// v1.4.39.1 — surface the rollup hook so the new regression test can
// assert that the import path now folds the persistent rollup tier
// for each touched (type, day). Mood rollup mock stays no-op because
// the existing v1.4.39 W-MOOD hook already covers the import branch.
vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  const perKey = vi.fn().mockResolvedValue(undefined);
  return {
    ...actual,
    recomputeBucketsForMeasurement: perKey,
    // The keyed refold, observed as the per-key recomputes it stands for.
    recomputeBucketsForKeys: vi.fn(
      async (
        userId: string,
        keys: Array<{ type: string; measuredAt: Date }>,
      ) => {
        for (const k of keys) await perKey(userId, k.type, k.measuredAt);
      },
    ),
  };
});

vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeUserMoodRollups: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { Prisma } from "@/generated/prisma/client";
import { auditLog } from "@/lib/auth/audit";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurement.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.moodEntry.findUnique).mockResolvedValue(null);
  vi.mocked(emitInsertedMeasurementArrivals).mockResolvedValue(undefined);
  vi.mocked(maybeEnqueueMorningRefresh).mockResolvedValue(undefined);
  encryptNoteMock.mockImplementation((note: string | null) =>
    note === null ? null : `encrypted:${note}`,
  );
});

interface ApiErrorEnvelope {
  data: null;
  error: string;
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

// V3 audit: /api/import POST had no rate-limit. Bulk-injection vector
// (max:10000 records per call). Now capped at 5/hour/user.
describe("POST /api/import — rate-limit guard", () => {
  it("returns 429 when the user has exhausted the 5/hour quota (HIGH coverage gap)", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({ measurements: [] }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(429);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/per hour/i);
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("import:u-1"),
      5,
      60 * 60 * 1000,
    );
  });

  it("processes the request when within the quota", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({ measurements: [] }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
  });

  it("rejects a body over the 16 MB cap with 413 before parsing", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [],
          pad: "x".repeat(16 * 1024 * 1024),
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(413);
  });

  it("returns the standard apiError envelope for invalid payloads", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({ measurements: "not-an-array" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.data).toBeNull();
    expect(body.error).toBeTruthy();
  });
});

// v1.4.39.1 — the import path used to write measurements without
// firing the rollup hook, so the dashboard chart's `source=rollup`
// fast-path silently under-counted any imported days until the next
// worker boot ran the backfill discovery. Cover the wiring with a
// regression test so a future refactor can't silently drop it again.
describe("POST /api/import — measurement rollup hook (v1.4.39.1)", () => {
  it("folds the persistent rollup table for each (type, day) the import touched", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "BLOOD_PRESSURE_SYS",
              value: 124,
              unit: "mmHg",
              measuredAt: "2026-05-12T07:30:00.000Z",
            },
            {
              type: "BLOOD_PRESSURE_SYS",
              value: 121,
              unit: "mmHg",
              measuredAt: "2026-05-12T19:30:00.000Z",
            },
            {
              type: "BLOOD_PRESSURE_SYS",
              value: 119,
              unit: "mmHg",
              measuredAt: "2026-05-14T08:00:00.000Z",
            },
            {
              type: "WEIGHT",
              value: 82.4,
              unit: "kg",
              measuredAt: "2026-05-14T07:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    // Two BP rows on 2026-05-12 collapse to one rollup call; one BP
    // row on 2026-05-14 is its own call; one WEIGHT row on 2026-05-14
    // is a separate (type, day) pair. Total = 3 distinct rollup folds.
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(3);
    const calls = vi
      .mocked(recomputeBucketsForMeasurement)
      .mock.calls.map((c) => `${c[1]}|${(c[2] as Date).toISOString()}`);
    expect(new Set(calls)).toEqual(
      new Set([
        "BLOOD_PRESSURE_SYS|2026-05-12T00:00:00.000Z",
        "BLOOD_PRESSURE_SYS|2026-05-14T00:00:00.000Z",
        "WEIGHT|2026-05-14T00:00:00.000Z",
      ]),
    );
  });

  it("does not call the rollup hook when no measurements were written", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
    vi.mocked(prisma.measurement.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 82.4,
              unit: "kg",
              measuredAt: "2026-05-14T07:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    // Every measurement raised a duplicate — no rollup fold needed.
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });
});

describe("POST /api/import — arrival wiring", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
  });

  it("emits and refreshes only a newly inserted sleep row", async () => {
    const measuredAt = new Date("2026-05-14T06:00:00.000Z");
    const created = {
      id: "sleep-new",
      type: "SLEEP_DURATION" as const,
      measuredAt,
    };
    vi.mocked(prisma.measurement.create).mockResolvedValue(created as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "SLEEP_DURATION",
              value: 480,
              unit: "min",
              measuredAt: measuredAt.toISOString(),
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(emitInsertedMeasurementArrivals).toHaveBeenCalledWith(
      "u-1",
      [created],
      "json_import",
    );
    expect(maybeEnqueueMorningRefresh).toHaveBeenCalledWith("u-1", [
      measuredAt,
    ]);
  });

  it("emits and refreshes an external-id row only when INSERT returns it", async () => {
    const measuredAt = new Date("2026-05-14T06:00:00.000Z");
    const inserted = {
      id: "sleep-inserted",
      type: "SLEEP_DURATION" as const,
      measuredAt,
    };
    vi.mocked(prisma.measurement.createManyAndReturn).mockResolvedValue([
      inserted,
    ] as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "SLEEP_DURATION",
              value: 480,
              unit: "min",
              measuredAt: measuredAt.toISOString(),
              externalId: "sleep-new",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(emitInsertedMeasurementArrivals).toHaveBeenCalledWith(
      "u-1",
      [inserted],
      "json_import",
    );
    expect(maybeEnqueueMorningRefresh).toHaveBeenCalledWith("u-1", [
      measuredAt,
    ]);
  });

  it("does not emit or refresh when INSERT loses a race and returns no row", async () => {
    vi.mocked(prisma.measurement.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.measurement.createManyAndReturn).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.measurement.update).mockResolvedValue({
      id: "raced-winner",
      type: "SLEEP_DURATION",
      measuredAt: new Date("2026-05-14T06:00:00.000Z"),
    } as never);
    vi.mocked(prisma.measurement.upsert).mockResolvedValue({
      id: "raced-winner",
      type: "SLEEP_DURATION",
      measuredAt: new Date("2026-05-14T06:00:00.000Z"),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "SLEEP_DURATION",
              value: 480,
              unit: "min",
              measuredAt: "2026-05-14T06:00:00.000Z",
              externalId: "sleep-raced",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(emitInsertedMeasurementArrivals).toHaveBeenCalledWith(
      "u-1",
      [],
      "json_import",
    );
    expect(maybeEnqueueMorningRefresh).toHaveBeenCalledWith("u-1", []);
  });

  it("does not emit or refresh an existing external-id update", async () => {
    vi.mocked(prisma.measurement.createManyAndReturn).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.measurement.update).mockResolvedValue({
      id: "existing",
      type: "SLEEP_DURATION",
      measuredAt: new Date("2026-05-14T06:00:00.000Z"),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "SLEEP_DURATION",
              value: 480,
              unit: "min",
              measuredAt: "2026-05-14T06:00:00.000Z",
              externalId: "sleep-existing",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(emitInsertedMeasurementArrivals).toHaveBeenCalledWith(
      "u-1",
      [],
      "json_import",
    );
    expect(maybeEnqueueMorningRefresh).toHaveBeenCalledWith("u-1", []);
  });
});

// v1.17.1 — two real bugs the data-portability audit found in the JSON
// import. Regression guards so a future refactor can't silently re-open
// them.
describe("POST /api/import — entry-instant bound (v1.17.1)", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);
  });

  it("rejects a future-dated measurement (previously accepted)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            { type: "WEIGHT", value: 80, unit: "kg", measuredAt: future },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(422);
    expect(vi.mocked(prisma.measurement.create)).not.toHaveBeenCalled();
  });

  it("rejects a pre-1900 measurement", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 80,
              unit: "kg",
              measuredAt: "1899-01-01T00:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(422);
  });

  it("accepts a backdated (past) measurement", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 80,
              unit: "kg",
              measuredAt: "2020-01-01T08:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBeLessThan(400);
    expect(vi.mocked(prisma.measurement.create)).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/import — measurement externalId dedup (v1.17.1)", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
  });

  it("updates in place when an external-id INSERT returns no row", async () => {
    vi.mocked(prisma.measurement.createManyAndReturn).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.measurement.update).mockResolvedValue({} as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 80,
              unit: "kg",
              measuredAt: "2026-05-01T08:00:00.000Z",
              externalId: "scale-row-42",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(
      vi.mocked(prisma.measurement.createManyAndReturn),
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.measurement.create)).not.toHaveBeenCalled();
    const arg = vi.mocked(prisma.measurement.update).mock.calls[0][0];
    expect(arg.where).toEqual({
      userId_type_source_externalId: {
        userId: "u-1",
        type: "WEIGHT",
        source: "IMPORT",
        externalId: "scale-row-42",
      },
    });
  });

  it("still creates (first-write-wins) when no externalId is present", async () => {
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 80,
              unit: "kg",
              measuredAt: "2026-05-01T08:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(vi.mocked(prisma.measurement.create)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.measurement.upsert)).not.toHaveBeenCalled();
  });
});

describe("POST /api/import — write failure classification", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
  });

  function request(body: Record<string, unknown>): NextRequest {
    return new NextRequest("http://localhost/api/import", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  function measurement(value = 80): Record<string, unknown> {
    return {
      type: "WEIGHT",
      value,
      unit: "kg",
      measuredAt: "2026-05-01T08:00:00.000Z",
    };
  }

  function moodEntry(): Record<string, unknown> {
    return {
      date: "2026-05-01",
      mood: "GUT",
      score: 4,
      loggedAt: "2026-05-01T12:00:00.000Z",
    };
  }

  function expectRetryableFailure(
    body: unknown,
    stats: { measurements: number; moodEntries: number; skipped: number },
  ): void {
    expect(body).toEqual({
      data: null,
      error: "Import write failed",
      meta: {
        errorCode: "import.write_failed",
        retryable: true,
        stats,
      },
    });
  }

  it("counts an authentic P2002 measurement error as a duplicate", async () => {
    vi.mocked(prisma.measurement.create).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: {
          target: ["userId", "type", "measuredAt", "source", "sleepStage"],
        },
      }),
    );

    const response = await POST(request({ measurements: [measurement()] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { measurements: 0, moodEntries: 0, skipped: 1 },
      error: null,
    });
  });

  it("counts an authentic P2002 mood error as a duplicate", async () => {
    vi.mocked(prisma.moodEntry.create).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: {
          target: ["userId", "date", "moodLoggedAt"],
        },
      }),
    );

    const response = await POST(request({ moodEntries: [moodEntry()] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { measurements: 0, moodEntries: 0, skipped: 1 },
      error: null,
    });
  });

  it("skips an external-id insert race lost on timestamp", async () => {
    vi.mocked(prisma.measurement.createManyAndReturn).mockResolvedValueOnce(
      [] as never,
    );
    vi.mocked(prisma.measurement.update).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Record to update not found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );

    const response = await POST(
      request({
        measurements: [{ ...measurement(), externalId: "new-source-id" }],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { measurements: 0, moodEntries: 0, skipped: 1 },
      error: null,
    });
  });

  it("returns retryable counts on database timeout", async () => {
    vi.mocked(prisma.measurement.create)
      .mockResolvedValueOnce({
        id: "measurement-1",
        type: "WEIGHT",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"),
      } as never)
      .mockRejectedValueOnce(
        new Prisma.PrismaClientInitializationError(
          "Operations timed out",
          "test",
          "P1008",
        ),
      );

    const response = await POST(
      request({ measurements: [measurement(80), measurement(81)] }),
    );

    expect(response.status).toBe(503);
    expectRetryableFailure(await response.json(), {
      measurements: 1,
      moodEntries: 0,
      skipped: 0,
    });
  });

  it("returns retryable counts on connection loss", async () => {
    vi.mocked(prisma.measurement.create).mockResolvedValueOnce({
      id: "measurement-1",
      type: "WEIGHT",
      measuredAt: new Date("2026-05-01T08:00:00.000Z"),
    } as never);
    vi.mocked(prisma.moodEntry.create).mockRejectedValueOnce(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server",
        "test",
        "P1001",
      ),
    );

    const response = await POST(
      request({
        measurements: [measurement()],
        moodEntries: [moodEntry()],
      }),
    );

    expect(response.status).toBe(503);
    expectRetryableFailure(await response.json(), {
      measurements: 1,
      moodEntries: 0,
      skipped: 0,
    });
  });

  it("returns a retryable failure when note encryption fails", async () => {
    encryptNoteMock.mockImplementationOnce(() => {
      throw new Error("Encryption key unavailable");
    });

    const response = await POST(
      request({
        measurements: [{ ...measurement(), notes: "private note" }],
      }),
    );

    expect(response.status).toBe(503);
    expectRetryableFailure(await response.json(), {
      measurements: 0,
      moodEntries: 0,
      skipped: 0,
    });
  });

  it("resumes a partially committed legacy mood import without duplicates", async () => {
    type LegacyMoodWrite = { date: string; moodLoggedAt: Date };

    const committedKeys = new Set<string>();
    let writeAttempt = 0;
    const writeMood = async (
      data: LegacyMoodWrite,
      target: Set<string>,
    ): Promise<never> => {
      writeAttempt++;
      if (writeAttempt === 2) {
        throw new Error("transient write failure");
      }

      const key = `${data.date}:${data.moodLoggedAt.toISOString()}`;
      if (target.has(key)) {
        throw new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed",
          {
            code: "P2002",
            clientVersion: "test",
            meta: { target: ["userId", "date", "moodLoggedAt"] },
          },
        );
      }
      target.add(key);
      return {} as never;
    };

    vi.mocked(prisma.moodEntry.create).mockImplementation(
      ({ data }: Prisma.MoodEntryCreateArgs) =>
        writeMood(data as LegacyMoodWrite, committedKeys) as never,
    );
    vi.mocked(prisma.moodEntry.findUnique).mockImplementation(
      ({ where }: Prisma.MoodEntryFindUniqueArgs) => {
        const composite = where.userId_date_moodLoggedAt!;
        const key = `${composite.date}:${asDate(composite.moodLoggedAt).toISOString()}`;
        if (!committedKeys.has(key)) return Promise.resolve(null) as never;
        const isFirstDay = composite.date === "2026-05-01";
        return Promise.resolve({
          source: "IMPORT",
          mood: isFirstDay ? "GUT" : "OKAY",
          score: isFirstDay ? 4 : 3,
          tags: null,
          externalId: null,
        } as never) as never;
      },
    );

    const payload = {
      moodEntries: [
        { date: "2026-05-01", mood: "GUT", score: 4 },
        { date: "2026-05-02", mood: "OKAY", score: 3 },
      ],
    };

    const failedResponse = await POST(request(payload));
    expect(failedResponse.status).toBe(503);
    expectRetryableFailure(await failedResponse.json(), {
      measurements: 0,
      moodEntries: 1,
      skipped: 0,
    });
    expect(committedKeys.size).toBe(1);

    const retryResponse = await POST(request(payload));

    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toEqual({
      data: { measurements: 0, moodEntries: 1, skipped: 1 },
      error: null,
    });
    expect(committedKeys.size).toBe(2);
  });

  it("does not alias unrelated date-only mood imports", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T08:00:00.000Z"));
      const committedKeys = new Set<string>();
      vi.mocked(prisma.moodEntry.create).mockImplementation(
        ({ data }: Prisma.MoodEntryCreateArgs) => {
          const key = `${data.date}:${asDate(data.moodLoggedAt).toISOString()}`;
          if (committedKeys.has(key)) {
            return Promise.reject(
              new Prisma.PrismaClientKnownRequestError(
                "Unique constraint failed",
                {
                  code: "P2002",
                  clientVersion: "test",
                  meta: { target: ["userId", "date", "moodLoggedAt"] },
                },
              ),
            ) as never;
          }
          committedKeys.add(key);
          return Promise.resolve({} as never) as never;
        },
      );

      const firstResponse = await POST(
        request({
          moodEntries: [{ date: "2026-05-10", mood: "GUT", score: 4 }],
        }),
      );
      vi.advanceTimersByTime(1000);
      const secondResponse = await POST(
        request({
          moodEntries: [{ date: "2026-05-10", mood: "SCHLECHT", score: 2 }],
        }),
      );

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(await secondResponse.json()).toEqual({
        data: { measurements: 0, moodEntries: 1, skipped: 0 },
        error: null,
      });
      expect(committedKeys.size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors a date-only mood row to its recorded day", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T08:00:00.000Z"));
      vi.mocked(prisma.moodEntry.create).mockResolvedValue({} as never);

      const response = await POST(
        request({
          moodEntries: [{ date: "2026-05-01", mood: "GUT", score: 4 }],
        }),
      );

      expect(response.status).toBe(200);
      const moodLoggedAt = asDate(
        vi.mocked(prisma.moodEntry.create).mock.calls[0][0].data.moodLoggedAt,
      );
      expect(moodLoggedAt.getTime()).toBeGreaterThanOrEqual(
        Date.parse("2026-04-30T22:00:00.000Z"),
      );
      expect(moodLoggedAt.getTime()).toBeLessThan(
        Date.parse("2026-04-30T22:05:00.000Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts the current Berlin day shortly after local midnight", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T22:30:00.000Z"));
      vi.mocked(prisma.moodEntry.create).mockResolvedValue({} as never);

      const response = await POST(
        request({
          moodEntries: [{ date: "2026-05-11", mood: "GUT", score: 4 }],
        }),
      );

      expect(response.status).toBe(200);
      const moodLoggedAt = vi.mocked(prisma.moodEntry.create).mock.calls[0][0]
        .data.moodLoggedAt;
      expect(new Date(moodLoggedAt).getTime()).toBeGreaterThanOrEqual(
        Date.parse("2026-05-10T22:00:00.000Z"),
      );
      expect(new Date(moodLoggedAt).getTime()).toBeLessThan(
        Date.parse("2026-05-10T22:05:00.000Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves persisted and repeated-row fallback timestamp collisions", async () => {
    type StoredMood = {
      date: string;
      mood: string;
      score: number;
      tags: string | null;
      externalId?: string | null;
      moodLoggedAt: Date;
    };

    const persisted = new Map<string, StoredMood>();
    vi.mocked(prisma.moodEntry.create).mockImplementation(
      ({ data }: Prisma.MoodEntryCreateArgs) => {
        const moodLoggedAt = asDate(data.moodLoggedAt);
        const key = `${data.date}:${moodLoggedAt.toISOString()}`;
        if (persisted.has(key)) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed",
              {
                code: "P2002",
                clientVersion: "test",
                meta: { target: ["userId", "date", "moodLoggedAt"] },
              },
            ),
          ) as never;
        }
        persisted.set(key, { ...data, moodLoggedAt } as StoredMood);
        return Promise.resolve({} as never) as never;
      },
    );
    vi.mocked(prisma.moodEntry.findUnique).mockImplementation(
      ({ where }: Prisma.MoodEntryFindUniqueArgs) => {
        const composite = where.userId_date_moodLoggedAt!;
        const key = `${composite.date}:${asDate(composite.moodLoggedAt).toISOString()}`;
        return Promise.resolve((persisted.get(key) ?? null) as never) as never;
      },
    );

    const firstPayload = {
      moodEntries: [
        { date: "2026-05-01", mood: "GUT", score: 4, tags: "tag-250" },
      ],
    };
    const collidingPayload = {
      moodEntries: [
        { date: "2026-05-01", mood: "GUT", score: 4, tags: "tag-421" },
      ],
    };

    await POST(request(firstPayload));
    const collisionResponse = await POST(request(collidingPayload));
    const retryResponse = await POST(request(collidingPayload));

    expect(await collisionResponse.json()).toEqual({
      data: { measurements: 0, moodEntries: 1, skipped: 0 },
      error: null,
    });
    expect(await retryResponse.json()).toEqual({
      data: { measurements: 0, moodEntries: 0, skipped: 1 },
      error: null,
    });
    expect(persisted.size).toBe(2);

    const reverseOrderResponse = await POST(
      request({
        moodEntries: [
          { date: "2026-05-01", mood: "GUT", score: 4, tags: "tag-421" },
          { date: "2026-05-01", mood: "GUT", score: 4, tags: "tag-250" },
        ],
      }),
    );
    expect(await reverseOrderResponse.json()).toEqual({
      data: { measurements: 0, moodEntries: 0, skipped: 2 },
      error: null,
    });
    expect(persisted.size).toBe(2);

    const repeatedRowResponse = await POST(
      request({
        moodEntries: [
          { date: "2026-05-01", mood: "GUT", score: 4, tags: "tag-53200" },
          { date: "2026-05-01", mood: "GUT", score: 4, tags: "tag-53200" },
        ],
      }),
    );
    expect(await repeatedRowResponse.json()).toEqual({
      data: { measurements: 0, moodEntries: 2, skipped: 0 },
      error: null,
    });
    expect(persisted.size).toBe(4);
  });

  it("keeps a generated timestamp stable when upserting an external ID", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T08:00:00.000Z"));
      vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({} as never);
      const payload = {
        moodEntries: [
          {
            date: "2026-05-01",
            mood: "GUT",
            score: 4,
            externalId: "legacy-row-1",
          },
        ],
      };

      await POST(request(payload));
      vi.advanceTimersByTime(1000);
      await POST(request(payload));

      const first = vi.mocked(prisma.moodEntry.upsert).mock.calls[0][0];
      const second = vi.mocked(prisma.moodEntry.upsert).mock.calls[1][0];
      expect(first.create.moodLoggedAt).toEqual(second.create.moodLoggedAt);
      expect(first.update.moodLoggedAt).toEqual(second.update.moodLoggedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["1899-12-31", "2026-05-11"])(
    "rejects an implausible date-only mood row dated %s",
    async (date) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-10T08:00:00.000Z"));

        const response = await POST(
          request({ moodEntries: [{ date, mood: "GUT", score: 4 }] }),
        );

        expect(response.status).toBe(422);
        expect(prisma.moodEntry.create).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("returns a retryable failure for a generic mood write error", async () => {
    vi.mocked(prisma.moodEntry.create).mockRejectedValueOnce(
      new Error("write failed"),
    );

    const response = await POST(request({ moodEntries: [moodEntry()] }));

    expect(response.status).toBe(503);
    expectRetryableFailure(await response.json(), {
      measurements: 0,
      moodEntries: 0,
      skipped: 0,
    });
  });

  it("audits rows committed before a later write failure", async () => {
    vi.mocked(prisma.measurement.create)
      .mockResolvedValueOnce({
        id: "measurement-1",
        type: "WEIGHT",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"),
      } as never)
      .mockRejectedValueOnce(new Error("write failed"));

    const response = await POST(
      request({ measurements: [measurement(80), measurement(81)] }),
    );

    expect(response.status).toBe(503);
    expect(auditLog).toHaveBeenCalledWith("import.upload", {
      userId: "u-1",
      ipAddress: null,
      details: { measurements: 1, moodEntries: 0, skipped: 0 },
    });
  });

  it("keeps the classified failure when its audit also fails", async () => {
    vi.mocked(prisma.measurement.create).mockRejectedValueOnce(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server",
        "test",
        "P1001",
      ),
    );
    vi.mocked(auditLog).mockRejectedValueOnce(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server",
        "test",
        "P1001",
      ),
    );

    const response = await POST(request({ measurements: [measurement()] }));

    expect(response.status).toBe(503);
    expectRetryableFailure(await response.json(), {
      measurements: 0,
      moodEntries: 0,
      skipped: 0,
    });
    expect(auditLog).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/import — external-id stability floor", () => {
  /**
   * The importer upserts on `(userId, type, source=IMPORT, externalId)` so
   * a re-import of the same export converges instead of duplicating. An id
   * that cannot be stable between two exports defeats that. The importer
   * has no per-entry status envelope — its vocabulary is a skipped COUNT —
   * so the offending row lands there and every other row still imports.
   */
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
    vi.mocked(prisma.measurement.createManyAndReturn).mockResolvedValue([
      { id: "m-1", type: "WEIGHT", measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.measurement.create).mockResolvedValue({
      id: "m-2",
      type: "WEIGHT",
      measuredAt: new Date(),
    } as never);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.moodEntry.create).mockResolvedValue({} as never);
  });

  function importReq(body: unknown) {
    return new NextRequest("http://localhost/api/import", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  function measurement(externalId?: string) {
    return {
      type: "WEIGHT",
      value: 80,
      unit: "kg",
      measuredAt: "2026-05-01T08:00:00.000Z",
      ...(externalId ? { externalId } : {}),
    };
  }

  it("skips the poisoned row, imports the two good ones, and never writes the bad id", async () => {
    const response = await POST(
      importReq({
        measurements: [
          measurement("scale-row-42"),
          measurement("<HKQuantitySample: 0x12568db80>"),
          measurement("scale-row-43"),
        ],
      }),
    );
    expect(response.status).toBeLessThan(400);
    const body = (await response.json()) as {
      data: { measurements: number; skipped: number };
    };
    expect(body.data.measurements).toBe(2);
    expect(body.data.skipped).toBe(1);
    const written = vi
      .mocked(prisma.measurement.createManyAndReturn)
      .mock.calls.flatMap(
        (call) => (call[0] as { data: Array<{ externalId?: string }> }).data,
      );
    expect(written).toHaveLength(2);
    expect(written.map((r) => r.externalId)).toEqual([
      "scale-row-42",
      "scale-row-43",
    ]);
  });

  it("skips a poisoned mood row and still imports the good one", async () => {
    const response = await POST(
      importReq({
        moodEntries: [
          {
            date: "2026-05-01",
            mood: "GUT",
            score: 4,
            loggedAt: "2026-05-01T08:00:00.000Z",
            externalId: "daylio-1041",
          },
          {
            date: "2026-05-02",
            mood: "OKAY",
            score: 3,
            loggedAt: "2026-05-02T08:00:00.000Z",
            externalId: "0xdeadbeef",
          },
        ],
      }),
    );
    expect(response.status).toBeLessThan(400);
    const body = (await response.json()) as {
      data: { moodEntries: number; skipped: number };
    };
    expect(body.data.moodEntries).toBe(1);
    expect(body.data.skipped).toBe(1);
    expect(vi.mocked(prisma.moodEntry.upsert)).toHaveBeenCalledTimes(1);
  });

  it("accepts the exporter row ids a real re-import carries", async () => {
    const response = await POST(
      importReq({
        measurements: [
          measurement("scale-row-42"),
          measurement("8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30"),
        ],
      }),
    );
    expect(response.status).toBeLessThan(400);
    const body = (await response.json()) as {
      data: { measurements: number; skipped: number };
    };
    expect(body.data.measurements).toBe(2);
    expect(body.data.skipped).toBe(0);
  });
});
