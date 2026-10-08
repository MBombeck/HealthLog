/**
 * v1.32.1 (issue #588) — periodic orphan-`ImportJob` reconcile.
 *
 * Before this change `reconcileOrphanImportJobs()` only ran once, at
 * worker boot. A worker that crashed mid-extraction (OOM, restart) and
 * came back up BEFORE the stuck row's heartbeat went stale (30 min) or
 * pg-boss stopped reporting the backing job as live left that row
 * stuck in `unpacking` / `parsing` / `upserting` forever — an import
 * that never leaves "Unpacking the archive… 0 rows imported" with no
 * failure ever surfaced, because nothing re-evaluated the row after
 * that one boot-time pass. These tests cover both the periodic-tick
 * wiring (queue provisioned, cron scheduled, handler bound) and the
 * reconcile logic itself (a genuinely-abandoned row flips to `failed`;
 * a row another worker is still actively running does not).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  getGlobalBoss: vi.fn(),
  getJobById: vi.fn(),
}));

vi.mock("@/lib/import/apple-health-staging", () => ({
  ACTIVE_IMPORT_STATUSES: ["queued", "unpacking", "parsing", "upserting"],
  sweepStaleImportStaging: vi.fn(async () => 2),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    importJob: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
  },
  toJson: (value: unknown) => value,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: mocks.getGlobalBoss,
}));

import {
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  APPLE_HEALTH_IMPORT_V2_QUEUE,
  IMPORT_JOB_RECONCILE_CRON,
  IMPORT_JOB_RECONCILE_QUEUE,
  handleImportJobReconcileTick,
  reconcileOrphanImportJobs,
  stagedImportFilesInUse,
} from "../apple-health-import-worker";
import { sweepStaleImportStaging } from "@/lib/import/apple-health-staging";

const maintenanceSource = readFileSync(
  join(process.cwd(), "src/lib/jobs/reminder/register-maintenance.ts"),
  "utf8",
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getGlobalBoss.mockReturnValue({ getJobById: mocks.getJobById });
  mocks.updateMany.mockResolvedValue({ count: 0 });
});

describe("periodic reconcile — wiring", () => {
  it("provisions the queue, schedules a 15-minute cron, and binds the handler", () => {
    expect(IMPORT_JOB_RECONCILE_QUEUE).toBe("apple-health-import-reconcile");
    expect(IMPORT_JOB_RECONCILE_CRON).toBe("*/15 * * * *");

    const allQueues = maintenanceSource.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueues).not.toBeNull();
    expect(allQueues![1]).toMatch(/\bIMPORT_JOB_RECONCILE_QUEUE\b/);

    const schedules = maintenanceSource.match(
      /const schedules[\s\S]*?=\s*\[([\s\S]*?)\];/,
    );
    expect(schedules).not.toBeNull();
    // The third element pins the retry policy. It is load-bearing now that
    // the handler reports a failed outcome instead of swallowing: without
    // `cronIsTheRetry` a database outage would run the same doomed sweep
    // three times per tick, and the next tick is already the retry.
    expect(schedules![1]).toMatch(
      /\[IMPORT_JOB_RECONCILE_QUEUE,\s*IMPORT_JOB_RECONCILE_CRON,\s*cronIsTheRetry\]/,
    );

    expect(maintenanceSource).toMatch(
      /createAndWork\(\s*boss,\s*IMPORT_JOB_RECONCILE_QUEUE[\s\S]{0,120}handleImportJobReconcileTick/,
    );
  });
});

describe("reconcileOrphanImportJobs", () => {
  it("flips a row to failed once its heartbeat has gone stale", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "import-stale",
        pgBossJobId: "boss-1",
        updatedAt: new Date(Date.now() - 31 * 60 * 1000),
      },
    ]);
    mocks.getJobById.mockResolvedValue({ state: "active" });

    await reconcileOrphanImportJobs();

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["import-stale"] } },
      data: {
        status: "failed",
        failureReason: "interrupted_by_restart",
        completedAt: expect.any(Date),
      },
    });
  });

  it("leaves a row alone while its heartbeat is fresh and pg-boss reports the job active", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "import-live",
        pgBossJobId: "boss-2",
        updatedAt: new Date(Date.now() - 2 * 60 * 1000),
      },
    ]);
    mocks.getJobById.mockResolvedValue({ state: "active" });

    await reconcileOrphanImportJobs();

    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.getJobById).toHaveBeenCalledWith(
      APPLE_HEALTH_IMPORT_V2_QUEUE,
      "boss-2",
    );
  });

  it("flips a row whose backing pg-boss job is gone even with a fresh heartbeat", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "import-gone",
        pgBossJobId: "boss-3",
        updatedAt: new Date(Date.now() - 60 * 1000),
      },
    ]);
    mocks.getJobById.mockResolvedValue(null);

    await reconcileOrphanImportJobs();

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["import-gone"] } },
      data: {
        status: "failed",
        failureReason: "interrupted_by_restart",
        completedAt: expect.any(Date),
      },
    });
  });

  it("scopes Apple Health rows to the current parser revision and takes every Health Connect row", async () => {
    // v1.42: the table holds both importers' rows. A revision filter alone
    // would either skip the Health Connect rows (they carry their own
    // revision) or, matched by accident, look them up on the wrong queue.
    mocks.findMany.mockResolvedValue([]);

    await reconcileOrphanImportJobs();

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["unpacking", "parsing", "upserting"] },
        OR: [
          {
            kind: "apple_health",
            parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
          },
          { kind: "health_connect" },
        ],
      },
      select: { id: true, pgBossJobId: true, updatedAt: true, kind: true },
    });
  });
});

