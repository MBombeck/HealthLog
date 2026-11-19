import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/withings/ecg-waveform-codec", () => ({
  encryptWaveformToBytes: vi.fn(),
}));

import { encryptWaveformToBytes } from "@/lib/withings/ecg-waveform-codec";
import {
  ecgDurationSeconds,
  persistEcgRecording,
} from "@/lib/ecg/persist-recording";

function fakeDb() {
  const findUnique = vi.fn();
  const upsert = vi.fn();
  const tombstoneFind = vi.fn(async () => null as { id: string } | null);
  const $transaction = vi.fn(
    async (fn: (tx: unknown) => unknown) =>
      await fn({
        ecgRecording: { findUnique, upsert },
        appleHealthTombstone: { findUnique: tombstoneFind },
      }),
  );
  const db = { $transaction };
  return {
    db,
    // The one transactional seam the function takes, typed once here.
    client: db as unknown as Parameters<typeof persistEcgRecording>[1],
    findUnique,
    upsert,
    tombstoneFind,
    $transaction,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    source: "APPLE_HEALTH" as const,
    externalRecordingId: "hk-uuid-1",
    recordedAt: new Date("2026-07-18T06:14:03.000Z"),
    samples: [12, -7, 3],
    samplingFrequency: 512,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(encryptWaveformToBytes).mockImplementation(
    () => new Uint8Array(new ArrayBuffer(4)),
  );
});

describe("ecgDurationSeconds", () => {
  it("divides the sample count by the sampling rate", () => {
    expect(ecgDurationSeconds(15_360, 512)).toBe(30);
  });

  it("is null when the source reported no sampling rate", () => {
    expect(ecgDurationSeconds(15_360, 0)).toBeNull();
  });
});

describe("persistEcgRecording", () => {
  it("fails closed on a crypto error without ever opening a write transaction", async () => {
    vi.mocked(encryptWaveformToBytes).mockImplementation(() => {
      throw new Error("no encryption key");
    });
    const { db, $transaction } = fakeDb();

    await expect(persistEcgRecording(input(), db as never)).rejects.toThrow(
      "no encryption key",
    );
    expect($transaction).not.toHaveBeenCalled();
  });

  it("inserts when neither identity matches an existing row", async () => {
    const { db, findUnique, upsert } = fakeDb();
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "row-new" });

    const result = await persistEcgRecording(input(), db as never);

    expect(result).toMatchObject({
      outcome: "inserted",
      id: "row-new",
      sampleCount: 3,
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("updates in place when the source id is already stored", async () => {
    const { db, findUnique, upsert } = fakeDb();
    findUnique.mockResolvedValueOnce({ id: "row-existing" });
    upsert.mockResolvedValue({ id: "row-existing" });

    const result = await persistEcgRecording(input(), db as never);

    expect(result.outcome).toBe("updated");
    expect(result.id).toBe("row-existing");
    // The source-id lookup answered; the recording-identity lookup is not
    // needed and must not run.
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the recording is already stored under another id", async () => {
    const { db, findUnique, upsert } = fakeDb();
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "row-from-the-archive" });

    const result = await persistEcgRecording(input(), db as never);

    expect(result.outcome).toBe("duplicate");
    expect(result.id).toBe("row-from-the-archive");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("keeps an Apple Health recording the phone reported deleted deleted", async () => {
    const { client, findUnique, upsert, tombstoneFind } = fakeDb();
    tombstoneFind.mockResolvedValue({ id: "tombstone-1" });

    const result = await persistEcgRecording(input(), client);

    expect(result.outcome).toBe("duplicate");
    expect(result.id).toBe("tombstone-1");
    expect(tombstoneFind.mock.calls[0]).toEqual([
      {
        where: {
          userId_domain_externalId: {
            userId: "user-1",
            domain: "ecg",
            externalId: "hk-uuid-1",
          },
        },
        select: { id: true },
      },
    ]);
    expect(findUnique).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("never consults the deletion ledger for another source", async () => {
    const { client, findUnique, upsert, tombstoneFind } = fakeDb();
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "row-new" });

    const result = await persistEcgRecording(
      input({ source: "WITHINGS" }),
      client,
    );

    expect(result.outcome).toBe("inserted");
    expect(tombstoneFind).not.toHaveBeenCalled();
  });

  it("looks the twin up by the recording's own identity, not by the source id", async () => {
    const { db, findUnique, upsert } = fakeDb();
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "row-new" });

    await persistEcgRecording(input(), db as never);

    expect(findUnique.mock.calls[1][0].where).toEqual({
      userId_source_recordedAt_samplingFrequency: {
        userId: "user-1",
        source: "APPLE_HEALTH",
        recordedAt: new Date("2026-07-18T06:14:03.000Z"),
        samplingFrequency: 512,
      },
    });
  });

  it("builds the row field by field and narrows the owner to the caller's user", async () => {
    const { db, findUnique, upsert } = fakeDb();
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "row-new" });

    await persistEcgRecording(
      input({
        lead: "I",
        averageHeartRate: 64,
        rhythmClassification: "IRREGULAR",
      }),
      db as never,
    );

    const created = upsert.mock.calls[0][0].create;
    expect(created).toMatchObject({
      userId: "user-1",
      source: "APPLE_HEALTH",
      externalRecordingId: "hk-uuid-1",
      samplingFrequency: 512,
      sampleCount: 3,
      lead: "I",
      averageHeartRate: 64,
      rhythmClassification: "IRREGULAR",
      measurementId: null,
    });
    expect(created.durationSeconds).toBeCloseTo(3 / 512, 10);
  });

  it("leaves no plaintext samples behind in the caller's array", async () => {
    const { db, findUnique, upsert } = fakeDb();
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "row-new" });

    const payload = input();
    await persistEcgRecording(payload, db as never);

    expect(payload.samples).toEqual([0, 0, 0]);
  });
});
