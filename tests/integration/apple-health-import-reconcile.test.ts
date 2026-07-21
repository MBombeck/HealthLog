/**
 * Issue #486 follow-up — `reconcileOrphanImportJobs` liveness contract +
 * the kick-off dedup-by-status DB contract, pinned against real Postgres.
 *
 * Two defects fixed here:
 *
 *   1. Boot reconcile used to flip EVERY non-terminal ImportJob row to
 *      `failed` unconditionally. In a multi-replica / rolling-deploy
 *      topology that killed an import still actively parsing in another
 *      worker. The reconcile now only flips a row whose pg-boss job is
 *      gone/terminal OR whose `updatedAt` heartbeat has gone stale — a
 *      job that is `active` in pg-boss with a fresh heartbeat survives.
 *
 *   2. The kick-off dedup matched ANY prior job with the same
 *      `uploadSha256`, including a `failed` one, tombstoning the file's
 *      hash forever. The lookup now excludes `failed` rows so the same
 *      export always stays retryable; a still-viable job (queued /
 *      in-flight / `done`) still short-circuits.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  reconcileOrphanImportJobs,
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  _setWorkerPrismaForTests,
} from "@/lib/jobs/apple-health-import-worker";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// Controllable pg-boss handle: the reconcile consults `getJobById` for a
// row's real queue state.
const bossMock = vi.hoisted(() => ({
  getJobById: vi.fn(),
  handle: null as { getJobById: (n: string, id: string) => unknown } | null,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => bossMock.handle),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  _setWorkerPrismaForTests(getPrismaClient());
  bossMock.getJobById.mockReset();
  bossMock.handle = { getJobById: bossMock.getJobById };
});

afterAll(() => {
  _setWorkerPrismaForTests(null);
});

async function createUser(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test`, role: "USER" },
  });
}

/** Backdate the heartbeat past the staleness threshold (30 min). */
async function backdateHeartbeat(rowId: string, minutesAgo: number) {
  await getPrismaClient().$executeRawUnsafe(
    `UPDATE import_jobs SET updated_at = NOW() - INTERVAL '${minutesAgo} minutes' WHERE id = $1`,
    rowId,
  );
}

describe("reconcileOrphanImportJobs — liveness gate (issue #486)", () => {
  it("does NOT flip a row that is active in pg-boss with a fresh heartbeat", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("recon-active-fresh");
    const row = await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-active-fresh",
        status: "parsing",
        uploadBytes: 100,
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      },
    });
    bossMock.getJobById.mockResolvedValue({
      id: "boss-active-fresh",
      state: "active",
    });

    await reconcileOrphanImportJobs();

    const after = await prisma.importJob.findUnique({ where: { id: row.id } });
    expect(after!.status).toBe("parsing");
    expect(after!.failureReason).toBeNull();
  });

  it("flips a row whose pg-boss job is gone (archived / null)", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("recon-gone");
    const row = await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-gone",
        status: "upserting",
        uploadBytes: 100,
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      },
    });
    bossMock.getJobById.mockResolvedValue(null);

    await reconcileOrphanImportJobs();

    const after = await prisma.importJob.findUnique({ where: { id: row.id } });
    expect(after!.status).toBe("failed");
    expect(after!.failureReason).toBe("interrupted_by_restart");
  });

  it("flips a row whose pg-boss job is terminal (completed / failed)", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("recon-terminal");
    const row = await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-terminal",
        status: "parsing",
        uploadBytes: 100,
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      },
    });
    bossMock.getJobById.mockResolvedValue({
      id: "boss-terminal",
      state: "completed",
    });

    await reconcileOrphanImportJobs();

    const after = await prisma.importJob.findUnique({ where: { id: row.id } });
    expect(after!.status).toBe("failed");
  });

  it("flips a stale-heartbeat row even when pg-boss still reports it active", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("recon-stale-active");
    const row = await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-stale-active",
        status: "parsing",
        uploadBytes: 100,
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      },
    });
    await backdateHeartbeat(row.id, 45);
    bossMock.getJobById.mockResolvedValue({
      id: "boss-stale-active",
      state: "active",
    });

    await reconcileOrphanImportJobs();

    const after = await prisma.importJob.findUnique({ where: { id: row.id } });
    expect(after!.status).toBe("failed");
  });

  it("self-heals under the single-worker fallback when no boss handle is present", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("recon-no-boss");
    const row = await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-none",
        status: "parsing",
        uploadBytes: 100,
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      },
    });
    bossMock.handle = null; // getGlobalBoss() → null

    await reconcileOrphanImportJobs();

    const after = await prisma.importJob.findUnique({ where: { id: row.id } });
    expect(after!.status).toBe("failed");
  });

  it("leaves a legacy-default revision-1 row to a revision-1 worker", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("recon-legacy-revision");
    const row = await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-legacy",
        status: "parsing",
        uploadBytes: 100,
      },
    });

    expect(row.parserRevision).toBe(1);
    await reconcileOrphanImportJobs();

    const after = await prisma.importJob.findUnique({ where: { id: row.id } });
    expect(after!.status).toBe("parsing");
    expect(bossMock.getJobById).not.toHaveBeenCalled();
  });

  it("leaves terminal rows untouched", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("recon-already-terminal");
    const done = await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-done",
        status: "done",
        uploadBytes: 100,
      },
    });

    await reconcileOrphanImportJobs();

    const after = await prisma.importJob.findUnique({ where: { id: done.id } });
    expect(after!.status).toBe("done");
    expect(bossMock.getJobById).not.toHaveBeenCalled();
  });
});

