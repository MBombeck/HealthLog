/**
 * `reconcileExternalMeasurementsInChunks`: an importer's day totals in
 * transactions of 200, where one chunk that fails (a transaction timeout, a
 * lock wait) costs that chunk's rows, counted as failed, and the rest of the
 * import still runs.
 */
import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";

import {
  reconcileExternalMeasurementsInChunks,
  type ExternalMeasurementWrite,
  type MeasurementReconciliationVerdict,
} from "../reconcile-external-measurement";

function entry(i: number): ExternalMeasurementWrite {
  return {
    userId: "user-1",
    type: "ACTIVITY_STEPS",
    value: 1000 + i,
    unit: "steps",
    source: "HEALTH_CONNECT",
    externalId: `stats:steps:${i}`,
    measuredAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000),
  };
}

function inserted(n: number): MeasurementReconciliationVerdict[] {
  return Array.from({ length: n }, (_, i) => ({
    status: "duplicate" as const,
    row: {
      id: `m${i}`,
      type: "ACTIVITY_STEPS" as const,
      measuredAt: new Date(Date.UTC(2026, 0, 1)),
      externalId: `stats:steps:${i}`,
    },
  }));
}

describe("reconcileExternalMeasurementsInChunks", () => {
  it("runs chunks of 200 and turns a failed chunk into failed rows, not an abort", async () => {
    const batch = Array.from({ length: 450 }, (_, i) => entry(i));
    const sizes = [200, 200, 50];
    let call = 0;
    const transaction = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("Transaction already closed");
      return inserted(sizes[call - 1]!);
    });
    const db: Pick<PrismaClient, "$transaction"> = {
      $transaction: transaction as PrismaClient["$transaction"],
    };

    const verdicts = await reconcileExternalMeasurementsInChunks(db, batch);

    expect(transaction).toHaveBeenCalledTimes(3);
    expect(verdicts).toHaveLength(450);
    expect(verdicts.slice(0, 200).every((v) => v.status === "failed")).toBe(
      true,
    );
    expect(verdicts.slice(200).every((v) => v.status === "duplicate")).toBe(
      true,
    );
  });
});
