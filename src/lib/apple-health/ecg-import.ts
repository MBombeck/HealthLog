/**
 * Persistence for one normalized Apple Health ECG recording out of an
 * `export.zip`.
 *
 * The stable identity is derived from canonical recording content, never the
 * archive filename, so the same strip re-imported under a different filename
 * deduplicates. The database uniqueness constraint adds the user boundary, so
 * identical recordings deduplicate for one user while remaining independent
 * across tenants.
 *
 * The write itself lives in `@/lib/ecg/persist-recording`, shared with the
 * live `POST /api/insights/ecg` ingest and the Withings sync. That is also
 * where the second identity — `(userId, source, recordedAt,
 * samplingFrequency)` — is honoured: a strip already stored from the live
 * sync under its device sample uuid reports `skipped` here rather than
 * landing a second time under its content hash.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  APPLE_HEALTH_ARCHIVE_MAX_ENTRIES,
  streamAppleHealthEcgMembers,
} from "@/lib/apple-health/archive-stream";
import {
  parseAppleHealthEcgCsv,
  type NormalizedAppleHealthEcg,
} from "@/lib/apple-health/ecg-csv";
import { persistEcgRecording } from "@/lib/ecg/persist-recording";

export type AppleHealthEcgImportOutcome = "imported" | "updated" | "skipped";

function recordingIdentity(ecg: NormalizedAppleHealthEcg): string {
  const hash = createHash("sha256");
  hash.update("healthlog:apple-health-ecg:v1\0");
  hash.update(ecg.recordedAt.toISOString());
  hash.update(`\0${ecg.samplingFrequency}\0${ecg.lead ?? ""}`);
  hash.update(
    `\0${ecg.averageHeartRate ?? ""}\0${ecg.rhythmClassification ?? ""}\0`,
  );
  const sample = Buffer.allocUnsafe(8);
  for (const value of ecg.samples) {
    sample.writeDoubleLE(value, 0);
    hash.update(sample);
  }
  sample.fill(0);
  return `apple-health:ecg:${hash.digest("hex")}`;
}

export async function importAppleHealthEcg(input: {
  userId: string;
  ecg: NormalizedAppleHealthEcg;
  prisma: Pick<PrismaClient, "$transaction">;
}): Promise<AppleHealthEcgImportOutcome> {
  const { userId, ecg, prisma } = input;
  if (ecg.samples.length === 0) return "skipped";

  const result = await persistEcgRecording(
    {
      userId,
      source: "APPLE_HEALTH",
      externalRecordingId: recordingIdentity(ecg),
      recordedAt: ecg.recordedAt,
      samples: ecg.samples,
      samplingFrequency: ecg.samplingFrequency,
      lead: ecg.lead,
      averageHeartRate: ecg.averageHeartRate,
      rhythmClassification: ecg.rhythmClassification,
    },
    prisma,
  );

  if (result.outcome === "inserted") return "imported";
  // The live ingest already holds this strip under its device sample uuid.
  // Nothing was written and nothing was lost.
  if (result.outcome === "duplicate") return "skipped";
  return "updated";
}

/** Per-archive ceilings for the ECG members. */
export const APPLE_HEALTH_ECG_ARCHIVE_LIMITS = {
  maxMembers: APPLE_HEALTH_ARCHIVE_MAX_ENTRIES,
  maxEcgMembers: 2_000,
  maxMemberBytes: 16 * 1024 * 1024,
  maxTotalEcgBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
} as const;
const APPLE_HEALTH_ECG_MAX_SAMPLES = 2_000_000;

export interface AppleHealthEcgCounts {
  discovered: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}

/**
 * Every ECG recording in an export archive. Intentionally fail-soft: the
 * canonical export.xml pass has already completed, and malformed, oversized
 * or unwritable ECG members affect only bounded scalar counters in the
 * terminal result. `memberNames` are the archive's other members, which the
 * discovered count is taken from.
 */
export async function importAppleHealthArchiveEcgs(input: {
  archivePath: string;
  userId: string;
  memberNames: readonly string[];
  prisma: Pick<PrismaClient, "$transaction">;
}): Promise<AppleHealthEcgCounts> {
  const ecg: AppleHealthEcgCounts = {
    discovered: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };
  ecg.discovered = input.memberNames.filter((name) => {
    const lower = name.toLowerCase();
    return lower.includes("electrocardiograms/") && lower.endsWith(".csv");
  }).length;
  try {
    for await (const member of streamAppleHealthEcgMembers({
      archivePath: input.archivePath,
      limits: APPLE_HEALTH_ECG_ARCHIVE_LIMITS,
    })) {
      try {
        const parsed = await parseAppleHealthEcgCsv({
          memberName: member.name,
          stream: member.stream,
          maxSamples: APPLE_HEALTH_ECG_MAX_SAMPLES,
        });
        const outcome = await importAppleHealthEcg({
          userId: input.userId,
          ecg: parsed,
          prisma: input.prisma,
        });
        ecg[outcome] += 1;
      } catch {
        ecg.failed += 1;
      }
    }
  } catch {
    const completed = ecg.imported + ecg.updated + ecg.skipped + ecg.failed;
    ecg.failed += Math.max(0, ecg.discovered - completed);
  }
  return ecg;
}
