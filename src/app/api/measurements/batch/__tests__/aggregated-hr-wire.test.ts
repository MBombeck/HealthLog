/**
 * v1.30.7/v1.30.8 (iOS #34) — go-forward aggregated 10-min heart-rate wire
 * contract on `POST /api/measurements/batch`.
 *
 * Asserts:
 *   - a fresh 10-min HR bucket inserts, with its per-bucket min/max spread;
 *   - a re-post of the same bucket OVERWRITES (status `updated`, not a
 *     duplicate row);
 *   - a malformed / off-grid aggregated HR bucket externalId is `skipped`;
 *   - v1.30.8: an out-of-range or mis-ordered spread is dropped to null while
 *     the trustworthy average survives;
 *   - the per-sample uuid HR path is unaffected (immutable duplicate);
 *   - the existing per-day step `stats:` overwrite path is unaffected.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
    measurement: {
      findMany: vi.fn(),
      createManyAndReturn: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (fn as any)(prisma as unknown as { measurement: unknown });
      }
    }),
  },
}));

vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: async (
    tx: {
      measurement: {
        findMany: (args: unknown) => Promise<
          Array<{
            id?: string;
            type?: string;
            source?: string;
            externalId?: string | null;
          }>
        >;
        createManyAndReturn: (args: {
          data: Record<string, unknown>;
        }) => Promise<Array<Record<string, unknown>>>;
        updateMany: (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => Promise<unknown>;
      };
    },
    input: Record<string, unknown> & {
      userId: string;
      type: string;
      source: string;
      externalId: string;
    },
    options: { exactExternalMatch?: "update" | "duplicate" } = {},
  ) => {
    const existing = await tx.measurement.findMany({});
    const exact = existing.find(
      (row: { type?: string; source?: string; externalId?: string | null }) =>
        row.type === input.type &&
        row.source === input.source &&
        row.externalId === input.externalId,
    );
    if (exact && options.exactExternalMatch !== "update") {
      return { status: "duplicate", row: exact };
    }
    if (exact) {
      await tx.measurement.updateMany({
        where: { id: exact.id },
        data: { ...input, deletedAt: null },
      });
      return { status: "updated", row: { ...exact, ...input } };
    }
    const [inserted] = await tx.measurement.createManyAndReturn({
      data: input,
    });
    if (inserted) return { status: "inserted", row: inserted };
    if (options.exactExternalMatch === "update") {
      await tx.measurement.updateMany({ where: {}, data: input });
      return { status: "updated", row: input };
    }
    return { status: "duplicate" };
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/jobs/pr-detection", () => ({
  enqueuePrDetection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
  collapseToTypeDayKeys: vi.fn(() => []),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const HR_BUCKET_ID =
  "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:00:00.000Z";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hrBucketEntry(
  externalId: string,
  value: number,
  spread?: { valueMin: number; valueMax: number },
) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
    value,
    unit: "count/min",
    startDate: "2026-06-21T14:00:00.000Z",
    endDate: "2026-06-21T14:59:59.000Z",
    externalId,
    ...(spread ?? {}),
  };
}

async function readJson(res: Response) {
  return (await res.json()) as {
    data: {
      processed: number;
      inserted: number;
      updated: number;
      duplicates: number;
      skipped: { index: number; reason: string }[];
      entries: { index: number; status: string; reason?: string }[];
    };
  };
}

beforeEach(() => {
  // `clearAllMocks` (not `resetAllMocks`) so the factory `$transaction`
  // pass-through implementation survives — the overwrite path sets its
  // per-entry status INSIDE the transaction, and a wiped impl would leave
  // the result slot undefined and 500 the route.
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
  vi.mocked(prisma.measurement.createManyAndReturn).mockImplementation((async (
    args: unknown,
  ) => {
    const { data } = args as {
      data:
        | { type: unknown; source: string; externalId: string | null }
        | Array<{ type: unknown; source: string; externalId: string | null }>;
    };
    const rows = Array.isArray(data) ? data : [data];
    return rows.map(({ type, source, externalId }) => ({
      type,
      source,
      externalId,
    }));
  }) as never);
  vi.mocked(prisma.measurement.updateMany).mockResolvedValue({ count: 1 });
});

describe("POST /api/measurements/batch — aggregated HR wire contract (iOS #34)", () => {
  it("inserts a fresh 10-min HR bucket as a PULSE row", async () => {
    const res = await POST(
      makeRequest({ entries: [hrBucketEntry(HR_BUCKET_ID, 72)] }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    expect(data.inserted).toBe(1);
    expect(data.updated).toBe(0);
    expect(data.entries[0].status).toBe("inserted");

    // Stored as a PULSE row carrying the 10-min average value.
    const row = vi.mocked(prisma.measurement.createManyAndReturn).mock
      .calls[0]![0]!.data as { type: string; value: number };
    expect(row.type).toBe("PULSE");
    expect(row.value).toBe(72);
  });

  it("persists per-bucket min/max on a fresh 10-min HR bucket (iOS #34 ext)", async () => {
    const res = await POST(
      makeRequest({
        entries: [
          hrBucketEntry(HR_BUCKET_ID, 72, { valueMin: 58, valueMax: 96 }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const row = vi.mocked(prisma.measurement.createManyAndReturn).mock
      .calls[0]![0]!.data as {
      value: number;
      valueMin: number;
      valueMax: number;
    };
    expect(row.value).toBe(72);
    expect(row.valueMin).toBe(58);
    expect(row.valueMax).toBe(96);
  });

  it.each([
    // out-of-plausible-range spread (a sensor glitch / spurious discreteMax)
    { valueMin: 58, valueMax: 99999 },
    { valueMin: -9999, valueMax: 96 },
    // mis-ordered: valueMin above the average, or valueMax below it
    { valueMin: 80, valueMax: 96 },
    { valueMin: 58, valueMax: 70 },
  ])(
    "v1.30.8 — drops an out-of-range or mis-ordered spread to null but keeps the average %o",
    async (spread) => {
      const res = await POST(
        makeRequest({ entries: [hrBucketEntry(HR_BUCKET_ID, 72, spread)] }),
      );
      expect(res.status).toBe(200);
      const row = vi.mocked(prisma.measurement.createManyAndReturn).mock
        .calls[0]![0]!.data as {
        value: number;
        valueMin: number | null;
        valueMax: number | null;
      };
      expect(row.value).toBe(72);
      expect(row.valueMin).toBeNull();
      expect(row.valueMax).toBeNull();
    },
  );

  it("overwrites min/max alongside the average on a re-post", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "PULSE", source: "APPLE_HEALTH", externalId: HR_BUCKET_ID },
    ] as never);
    const res = await POST(
      makeRequest({
        entries: [
          hrBucketEntry(HR_BUCKET_ID, 78, { valueMin: 55, valueMax: 110 }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const updateArg = vi.mocked(prisma.measurement.updateMany).mock.calls[0][0];
    const data = (
      updateArg as {
        data: { value: number; valueMin: number; valueMax: number };
      }
    ).data;
    expect(data.value).toBe(78);
    expect(data.valueMin).toBe(55);
    expect(data.valueMax).toBe(110);
  });

  it("leaves min/max null on a per-sample PULSE row even if sent", async () => {
    const SAMPLE_ID = "C0FFEE00-0000-4000-8000-000000000000";
    const res = await POST(
      makeRequest({
        entries: [hrBucketEntry(SAMPLE_ID, 64, { valueMin: 50, valueMax: 80 })],
      }),
    );
    expect(res.status).toBe(200);
    const row = vi.mocked(prisma.measurement.createManyAndReturn).mock
      .calls[0]![0]!.data as {
      valueMin: number | null;
      valueMax: number | null;
    };
    expect(row.valueMin).toBeNull();
    expect(row.valueMax).toBeNull();
  });

  it("overwrites the same bucket on a re-post (updated, not duplicate)", async () => {
    // The bucket already exists from an earlier within-bucket post.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        type: "PULSE",
        source: "APPLE_HEALTH",
        externalId: HR_BUCKET_ID,
      },
    ] as never);

    const res = await POST(
      makeRequest({ entries: [hrBucketEntry(HR_BUCKET_ID, 78)] }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    expect(data.updated).toBe(1);
    expect(data.inserted).toBe(0);
    expect(data.duplicates).toBe(0);
    expect(data.entries[0].status).toBe("updated");

    // The overwrite went through updateMany with the new 10-min average.
    expect(prisma.measurement.updateMany).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.measurement.updateMany).mock.calls[0][0];
    expect((updateArg as { data: { value: number } }).data.value).toBe(78);
    expect(prisma.measurement.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("skips a malformed aggregated HR bucket externalId", async () => {
    const res = await POST(
      makeRequest({
        entries: [
          hrBucketEntry(
            "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:35:00.000Z",
            70,
          ),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    expect(data.inserted).toBe(0);
    expect(data.skipped).toEqual([
      { index: 0, reason: "malformed_hr_bucket_id" },
    ]);
    expect(prisma.measurement.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("keeps the per-sample uuid HR path immutable (duplicate, not overwrite)", async () => {
    const SAMPLE_ID = "B3A1C0DE-0000-4000-8000-000000000000";
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "PULSE", source: "APPLE_HEALTH", externalId: SAMPLE_ID },
    ] as never);

    const res = await POST(
      makeRequest({ entries: [hrBucketEntry(SAMPLE_ID, 99)] }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    expect(data.duplicates).toBe(1);
    expect(data.updated).toBe(0);
    expect(data.entries[0].status).toBe("duplicate");
    expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
  });

  it("leaves the per-day step stats overwrite path unaffected", async () => {
    const STEP_STATS_ID = "stats:HKQuantityTypeIdentifierStepCount:2026-06-21";
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        type: "ACTIVITY_STEPS",
        source: "APPLE_HEALTH",
        externalId: STEP_STATS_ID,
      },
    ] as never);

    const res = await POST(
      makeRequest({
        entries: [
          {
            hkIdentifier: "HKQuantityTypeIdentifierStepCount",
            value: 8421,
            unit: "count",
            startDate: "2026-06-21T00:00:00.000Z",
            endDate: "2026-06-21T23:59:59.000Z",
            externalId: STEP_STATS_ID,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    expect(data.updated).toBe(1);
    expect(data.entries[0].status).toBe("updated");
  });
});

describe("POST /api/measurements/batch — stats tombstone resurrection", () => {
  it("resurrects a tombstoned stats: day-total on re-post (deletedAt: null, status updated)", async () => {
    const STEP_STATS_ID = "stats:HKQuantityTypeIdentifierStepCount:2026-06-21";
    // The existence probe is deliberately deletedAt-less, so a tombstoned
    // day-total row matches exactly like a live one and routes into the
    // overwrite branch.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        type: "ACTIVITY_STEPS",
        source: "APPLE_HEALTH",
        externalId: STEP_STATS_ID,
      },
    ] as never);

    const res = await POST(
      makeRequest({
        entries: [
          {
            hkIdentifier: "HKQuantityTypeIdentifierStepCount",
            value: 9001,
            unit: "count",
            startDate: "2026-06-21T00:00:00.000Z",
            endDate: "2026-06-21T23:59:59.000Z",
            externalId: STEP_STATS_ID,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    expect(data.updated).toBe(1);
    expect(data.entries[0].status).toBe("updated");

    // The overwrite carries the resurrection: the observer re-posts the
    // day's canonical total, so the update data pins `deletedAt: null`.
    expect(prisma.measurement.updateMany).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.measurement.updateMany).mock.calls[0][0];
    const updateData = (
      updateArg as { data: { value: number; deletedAt: Date | null } }
    ).data;
    expect(updateData.value).toBe(9001);
    expect(updateData.deletedAt).toBeNull();
  });

  it("keeps a tombstoned SAMPLE-grain row suppressed (duplicate, no resurrect write)", async () => {
    // Apple LWW contract: the iOS reconciler propagates HealthKit
    // deletions for sample-grain rows, so a re-post of a tombstoned
    // sample stays a checkpointing `duplicate` — no update runs at all.
    const SAMPLE_ID = "D00DAD00-0000-4000-8000-000000000000";
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "PULSE", source: "APPLE_HEALTH", externalId: SAMPLE_ID },
    ] as never);

    const res = await POST(
      makeRequest({ entries: [hrBucketEntry(SAMPLE_ID, 61)] }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    expect(data.duplicates).toBe(1);
    expect(data.updated).toBe(0);
    expect(data.entries[0].status).toBe("duplicate");
    expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    expect(prisma.measurement.createManyAndReturn).not.toHaveBeenCalled();
  });
});

/**
 * Two entries carrying the SAME `stats:` key inside ONE batch. Neither is in
 * the DB yet, so before the fix both missed the existing-row probe, both
 * landed in the bulk insert, and `skipDuplicates` kept whichever the unique
 * index saw first — the OLDER snapshot won and the newer, larger figure was
 * dropped silently while both entries still reported `inserted`.
 *
 * `stats:` rows are overwrite-by-contract, so the LAST entry for a key wins.
 */
