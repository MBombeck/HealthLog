/**
 * #1031 — the rollup fold after an import covers what the import wrote.
 *
 * The worker folded the rollup table from the account's first measurement to
 * its last, whatever the import carried, and so also folded history older
 * than the five-year window every other fold path keeps to. It now folds the
 * span of the rows this import wrote, clamped to that window.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  handleAppleHealthImport,
  _setWorkerPrismaForTests,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";
import { ROLLUP_FOLD_WINDOW_MS } from "@/lib/rollups/measurement-rollups";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const USER = "user-import-rollup-window";

function record(at: Date, value: number): string {
  const stamp = at.toISOString().replace("T", " ").slice(0, 19) + " +0000";
  return `<Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="${stamp}" endDate="${stamp}" value="${value}" sourceName="Scale"/>`;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  _setWorkerPrismaForTests(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: "UTC",
    },
  });
});

describe("import rollup fold window", () => {
  it("folds the imported span, never past the fold window, and leaves older history alone", async () => {
    const prisma = getPrismaClient();
    const now = Date.now();
    const day = 86_400_000;
    // Already in the account before the import: a reading eight years old.
    await prisma.measurement.create({
      data: {
        userId: USER,
        type: "WEIGHT",
        value: 90,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(now - 8 * 365 * day),
      },
    });
    // The import: one reading seven years old, a few recent ones.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  ${record(new Date(now - 7 * 365 * day), 88)}
  ${record(new Date(now - 40 * day), 84)}
  ${record(new Date(now - 30 * day), 83)}
  ${record(new Date(now - 20 * day), 82)}
</HealthData>`;
    const dir = mkdtempSync(join(tmpdir(), "hl-import-window-"));
    const path = join(dir, "export.zip");
    const bytes = Buffer.from(
      zipSync({ "apple_health_export/export.xml": strToU8(xml) }),
    );
    writeFileSync(path, bytes);
    await prisma.importJob.create({
      data: {
        userId: USER,
        pgBossJobId: "window-job",
        status: "queued",
        uploadBytes: bytes.length,
        uploadSha256: createHash("sha256").update(bytes).digest("hex"),
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      },
    });

    const outcome = await handleAppleHealthImport({
      id: "window-job",
      data: {
        userId: USER,
        uploadPath: path,
        uploadBytes: bytes.length,
        enqueuedAt: new Date().toISOString(),
      },
    } as unknown as Job<AppleHealthImportPayload>);
    expect(outcome.ok).toBe(true);

    const buckets = await prisma.measurementRollup.findMany({
      where: { userId: USER, type: "WEIGHT", granularity: "DAY" },
      orderBy: { bucketStart: "asc" },
    });
    const windowStart = now - ROLLUP_FOLD_WINDOW_MS;
    expect(buckets.length).toBeGreaterThanOrEqual(3);
    for (const bucket of buckets) {
      expect(bucket.bucketStart.getTime()).toBeGreaterThan(windowStart - day);
    }
  });
});
