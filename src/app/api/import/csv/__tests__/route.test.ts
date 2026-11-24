import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => {
  const measurement = {
    findMany: vi.fn(),
    createManyAndReturn: vi.fn(),
    updateMany: vi.fn(),
  };
  return {
    prisma: {
      measurement,
      // Both transaction forms against the same measurement mock so
      // createManyAndReturn / updateMany calls are observable: a callback
      // gets the mock as `tx`, a batch array is simply awaited.
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === "function"
          ? (arg as (tx: unknown) => unknown)({ measurement })
          : Promise.all(arg as Promise<unknown>[]),
      ),
    },
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

// v1.23 — deterministic note-cipher so the route test stays isolated from the
// encryption-key env. `enc:<text>` stands in for the AES-256-GCM ciphertext.
vi.mock("@/lib/crypto/note-cipher", () => ({
  encryptNote: (s: string | null | undefined) =>
    s === null || s === undefined || s.length === 0
      ? null
      : new Uint8Array(Buffer.from(`enc:${s}`, "utf8")),
  readNote: (c: Uint8Array | null | undefined, p: string | null | undefined) =>
    c && c.byteLength > 0
      ? Buffer.from(c).toString("utf8").slice(4)
      : (p ?? null),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging/context")>()),
  annotate: vi.fn(),
}));

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

import { NextRequest } from "next/server";
import { POST } from "../route";
import { MGDL_PER_MMOL } from "@/lib/glucose";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

const HEADER = "type,value,unit,measuredAt,glucoseContext,notes,externalId";

function csvRequest(csv: string, dryRun = false) {
  return new NextRequest(
    `http://localhost/api/import/csv${dryRun ? "?dryRun=1" : ""}`,
    {
      method: "POST",
      body: csv,
      headers: { "content-type": "text/csv" },
    },
  );
}

interface CsvEnvelope {
  data: {
    inserted: number;
    updated: number;
    skipped: number;
    total: number;
    dryRun: boolean;
    rows: Array<{ line: number; status: string; reason?: string }>;
  } | null;
  error: string | null;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: new Date(Date.now() + 1000),
  } as never);
  // Default: nothing pre-exists; the transaction runner is re-stubbed by the
  // db mock factory (resetAllMocks clears its implementation), so restore it.
  const measurement = prisma.measurement as unknown as {
    findMany: ReturnType<typeof vi.fn>;
    createManyAndReturn: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  measurement.findMany.mockResolvedValue([]);
  // Echo the attempted rows, matching Postgres semantics when no row
  // collides — the route reconciles `inserted` against this result.
  measurement.createManyAndReturn.mockImplementation(
    async (arg: { data: Array<Record<string, unknown>> }) =>
      arg.data.map((row, index) => ({ ...row, id: `inserted-${index}` })),
  );
  measurement.updateMany.mockResolvedValue({ count: 0 });
  (
    prisma.$transaction as unknown as {
      mockImplementation: (f: unknown) => void;
    }
  ).mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)({ measurement })
      : Promise.all(arg as Promise<unknown>[]),
  );
});

describe("POST /api/import/csv — rate limit", () => {
  it("returns 429 against the shared import bucket when exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const res = await POST(csvRequest([HEADER, ""].join("\n")));
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("import:u-1"),
      5,
      60 * 60 * 1000,
    );
  });
});

const mMeasurement = () =>
  prisma.measurement as unknown as {
    findMany: ReturnType<typeof vi.fn>;
    createManyAndReturn: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };

