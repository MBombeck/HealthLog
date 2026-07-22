import { describe, expect, it } from "vitest";

import {
  MEDICATION_INTAKE_IMPORT_CHUNK_SIZE,
  MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE,
  _setMedicationIntakeImportPrismaForTests,
  advanceMedicationImportProgress,
  medicationImportChunk,
  processMedicationIntakeImportJob,
  sanitiseMedicationImportFailure,
  type MedicationImportProgress,
} from "@/lib/jobs/medication-intake-import";

const INITIAL: MedicationImportProgress = {
  processed: 0,
  total: 1_000,
  imported: 0,
  skippedDuplicates: 0,
  touchedDays: [],
  rollupProcessed: 0,
};

describe("medication intake import worker bounds", () => {
  it("never exposes more than the configured chunk-size to one transaction", () => {
    const entries = Array.from({ length: 1_000 }, (_, index) => ({ index }));
    let cursor = 0;
    const observed: number[] = [];

    while (cursor < entries.length) {
      const chunk = medicationImportChunk(entries, cursor);
      observed.push(chunk.length);
      cursor += chunk.length;
    }

    expect(MEDICATION_INTAKE_IMPORT_CHUNK_SIZE).toBeGreaterThan(0);
    expect(MEDICATION_INTAKE_IMPORT_CHUNK_SIZE).toBeLessThanOrEqual(100);
    expect(Math.max(...observed)).toBe(MEDICATION_INTAKE_IMPORT_CHUNK_SIZE);
    expect(observed.reduce((sum, size) => sum + size, 0)).toBe(1_000);
  });

  it("advances progress monotonically and ignores a stale replay", () => {
    const first = advanceMedicationImportProgress(INITIAL, {
      from: 0,
      processed: 100,
      imported: 98,
      skippedDuplicates: 2,
      touchedDays: ["2026-07-20", "2026-07-21"],
    });
    const second = advanceMedicationImportProgress(first, {
      from: 100,
      processed: 100,
      imported: 97,
      skippedDuplicates: 3,
      touchedDays: ["2026-07-21", "2026-07-22"],
    });
    const replay = advanceMedicationImportProgress(second, {
      from: 0,
      processed: 100,
      imported: 98,
      skippedDuplicates: 2,
      touchedDays: ["2026-07-20"],
    });

    expect(first.processed).toBe(100);
    expect(second).toEqual({
      processed: 200,
      total: 1_000,
      imported: 195,
      skippedDuplicates: 5,
      touchedDays: ["2026-07-20", "2026-07-21", "2026-07-22"],
      rollupProcessed: 0,
    });
    expect(replay).toBe(second);
  });

  it("stores a bounded generic failure instead of an internal error", () => {
    const internal = new Error(
      "postgres://queue-user:secret@example.test medication payload leaked",
    );

    const failure = sanitiseMedicationImportFailure(internal);

    expect(failure).toBe("Medication intake import failed");
    expect(failure).not.toContain("secret");
    expect(failure.length).toBeLessThanOrEqual(1_000);
  });

  it("checkpoints bounded rollup transactions across many touched days", async () => {
    const touchedDays = Array.from({ length: 1_000 }, (_, index) =>
      new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    );
    let persistedProgress: unknown = {
      processed: 0,
      total: 0,
      imported: 0,
      skippedDuplicates: 0,
      touchedDays,
    };
    let status = "running";
    const executeRawCounts: number[] = [];
    let auditCount = 0;
    let transactionNumber = 0;
    let rejectRollup = true;

    const client = {
      $transaction: async (
        operation: (tx: Record<string, unknown>) => Promise<unknown>,
      ) => {
        transactionNumber += 1;
        let executeRawCount = 0;
        const tx = {
          $queryRaw: async () => [{ id: "job-many-days" }],
          $executeRaw: async () => {
            executeRawCount += 1;
            if (rejectRollup && transactionNumber === 3) {
              rejectRollup = false;
              throw new Error("rollup transaction failed");
            }
            return 1;
          },
          medicationIntakeImportJob: {
            findUnique: async () => ({
              id: "job-many-days",
              userId: "user-1",
              medicationId: "medication-1",
              status,
              payload: { entries: [] },
              progress: persistedProgress,
              startedAt: new Date(),
              user: { timezone: "UTC" },
            }),
            update: async (args: {
              data: { progress?: unknown; status?: string };
            }) => {
              if (args.data.progress !== undefined) {
                persistedProgress = args.data.progress;
              }
              if (args.data.status !== undefined) status = args.data.status;
              return {};
            },
          },
          auditLog: {
            create: async () => {
              auditCount += 1;
              return {};
            },
          },
        };
        try {
          return await operation(tx);
        } finally {
          executeRawCounts.push(executeRawCount);
        }
      },
    };

    _setMedicationIntakeImportPrismaForTests(client as never);
    try {
      await expect(
        processMedicationIntakeImportJob("job-many-days"),
      ).rejects.toThrow("rollup transaction failed");
      expect(persistedProgress).toMatchObject({
        rollupProcessed: MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE * 2,
      });
      expect(status).toBe("running");
      expect(auditCount).toBe(0);

      await processMedicationIntakeImportJob("job-many-days");
    } finally {
      _setMedicationIntakeImportPrismaForTests(null);
    }

    expect(executeRawCounts).toHaveLength(
      Math.ceil(
        touchedDays.length / MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE,
      ) + 1,
    );
    expect(Math.max(...executeRawCounts)).toBeLessThanOrEqual(
      MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE * 2,
    );
    expect(status).toBe("done");
    expect(persistedProgress).toMatchObject({
      rollupProcessed: touchedDays.length,
    });
    expect(auditCount).toBe(1);
  });
});
