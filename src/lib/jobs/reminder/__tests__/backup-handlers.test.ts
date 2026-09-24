import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildFullBackupPayload: vi.fn(),
  getWorkerPrisma: vi.fn(),
  store: vi.fn(),
}));

// Only the payload builder is stubbed. The REAL streaming writer runs on top
// of it, so this file keeps stubbing and asserting the PAYLOAD — which is what
// it is about — while the framing that turns it into stored bytes is the
// framing the job actually uses. `isDeferredRows` rides along because the
// writer asks it about every section; nothing here defers.
vi.mock("@/lib/export/full-backup-payload", () => ({
  buildFullBackupPayload: mocks.buildFullBackupPayload,
  isDeferredRows: () => false,
}));

// The envelope and the piecewise store are exercised end-to-end in
// `src/lib/export/__tests__/backup-blob.test.ts` and the integration suite;
// here the store stays transparent so the stored bytes can be read back as
// JSON. `mocks.store` receives what would have been stored and decides
// whether the write succeeds.
vi.mock("@/lib/export/store-backup-blob", () => ({
  storeBackupBlob: async (
    _prisma: unknown,
    input: { userId: string; type: string },
    produce: (write: (chunk: string) => Promise<void>) => Promise<void>,
  ) => {
    let out = "";
    await produce(async (chunk) => {
      out += chunk;
    });
    await mocks.store(input, out);
    return out.length;
  },
}));

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: vi.fn(
    async (_name: string, run: (event: object) => Promise<void>) =>
      run({
        addMeta: vi.fn(),
        addWarning: vi.fn(),
        setBackground: vi.fn(),
        setError: vi.fn(),
      }),
  ),
}));

vi.mock("../shared", () => ({
  getWorkerPrisma: mocks.getWorkerPrisma,
}));

import { BackupBlobTooLargeError } from "@/lib/export/backup-blob";

import { handleDataBackup } from "../backup-handlers";

const documentCiphertext = Buffer.from([1, 2, 3, 4]).toString("base64");

function buildPrismaMock(
  users: Array<{ id: string; username: string }> = [
    { id: "user-dr", username: "backup-owner" },
  ],
) {
  return {
    user: { findMany: vi.fn().mockResolvedValue(users) },
  };
}

describe("handleDataBackup canonical DR payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkerPrisma.mockReturnValue(buildPrismaMock());
    mocks.store.mockResolvedValue(undefined);
    mocks.buildFullBackupPayload.mockResolvedValue({
      payload: {
        schemaVersion: "1",
        exportedAt: "2026-07-20T00:00:00.000Z",
        userId: "user-dr",
        moodEntries: [
          {
            id: "mood-dr",
            externalId: "mood-external-dr",
            factors: [{ key: "sleep_quality", rating: 5 }],
          },
        ],
        documents: [
          {
            id: "document-dr",
            contentEncrypted: documentCiphertext,
            contentCodec: "binary2",
          },
        ],
      },
      counts: {},
    });
  });

  it("serializes the shared canonical disaster-recovery payload", async () => {
    await handleDataBackup([]);

    const prisma = mocks.getWorkerPrisma.mock.results[0]!.value;
    expect(mocks.buildFullBackupPayload).toHaveBeenCalledWith(
      prisma,
      "user-dr",
      // `deferBulk` is the writer's own ask: it declares the unbounded tables
      // rather than reading them, and pulls their rows through itself.
      expect.objectContaining({
        purpose: "disaster-recovery",
        deferBulk: true,
      }),
    );
    expect(mocks.store).toHaveBeenCalledOnce();
    expect(mocks.store.mock.calls[0]![0]).toEqual({
      userId: "user-dr",
      type: "WEEKLY_AUTO",
    });
    const encrypted = mocks.store.mock.calls[0]![1] as string;
    const payload = JSON.parse(encrypted) as {
      moodEntries: Array<{
        id: string;
        externalId: string;
        factors: Array<{ key: string; rating: number }>;
      }>;
      documents: Array<{ contentEncrypted: string; contentCodec: string }>;
    };
    expect(payload.moodEntries).toEqual([
      expect.objectContaining({
        id: "mood-dr",
        externalId: "mood-external-dr",
        factors: [{ key: "sleep_quality", rating: 5 }],
      }),
    ]);
    expect(payload.documents).toEqual([
      expect.objectContaining({
        contentEncrypted: documentCiphertext,
        contentCodec: "binary2",
      }),
    ]);
  });
});

/**
 * What the pass says about itself when it protected nobody.
 *
 * The weekly job used to report `ok: true` with `backed: 0` — a completed
 * pg-boss job, an untouched failing-queue panel, and a backups page listing
 * copies from six weeks earlier with perfectly ordinary timestamps. Every
 * surface an operator could look at agreed that a pass which wrote nothing
 * had gone fine.
 */
describe("handleDataBackup outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.mockResolvedValue(undefined);
    mocks.buildFullBackupPayload.mockResolvedValue({
      payload: { schemaVersion: "1", userId: "user-dr" },
      counts: {},
    });
  });

  it("fails the run when not one account got a copy", async () => {
    mocks.getWorkerPrisma.mockReturnValue(buildPrismaMock());
    mocks.store.mockRejectedValue(new Error("write failed"));

    const outcome = await handleDataBackup([]);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({
      ok: false,
      reason: "no account could be backed up",
      did: { backed: 0, total: 1, users_failed: 1, records_oversized: 0 },
    });
  });

  it("counts an oversized record as the reason it could not", async () => {
    mocks.getWorkerPrisma.mockReturnValue(buildPrismaMock());
    mocks.store.mockRejectedValue(new BackupBlobTooLargeError(9_000, 4_096));

    const outcome = await handleDataBackup([]);

    expect(outcome).toMatchObject({
      ok: false,
      did: { backed: 0, users_failed: 1, records_oversized: 1 },
    });
  });

  it("still passes when one account failed and another was written", async () => {
    // The fan-out rule: a pass is judged on the pass. Failing the queue over
    // one account's record would re-run the whole cohort on every retry, and
    // that account's own copy ages on the backups page either way.
    mocks.getWorkerPrisma.mockReturnValue(
      buildPrismaMock([
        { id: "user-a", username: "a" },
        { id: "user-b", username: "b" },
      ]),
    );
    mocks.store
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce(undefined);

    const outcome = await handleDataBackup([]);

    expect(outcome).toMatchObject({
      ok: true,
      did: { backed: 1, total: 2, users_failed: 1 },
    });
  });

  it("passes on an instance with no accounts at all", async () => {
    mocks.getWorkerPrisma.mockReturnValue(buildPrismaMock([]));

    const outcome = await handleDataBackup([]);

    expect(outcome).toMatchObject({ ok: true, did: { backed: 0, total: 0 } });
  });
});
