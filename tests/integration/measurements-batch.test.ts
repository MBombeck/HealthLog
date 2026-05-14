/**
 * Integration suite for `POST /api/measurements/batch` — the iOS Apple
 * Health ingest endpoint. Asserts the contract the iOS client relies on:
 *   - Mixed batches succeed end-to-end
 *   - Re-posting the same batch yields an idempotent outcome
 *   - Over-cap batches return 422 with the documented error code
 *   - Unmappable identifiers and out-of-range values surface as `skipped`
 *   - The composite unique index dedupes by `(user_id, type, source, external_id)`
 *   - Idempotency-Key replay returns the cached envelope
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-batch-ingest-test";

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
      username: "batch-ingest",
      email: "batch-ingest@example.test",
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

interface BatchEntryFixture {
  hkIdentifier: string;
  value: number;
  unit: string;
  startDate: string;
  endDate: string;
  externalId: string;
  externalSourceVersion?: string;
  sleepStage?: number;
}

function makeRequest(
  body: { entries: BatchEntryFixture[] },
  opts: { idempotencyKey?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.idempotencyKey) {
    headers["idempotency-key"] = opts.idempotencyKey;
  }
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/measurements/batch (real Postgres)", () => {
  it("inserts a well-formed batch and returns per-entry status", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    const body = {
      entries: [
        {
          hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
          value: 81.4,
          unit: "kg",
          startDate: "2026-05-09T07:30:00.000Z",
          endDate: "2026-05-09T07:30:00.000Z",
          externalId: "uuid-weight-001",
        },
        {
          hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
          value: 64,
          unit: "count/min",
          startDate: "2026-05-09T08:00:00.000Z",
          endDate: "2026-05-09T08:00:00.000Z",
          externalId: "uuid-pulse-001",
        },
        {
          hkIdentifier: "HKQuantityTypeIdentifierOxygenSaturation",
          value: 0.97,
          unit: "fraction",
          startDate: "2026-05-09T08:05:00.000Z",
          endDate: "2026-05-09T08:05:00.000Z",
          externalId: "uuid-spo2-001",
        },
      ],
    };

    const response = await POST(makeRequest(body));
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: {
        processed: number;
        inserted: number;
        duplicates: number;
        skipped: Array<{ index: number; reason: string }>;
      };
    };

    expect(json.data.processed).toBe(3);
    expect(json.data.inserted).toBe(3);
    expect(json.data.duplicates).toBe(0);
    expect(json.data.skipped).toHaveLength(0);

    const stored = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
      orderBy: { measuredAt: "asc" },
    });
    expect(stored).toHaveLength(3);
    expect(stored.every((r) => r.source === "APPLE_HEALTH")).toBe(true);

    const spo2 = stored.find((r) => r.type === "OXYGEN_SATURATION");
    expect(spo2?.value).toBeCloseTo(97);
    expect(spo2?.unit).toBe("%");
  });

  it("dedupes a re-posted batch into duplicate status without inserting twice", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    const body = {
      entries: [
        {
          hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
          value: 81.5,
          unit: "kg",
          startDate: "2026-05-09T07:30:00.000Z",
          endDate: "2026-05-09T07:30:00.000Z",
          externalId: "uuid-dup-001",
        },
        {
          hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
          value: 81.6,
          unit: "kg",
          startDate: "2026-05-09T08:00:00.000Z",
          endDate: "2026-05-09T08:00:00.000Z",
          externalId: "uuid-dup-002",
        },
      ],
    };

    const first = await POST(makeRequest(body));
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { data: { inserted: number } };
    expect(firstJson.data.inserted).toBe(2);

    // Re-post the SAME body with NO idempotency-key. Per-entry dedup
    // should kick in via the composite unique index, returning all
    // duplicates and inserting nothing new.
    const second = await POST(makeRequest(body));
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      data: { inserted: number; duplicates: number };
    };
    expect(secondJson.data.inserted).toBe(0);
    expect(secondJson.data.duplicates).toBe(2);

    const stored = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toHaveLength(2);
  });

  it("returns 422 with measurement.batch.too_large when entries exceed the cap", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    const entries: BatchEntryFixture[] = [];
    for (let i = 0; i < 501; i++) {
      entries.push({
        hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
        value: 80 + (i % 10) * 0.1,
        unit: "kg",
        startDate: "2026-05-09T07:30:00.000Z",
        endDate: "2026-05-09T07:30:00.000Z",
        externalId: `uuid-cap-${i}`,
      });
    }

    const response = await POST(makeRequest({ entries }));
    expect(response.status).toBe(422);
    const json = (await response.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(json.error).toMatch(/500/);
    expect(json.meta?.errorCode).toBe("measurement.batch.too_large");
  });

  it("flags unmappable identifiers and out-of-range values as skipped", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    const body = {
      entries: [
        {
          hkIdentifier: "HKQuantityTypeIdentifierHallucinated",
          value: 42,
          unit: "kg",
          startDate: "2026-05-09T07:30:00.000Z",
          endDate: "2026-05-09T07:30:00.000Z",
          externalId: "uuid-skip-unknown",
        },
        {
          hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
          value: 9999, // out of plausible range
          unit: "kg",
          startDate: "2026-05-09T07:30:00.000Z",
          endDate: "2026-05-09T07:30:00.000Z",
          externalId: "uuid-skip-range",
        },
        {
          hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
          value: 81.5,
          unit: "kg",
          startDate: "2026-05-09T07:30:00.000Z",
          endDate: "2026-05-09T07:30:00.000Z",
          externalId: "uuid-good-001",
        },
      ],
    };

    const response = await POST(makeRequest(body));
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: {
        processed: number;
        inserted: number;
        skipped: Array<{ index: number; reason: string }>;
      };
    };

    expect(json.data.processed).toBe(3);
    expect(json.data.inserted).toBe(1);
    expect(json.data.skipped).toEqual(
      expect.arrayContaining([
        { index: 0, reason: "unmappable_identifier" },
        { index: 1, reason: "value_out_of_range" },
      ]),
    );

    const stored = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.externalId).toBe("uuid-good-001");
  });

  it("inserts per-stage sleep rows with the sleepStage column populated", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    const body = {
      entries: [
        {
          hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
          value: 60, // minutes
          unit: "min",
          startDate: "2026-05-09T01:00:00.000Z",
          endDate: "2026-05-09T02:00:00.000Z",
          externalId: "uuid-sleep-core-001",
          sleepStage: 3, // CORE
        },
        {
          hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
          value: 90,
          unit: "min",
          startDate: "2026-05-09T02:00:00.000Z",
          endDate: "2026-05-09T03:30:00.000Z",
          externalId: "uuid-sleep-deep-001",
          sleepStage: 4, // DEEP
        },
        {
          hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
          value: 25,
          unit: "min",
          startDate: "2026-05-09T03:30:00.000Z",
          endDate: "2026-05-09T03:55:00.000Z",
          externalId: "uuid-sleep-rem-001",
          sleepStage: 5, // REM
        },
      ],
    };

    const response = await POST(makeRequest(body));
    expect(response.status).toBe(200);

    const stored = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID, type: "SLEEP_DURATION" },
      orderBy: { measuredAt: "asc" },
    });
    expect(stored).toHaveLength(3);
    expect(stored.map((r) => r.sleepStage)).toEqual(["CORE", "DEEP", "REM"]);
    expect(stored.every((r) => r.unit === "minutes")).toBe(true);
  });

  // v1.4.25 W10 reconcile (senior-dev H-1): under contention the
  // per-entry envelope MUST stay in sync with the aggregate
  // `inserted` / `duplicate` counts. The previous reconciliation
  // block was an effective no-op (it looked for rows that were
  // "marked inserted but missing from the DB" — an impossibility
  // because the raced row IS in the DB, written by the other
  // batch). The corrected block downgrades enough "inserted"
  // statuses to "duplicate" so the per-entry envelope and the
  // aggregate counts agree, which the iOS sync cursor depends on
  // to checkpoint correctly.
  it("keeps per-entry status in sync with aggregate counts under a concurrent-write race", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    // Two batches with overlapping externalIds posted in parallel.
    // The composite unique index ensures only one row per
    // (user, type, source, externalId) lands; `skipDuplicates`
    // absorbs duplicate-key conflicts. The exact split between
    // "won the race" and "got absorbed" depends on Postgres's
    // commit order, so we assert only the invariant the iOS sync
    // cursor relies on: per-entry envelope sums equal the aggregate
    // counts for each response.
    const sharedEntries = () =>
      Array.from({ length: 6 }, (_, i) => ({
        hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
        value: 80 + i * 0.1,
        unit: "kg",
        startDate: "2026-05-09T07:30:00.000Z",
        endDate: "2026-05-09T07:30:00.000Z",
        externalId: `uuid-race-${i}`,
      }));

    const [first, second] = await Promise.all([
      POST(makeRequest({ entries: sharedEntries() })),
      POST(makeRequest({ entries: sharedEntries() })),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstJson = (await first.json()) as {
      data: {
        processed: number;
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string }>;
      };
    };
    const secondJson = (await second.json()) as typeof firstJson;

    // Invariant 1 — per-entry statuses sum to the aggregate counts.
    // Before the fix this failed under contention because the
    // no-op reconciliation left the envelope out of sync.
    for (const json of [firstJson, secondJson]) {
      const insertedEntries = json.data.entries.filter(
        (e) => e.status === "inserted",
      ).length;
      const duplicateEntries = json.data.entries.filter(
        (e) => e.status === "duplicate",
      ).length;
      const skippedEntries = json.data.entries.filter(
        (e) => e.status === "skipped",
      ).length;
      expect(insertedEntries).toBe(json.data.inserted);
      expect(duplicateEntries).toBe(json.data.duplicates);
      expect(
        insertedEntries + duplicateEntries + skippedEntries,
      ).toBe(json.data.processed);
    }

    // Invariant 2 — aggregate counts are non-negative. The previous
    // logic could not produce a negative `inserted` count but a
    // naive "downgrade and also decrement" implementation can.
    expect(firstJson.data.inserted).toBeGreaterThanOrEqual(0);
    expect(secondJson.data.inserted).toBeGreaterThanOrEqual(0);

    // Invariant 3 — the DB ends up with at most 6 rows because the
    // composite unique index enforces single-copy, and the
    // `inserted` counts across both requests cannot exceed the
    // number of rows actually present.
    const stored = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored.length).toBeLessThanOrEqual(6);
    expect(firstJson.data.inserted + secondJson.data.inserted).toBe(
      stored.length,
    );
  });

  it("rate-limits a user at 60 batches per minute (security H-2)", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    // Pre-seed the rate-limit counter to the cap so the next call
    // exercises the over-limit path without 60 round-trips.
    const cap = 60;
    const resetAt = new Date(Date.now() + 60 * 1000);
    await getPrismaClient().$executeRaw`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES (${`measurements:batch:${TEST_USER_ID}`}, ${cap}, ${resetAt})
    `;

    const body = {
      entries: [
        {
          hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
          value: 81.4,
          unit: "kg",
          startDate: "2026-05-09T07:30:00.000Z",
          endDate: "2026-05-09T07:30:00.000Z",
          externalId: "uuid-rate-limit-001",
        },
      ],
    };

    const response = await POST(makeRequest(body));
    expect(response.status).toBe(429);
    const json = (await response.json()) as { error: string };
    expect(json.error).toMatch(/too many/i);

    // The over-limit response must not have written anything to the
    // measurement table — the iOS client should retry, not assume the
    // row landed.
    const stored = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toHaveLength(0);
  });

  it("replays a cached response when the same Idempotency-Key is reused", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    const body = {
      entries: [
        {
          hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
          value: 81.7,
          unit: "kg",
          startDate: "2026-05-09T07:30:00.000Z",
          endDate: "2026-05-09T07:30:00.000Z",
          externalId: "uuid-idem-001",
        },
      ],
    };

    const key = "ios-batch-12345678";
    const first = await POST(makeRequest(body, { idempotencyKey: key }));
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { data: { inserted: number } };
    expect(firstJson.data.inserted).toBe(1);

    const second = await POST(makeRequest(body, { idempotencyKey: key }));
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    const secondJson = (await second.json()) as { data: { inserted: number } };
    // Same envelope as the first call — even though it would otherwise
    // have surfaced as a duplicate.
    expect(secondJson.data.inserted).toBe(1);

    const stored = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID, externalId: "uuid-idem-001" },
    });
    expect(stored).toHaveLength(1);
  });
});
