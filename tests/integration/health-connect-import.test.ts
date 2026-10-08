/**
 * The Health Connect export import against a real Postgres (v1.42, #972).
 *
 * Pinned here: what each record type becomes, that a second import of the
 * same export writes nothing, that an app the account receives through a
 * connected integration is left out (and the same reading under another
 * source too), that old heart rate folds into hourly means without
 * duplicating hours already stored raw, that the shared reconcile cron
 * leaves a running Health Connect job alone, that the worker removes both
 * staged files on every way out, and that a year of minute-by-minute heart
 * rate stays far below the production heap.
 */
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  buildHealthConnectFixture,
  zipHealthConnectDb,
} from "../fixtures/health-connect/build-fixture";
import { importHealthConnectExport } from "@/lib/import/health-connect/import";
import {
  HEALTH_CONNECT_IMPORT_KIND,
  HEALTH_CONNECT_IMPORT_QUEUE,
  runHealthConnectImport,
} from "@/lib/jobs/health-connect-import-worker";
import {
  _setWorkerPrismaForTests,
  reconcileOrphanImportJobs,
} from "@/lib/jobs/apple-health-import-worker";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const bossMock = vi.hoisted(() => ({
  handle: null as null | {
    getJobById: (queue: string, id: string) => Promise<unknown>;
  },
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => bossMock.handle),
}));

const gates = vi.hoisted(() => ({ nutrients: true, cycle: true }));
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  isModuleEnabled: vi.fn(async (_userId: string, key: string) =>
    key === "nutrients" ? gates.nutrients : true,
  ),
}));
vi.mock("@/lib/cycle/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cycle/gate")>()),
  isCycleAvailableForUser: vi.fn(async () => gates.cycle),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));

const DAY = 86_400_000;
const scratch = mkdtempSync(join(tmpdir(), "hl-hc-import-"));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  _setWorkerPrismaForTests(getPrismaClient());
  bossMock.handle = null;
  gates.nutrients = true;
  gates.cycle = true;
});