describe("POST /api/import/csv — strict query", () => {
  it("refuses a misspelt dry-run flag instead of importing", async () => {
    for (const query of ["dryrun=1", "dry_run=1", "dryRun=yes"]) {
      const res = await POST(
        new NextRequest(`http://localhost/api/import/csv?${query}`, {
          method: "POST",
          body: [HEADER, "WEIGHT,80,kg,2026-05-01T08:00:00Z,,,"].join("\n"),
          headers: { "content-type": "text/csv" },
        }),
      );
      expect(res.status).toBe(422);
    }
    expect(mMeasurement().createManyAndReturn).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/import/csv — fatal header error", () => {
  it("returns 422 when a required column is missing", async () => {
    const res = await POST(csvRequest("type,value,unit\nWEIGHT,80,kg"));
    expect(res.status).toBe(422);
    expect(mMeasurement().createManyAndReturn).not.toHaveBeenCalled();
  });

  it("returns 422 for a file with more rows than one import reads", async () => {
    const res = await POST(csvRequest(`${HEADER}\n${"x\n".repeat(100_001)}`));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/more than 100000 data rows/);
    expect(mMeasurement().createManyAndReturn).not.toHaveBeenCalled();
  });
});

describe("POST /api/import/csv — batched write + per-row envelope", () => {
  it("inserts valid rows, skips invalid ones, returns per-row status", async () => {
    const res = await POST(
      csvRequest(
        [
          HEADER,
          "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,morning,", // inserted
          "NOPE,1,kg,2026-05-01T08:00:00Z,,,", // skipped unknown_type
          "WEIGHT,80,kg,2026-05-01T08:00:00,,,", // skipped missing offset
        ].join("\n"),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.skipped).toBe(2);
    expect(body.data?.total).toBe(3);
    expect(body.data?.dryRun).toBe(false);
    const reasons = body.data?.rows.map((r) => r.reason);
    expect(reasons).toContain("unknown_type");
    expect(reasons).toContain("missing_timezone_offset");
    // One bulk createManyAndReturn carrying the single valid survivor.
    expect(mMeasurement().createManyAndReturn).toHaveBeenCalledTimes(1);
    const arg = mMeasurement().createManyAndReturn.mock.calls[0][0];
    expect(arg.data).toHaveLength(1);
    // Rollup re-fold fired for the touched (type, day).
    expect(vi.mocked(recomputeBucketsForMeasurement)).toHaveBeenCalled();
  });

  it("batches many rows into a single createManyAndReturn", async () => {
    const rows = [HEADER];
    for (let i = 0; i < 50; i++) {
      const mm = String(i).padStart(2, "0"); // unique minute → unique measuredAt
      rows.push(`WEIGHT,${80 + i * 0.1},kg,2026-05-01T08:${mm}:00Z,,,`);
    }
    const res = await POST(csvRequest(rows.join("\n")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(50);
    // 50 rows, one bulk call — the whole point of the batch.
    expect(mMeasurement().createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(
      mMeasurement().createManyAndReturn.mock.calls[0][0].data,
    ).toHaveLength(50);
  });

  it("dryRun previews without writing and reports projected inserts", async () => {
    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,"].join("\n"),
        true,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.dryRun).toBe(true);
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.rows[0].status).toBe("inserted");
    expect(mMeasurement().createManyAndReturn).not.toHaveBeenCalled();
    expect(vi.mocked(recomputeBucketsForMeasurement)).not.toHaveBeenCalled();
  });

  it("surfaces an externalId row as updated when it already existed (updateMany)", async () => {
    mMeasurement().findMany.mockResolvedValue([
      {
        type: "WEIGHT",
        externalId: "ext-1",
        measuredAt: new Date("2026-05-01T08:00:00Z"),
      },
    ]);

    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,ext-1"].join("\n"),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.updated).toBe(1);
    expect(body.data?.inserted).toBe(0);
    expect(body.data?.rows[0].status).toBe("updated");
    expect(mMeasurement().updateMany).toHaveBeenCalledTimes(1);
    expect(mMeasurement().createManyAndReturn).not.toHaveBeenCalled();
  });

  it("resurrects a tombstoned externalId row on re-import (deletedAt: null in update)", async () => {
    // The ext-probe is deliberately deletedAt-less, so a tombstoned IMPORT
    // row matches like a live one; the update must carry the resurrection
    // (IMPORT rows are re-importable by design).
    mMeasurement().findMany.mockResolvedValue([
      {
        type: "WEIGHT",
        externalId: "ext-tomb",
        // Identical values: only the tombstone differs, and that alone
        // makes the line an update rather than a duplicate.
        value: 81.0,
        unit: "kg",
        measuredAt: new Date("2026-05-01T08:00:00Z"),
        glucoseContext: null,
        notes: null,
        notesEncrypted: null,
        deletedAt: new Date("2026-05-02T08:00:00Z"),
      },
    ]);

    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,81.0,kg,2026-05-01T08:00:00Z,,,ext-tomb"].join("\n"),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.updated).toBe(1);
    expect(body.data?.rows[0].status).toBe("updated");
    const updateArg = mMeasurement().updateMany.mock.calls[0][0] as {
      data: { value: number; deletedAt: Date | null };
    };
    expect(updateArg.data.value).toBe(81.0);
    expect(updateArg.data.deletedAt).toBeNull();
  });

  it("inserts an externalId row when it does not exist yet", async () => {
    mMeasurement().findMany.mockResolvedValue([]);
    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,ext-2"].join("\n"),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.updated).toBe(0);
    expect(body.data?.rows[0].status).toBe("inserted");
    expect(mMeasurement().createManyAndReturn).toHaveBeenCalledTimes(1);
  });

  it("counts a pre-existing natural-key row as skipped/duplicate", async () => {
    mMeasurement().findMany.mockResolvedValue([
      { type: "WEIGHT", measuredAt: new Date("2026-05-01T08:00:00Z") },
    ]);

    const res = await POST(
      csvRequest([HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,"].join("\n")),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(0);
    expect(body.data?.skipped).toBe(1);
    expect(body.data?.rows[0]).toMatchObject({
      status: "skipped",
      reason: "duplicate",
    });
    expect(mMeasurement().createManyAndReturn).not.toHaveBeenCalled();
  });

  it("collapses an in-file duplicate (same type+measuredAt) to one insert + one duplicate", async () => {
    const res = await POST(
      csvRequest(
        [
          HEADER,
          "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,",
          "WEIGHT,80.6,kg,2026-05-01T08:00:00Z,,,",
        ].join("\n"),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.skipped).toBe(1);
    // Only the first survivor reaches the bulk insert.
    expect(
      mMeasurement().createManyAndReturn.mock.calls[0][0].data,
    ).toHaveLength(1);
  });

  it("reconciles `inserted` against returned rows after a race", async () => {
    // Two fresh rows attempted, but a concurrent double-submit already
    // landed one of them — `skipDuplicates` absorbs the conflict and the
    // count comes back short. The envelope must sum to the DB truth: one
    // inserted, one downgraded to skipped/duplicate.
    mMeasurement().createManyAndReturn.mockImplementation(
      async (arg: { data: Array<Record<string, unknown>> }) =>
        arg.data
          .slice(0, -1)
          .map((row, index) => ({ ...row, id: `inserted-${index}` })),
    );

    const res = await POST(
      csvRequest(
        [
          HEADER,
          "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,",
          "WEIGHT,81.5,kg,2026-05-01T09:00:00Z,,,",
        ].join("\n"),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.skipped).toBe(1);
    const statuses = body.data?.rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["inserted", "skipped"]);
    expect(body.data?.rows.find((r) => r.status === "skipped")?.reason).toBe(
      "duplicate",
    );
  });
});

describe("POST /api/import/csv — contextless blood glucose", () => {
  // #640 — the reported file. A sensor export leaves `glucoseContext` blank
  // on every row; the route must build a row with the column NULL rather
  // than refusing the reading.
  it("writes a contextless sensor reading with the canonical shape", async () => {
    const res = await POST(
      csvRequest(
        [
          HEADER,
          "BLOOD_GLUCOSE,5.3,mmol/L,2024-04-03T13:15:00+1100,,Sensor,sensor-1",
        ].join("\n"),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.skipped).toBe(0);
    expect(body.data?.rows).toEqual([{ line: 2, status: "inserted" }]);

    const row = mMeasurement().createManyAndReturn.mock.calls[0][0].data[0];
    expect(row).toMatchObject({
      userId: "u-1",
      type: "BLOOD_GLUCOSE",
      unit: "mg/dL",
      source: "IMPORT",
      externalId: "sensor-1",
      glucoseContext: null,
    });
    expect(row.value).toBeCloseTo(5.3 * MGDL_PER_MMOL, 3);
    expect((row.measuredAt as Date).toISOString()).toBe(
      "2024-04-03T02:15:00.000Z",
    );
  });

  it("keeps a re-upload of the same external id idempotent", async () => {
    // The key already exists under (userId, type, source=IMPORT, externalId).
    mMeasurement().findMany.mockResolvedValue([
      {
        type: "BLOOD_GLUCOSE",
        externalId: "sensor-1",
        measuredAt: new Date("2024-04-03T02:15:00Z"),
      },
    ]);

    const res = await POST(
      csvRequest(
        [
          HEADER,
          "BLOOD_GLUCOSE,5.3,mmol/L,2024-04-03T13:15:00+1100,,Sensor,sensor-1",
        ].join("\n"),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(0);
    expect(body.data?.updated).toBe(1);
    expect(body.data?.rows).toEqual([{ line: 2, status: "updated" }]);
    // No second row minted — the existing one is updated in place.
    expect(mMeasurement().createManyAndReturn).not.toHaveBeenCalled();
    const update = mMeasurement().updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({
      userId: "u-1",
      source: "IMPORT",
      type: "BLOOD_GLUCOSE",
      externalId: "sensor-1",
    });
    expect(update.data).toMatchObject({ glucoseContext: null, unit: "mg/dL" });
  });

  it("still refuses a context that is not one of the four", async () => {
    const res = await POST(
      csvRequest(
        [HEADER, "BLOOD_GLUCOSE,95,mg/dL,2026-05-01T08:00:00Z,LUNCH,,"].join(
          "\n",
        ),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(0);
    expect(body.data?.rows[0]).toMatchObject({
      status: "skipped",
      reason: "invalid_glucose_context",
    });
  });
});

/**
 * v1.39.3 — re-importing the same file. A 9 000-row re-upload with an
 * externalId column used to run one update per row inside a single
 * interactive transaction and ended in a 500 when that outlived Prisma's 5 s
 * timeout. An unchanged row is now a duplicate with no write, a changed one
 * still updates, and lookups and writes run in bounded chunks.
 */
describe("POST /api/import/csv — re-import", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: Date.now() + 3_600_000,
    } as never);
    mMeasurement().findMany.mockReset();
    mMeasurement().createManyAndReturn.mockReset();
    mMeasurement().createManyAndReturn.mockResolvedValue([]);
    mMeasurement().updateMany.mockReset();
    mMeasurement().updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(prisma.$transaction).mockClear();
  });

  function stored(externalId: string, overrides: Record<string, unknown> = {}) {
    return {
      type: "WEIGHT",
      externalId,
      value: 80.5,
      unit: "kg",
      measuredAt: new Date("2026-05-01T08:00:00Z"),
      glucoseContext: null,
      notes: null,
      notesEncrypted: new Uint8Array(Buffer.from("enc:after run", "utf8")),
      deletedAt: null,
      ...overrides,
    };
  }

  it("writes nothing for a row that is already stored exactly so", async () => {
    mMeasurement().findMany.mockResolvedValue([stored("ext-1")]);
    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,after run,ext-1"].join(
          "\n",
        ),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
    expect(body.data?.rows).toEqual([
      { line: 2, status: "skipped", reason: "duplicate" },
    ]);
    expect(mMeasurement().updateMany).not.toHaveBeenCalled();
    expect(mMeasurement().createManyAndReturn).not.toHaveBeenCalled();
  });

  it.each([
    ["value", "WEIGHT,81,kg,2026-05-01T08:00:00Z,,after run,ext-1"],
    ["note", "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,before run,ext-1"],
    ["instant", "WEIGHT,80.5,kg,2026-05-01T09:00:00Z,,after run,ext-1"],
  ])("still updates a row whose %s changed", async (_what, line) => {
    mMeasurement().findMany.mockResolvedValue([stored("ext-1")]);
    const res = await POST(csvRequest([HEADER, line].join("\n")));
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data).toMatchObject({ updated: 1, skipped: 0 });
    expect(mMeasurement().updateMany).toHaveBeenCalledTimes(1);
  });

  it("re-folds the day a moved reading left as well as the day it moved to", async () => {
    mMeasurement().findMany.mockResolvedValue([stored("ext-1")]);
    await POST(
      csvRequest(
        [HEADER, "WEIGHT,80.5,kg,2026-05-03T08:00:00Z,,after run,ext-1"].join(
          "\n",
        ),
      ),
    );
    const days = vi
      .mocked(recomputeBucketsForMeasurement)
      .mock.calls.map(
        ([, type, at]) => `${type}@${at.toISOString().slice(0, 10)}`,
      )
      .sort();
    expect(days).toEqual(["WEIGHT@2026-05-01", "WEIGHT@2026-05-03"]);
  });

  it("re-folds what it touched when a write chunk fails part-way", async () => {
    mMeasurement().findMany.mockResolvedValue([]);
    mMeasurement().createManyAndReturn.mockRejectedValue(
      new Error("connection reset"),
    );
    await expect(
      POST(
        csvRequest(
          [
            HEADER,
            "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,",
            "WEIGHT,80.7,kg,2026-05-02T08:00:00Z,,,",
          ].join("\n"),
        ),
      ),
    ).rejects.toThrow("connection reset");
    const days = vi
      .mocked(recomputeBucketsForMeasurement)
      .mock.calls.map(([, , at]) => at.toISOString().slice(0, 10))
      .sort();
    expect(days).toEqual(["2026-05-01", "2026-05-02"]);
  });

  it("probes per type in bounded chunks and writes updates in bounded batches", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
      return `WEIGHT,${70 + (i % 10)},kg,${at},,,ext-${i}`;
    });
    // Every key exists, with a different value, so every line updates.
    mMeasurement().findMany.mockImplementation((async (args: {
      where: { externalId: { in: string[] } };
    }) =>
      args.where.externalId.in.map((externalId) =>
        stored(externalId, { value: 1 }),
      )) as never);

    const res = await POST(csvRequest([HEADER, ...lines].join("\n")));
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.updated).toBe(2500);

    const probes = mMeasurement().findMany.mock.calls.map(
      (c) => (c[0] as { where: { externalId: { in: string[] } } }).where,
    );
    expect(probes).toHaveLength(3);
    expect(probes.every((w) => w.externalId.in.length <= 1000)).toBe(true);
    // 2 500 updates in batches of at most 200, each its own transaction:
    // no single transaction carries the whole file.
    const batches = vi
      .mocked(prisma.$transaction)
      .mock.calls.map((c) => c[0] as unknown as unknown[]);
    expect(batches).toHaveLength(13);
    expect(batches.every((b) => Array.isArray(b) && b.length <= 200)).toBe(
      true,
    );
    expect(mMeasurement().updateMany).toHaveBeenCalledTimes(2500);
  });
});