describe("kick-off dedup — status-scoped lookup (issue #486)", () => {
  // Mirrors the exact `findFirst` the kick-off routes run.
  async function dedupLookup(userId: string, sha: string) {
    return getPrismaClient().importJob.findFirst({
      where: {
        userId,
        uploadSha256: sha,
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
        status: { not: "failed" },
      },
      orderBy: { startedAt: "desc" },
    });
  }

  it("does NOT match a prior failed job for the same bytes", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("dedup-failed");
    await prisma.importJob.create({
      data: {
        userId: user.id,
        status: "failed",
        failureReason: "ENOENT: no such file or directory",
        uploadBytes: 100,
        uploadSha256: "sha-failed",
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
        completedAt: new Date(),
      },
    });

    expect(await dedupLookup(user.id, "sha-failed")).toBeNull();
  });

  it("still matches a viable prior job (queued / in-flight / done) for the same bytes", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("dedup-viable");
    const done = await prisma.importJob.create({
      data: {
        userId: user.id,
        status: "done",
        uploadBytes: 100,
        uploadSha256: "sha-viable",
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
        completedAt: new Date(),
      },
    });

    const hit = await dedupLookup(user.id, "sha-viable");
    expect(hit!.id).toBe(done.id);
  });

  it("falls through to the viable row when a failed and a done row share a hash", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("dedup-mixed");
    await prisma.importJob.create({
      data: {
        userId: user.id,
        status: "failed",
        uploadBytes: 100,
        uploadSha256: "sha-mixed",
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
        completedAt: new Date(),
      },
    });
    const done = await prisma.importJob.create({
      data: {
        userId: user.id,
        status: "done",
        uploadBytes: 100,
        uploadSha256: "sha-mixed",
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
        completedAt: new Date(),
      },
    });

    const hit = await dedupLookup(user.id, "sha-mixed");
    expect(hit!.id).toBe(done.id);
  });
  it("allows a revision-1 archive to be reprocessed at revision 2", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("dedup-parser-revision");
    await prisma.importJob.create({
      data: {
        userId: user.id,
        status: "done",
        uploadBytes: 100,
        uploadSha256: "sha-parser-revision",
        parserRevision: 1,
        completedAt: new Date(),
      },
    });

    expect(await dedupLookup(user.id, "sha-parser-revision")).toBeNull();

    const current = await prisma.importJob.create({
      data: {
        userId: user.id,
        status: "done",
        uploadBytes: 100,
        uploadSha256: "sha-parser-revision",
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
        completedAt: new Date(),
      },
    });
    expect((await dedupLookup(user.id, "sha-parser-revision"))?.id).toBe(
      current.id,
    );
  });
});
