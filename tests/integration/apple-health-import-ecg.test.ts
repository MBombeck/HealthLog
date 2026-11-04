import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Job } from "pg-boss";
import { strToU8, zipSync } from "fflate";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { decryptWaveformFromBytes } from "@/lib/withings/ecg-waveform-codec";
import {
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  _setWorkerPrismaForTests,
  handleAppleHealthImport,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

// The real module with only the fold stubbed, so the import's tail (its fold
// window, the cache invalidation, the status re-warm) runs as it does in
// production.
vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/rollups/measurement-rollups")
  >()),
  recomputeUserRollups: vi.fn(async () => {}),
}));

const USER_ID = "user-apple-ecg-contract";
let jobSequence = 0;

function supportedWhoopXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate"
          unit="count/min"
          startDate="2026-07-18 08:14:03 +0200"
          endDate="2026-07-18 08:14:04 +0200"
          value="64"
          sourceName="WHOOP"
          sourceVersion="5.2.1"
          device="WHOOP MG"/>
</HealthData>`;
}

function ecgCsv(
  input: {
    recordedAt?: string;
    classification?: string;
    samples?: number[];
    marker?: string;
  } = {},
): string {
  const samples = input.samples ?? [0.001, -0.002, 0.003];
  return [
    `Name,${input.marker ?? "patient-name-must-not-persist"}`,
    `Recorded Date,${input.recordedAt ?? "2026-07-18 08:14:03 +0200"}`,
    `Classification,${input.classification ?? "Sinus Rhythm"}`,
    "Average Heart Rate,64 bpm",
    "Sample Rate,512 Hz",
    "Lead,Voltage",
    ...samples.map((sample) => `I,${sample}`),
  ].join("\n");
}

function createArchive(ecgs: Array<{ filename: string; csv: string }>): {
  path: string;
  bytes: Buffer;
} {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-ecg-integration-"));
  const path = join(dir, "export.zip");
  const files: Record<string, Uint8Array> = {
    "apple_health_export/export.xml": strToU8(supportedWhoopXml()),
  };
  for (const ecg of ecgs) {
    files[`apple_health_export/electrocardiograms/${ecg.filename}`] = strToU8(
      ecg.csv,
    );
  }
  const bytes = Buffer.from(zipSync(files, { level: 6 }));
  writeFileSync(path, bytes);
  return { path, bytes };
}

async function runArchive(
  ecgs: Array<{ filename: string; csv: string }>,
): Promise<{
  outcome: Awaited<ReturnType<typeof handleAppleHealthImport>>;
  mirror: Awaited<
    ReturnType<ReturnType<typeof getPrismaClient>["importJob"]["findUnique"]>
  >;
  uploadPath: string;
}> {
  const prisma = getPrismaClient();
  const archive = createArchive(ecgs);
  jobSequence += 1;
  const jobId = `apple-ecg-job-${jobSequence}`;
  const mirror = await prisma.importJob.create({
    data: {
      userId: USER_ID,
      pgBossJobId: jobId,
      status: "queued",
      uploadBytes: archive.bytes.length,
      uploadSha256: createHash("sha256").update(archive.bytes).digest("hex"),
      parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
    },
  });
  const data: AppleHealthImportPayload = {
    userId: USER_ID,
    uploadPath: archive.path,
    uploadBytes: archive.bytes.length,
    enqueuedAt: "2026-07-18T06:14:03.000Z",
  };

  const outcome = await handleAppleHealthImport({
    id: jobId,
    data,
  } as unknown as Job<AppleHealthImportPayload>);

  return {
    outcome,
    mirror: await prisma.importJob.findUnique({ where: { id: mirror.id } }),
    uploadPath: archive.path,
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  _setWorkerPrismaForTests(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "apple-ecg-contract",
      email: "apple-ecg-contract@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  _setWorkerPrismaForTests(null);
});

describe("Apple Health auxiliary ECG import — real Postgres", () => {
  it("persists an encrypted APPLE_HEALTH recording and decrypts through the normal codec", async () => {
    const marker = "plaintext-waveform-marker-0.001--0.002";
    const run = await runArchive([
      { filename: "ecg_2026-07-18.csv", csv: ecgCsv({ marker }) },
    ]);

    expect(run.outcome.ok).toBe(true);
    const rows = await getPrismaClient().ecgRecording.findMany({
      where: { userId: USER_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "APPLE_HEALTH",
      samplingFrequency: 512,
      sampleCount: 3,
      averageHeartRate: 64,
      lead: "I",
      rhythmClassification: "NOT_DETECTED",
    });
    expect(decryptWaveformFromBytes(rows[0].waveformEncrypted)).toEqual([
      1, -2, 3,
    ]);
    expect(Buffer.from(rows[0].waveformEncrypted).toString("utf8")).not.toMatch(
      /0\.001|-0\.002|plaintext-waveform-marker/,
    );
    expect(JSON.stringify(run.mirror)).not.toContain(marker);
    expect(existsSync(run.uploadPath)).toBe(false);
  });

  it("deduplicates identical content across filenames and keeps distinct recordings distinct", async () => {
    const same = ecgCsv();
    await runArchive([{ filename: "first-name.csv", csv: same }]);
    await runArchive([{ filename: "renamed-copy.csv", csv: same }]);
    expect(
      await getPrismaClient().ecgRecording.count({
        where: { userId: USER_ID },
      }),
    ).toBe(1);

    await runArchive([
      {
        filename: "different.csv",
        csv: ecgCsv({
          recordedAt: "2026-07-18 09:14:03 +0200",
          samples: [0.004, -0.005, 0.006],
        }),
      },
    ]);
    const rows = await getPrismaClient().ecgRecording.findMany({
      where: { userId: USER_ID },
      orderBy: { recordedAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.externalRecordingId)).size).toBe(2);
  });

  it("keeps content identity tenant-scoped", async () => {
    const same = ecgCsv();
    await runArchive([{ filename: "same.csv", csv: same }]);
    const other = await getPrismaClient().user.create({
      data: {
        username: "apple-ecg-other",
        email: "apple-ecg-other@example.test",
      },
    });

    const archive = createArchive([{ filename: "same.csv", csv: same }]);
    jobSequence += 1;
    const jobId = `apple-ecg-job-${jobSequence}`;
    await getPrismaClient().importJob.create({
      data: {
        userId: other.id,
        pgBossJobId: jobId,
        status: "queued",
        uploadBytes: archive.bytes.length,
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      },
    });
    await handleAppleHealthImport({
      id: jobId,
      data: {
        userId: other.id,
        uploadPath: archive.path,
        uploadBytes: archive.bytes.length,
        enqueuedAt: "2026-07-18T06:14:03.000Z",
      },
    } as unknown as Job<AppleHealthImportPayload>);

    const rows = await getPrismaClient().ecgRecording.findMany({
      orderBy: { userId: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].externalRecordingId).toBe(rows[1].externalRecordingId);
    expect(rows[0].userId).not.toBe(rows[1].userId);
  });

  it("keeps valid WHOOP-written export.xml data when an ECG is malformed", async () => {
    const secret = "malformed-private-waveform-secret";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = await runArchive([
      {
        filename: "malformed.csv",
        csv: ecgCsv().replace("I,-0.002", `I,${secret}`),
      },
    ]);

    expect(run.outcome.ok).toBe(true);
    expect(run.mirror?.status).toBe("done");
    const measurements = await getPrismaClient().measurement.findMany({
      where: { userId: USER_ID },
    });
    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      source: "APPLE_HEALTH",
      type: "PULSE",
      value: 64,
    });
    expect(JSON.stringify(measurements)).not.toContain("WHOOP");
    expect(await getPrismaClient().ecgRecording.count()).toBe(0);
    expect(run.mirror?.result).toMatchObject({
      ecg: {
        discovered: 1,
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 1,
      },
    });
    expect(JSON.stringify(run.mirror)).not.toContain(secret);
    expect(
      JSON.stringify([...warning.mock.calls, ...error.mock.calls]),
    ).not.toContain(secret);
  });

  it("fails an unsafe auxiliary member softly while valid XML survives", async () => {
    const run = await runArchive([
      { filename: "../escaped-ecg.csv", csv: ecgCsv() },
    ]);

    expect(run.outcome.ok).toBe(true);
    expect(run.mirror?.status).toBe("done");
    expect(
      await getPrismaClient().measurement.count({ where: { userId: USER_ID } }),
    ).toBe(1);
    expect(await getPrismaClient().ecgRecording.count()).toBe(0);
    expect(run.mirror?.result).toMatchObject({
      ecg: { discovered: 1, imported: 0, failed: 1 },
    });
  });

  it("rolls back a failed ECG write while preserving the valid XML transaction", async () => {
    const prisma = getPrismaClient();
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION reject_apple_health_ecg_contract()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source = 'APPLE_HEALTH' THEN
          RAISE EXCEPTION 'synthetic ECG write failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_apple_health_ecg_contract
      BEFORE INSERT OR UPDATE ON ecg_recordings
      FOR EACH ROW EXECUTE FUNCTION reject_apple_health_ecg_contract();
    `);

    try {
      const run = await runArchive([
        { filename: "mid-write.csv", csv: ecgCsv() },
      ]);
      expect(run.outcome.ok).toBe(true);
      expect(
        await prisma.measurement.count({ where: { userId: USER_ID } }),
      ).toBe(1);
      expect(
        await prisma.ecgRecording.count({ where: { userId: USER_ID } }),
      ).toBe(0);
      expect(run.mirror?.result).toMatchObject({
        ecg: { discovered: 1, failed: 1 },
      });
      expect(JSON.stringify(run.mirror)).not.toContain(
        "synthetic ECG write failure",
      );
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS reject_apple_health_ecg_contract ON ecg_recordings`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS reject_apple_health_ecg_contract()`,
      );
    }
  });

  it("stores unknown device classifications as null without waveform diagnosis", async () => {
    await runArchive([
      {
        filename: "unknown-classification.csv",
        csv: ecgCsv({ classification: "Localized Future Verdict" }),
      },
    ]);
    const row = await getPrismaClient().ecgRecording.findFirstOrThrow({
      where: { userId: USER_ID },
    });
    expect(row.rhythmClassification).toBeNull();
  });
});