describe("handleImportJobReconcileTick", () => {
  it("delegates to reconcileOrphanImportJobs and reports a done outcome", async () => {
    mocks.findMany.mockResolvedValue([]);

    await expect(handleImportJobReconcileTick([] as never)).resolves.toEqual({
      ok: true,
      did: { import_staging_swept: 2 },
    });
    // Once for what the sweep must keep, once for the reconcile.
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
  });

  it("reports a failed outcome when the reconcile pass throws", async () => {
    const cause = new Error("db unavailable");
    mocks.findMany.mockRejectedValue(cause);

    // The handler used to swallow this and resolve, which left a sweep
    // that had not run for hours indistinguishable from one that found
    // nothing to do. It now names the failure, `runJob` rethrows it, and
    // pg-boss records a failed job. The queue carries `cronIsTheRetry`
    // (retryLimit 0) because the next 15-minute tick is the retry — a
    // database that is down stays down for an immediate re-run.
    await expect(handleImportJobReconcileTick([] as never)).resolves.toEqual({
      ok: false,
      reason: "apple health import reconcile failed",
      cause,
    });
  });
});

describe("stagedImportFilesInUse", () => {
  beforeEach(() => {
    vi.mocked(sweepStaleImportStaging).mockResolvedValue(0);
  });

  it("keeps the upload of an import still waiting in the queue", async () => {
    // An upload can wait behind another account's import for longer than
    // the sweep's age limit; removing it failed the import on its turn.
    const rows = [
      { status: "queued", pgBossJobId: "boss-1" },
      { status: "parsing", pgBossJobId: "boss-2" },
      { status: "queued", pgBossJobId: "boss-3" },
    ];
    // The sweep's read, then (in the tick) the reconcile's.
    mocks.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    mocks.getGlobalBoss.mockReturnValue({ getJobById: mocks.getJobById });
    mocks.getJobById.mockImplementation(async (queue: string, id: string) => {
      if (queue !== APPLE_HEALTH_IMPORT_V2_QUEUE) return null;
      if (id === "boss-1") {
        return { state: "created", data: { uploadPath: "/tmp/a.bin" } };
      }
      if (id === "boss-2") {
        return { state: "active", data: { uploadPath: "/tmp/b.bin" } };
      }
      // A job pg-boss already finished holds nothing.
      return { state: "failed", data: { uploadPath: "/tmp/c.bin" } };
    });

    const inUse = await stagedImportFilesInUse();
    expect(inUse).not.toBeNull();
    expect([...(inUse?.paths ?? [])].sort()).toEqual([
      "/tmp/a.bin",
      "/tmp/b.bin",
    ]);
    expect(inUse?.extractedInUse).toBe(true);

    await handleImportJobReconcileTick([] as never);
    expect(sweepStaleImportStaging).toHaveBeenCalledWith(
      undefined,
      undefined,
      expect.objectContaining({ extractedInUse: true }),
    );
  });

  it("looks a Health Connect upload up on its own queue", async () => {
    const rows = [
      { status: "queued", pgBossJobId: "boss-hc", kind: "health_connect" },
    ];
    mocks.findMany.mockResolvedValueOnce(rows);
    mocks.getGlobalBoss.mockReturnValue({ getJobById: mocks.getJobById });
    mocks.getJobById.mockImplementation(async (queue: string) =>
      queue === "health-connect-import"
        ? { state: "created", data: { uploadPath: "/tmp/hc.bin" } }
        : null,
    );

    const inUse = await stagedImportFilesInUse();
    expect([...(inUse?.paths ?? [])]).toEqual(["/tmp/hc.bin"]);
  });

  it("sweeps nothing when the queue cannot be read", async () => {
    const rows = [{ status: "queued", pgBossJobId: "boss-1" }];
    mocks.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    mocks.getGlobalBoss.mockReturnValue(null);
    expect(await stagedImportFilesInUse()).toBeNull();

    await handleImportJobReconcileTick([] as never);
    expect(sweepStaleImportStaging).not.toHaveBeenCalled();
  });
});