afterAll(() => {
  _setWorkerPrismaForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

async function createUser(username: string) {
  return getPrismaClient().user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
}

function fixtureDb(
  name: string,
  options: Parameters<typeof buildHealthConnectFixture>[1] = {},
) {
  const path = join(scratch, `${name}.db`);
  const info = buildHealthConnectFixture(path, options);
  return { path, ...info };
}

const today = Math.floor(Date.now() / DAY) * DAY;

async function countBy(userId: string) {
  const rows = await getPrismaClient().measurement.groupBy({
    by: ["type"],
    where: { userId, source: "HEALTH_CONNECT", deletedAt: null },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.type, r._count._all]));
}

describe("Health Connect import, mapping", () => {
  it("writes every record type as the mapping says", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("hc-map");
    const { path } = fixtureDb("map", { days: 4, endUtc: today });
    const result = await importHealthConnectExport({
      prisma,
      dbPath: path,
      userId: user.id,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: [],
    });

    expect(await countBy(user.id)).toEqual({
      WEIGHT: 8,
      BODY_FAT: 4,
      LEAN_BODY_MASS: 4,
      BLOOD_PRESSURE_SYS: 4,
      BLOOD_PRESSURE_DIA: 4,
      RESTING_HEART_RATE: 4,
      HRV_RMSSD: 4,
      OXYGEN_SATURATION: 4,
      RESPIRATORY_RATE: 4,
      BLOOD_GLUCOSE: 4,
      BODY_TEMPERATURE: 4,
      VO2_MAX: 4,
      // All inside the 90-day window: one row per sample.
      PULSE: 4 * 24 * 60,
      // 8 classified stages a night (out of bed and the unknown gap left
      // out), 2 rows for the nap of unknown stages, 1 for the bare nap.
      SLEEP_DURATION: 4 * 8 + 2 + 1,
      ACTIVITY_STEPS: 4,
      ACTIVE_ENERGY_BURNED: 4,
      WALKING_RUNNING_DISTANCE: 4,
    });

    // Units: grams to kg, mmol/L to mg/dL, small calories to kcal.
    const one = async (type: string) =>
      prisma.measurement.findFirstOrThrow({
        where: {
          userId: user.id,
          type: type as never,
          source: "HEALTH_CONNECT",
        },
        orderBy: { measuredAt: "asc" },
      });
    expect((await one("WEIGHT")).value).toBe(80);
    expect((await one("WEIGHT")).unit).toBe("kg");
    expect((await one("BLOOD_GLUCOSE")).value).toBe(99);
    expect((await one("BLOOD_GLUCOSE")).glucoseContext).toBe("FASTING");
    expect((await one("ACTIVE_ENERGY_BURNED")).value).toBe(320);
    // Steps: the activity priority list names Samsung (5 600) before Fitbit
    // (6 400), so the day is Samsung's, not the sum of both.
    const steps = await one("ACTIVITY_STEPS");
    expect(steps.value).toBe(5600);
    expect(steps.externalId).toMatch(
      /^stats:HKQuantityTypeIdentifierStepCount:\d{4}-\d{2}-\d{2}$/,
    );
    expect((await one("WEIGHT")).externalId).toMatch(
      /^hc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect((await one("PULSE")).externalId).toMatch(/^hc:[0-9a-f-]{36}:\d+$/);

    const stages = await prisma.measurement.groupBy({
      by: ["sleepStage"],
      where: { userId: user.id, type: "SLEEP_DURATION" },
      _count: { _all: true },
    });
    expect(
      Object.fromEntries(stages.map((s) => [s.sleepStage, s._count._all])),
    ).toEqual({ AWAKE: 8, CORE: 12, DEEP: 8, REM: 4, ASLEEP: 3 });
    expect(result.skipped["SLEEP_DURATION::out_of_bed"]).toBe(4);
    expect(result.skipped["SLEEP_DURATION::unknown_stage"]).toBe(4);
    expect(result.sleep.overlapping).toBe(1);

    const workouts = await prisma.workout.findMany({
      where: { userId: user.id },
      orderBy: { startedAt: "asc" },
    });
    expect(workouts.map((w) => [w.sportType, w.source, w.durationSec])).toEqual(
      [
        ["running", "HEALTH_CONNECT", 2700],
        ["other", "HEALTH_CONNECT", 1800],
      ],
    );
    expect(workouts[1].metadata).toEqual({ healthConnectExerciseType: 999 });

    const logs = await prisma.cycleDayLog.findMany({
      where: { userId: user.id },
      orderBy: { date: "asc" },
      select: { flow: true, source: true },
    });
    expect(logs).toEqual([
      { flow: "HEAVY", source: "HEALTH_CONNECT" },
      { flow: "LIGHT", source: "HEALTH_CONNECT" },
      { flow: "LIGHT", source: "HEALTH_CONNECT" },
    ]);

    const nutrients = await prisma.nutrientIntakeDay.findMany({
      where: { userId: user.id },
      select: { nutrient: true, amount: true, unit: true, source: true },
    });
    expect(nutrients).toHaveLength(4 * 5);
    expect(nutrients.find((n) => n.nutrient === "water")).toMatchObject({
      amount: 750,
      unit: "ml",
      source: "HEALTH_CONNECT",
    });
    expect(
      nutrients.find((n) => n.nutrient === "vitamin_d")?.amount,
    ).toBeCloseTo(10);

    // Counts only: per type, per app, never a value.
    expect(result.perApp["com.fitbit.FitbitMobile"].records).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("Evening run");
  });

  it("writes nothing the second time the same export comes in", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("hc-twice");
    const { path } = fixtureDb("twice", { days: 3, endUtc: today });
    const args = {
      prisma,
      dbPath: path,
      userId: user.id,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: [],
    } as const;
    const first = await importHealthConnectExport(args);
    const before = await countBy(user.id);
    const second = await importHealthConnectExport(args);

    expect(await countBy(user.id)).toEqual(before);
    const inserted = Object.values(second.perType).reduce(
      (n, s) => n + s.inserted + s.updated,
      0,
    );
    expect(inserted).toBe(0);
    expect(second.totals.rowsUpserted).toBe(0);
    expect(second.workouts.inserted).toBe(0);
    expect(first.totals.rowsUpserted).toBeGreaterThan(0);
  });

  it("updates a record whose value changed and leaves a deleted one deleted", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("hc-change");
    const { path } = fixtureDb("change", { days: 2, endUtc: today });
    const args = {
      prisma,
      dbPath: path,
      userId: user.id,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: [],
    } as const;
    await importHealthConnectExport(args);
    const weights = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT" },
      orderBy: { measuredAt: "asc" },
    });
    await prisma.measurement.update({
      where: { id: weights[0].id },
      data: { value: 70 },
    });
    await prisma.measurement.update({
      where: { id: weights[1].id },
      data: { deletedAt: new Date() },
    });
    const again = await importHealthConnectExport(args);
    expect(again.perType.WEIGHT.updated).toBe(1);
    expect(again.skipped["WEIGHT::deleted_in_healthlog"]).toBe(1);
    const after = await prisma.measurement.findUniqueOrThrow({
      where: { id: weights[1].id },
    });
    expect(after.deletedAt).not.toBeNull();
  });
});

