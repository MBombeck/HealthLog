/**
 * v1.19.0 — server-side consolidation of high-frequency blood oxygen (SpO2).
 *
 * Apple Watch's Blood-Oxygen app samples OXYGEN_SATURATION periodically
 * through the day and overnight; the readings map to `aggregation: "latest"`
 * and belong to NEITHER `CUMULATIVE_HK_TYPES` nor `HIGH_FREQUENCY_MEAN_TYPES`,
 * so every sample piled up raw forever. The dense intra-day retention drain
 * folds the out-of-window per-sample rows to hourly-MEAN `stats:` rows,
 * mirroring the PULSE facet's fidelity handling: the daily MIN is the
 * overnight-desaturation nadir — the single most clinically meaningful SpO2
 * figure — so the DAY rollup bucket is recomputed from the RAW rows BEFORE the
 * fold and the post-fold recompute that would degrade min/max (and drift the
 * mean to an unweighted mean-of-hourly-means) is skipped.
 *
 * This suite pins the SpO2 facet: the pre-fold (and only) DAY-rollup recompute,
 * the hourly MEAN fold + soft-delete, the no-derived-resting-row guard
 * (resting HR is a PULSE-only concern), idempotency, and the per-day failure
 * boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recomputeBucketsForMeasurement } = vi.hoisted(() => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement,
}));

import { runDenseIntradayRetention } from "../dense-intraday-retention";
import type { PerSampleRow } from "../drain-per-sample-cumulative";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { candidateLookup, createManyVia } from "./hourly-mint-mock";

function spo2Row(id: string, value: number, iso: string): PerSampleRow {
  return {
    id,
    type: "OXYGEN_SATURATION" as MeasurementType,
    value,
    measuredAt: new Date(iso),
    externalId: null,
    unit: "%",
  };
}

/**
 * Prisma mock covering the SpO2 fold flow: the scan (per-type rows), the fold
 * transaction (`create`/`update`/`findFirst`/`updateMany`), and the top-level
 * surfaces a PULSE day would touch (`findFirst` for the native-resting probe,
 * `upsert` for the derived resting row) — both must stay UNCALLED for SpO2.
 */
function buildPrismaMock(opts: { spo2Rows: PerSampleRow[] }) {
  const txCreate = vi.fn().mockResolvedValue({ id: "minted-daily" });
  const txUpdate = vi.fn().mockResolvedValue({});
  const txFindFirst = vi.fn().mockResolvedValue(null);
  const txUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: opts.spo2Rows.length });
  const tx = {
    measurement: {
      create: txCreate,
      update: txUpdate,
      findFirst: txFindFirst,
      updateMany: txUpdateMany,
      findMany: candidateLookup(),
      createManyAndReturn: createManyVia(txCreate),
    },
  };

  const findMany = vi.fn(async (args: { where: { type: string } }) =>
    args.where.type === "OXYGEN_SATURATION" ? opts.spo2Rows : [],
  );
  // Native-resting probe + derived-resting upsert: PULSE-only surfaces.
  const topFindFirst = vi.fn().mockResolvedValue(null);
  const upsert = vi.fn().mockResolvedValue({ id: "derived-rhr" });

  const mock = {
    user: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]),
    },
    measurement: { findMany, findFirst: topFindFirst, upsert },
    $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaClient;

  return { mock, txCreate, txUpdate, txUpdateMany, upsert, topFindFirst };
}

beforeEach(() => {
  recomputeBucketsForMeasurement.mockClear();
});

describe("SpO2 fold — hourly MEAN collapse + soft-delete", () => {
  it("folds each LOCAL hour to its own MEAN row and soft-deletes the raw rows", async () => {
    // Overnight dip to 91, daytime band 96..98 — four distinct local hours.
    const rows = [
      spo2Row("a", 91, "2026-05-01T03:00:00.000Z"),
      spo2Row("b", 96, "2026-05-01T09:00:00.000Z"),
      spo2Row("c", 97, "2026-05-01T13:00:00.000Z"),
      spo2Row("d", 98, "2026-05-01T19:00:00.000Z"),
    ];
    const { mock, txCreate, txUpdateMany } = buildPrismaMock({
      spo2Rows: rows,
    });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    // One hourly row per distinct local hour; the overnight 91 nadir hour
    // keeps its own value instead of vanishing into a daily mean of ~95.5.
    expect(txCreate).toHaveBeenCalledTimes(4);
    const createArgs = txCreate.mock.calls.map(
      (c) =>
        (
          c[0] as {
            data: { value: number; type: string; source: string; unit: string };
          }
        ).data,
    );
    expect(createArgs.map((d) => d.value)).toEqual([91, 96, 97, 98]);
    for (const d of createArgs) {
      expect(d.type).toBe("OXYGEN_SATURATION");
      expect(d.source).toBe("APPLE_HEALTH");
      expect(d.unit).toBe("%");
    }

    // Soft-delete, never hard delete.
    const updArg = txUpdateMany.mock.calls[0]?.[0] as {
      data: { deletedAt: Date };
    };
    expect(updArg.data.deletedAt).toBeInstanceOf(Date);
    expect(summary.totals.daysConsolidated).toBe(1);
    expect(summary.totals.perSampleRowsSoftDeleted).toBe(rows.length);
    expect(summary.totals.hourlyRowsUpserted).toBe(4);
  });
});

