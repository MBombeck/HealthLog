/**
 * The activity FIT file import against a real Postgres.
 *
 * Every file is built by the synthetic encoder in `tests/fixtures/fit/`; no
 * recording of a real person is used. What is pinned:
 *   - a watch file becomes one `IMPORT` workout with its series, and with its
 *     track, sealed, only while the account keeps tracks;
 *   - importing the same file again, bare or zipped, writes nothing;
 *   - a session already stored from Apple Health is not stored twice: the
 *     Apple workout gains the file's series and stays the only row;
 *   - a series longer than the cap is stored at the cap;
 *   - the worker consumes its staged upload on success and on refusal, marks
 *     the job, and reports a damaged file by its code;
 *   - the shared reconcile leaves a running FIT job alone and fails a dead one.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  buildBikeComputerActivity,
  buildWatchActivity,
  gzip,
  zipOne,
} from "../fixtures/fit/build-fit";
import { importFitUpload } from "@/lib/fit/import";
import { runFitImport } from "@/lib/jobs/fit-import-worker";
import { FIT_IMPORT_KIND, FIT_IMPORT_QUEUE } from "@/lib/jobs/fit-import-queue";
import {
  _setWorkerPrismaForTests,
  reconcileOrphanImportJobs,
} from "@/lib/jobs/apple-health-import-worker";
import { readRouteGeometry } from "@/lib/workouts/route-geometry-cipher";
import { MAX_WORKOUT_HR_SAMPLES } from "@/lib/validations/workout";

const bossMock = vi.hoisted(() => ({
  handle: null as null | {
    getJobById: (queue: string, id: string) => Promise<unknown>;
  },
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => bossMock.handle),
}));

const USER_ID = "user-fit-import";
const START = new Date("2026-10-04T07:30:00Z");
const NOW = new Date("2026-10-05T12:00:00Z");
const scratch = mkdtempSync(join(tmpdir(), "hl-fit-import-"));

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  _setWorkerPrismaForTests(prisma);
  bossMock.handle = null;
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "fit-import",
      email: "fit-import@example.test",
      timezone: "UTC",
    },
  });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function keepRoutes(on: boolean) {
  await getPrismaClient().user.update({
    where: { id: USER_ID },
    data: { storeWorkoutRoutes: on },
  });
}

async function workouts() {
  return getPrismaClient().workout.findMany({
    where: { userId: USER_ID },
    include: { samples: true, route: true },
    orderBy: { startedAt: "asc" },
  });
}

describe("FIT import", () => {
  it("stores a watch file as one workout with its series and sealed track", async () => {
    await keepRoutes(true);
    const result = await importFitUpload({
      userId: USER_ID,
      upload: buildWatchActivity({ start: START, seconds: 1200 }),
      now: NOW,
    });
    expect(result).toMatchObject({
      container: "fit",
      sessions: 1,
      imported: 1,
      merged: 0,
      alreadyPresent: 0,
      withSeries: 1,
      withRoute: 1,
    });
    const [w] = await workouts();
    expect(w!.source).toBe("IMPORT");
    expect(w!.sportType).toBe("running");
    expect(w!.externalId).toMatch(/^fit:[0-9a-f]{40}:\d+$/);
    expect(w!.durationSec).toBe(1200);
    expect(w!.avgHeartRate).toBe(135);
    expect(w!.samples?.sampleCount).toBe(1200);
    // The track is sealed: the readable column stays empty.
    expect(w!.route?.geometry).toBeNull();
    expect(w!.route?.geometryEncrypted).not.toBeNull();
    const geometry = readRouteGeometry(w!.route!) as {
      type: string;
      coordinates: number[][];
    };
    expect(geometry.type).toBe("LineString");
    expect(geometry.coordinates).toHaveLength(1200);
    const sealedText = Buffer.from(w!.route!.geometryEncrypted!).toString(
      "latin1",
    );
    expect(sealedText).not.toContain("LineString");
  });

  it("drops the track while the account keeps none", async () => {
    await keepRoutes(false);
    const result = await importFitUpload({
      userId: USER_ID,
      upload: buildWatchActivity({ start: START, seconds: 120 }),
      now: NOW,
    });
    expect(result.withRoute).toBe(0);
    const [w] = await workouts();
    expect(w!.route).toBeNull();
    expect(w!.samples?.sampleCount).toBe(120);
  });

  it("writes nothing when the same file comes again, bare, gzipped or zipped", async () => {
    const file = buildWatchActivity({ start: START, seconds: 300 });
    await importFitUpload({ userId: USER_ID, upload: file, now: NOW });
    for (const again of [file, gzip(file), zipOne("1_ACTIVITY.fit", file)]) {
      const result = await importFitUpload({
        userId: USER_ID,
        upload: again,
        now: NOW,
      });
      expect(result).toMatchObject({
        imported: 0,
        merged: 0,
        alreadyPresent: 1,
      });
    }
    expect(await workouts()).toHaveLength(1);
  });

  it("hands the series to the Apple Health twin instead of storing a second workout", async () => {
    const prisma = getPrismaClient();
    // The same run, synced from the phone 40 s apart, without a series.
    const apple = await prisma.workout.create({
      data: {
        userId: USER_ID,
        source: "APPLE_HEALTH",
        externalId: "6F1C2B4A-0000-4000-8000-000000000001",
        sportType: "running",
        startedAt: new Date(START.getTime() + 40_000),
        endedAt: new Date(START.getTime() + 40_000 + 1_800_000),
        durationSec: 1800,
      },
    });
    const result = await importFitUpload({
      userId: USER_ID,
      upload: buildWatchActivity({ start: START, seconds: 1800 }),
      now: NOW,
    });
    expect(result).toMatchObject({ imported: 0, merged: 1 });
    const rows = await workouts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(apple.id);
    expect(rows[0]!.samples?.sampleCount).toBe(1800);

    // Again: the twin has its series now, so the file adds nothing.
    const again = await importFitUpload({
      userId: USER_ID,
      upload: buildWatchActivity({ start: START, seconds: 1800 }),
      now: NOW,
    });
    expect(again).toMatchObject({ imported: 0, merged: 0, alreadyPresent: 1 });
    expect(await workouts()).toHaveLength(1);
  });

  it("does not merge a session of another sport at the same time", async () => {
    await getPrismaClient().workout.create({
      data: {
        userId: USER_ID,
        source: "APPLE_HEALTH",
        externalId: "6F1C2B4A-0000-4000-8000-000000000002",
        sportType: "cycling",
        startedAt: START,
        endedAt: new Date(START.getTime() + 600_000),
        durationSec: 600,
      },
    });
    const result = await importFitUpload({
      userId: USER_ID,
      upload: buildWatchActivity({ start: START, seconds: 600 }),
      now: NOW,
    });
    expect(result.imported).toBe(1);
    expect(await workouts()).toHaveLength(2);
  });

  it("stores a series longer than the cap at the cap", async () => {
    const seconds = MAX_WORKOUT_HR_SAMPLES + 6_000;
    const result = await importFitUpload({
      userId: USER_ID,
      upload: buildBikeComputerActivity({ start: START, seconds }),
      now: new Date(START.getTime() + 2 * 86_400_000),
    });
    expect(result.imported).toBe(1);
    const [w] = await workouts();
    expect(w!.samples!.sampleCount).toBeLessThanOrEqual(MAX_WORKOUT_HR_SAMPLES);
    expect((w!.samples!.samples as unknown[]).length).toBe(
      w!.samples!.sampleCount,
    );
    expect(w!.sportType).toBe("cycling");
  });
});

describe("FIT import worker", () => {
  async function stage(name: string, bytes: Buffer) {
    const path = join(
      scratch,
      `healthlog-fit-import-${name.padEnd(8, "0")}-0000-4000-8000-000000000000.bin`,
    );
    writeFileSync(path, bytes);
    const job = await getPrismaClient().importJob.create({
      data: {
        userId: USER_ID,
        kind: FIT_IMPORT_KIND,
        status: "queued",
        uploadBytes: bytes.length,
      },
    });
    return { path, jobId: job.id };
  }

  it("imports, marks the job done with counts and removes the upload", async () => {
    const { path, jobId } = await stage(
      "aaaa",
      zipOne(
        "2_ACTIVITY.fit",
        buildWatchActivity({ start: START, seconds: 90 }),
      ),
    );
    const outcome = await runFitImport({
      userId: USER_ID,
      importJobId: jobId,
      uploadPath: path,
    });
    expect(outcome.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
    const job = await getPrismaClient().importJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(job.status).toBe("done");
    expect(job.result).toMatchObject({ container: "zip", imported: 1 });
    expect(JSON.stringify(job.result)).not.toMatch(/2026-10-04/);
  });

  it("fails a damaged file with its code and still removes the upload", async () => {
    const file = Buffer.from(buildWatchActivity({ start: START, seconds: 90 }));
    file[50] ^= 0xff;
    const { path, jobId } = await stage("bbbb", file);
    const outcome = await runFitImport({
      userId: USER_ID,
      importJobId: jobId,
      uploadPath: path,
    });
    // A refused file is the uploader's, not a worker failure.
    expect(outcome.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
    const job = await getPrismaClient().importJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(job.status).toBe("failed");
    expect(job.failureReason).toMatch(/^crc_mismatch:/);
    expect(await workouts()).toHaveLength(0);
  });

  it("reports a missing staged file as staging_missing", async () => {
    const { path, jobId } = await stage(
      "cccc",
      buildWatchActivity({ start: START, seconds: 10 }),
    );
    rmSync(path);
    await runFitImport({
      userId: USER_ID,
      importJobId: jobId,
      uploadPath: path,
    });
    const job = await getPrismaClient().importJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(job.failureReason).toMatch(/^staging_missing:/);
  });

  it("is reconciled on its own queue: a live job stays, a dead one fails", async () => {
    const prisma = getPrismaClient();
    const live = await prisma.importJob.create({
      data: {
        userId: USER_ID,
        kind: FIT_IMPORT_KIND,
        status: "parsing",
        uploadBytes: 1,
        pgBossJobId: "boss-fit-live",
      },
    });
    const dead = await prisma.importJob.create({
      data: {
        userId: USER_ID,
        kind: FIT_IMPORT_KIND,
        status: "parsing",
        uploadBytes: 1,
        pgBossJobId: "boss-fit-dead",
      },
    });
    const asked: string[] = [];
    bossMock.handle = {
      getJobById: async (queue, id) => {
        asked.push(queue);
        return queue === FIT_IMPORT_QUEUE && id === "boss-fit-live"
          ? { state: "active", data: {} }
          : null;
      },
    };
    await reconcileOrphanImportJobs();
    expect(asked.every((q) => q === FIT_IMPORT_QUEUE)).toBe(true);
    const after = await prisma.importJob.findMany({
      where: { id: { in: [live.id, dead.id] } },
    });
    expect(after.find((r) => r.id === live.id)!.status).toBe("parsing");
    expect(after.find((r) => r.id === dead.id)!.status).toBe("failed");
  });
});