describe("POST /api/measurements/batch — intra-batch `stats:` supersession", () => {
  it("keeps only the LAST entry when one batch carries the same stats: key twice", async () => {
    const res = await POST(
      makeRequest({
        entries: [
          hrBucketEntry(HR_BUCKET_ID, 70), // earlier snapshot of a filling bucket
          hrBucketEntry(HR_BUCKET_ID, 78), // later, authoritative snapshot
        ],
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);

    expect(prisma.measurement.createManyAndReturn).toHaveBeenCalledTimes(1);
    const row = vi.mocked(prisma.measurement.createManyAndReturn).mock
      .calls[0]![0]!.data as { value: number };
    expect(row.value).toBe(78);

    // The superseded entry is reported honestly, not as a phantom insert.
    expect(data.entries[0].status).toBe("duplicate");
    expect(data.entries[0].reason).toBe("superseded_in_batch");
    expect(data.entries[1].status).toBe("inserted");
    expect(data.inserted).toBe(1);
    expect(data.duplicates).toBe(1);
  });

  it("overwrites an existing row exactly once, with the LAST value in the batch", async () => {
    // The key is already stored, so both entries take the overwrite branch.
    // Only the authoritative last snapshot may reach the DB.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "PULSE", source: "APPLE_HEALTH", externalId: HR_BUCKET_ID },
    ] as never);

    const res = await POST(
      makeRequest({
        entries: [
          hrBucketEntry(HR_BUCKET_ID, 70),
          hrBucketEntry(HR_BUCKET_ID, 78),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);

    expect(prisma.measurement.updateMany).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.measurement.updateMany).mock.calls[0][0];
    expect((updateArg as { data: { value: number } }).data.value).toBe(78);

    expect(data.entries[0].status).toBe("duplicate");
    expect(data.entries[0].reason).toBe("superseded_in_batch");
    expect(data.entries[1].status).toBe("updated");
    expect(data.updated).toBe(1);
  });

  it("leaves DISTINCT stats: keys in one batch untouched", async () => {
    const OTHER =
      "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:10:00.000Z";

    const res = await POST(
      makeRequest({
        entries: [hrBucketEntry(HR_BUCKET_ID, 70), hrBucketEntry(OTHER, 78)],
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson(res);

    expect(prisma.measurement.createManyAndReturn).toHaveBeenCalledTimes(2);
    expect(data.inserted).toBe(2);
    expect(data.duplicates).toBe(0);
  });
});
