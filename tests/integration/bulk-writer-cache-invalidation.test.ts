/**
 * Every bulk writer of measurements marks the cached reads stale back to the
 * oldest reading it wrote.
 *
 * A closed analytics block (a value over readings before a fixed instant)
 * survives every write that says it reached no further back, so a writer that
 * did not invalidate at all left the block on its pre-write value: an Apple
 * Health export carrying years of history showed the old all-time figures
 * until the entry aged out, and the next sync, reaching back only a day,
 * spared it. Pinned here for the writers that had no invalidation: the Apple
 * Health import worker, the shared post-mutation tail the CSV and JSON
 * imports and the score engines rely on, the Oura upsert a history backfill
 * writes through, and the sleep-segment sweep.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { closedBlockKeyPart } from "@/lib/cache/closed-block";
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  handleAppleHealthImport,
  _setWorkerPrismaForTests,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";
import { upsertOuraMeasurements } from "@/lib/oura/sync";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { sweepStaleSleepSegments } from "@/lib/sleep/sweep-stale-segments";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const prisma = getPrismaClient();
const analytics = caches.analytics as ServerCache<{ v: number }>;
const USER = "user-bulk-writer-cache";
const DAY_MS = 86_400_000;
const NOW = Date.now();
const yearsAgo = (years: number) => new Date(NOW - years * 365 * DAY_MS);

/** A closed block over the readings before `before`, and an open entry. */
function seedCache(before: Date) {
  const closed = `${USER}|pre-fold-remainder|${closedBlockKeyPart(before)}|x`;
  const open = `${USER}|dashboard-snapshot|en`;
  analytics.deleteByPrefix(`${USER}|`);
  analytics.set(closed, { v: 1 });
  analytics.set(open, { v: 2 });
  return { closed, open };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  _setWorkerPrismaForTests(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: "UTC",
    },
  });
});

function record(at: Date, value: number): string {
  const stamp = at.toISOString().replace("T", " ").slice(0, 19) + " +0000";
  return `<Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="${stamp}" endDate="${stamp}" value="${value}" sourceName="Scale"/>`;
}

async function runImport(xmlRecords: string[]) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  ${xmlRecords.join("\n  ")}
</HealthData>`;
  const dir = mkdtempSync(join(tmpdir(), "hl-import-cache-"));
  const path = join(dir, "export.zip");
  const bytes = Buffer.from(
    zipSync({ "apple_health_export/export.xml": strToU8(xml) }),
  );
  writeFileSync(path, bytes);
  await prisma.importJob.create({
    data: {
      userId: USER,
      pgBossJobId: "cache-job",
      status: "queued",
      uploadBytes: bytes.length,
      uploadSha256: createHash("sha256").update(bytes).digest("hex"),
      parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
    },
  });
  const outcome = await handleAppleHealthImport({
    id: "cache-job",
    data: {
      userId: USER,
      uploadPath: path,
      uploadBytes: bytes.length,
      enqueuedAt: new Date().toISOString(),
    },
  } as unknown as Job<AppleHealthImportPayload>);
  expect(outcome.ok).toBe(true);
}

describe("bulk writers invalidate the measurement read caches", () => {
  it("the Apple Health import marks stale every block its oldest sample reaches", async () => {
    const reached = seedCache(yearsAgo(1));
    const older = `${USER}|pre-fold-remainder|${closedBlockKeyPart(yearsAgo(9))}|x`;
    analytics.set(older, { v: 3 });

    await runImport([record(yearsAgo(7), 88), record(yearsAgo(0.1), 84)]);

    expect(analytics.get(reached.closed)).toBeNull();
    expect(analytics.get(reached.open)).toBeNull();
    // A block of readings older than anything imported stays.
    expect(analytics.get(older)).toEqual({ v: 3 });
  });

  it("the shared post-mutation tail invalidates back to its oldest row", async () => {
    const cache = seedCache(yearsAgo(1));
    await afterMeasurementMutation(
      USER,
      [{ type: "WEIGHT", measuredAt: yearsAgo(3) }],
      { source: "manual" },
    );
    expect(analytics.get(cache.closed)).toBeNull();
    expect(analytics.get(cache.open)).toBeNull();
  });

  it("the Oura upsert a history backfill writes through invalidates", async () => {
    const cache = seedCache(yearsAgo(1));
    const written = await upsertOuraMeasurements(
      USER,
      [
        {
          type: "RESTING_HEART_RATE",
          value: 52,
          unit: "bpm",
          measuredAt: yearsAgo(2),
          externalId: "oura:test:resting:1",
        },
      ],
      { emitArrivals: false },
    );
    expect(written).toBe(1);
    expect(analytics.get(cache.closed)).toBeNull();
  });

  it("a sleep-segment sweep that tombstones a row invalidates", async () => {
    await prisma.measurement.create({
      data: {
        userId: USER,
        type: "SLEEP_DURATION",
        value: 60,
        unit: "min",
        source: "OURA",
        measuredAt: yearsAgo(2),
        externalId: "night-1:stale",
      },
    });
    const cache = seedCache(yearsAgo(1));
    const removed = await sweepStaleSleepSegments(USER, "OURA", [
      { prefix: "night-1:", keepIds: ["night-1:fresh"] },
    ]);
    expect(removed).toBe(1);
    expect(analytics.get(cache.closed)).toBeNull();
  });
});