describe("SpO2 fold — min/max preservation (overnight desat nadir)", () => {
  it("recomputes the SpO2 DAY rollup from RAW rows BEFORE the fold, and NOT after", async () => {
    const rows = [
      spo2Row("a", 90, "2026-05-01T03:00:00.000Z"),
      spo2Row("b", 96, "2026-05-01T12:00:00.000Z"),
      spo2Row("c", 99, "2026-05-01T18:00:00.000Z"),
    ];
    const { mock, txCreate } = buildPrismaMock({ spo2Rows: rows });

    await runDenseIntradayRetention(mock, { retentionDays: 0, log: () => {} });

    // Three distinct local hours → three hourly rows.
    expect(txCreate).toHaveBeenCalledTimes(3);

    // EXACTLY one SpO2 recompute — the pre-fold capture. A second (post-fold)
    // recompute would aggregate the hourly mean rows and degrade the daily MIN
    // (the overnight-desaturation nadir) toward the hourly means.
    const spo2Recomputes = recomputeBucketsForMeasurement.mock.calls.filter(
      (c) => c[1] === "OXYGEN_SATURATION",
    );
    expect(spo2Recomputes).toHaveLength(1);
  });
});

describe("SpO2 fold — no resting derivation (PULSE-only concern)", () => {
  it("never probes native resting nor mints a derived RESTING_HEART_RATE row", async () => {
    const rows = [
      spo2Row("a", 95, "2026-05-01T03:00:00.000Z"),
      spo2Row("b", 96, "2026-05-01T09:00:00.000Z"),
      spo2Row("c", 97, "2026-05-01T19:00:00.000Z"),
    ];
    const { mock, upsert, topFindFirst } = buildPrismaMock({ spo2Rows: rows });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    expect(upsert).not.toHaveBeenCalled();
    expect(topFindFirst).not.toHaveBeenCalled();
    expect(summary.totals.derivedRestingRowsUpserted).toBe(0);
  });
});

describe("SpO2 fold — idempotency + dry-run + no double-collapse", () => {
  it("converges to zero work when the scan returns no live rows (re-run)", async () => {
    const { mock, txCreate, txUpdateMany } = buildPrismaMock({ spo2Rows: [] });
    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });
    expect(txCreate).not.toHaveBeenCalled();
    expect(txUpdateMany).not.toHaveBeenCalled();
    expect(summary.totals.daysConsolidated).toBe(0);
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });

  it("writes nothing on a dry-run (no fold, no pre-fold recompute)", async () => {
    const rows = [
      spo2Row("a", 95, "2026-05-01T03:00:00.000Z"),
      spo2Row("b", 96, "2026-05-01T09:00:00.000Z"),
      spo2Row("c", 97, "2026-05-01T19:00:00.000Z"),
    ];
    const { mock, txCreate, upsert } = buildPrismaMock({ spo2Rows: rows });
    await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      dryRun: true,
      log: () => {},
    });
    expect(txCreate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });

  it("does not double-collapse already-folded `stats:` rows (skipped by the bucketing predicate)", async () => {
    // A previously-folded daily row carrying the `stats:` externalId is the
    // only "row" left on a re-run; the bucketing skips it, so nothing folds.
    const folded: PerSampleRow = {
      id: "folded",
      type: "OXYGEN_SATURATION" as MeasurementType,
      value: 95,
      measuredAt: new Date("2026-05-01T12:00:00.000Z"),
      externalId: "stats:HKQuantityTypeIdentifierOxygenSaturation:2026-05-01",
      unit: "%",
    };
    const { mock, txCreate } = buildPrismaMock({ spo2Rows: [folded] });
    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });
    expect(txCreate).not.toHaveBeenCalled();
    expect(summary.totals.daysConsolidated).toBe(0);
  });
});

describe("SpO2 fold — per-day failure boundary", () => {
  it("steps over a day whose fold throws and keeps draining the rest", async () => {
    const day1 = [
      spo2Row("a", 95, "2026-05-01T03:00:00.000Z"),
      spo2Row("b", 96, "2026-05-01T12:00:00.000Z"),
    ];
    const day2 = [
      spo2Row("c", 94, "2026-05-02T03:00:00.000Z"),
      spo2Row("d", 97, "2026-05-02T12:00:00.000Z"),
    ];
    const { mock } = buildPrismaMock({ spo2Rows: [...day1, ...day2] });

    // First day's fold transaction throws a non-P2002 error; the boundary
    // must absorb it and continue to the second day.
    let call = 0;
    (mock.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (t: unknown) => Promise<unknown>) => {
        call += 1;
        if (call === 1) throw new Error("boom — poisoned day");
        return cb({
          measurement: {
            create: vi.fn().mockResolvedValue({ id: "minted" }),
            update: vi.fn(),
            findFirst: vi.fn().mockResolvedValue(null),
            updateMany: vi.fn().mockResolvedValue({ count: 2 }),
            findMany: candidateLookup(),
            createManyAndReturn: createManyVia(
              vi.fn().mockResolvedValue({ id: "minted" }),
            ),
          },
        });
      },
    );

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    // The second day still folded despite the first day's failure.
    expect(summary.totals.daysConsolidated).toBe(1);
  });
});