describe("Health Connect import, duplicates from other paths", () => {
  it("leaves out the apps of connected integrations", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("hc-skip");
    const { path } = fixtureDb("skip", { days: 2, endUtc: today });
    const result = await importHealthConnectExport({
      prisma,
      dbPath: path,
      userId: user.id,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: ["withings", "fitbit"],
    });
    const counts = await countBy(user.id);
    // Only the Health Connect app's own weighings; the scale's are skipped.
    expect(counts.WEIGHT).toBe(2);
    expect(counts.BODY_FAT).toBeUndefined();
    // Fitbit wrote heart rate, resting heart rate and energy.
    expect(counts.PULSE).toBeUndefined();
    expect(counts.RESTING_HEART_RATE).toBeUndefined();
    expect(counts.ACTIVE_ENERGY_BURNED).toBeUndefined();
    expect(counts.ACTIVITY_STEPS).toBe(2);
    expect(result.perApp["com.withings.wiscale2"].leftOut).toBe(true);
    expect(result.skipped.connected_integration).toBeGreaterThan(0);
  });

  it("finds the connected integrations of the account", async () => {
    const { connectedDirectIntegrations } =
      await import("@/lib/import/health-connect/skip-packages");
    const prisma = getPrismaClient();
    const user = await createUser("hc-connected");
    expect(await connectedDirectIntegrations(prisma, user.id)).toEqual([]);
    await prisma.user.update({
      where: { id: user.id },
      data: { ouraAccessTokenEncrypted: "sealed" },
    });
    expect(await connectedDirectIntegrations(prisma, user.id)).toEqual([
      "oura",
    ]);
  });

  it("leaves out a reading already stored under another source", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("hc-twin");
    const { path, startUtc } = fixtureDb("twin", { days: 1, endUtc: today });
    // The Health Connect app's weighing of the day, typed in by hand as well
    // a second later.
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 79.5,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(startUtc + 5.5 * 3_600_000 + 1000),
      },
    });
    const result = await importHealthConnectExport({
      prisma,
      dbPath: path,
      userId: user.id,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: ["withings"],
    });
    expect(result.skipped["WEIGHT::same_reading_other_source"]).toBe(1);
    expect((await countBy(user.id)).WEIGHT).toBeUndefined();
  });
});

describe("Health Connect import, heart rate history", () => {
  it("folds samples older than 90 days into hourly means with their range", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("hc-hourly");
    const { path, endUtc } = fixtureDb("hourly", { days: 2, endUtc: today });
    await importHealthConnectExport({
      prisma,
      dbPath: path,
      userId: user.id,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: [],
      now: new Date(endUtc + 120 * DAY),
    });
    const pulse = await prisma.measurement.findMany({
      where: { userId: user.id, type: "PULSE" },
      orderBy: { measuredAt: "asc" },
    });
    expect(pulse).toHaveLength(2 * 24);
    expect(pulse[0].externalId).toMatch(
      /^stats:HKQuantityTypeIdentifierHeartRate:\d{4}-\d{2}-\d{2}T\d{2}$/,
    );
    expect(pulse[0].valueMin).toBe(55);
    expect(pulse[0].valueMax).toBe(94);
  });

  it("does not fold an hour that an earlier import stored raw", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("hc-raw-then-old");
    const { path, endUtc } = fixtureDb("rawold", { days: 1, endUtc: today });
    const args = {
      prisma,
      dbPath: path,
      userId: user.id,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: [],
    } as const;
    await importHealthConnectExport({ ...args, now: new Date(endUtc) });
    const later = await importHealthConnectExport({
      ...args,
      now: new Date(endUtc + 120 * DAY),
    });
    expect(later.skipped["PULSE::hour_already_raw"]).toBe(24);
    expect((await countBy(user.id)).PULSE).toBe(24 * 60);
  });
});

