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
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { streamParseExportXml } from "@/lib/measurements/import-apple-health-export";

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
  source?: string;
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

function writeCumulativeXml(firstValue = 8_526, secondValue = 7_082): string {
  const tmp = mkdtempSync(join(tmpdir(), "healthlog-aggregate-authority-"));
  const xmlPath = join(tmp, "export.xml");
  writeFileSync(
    xmlPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierStepCount" unit="count"
          startDate="2026-07-20 08:00:00 +0200"
          endDate="2026-07-20 08:30:00 +0200"
          value="${firstValue}" sourceName="iPhone" sourceVersion="18.5"/>
  <Record type="HKQuantityTypeIdentifierStepCount" unit="count"
          startDate="2026-07-20 09:00:00 +0200"
          endDate="2026-07-20 09:30:00 +0200"
          value="${secondValue}" sourceName="Zepp" sourceVersion="9.1"/>
</HealthData>`,
  );
  return xmlPath;
}

function nativeStepsRequest(value: number): NextRequest {
  return makeRequest({
    entries: [
      {
        hkIdentifier: "HKQuantityTypeIdentifierStepCount",
        value,
        unit: "count",
        startDate: "2026-07-20T00:00:00.000Z",
        endDate: "2026-07-20T18:00:00.000Z",
        externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
      },
    ],
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

  // Under contention every per-entry verdict must stay in sync with its
  // aggregate counter. Inserted, updated, duplicate, skipped, and failed are
  // all explicit because only the hard failure verdict must block checkpoint
  // advancement.
  it("keeps per-entry status in sync with aggregate counts under a concurrent-write race", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    // Two batches with overlapping external ids and the same natural identity
    // are posted in parallel. The reconciler serializes both identity indexes;
    // the exact inserted/updated split depends on commit order, but every
    // response must remain internally consistent.
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
        updated: number;
        failed: number;
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
        (entry) => entry.status === "inserted",
      ).length;
      const updatedEntries = json.data.entries.filter(
        (entry) => entry.status === "updated",
      ).length;
      const duplicateEntries = json.data.entries.filter(
        (entry) => entry.status === "duplicate",
      ).length;
      const skippedEntries = json.data.entries.filter(
        (entry) => entry.status === "skipped",
      ).length;
      const failedEntries = json.data.entries.filter(
        (entry) => entry.status === "failed",
      ).length;
      expect(insertedEntries).toBe(json.data.inserted);
      expect(updatedEntries).toBe(json.data.updated);
      expect(duplicateEntries).toBe(json.data.duplicates);
      expect(failedEntries).toBe(json.data.failed);
      expect(
        insertedEntries +
          updatedEntries +
          duplicateEntries +
          skippedEntries +
          failedEntries,
      ).toBe(json.data.processed);
    }

    // Invariant 2 — aggregate counts are non-negative. The previous
    // logic could not produce a negative `inserted` count but a
    // naive "downgrade and also decrement" implementation can.
    expect(firstJson.data.inserted).toBeGreaterThanOrEqual(0);
    expect(secondJson.data.inserted).toBeGreaterThanOrEqual(0);

    // Invariant 3 — all samples share one natural identity, so exactly one
    // canonical row survives and only one request can report its insertion.
    const stored = await getPrismaClient().measurement.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toHaveLength(1);
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

  // v1.5.0 issue #213 — per-day cumulative `stats:*` externalIds are
  // re-posted by the iOS HealthKit observer throughout the day. Prior
  // to this fix the server returned `status: "duplicate"` and silently
  // dropped the new value, freezing today's tile at the first-sync
  // total. Sample-class externalIds (every other prefix) keep the
  // immutable duplicate contract because each sample is canonical.
  describe("stats:* externalId overwrite (issue #213)", () => {
    it("re-posting a stats:* day-aggregate row overwrites the value and returns status='updated'", async () => {
      const { POST } = await import("@/app/api/measurements/batch/route");

      const externalId = "stats:HKQuantityTypeIdentifierStepCount:2026-05-24";
      const firstBody = {
        entries: [
          {
            hkIdentifier: "HKQuantityTypeIdentifierStepCount",
            value: 300,
            unit: "count",
            startDate: "2026-05-24T00:00:00.000Z",
            endDate: "2026-05-24T08:00:00.000Z",
            externalId,
          },
        ],
      };

      const first = await POST(makeRequest(firstBody));
      expect(first.status).toBe(200);
      const firstJson = (await first.json()) as {
        data: {
          inserted: number;
          updated: number;
          duplicates: number;
          entries: Array<{ status: string }>;
        };
      };
      expect(firstJson.data.inserted).toBe(1);
      expect(firstJson.data.updated).toBe(0);
      expect(firstJson.data.duplicates).toBe(0);
      expect(firstJson.data.entries[0]?.status).toBe("inserted");

      const secondBody = {
        entries: [
          {
            ...firstBody.entries[0],
            value: 5200,
            endDate: "2026-05-24T16:00:00.000Z",
          },
        ],
      };

      const second = await POST(makeRequest(secondBody));
      expect(second.status).toBe(200);
      const secondJson = (await second.json()) as {
        data: {
          inserted: number;
          updated: number;
          duplicates: number;
          entries: Array<{ status: string }>;
        };
      };
      expect(secondJson.data.inserted).toBe(0);
      expect(secondJson.data.updated).toBe(1);
      expect(secondJson.data.duplicates).toBe(0);
      expect(secondJson.data.entries[0]?.status).toBe("updated");

      // The single row on disk reflects the latest re-post.
      const stored = await getPrismaClient().measurement.findMany({
        where: { userId: TEST_USER_ID, externalId },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.value).toBeCloseTo(5200, 5);
      expect(stored[0]).toMatchObject({
        aggregationProvenance: "HEALTHKIT_STATISTICS",
        aggregationContributorCount: null,
        aggregationSelectedSourceHash: null,
        syncVersion: 2,
      });
    });

    it("sample-class externalIds (non-stats:* prefix) keep the strict duplicate contract", async () => {
      const { POST } = await import("@/app/api/measurements/batch/route");

      const externalId = "uuid-pulse-sample-001";
      const body = {
        entries: [
          {
            hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
            value: 64,
            unit: "count/min",
            startDate: "2026-05-24T08:00:00.000Z",
            endDate: "2026-05-24T08:00:00.000Z",
            externalId,
          },
        ],
      };

      const first = await POST(makeRequest(body));
      expect(first.status).toBe(200);
      expect(
        ((await first.json()) as { data: { inserted: number } }).data.inserted,
      ).toBe(1);

      // Replay with a different value — must NOT overwrite because the
      // externalId is not stats:*. Sample-class rows are immutable.
      const replayBody = {
        entries: [
          {
            ...body.entries[0],
            value: 200,
          },
        ],
      };

      const second = await POST(makeRequest(replayBody));
      expect(second.status).toBe(200);
      const secondJson = (await second.json()) as {
        data: { inserted: number; updated: number; duplicates: number };
      };
      expect(secondJson.data.inserted).toBe(0);
      expect(secondJson.data.updated).toBe(0);
      expect(secondJson.data.duplicates).toBe(1);

      const stored = await getPrismaClient().measurement.findMany({
        where: { userId: TEST_USER_ID, externalId },
      });
      expect(stored).toHaveLength(1);
      // First-write wins — sample-class duplicates do not overwrite.
      expect(stored[0]!.value).toBeCloseTo(64, 5);
    });

    it("a mixed batch with one new + one stats:* overwrite + one sample-class duplicate returns all three statuses", async () => {
      const { POST } = await import("@/app/api/measurements/batch/route");

      // Seed: one stats:* steps row (will be overwritten) + one
      // sample-class pulse row (will surface as duplicate on replay).
      const stepsExternalId =
        "stats:HKQuantityTypeIdentifierStepCount:2026-05-25";
      const pulseExternalId = "uuid-pulse-mixed-001";
      await POST(
        makeRequest({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierStepCount",
              value: 1200,
              unit: "count",
              startDate: "2026-05-25T00:00:00.000Z",
              endDate: "2026-05-25T09:00:00.000Z",
              externalId: stepsExternalId,
            },
            {
              hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
              value: 70,
              unit: "count/min",
              startDate: "2026-05-25T09:00:00.000Z",
              endDate: "2026-05-25T09:00:00.000Z",
              externalId: pulseExternalId,
            },
          ],
        }),
      );

      // Second batch: stats:* re-post (overwrite) + sample-class
      // replay (duplicate) + a brand-new pulse sample (insert).
      const second = await POST(
        makeRequest({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierStepCount",
              value: 8400,
              unit: "count",
              startDate: "2026-05-25T00:00:00.000Z",
              endDate: "2026-05-25T18:00:00.000Z",
              externalId: stepsExternalId,
            },
            {
              hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
              value: 70,
              unit: "count/min",
              startDate: "2026-05-25T09:00:00.000Z",
              endDate: "2026-05-25T09:00:00.000Z",
              externalId: pulseExternalId,
            },
            {
              hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
              value: 88,
              unit: "count/min",
              startDate: "2026-05-25T15:00:00.000Z",
              endDate: "2026-05-25T15:00:00.000Z",
              externalId: "uuid-pulse-mixed-002",
            },
          ],
        }),
      );

      expect(second.status).toBe(200);
      const json = (await second.json()) as {
        data: {
          inserted: number;
          updated: number;
          duplicates: number;
          entries: Array<{ index: number; status: string }>;
        };
      };
      expect(json.data.inserted).toBe(1);
      expect(json.data.updated).toBe(1);
      expect(json.data.duplicates).toBe(1);

      const byIndex = new Map(
        json.data.entries.map((e) => [e.index, e.status]),
      );
      expect(byIndex.get(0)).toBe("updated");
      expect(byIndex.get(1)).toBe("duplicate");
      expect(byIndex.get(2)).toBe("inserted");

      const stepsRow = await getPrismaClient().measurement.findFirst({
        where: { userId: TEST_USER_ID, externalId: stepsExternalId },
      });
      expect(stepsRow?.value).toBeCloseTo(8400, 5);
    });
  });

  // v1.8.6 W6 — optional per-entry `source`. The standalone iOS client
  // tags adopt-on-pair backfill rows it knows were entered by hand as
  // `MANUAL`; every other caller (web + current iOS) omits the field and
  // must keep storing rows as `APPLE_HEALTH`. `source` is part of the
  // `(userId, type, source, externalId)` dedup key.
  describe("optional source field (W6)", () => {
    it("persists a row as APPLE_HEALTH when source is absent (backward-compat)", async () => {
      const { POST } = await import("@/app/api/measurements/batch/route");

      const response = await POST(
        makeRequest({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 80.2,
              unit: "kg",
              startDate: "2026-05-09T07:30:00.000Z",
              endDate: "2026-05-09T07:30:00.000Z",
              externalId: "uuid-source-absent-001",
            },
          ],
        }),
      );
      expect(response.status).toBe(200);

      const stored = await getPrismaClient().measurement.findMany({
        where: { userId: TEST_USER_ID, externalId: "uuid-source-absent-001" },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.source).toBe("APPLE_HEALTH");
    });

    it("persists a row as MANUAL when source is explicitly MANUAL", async () => {
      const { POST } = await import("@/app/api/measurements/batch/route");

      const response = await POST(
        makeRequest({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 79.8,
              unit: "kg",
              startDate: "2026-05-09T07:30:00.000Z",
              endDate: "2026-05-09T07:30:00.000Z",
              externalId: "uuid-source-manual-001",
              source: "MANUAL",
            },
          ],
        }),
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as { data: { inserted: number } };
      expect(json.data.inserted).toBe(1);

      const stored = await getPrismaClient().measurement.findMany({
        where: { userId: TEST_USER_ID, externalId: "uuid-source-manual-001" },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.source).toBe("MANUAL");
    });

    it("treats the same externalId under different sources as two distinct rows", async () => {
      const { POST } = await import("@/app/api/measurements/batch/route");

      // The two rows share an externalId but carry DIFFERENT values +
      // timestamps so they are genuinely distinct readings — this asserts
      // that `source` is part of the composite dedup key, without tripping
      // the v1.11.4 cross-source same-reading merge (which only collapses a
      // MANUAL + APPLE_HEALTH pair that share value + measuredAt).
      const sharedExternalId = "uuid-source-collision-001";
      const response = await POST(
        makeRequest({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 81.0,
              unit: "kg",
              startDate: "2026-05-09T07:30:00.000Z",
              endDate: "2026-05-09T07:30:00.000Z",
              externalId: sharedExternalId,
              source: "APPLE_HEALTH",
            },
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 79.5,
              unit: "kg",
              startDate: "2026-05-09T19:30:00.000Z",
              endDate: "2026-05-09T19:30:00.000Z",
              externalId: sharedExternalId,
              source: "MANUAL",
            },
          ],
        }),
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        data: { inserted: number; duplicates: number };
      };
      // Distinct dedup keys — both insert, neither is a duplicate.
      expect(json.data.inserted).toBe(2);
      expect(json.data.duplicates).toBe(0);

      const stored = await getPrismaClient().measurement.findMany({
        where: { userId: TEST_USER_ID, externalId: sharedExternalId },
      });
      expect(stored).toHaveLength(2);
      expect(new Set(stored.map((r) => r.source))).toEqual(
        new Set(["APPLE_HEALTH", "MANUAL"]),
      );
    });

    // v1.11.4 (iOS #2) — same-reading merge for the MANUAL↔APPLE_HEALTH
    // mirror duplicate. A standalone manual reading mirrors into HealthKit;
    // on pair, adopt-on-pair uploads it as MANUAL and HealthKit background
    // sync re-ingests the mirror as APPLE_HEALTH with a different
    // externalId. The composite unique index would let both land; the
    // cross-source collapse drops the second copy as a `duplicate`.
    describe("cross-source same-reading merge (iOS #2)", () => {
      const weightEntry = (
        over: Partial<BatchEntryFixture>,
      ): BatchEntryFixture => ({
        hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
        value: 81.4,
        unit: "kg",
        startDate: "2026-06-04T07:30:00.000Z",
        endDate: "2026-06-04T07:30:00.000Z",
        externalId: "uuid-merge-default",
        ...over,
      });

      it("collapses MANUAL then APPLE_HEALTH same reading into one row (separate batches)", async () => {
        const { POST } = await import("@/app/api/measurements/batch/route");

        // Adopt-on-pair MANUAL upload first.
        const first = await POST(
          makeRequest({
            entries: [
              weightEntry({ externalId: "local-manual-001", source: "MANUAL" }),
            ],
          }),
        );
        expect(first.status).toBe(200);
        expect(
          ((await first.json()) as { data: { inserted: number } }).data
            .inserted,
        ).toBe(1);

        // HealthKit background sync re-ingests the same physical reading
        // as APPLE_HEALTH with a different (HKSample.uuid) externalId.
        const second = await POST(
          makeRequest({
            entries: [
              weightEntry({
                externalId: "hk-uuid-001",
                source: "APPLE_HEALTH",
              }),
            ],
          }),
        );
        expect(second.status).toBe(200);
        const secondJson = (await second.json()) as {
          data: {
            inserted: number;
            duplicates: number;
            entries: Array<{ status: string; reason?: string }>;
          };
        };
        expect(secondJson.data.inserted).toBe(0);
        expect(secondJson.data.duplicates).toBe(1);
        expect(secondJson.data.entries[0]?.status).toBe("duplicate");
        expect(secondJson.data.entries[0]?.reason).toBe("cross_source_merge");

        const stored = await getPrismaClient().measurement.findMany({
          where: { userId: TEST_USER_ID, type: "WEIGHT" },
        });
        expect(stored).toHaveLength(1);
        expect(stored[0]!.source).toBe("MANUAL");
      });

      it("collapses regardless of arrival order (APPLE_HEALTH then MANUAL)", async () => {
        const { POST } = await import("@/app/api/measurements/batch/route");

        const first = await POST(
          makeRequest({
            entries: [
              weightEntry({
                externalId: "hk-uuid-002",
                source: "APPLE_HEALTH",
              }),
            ],
          }),
        );
        expect(first.status).toBe(200);

        const second = await POST(
          makeRequest({
            entries: [
              weightEntry({ externalId: "local-manual-002", source: "MANUAL" }),
            ],
          }),
        );
        expect(second.status).toBe(200);
        const secondJson = (await second.json()) as {
          data: { inserted: number; duplicates: number };
        };
        expect(secondJson.data.inserted).toBe(0);
        expect(secondJson.data.duplicates).toBe(1);

        const stored = await getPrismaClient().measurement.findMany({
          where: { userId: TEST_USER_ID, type: "WEIGHT" },
        });
        expect(stored).toHaveLength(1);
        expect(stored[0]!.source).toBe("APPLE_HEALTH");
      });

      it("collapses a MANUAL + APPLE_HEALTH mirror arriving in the SAME batch", async () => {
        const { POST } = await import("@/app/api/measurements/batch/route");

        const response = await POST(
          makeRequest({
            entries: [
              weightEntry({ externalId: "local-manual-003", source: "MANUAL" }),
              weightEntry({
                externalId: "hk-uuid-003",
                source: "APPLE_HEALTH",
              }),
            ],
          }),
        );
        expect(response.status).toBe(200);
        const json = (await response.json()) as {
          data: { inserted: number; duplicates: number };
        };
        expect(json.data.inserted).toBe(1);
        expect(json.data.duplicates).toBe(1);

        const stored = await getPrismaClient().measurement.findMany({
          where: { userId: TEST_USER_ID, type: "WEIGHT" },
        });
        expect(stored).toHaveLength(1);
      });

      it("matches within the ±2s tolerance window", async () => {
        const { POST } = await import("@/app/api/measurements/batch/route");

        await POST(
          makeRequest({
            entries: [
              weightEntry({
                externalId: "local-manual-tol",
                source: "MANUAL",
                startDate: "2026-06-04T07:30:00.000Z",
                endDate: "2026-06-04T07:30:00.000Z",
              }),
            ],
          }),
        );

        // HK mirror ingested with a 1s sub-second drift on the same reading.
        const second = await POST(
          makeRequest({
            entries: [
              weightEntry({
                externalId: "hk-uuid-tol",
                source: "APPLE_HEALTH",
                startDate: "2026-06-04T07:30:01.000Z",
                endDate: "2026-06-04T07:30:01.000Z",
              }),
            ],
          }),
        );
        expect(second.status).toBe(200);
        const secondJson = (await second.json()) as {
          data: { inserted: number; duplicates: number };
        };
        expect(secondJson.data.inserted).toBe(0);
        expect(secondJson.data.duplicates).toBe(1);

        const stored = await getPrismaClient().measurement.findMany({
          where: { userId: TEST_USER_ID, type: "WEIGHT" },
        });
        expect(stored).toHaveLength(1);
      });

      it("does NOT merge different values (two real readings same minute)", async () => {
        const { POST } = await import("@/app/api/measurements/batch/route");

        await POST(
          makeRequest({
            entries: [
              weightEntry({
                externalId: "local-manual-distinct",
                source: "MANUAL",
                value: 81.4,
              }),
            ],
          }),
        );

        const second = await POST(
          makeRequest({
            entries: [
              weightEntry({
                externalId: "hk-uuid-distinct",
                source: "APPLE_HEALTH",
                value: 82.0,
              }),
            ],
          }),
        );
        expect(second.status).toBe(200);
        const secondJson = (await second.json()) as {
          data: { inserted: number; duplicates: number };
        };
        // Different value → genuinely distinct reading, both rows survive.
        expect(secondJson.data.inserted).toBe(1);
        expect(secondJson.data.duplicates).toBe(0);

        const stored = await getPrismaClient().measurement.findMany({
          where: { userId: TEST_USER_ID, type: "WEIGHT" },
        });
        expect(stored).toHaveLength(2);
      });

      it("does NOT merge timestamps beyond the tolerance window", async () => {
        const { POST } = await import("@/app/api/measurements/batch/route");

        await POST(
          makeRequest({
            entries: [
              weightEntry({
                externalId: "local-manual-far",
                source: "MANUAL",
                startDate: "2026-06-04T07:30:00.000Z",
                endDate: "2026-06-04T07:30:00.000Z",
              }),
            ],
          }),
        );

        // A full minute later — distinct reading, not the mirror pair.
        const second = await POST(
          makeRequest({
            entries: [
              weightEntry({
                externalId: "hk-uuid-far",
                source: "APPLE_HEALTH",
                startDate: "2026-06-04T07:31:00.000Z",
                endDate: "2026-06-04T07:31:00.000Z",
              }),
            ],
          }),
        );
        expect(second.status).toBe(200);
        const secondJson = (await second.json()) as {
          data: { inserted: number; duplicates: number };
        };
        expect(secondJson.data.inserted).toBe(1);
        expect(secondJson.data.duplicates).toBe(0);

        const stored = await getPrismaClient().measurement.findMany({
          where: { userId: TEST_USER_ID, type: "WEIGHT" },
        });
        expect(stored).toHaveLength(2);
      });

      it("leaves the stats:* overwrite contract untouched (no cross-source collapse)", async () => {
        const { POST } = await import("@/app/api/measurements/batch/route");

        const externalId = "stats:HKQuantityTypeIdentifierStepCount:2026-06-04";
        // A MANUAL same-day-total then an APPLE_HEALTH re-post must NOT
        // collapse — stats:* rows are per-day aggregates, excluded from the
        // merge. They are distinct (type, source) rows and each keeps its
        // own overwrite lane.
        await POST(
          makeRequest({
            entries: [
              {
                hkIdentifier: "HKQuantityTypeIdentifierStepCount",
                value: 4000,
                unit: "count",
                startDate: "2026-06-04T00:00:00.000Z",
                endDate: "2026-06-04T12:00:00.000Z",
                externalId,
                source: "MANUAL",
              },
            ],
          }),
        );

        const second = await POST(
          makeRequest({
            entries: [
              {
                hkIdentifier: "HKQuantityTypeIdentifierStepCount",
                value: 4000,
                unit: "count",
                startDate: "2026-06-04T00:00:00.000Z",
                endDate: "2026-06-04T12:00:00.000Z",
                externalId,
                source: "APPLE_HEALTH",
              },
            ],
          }),
        );
        expect(second.status).toBe(200);
        const secondJson = (await second.json()) as {
          data: { inserted: number; duplicates: number };
        };
        // Different source on a stats:* externalId → distinct row, inserted.
        expect(secondJson.data.inserted).toBe(1);
        expect(secondJson.data.duplicates).toBe(0);

        const stored = await getPrismaClient().measurement.findMany({
          where: { userId: TEST_USER_ID, externalId },
        });
        expect(stored).toHaveLength(2);
      });
    });

    it("rejects an out-of-range source value with 422", async () => {
      const { POST } = await import("@/app/api/measurements/batch/route");

      const response = await POST(
        makeRequest({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 80.5,
              unit: "kg",
              startDate: "2026-05-09T07:30:00.000Z",
              endDate: "2026-05-09T07:30:00.000Z",
              externalId: "uuid-source-bad-001",
              // WITHINGS is server-owned and not accepted on this
              // client-facing route — must surface as a 422, not silently
              // mint a forged Withings-attributed row.
              source: "WITHINGS",
            },
          ],
        }),
      );
      expect(response.status).toBe(422);

      const stored = await getPrismaClient().measurement.findMany({
        where: { userId: TEST_USER_ID, externalId: "uuid-source-bad-001" },
      });
      expect(stored).toHaveLength(0);
    });
  });
  describe("Apple aggregate authority reconciliation", () => {
    it("promotes an XML estimate to native HealthKit statistics", async () => {
      const prisma = getPrismaClient();
      await streamParseExportXml({
        xmlPath: writeCumulativeXml(),
        userId: TEST_USER_ID,
        userTimezone: "Europe/Berlin",
        prisma,
      });
      const estimated = await prisma.measurement.findMany({
        where: {
          userId: TEST_USER_ID,
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
        },
      });
      expect(estimated).toHaveLength(1);
      expect(estimated[0]).toMatchObject({
        value: 8_526,
        aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
        aggregationContributorCount: 2,
        syncVersion: 1,
      });

      const { POST } = await import("@/app/api/measurements/batch/route");
      const response = await POST(nativeStepsRequest(8_600));
      expect(response.status).toBe(200);

      const canonical = await prisma.measurement.findMany({
        where: {
          userId: TEST_USER_ID,
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
        },
      });
      expect(canonical).toHaveLength(1);
      expect(canonical[0]).toMatchObject({
        value: 8_600,
        aggregationProvenance: "HEALTHKIT_STATISTICS",
        aggregationContributorCount: null,
        aggregationSelectedSourceHash: null,
        syncVersion: 2,
      });
    });

    it("keeps native statistics authoritative when XML arrives later", async () => {
      const { POST } = await import("@/app/api/measurements/batch/route");
      expect((await POST(nativeStepsRequest(8_600))).status).toBe(200);

      const result = await streamParseExportXml({
        xmlPath: writeCumulativeXml(),
        userId: TEST_USER_ID,
        userTimezone: "Europe/Berlin",
        prisma: getPrismaClient(),
      });
      expect(result.cumulativeEstimates).toEqual({ days: 1, rows: 1 });
      expect(result.perType.ACTIVITY_STEPS).toMatchObject({
        inserted: 0,
        updated: 0,
      });

      const canonical = await getPrismaClient().measurement.findMany({
        where: {
          userId: TEST_USER_ID,
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
        },
      });
      expect(canonical).toHaveLength(1);
      expect(canonical[0]).toMatchObject({
        value: 8_600,
        aggregationProvenance: "HEALTHKIT_STATISTICS",
        syncVersion: 1,
      });
    });

    it("re-imports an XML estimate onto one row with monotonic syncVersion", async () => {
      const prisma = getPrismaClient();
      const xmlPath = writeCumulativeXml();
      await streamParseExportXml({
        xmlPath,
        userId: TEST_USER_ID,
        userTimezone: "Europe/Berlin",
        prisma,
      });
      await streamParseExportXml({
        xmlPath,
        userId: TEST_USER_ID,
        userTimezone: "Europe/Berlin",
        prisma,
      });

      const rows = await prisma.measurement.findMany({
        where: {
          userId: TEST_USER_ID,
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        value: 8_526,
        aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
        aggregationContributorCount: 2,
        syncVersion: 2,
      });
    });

    it("repairs an explicitly legacy aggregate with native statistics", async () => {
      const prisma = getPrismaClient();
      await prisma.measurement.create({
        data: {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 15_608,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-07-20T10:00:00.000Z"),
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
          aggregationProvenance: "LEGACY_UNKNOWN",
        },
      });

      const { POST } = await import("@/app/api/measurements/batch/route");
      expect((await POST(nativeStepsRequest(8_600))).status).toBe(200);

      const repaired = await prisma.measurement.findMany({
        where: {
          userId: TEST_USER_ID,
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
        },
      });
      expect(repaired).toHaveLength(1);
      expect(repaired[0]).toMatchObject({
        value: 8_600,
        aggregationProvenance: "HEALTHKIT_STATISTICS",
        syncVersion: 2,
      });
    });
  });
});