describe("Health Connect import, worker", () => {
  async function stagedJob(name: string, zipBuilder: (zip: string) => void) {
    const prisma = getPrismaClient();
    const user = await createUser(`hc-worker-${name}`);
    const uploadPath = join(
      scratch,
      `healthlog-health-connect-import-${name.padEnd(8, "0")}-0000-4000-8000-000000000000.bin`,
    );
    zipBuilder(uploadPath);
    const job = await prisma.importJob.create({
      data: {
        userId: user.id,
        kind: HEALTH_CONNECT_IMPORT_KIND,
        status: "queued",
        uploadBytes: 1,
        parserRevision: 1,
      },
    });
    return { user, job, uploadPath };
  }

  const extractedDbs = () =>
    readdirSync(tmpdir()).filter((n) =>
      /^healthlog-hc-import-[0-9a-f]{24}\.db$/.test(n),
    );

  it("imports, records counts only and removes both staged files", async () => {
    const prisma = getPrismaClient();
    const before = new Set(extractedDbs());
    const { path } = fixtureDb("worker", { days: 1, endUtc: today });
    const { user, job, uploadPath } = await stagedJob("ok", (zip) =>
      zipHealthConnectDb(path, zip),
    );
    const outcome = await runHealthConnectImport({
      userId: user.id,
      importJobId: job.id,
      uploadPath,
    });
    expect(outcome.ok).toBe(true);
    const row = await prisma.importJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(row.status).toBe("done");
    expect((row.result as { kind: string }).kind).toBe("health_connect");
    expect(existsSync(uploadPath)).toBe(false);
    expect(extractedDbs().filter((n) => !before.has(n))).toEqual([]);
  });

  it("fails a file that is not an export, with a reason, and still removes it", async () => {
    const prisma = getPrismaClient();
    const { job, user, uploadPath } = await stagedJob("bad", (zip) =>
      writeFileSync(zip, "not a zip at all"),
    );
    const outcome = await runHealthConnectImport({
      userId: user.id,
      importJobId: job.id,
      uploadPath,
    });
    expect(outcome.ok).toBe(false);
    const row = await prisma.importJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBeTruthy();
    expect(existsSync(uploadPath)).toBe(false);
  });

  it("refuses a database older than the supported schema", async () => {
    const prisma = getPrismaClient();
    const { path } = fixtureDb("old", { days: 1, userVersion: 7 });
    const { job, user, uploadPath } = await stagedJob("old", (zip) =>
      zipHealthConnectDb(path, zip),
    );
    await runHealthConnectImport({
      userId: user.id,
      importJobId: job.id,
      uploadPath,
    });
    const row = await prisma.importJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(row.failureReason).toMatch(/^unsupported_version:/);
  });

  it("the shared reconcile cron leaves a running Health Connect job alone", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("hc-reconcile");
    const row = await prisma.importJob.create({
      data: {
        userId: user.id,
        kind: HEALTH_CONNECT_IMPORT_KIND,
        pgBossJobId: "boss-hc-live",
        status: "upserting",
        uploadBytes: 1,
        parserRevision: 1,
      },
    });
    bossMock.handle = {
      getJobById: async (queue: string, id: string) =>
        queue === HEALTH_CONNECT_IMPORT_QUEUE && id === "boss-hc-live"
          ? { id, state: "active", data: {} }
          : null,
    };
    await reconcileOrphanImportJobs();
    const after = await prisma.importJob.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("upserting");

    // And a Health Connect job whose queue entry is gone is failed honestly.
    bossMock.handle = { getJobById: async () => null };
    await reconcileOrphanImportJobs();
    const gone = await prisma.importJob.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(gone.status).toBe("failed");
  });
});

describe("Health Connect import, memory", () => {
  // A year of per-minute heart rate (525 600 samples) plus every other type.
  // Production runs the worker with a 792 MB heap; what the import keeps
  // alive must stay far below that whatever the length of the history,
  // because nothing it holds grows with the number of records. Measured as
  // the heap that survives a full collection, sampled once per progress tick:
  // the raw `heapUsed` of an uncapped test process mostly counts garbage the
  // collector has not bothered to reclaim yet.
  const days = Number(process.env.HC_MEMORY_DAYS ?? 365);

  it(`keeps a bounded heap alive on ${days} days of data`, async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const prisma = getPrismaClient();
    const user = await createUser("hc-memory");
    const { path } = fixtureDb("memory", { days, endUtc: today });
    gc();
    const base = process.memoryUsage().heapUsed;
    let retainedPeak = base;
    let rawPeak = base;
    const timer = setInterval(() => {
      rawPeak = Math.max(rawPeak, process.memoryUsage().heapUsed);
    }, 50);
    const startedAt = Date.now();
    const result = await importHealthConnectExport({
      prisma,
      dbPath: path,
      userId: user.id,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: [],
      onProgress: async () => {
        gc();
        retainedPeak = Math.max(retainedPeak, process.memoryUsage().heapUsed);
      },
    });
    clearInterval(timer);
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    const retainedGrowthMb = (retainedPeak - base) / 1024 / 1024;
    const line =
      `[hc-memory] days=${days} records=${result.totals.recordsRead} rows=${result.totals.rowsUpserted} ` +
      `retainedGrowthMb=${retainedGrowthMb.toFixed(1)} rawPeakHeapMb=${mb(rawPeak)} baseHeapMb=${mb(base)} ` +
      `heapLimitMb=${(getHeapStatistics().heap_size_limit / 1024 / 1024).toFixed(0)} ` +
      `seconds=${((Date.now() - startedAt) / 1000).toFixed(1)}\n`;
    // The suite silences console output; a measurement run names a file.
    if (process.env.HC_MEMORY_REPORT) {
      appendFileSync(process.env.HC_MEMORY_REPORT, line);
    }
    expect(result.totals.recordsRead).toBeGreaterThan(days * 1440);
    expect(retainedGrowthMb).toBeLessThan(100);
  }, 900_000);
});
