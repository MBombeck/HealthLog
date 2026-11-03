/**
 * v1.28.33 — failure-path contracts for the Apple Health import worker
 * (issue #486).
 *
 * A cumulative re-import that outlives the queue's expiration window is
 * redelivered by pg-boss after the first run already consumed (and
 * unlinked) the staged upload. The redelivery used to re-open the
 * deleted `/tmp/healthlog-apple-health-import-*.bin`, fail with a raw
 * ENOENT, and OVERWRITE the first run's terminal state — masking the
 * real outcome (a genuine failure reason, or even a completed import)
 * behind "ENOENT: no such file or directory". Pinned here against the
 * real Postgres:
 *
 *   1. A delivery for an ImportJob already in a terminal state
 *      (`done` / `failed`) is ignored — status, failureReason and
 *      result stay exactly as the first run left them.
 *
 *   2. A missing staging file on a live (non-terminal) job surfaces an
 *      honest operator-facing reason instead of the raw ENOENT string.
 *
 *   3. A genuine parse failure records ITS message as the failure
 *      reason and deterministically removes the staged upload.
 */
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  handleAppleHealthImport,
  _setWorkerPrismaForTests,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";

// No pg-boss attached — the end-of-import rollup fold's enqueue helpers
// are silent no-ops without a boss.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const scratchDir = mkdtempSync(join(tmpdir(), "hl-import-worker-test-"));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  // Route the worker's Prisma singleton onto the shared testcontainer
  // client so the handler does not open a second pool.
  _setWorkerPrismaForTests(getPrismaClient());
});

afterAll(() => {
  _setWorkerPrismaForTests(null);
  rmSync(scratchDir, { recursive: true, force: true });
});

async function createUser(username: string) {
  return getPrismaClient().user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
    },
  });
}

function bossJob(
  id: string,
  payload: AppleHealthImportPayload,
): Job<AppleHealthImportPayload> {
  return {
    id,
    name: "apple-health-import",
    data: payload,
  } as Job<AppleHealthImportPayload>;
}

describe("apple health import worker — failure paths (issue #486)", () => {
  it("ignores a redelivery for a job already failed — the original reason survives", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("import-terminal-failed");
    const originalReason = "database write failed during upsert";
    await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-terminal-failed",
        status: "failed",
        failureReason: originalReason,
        uploadBytes: 1234,
        completedAt: new Date("2026-04-22T10:00:00.000Z"),
      },
    });

    // The staged upload is long gone — exactly the redelivery scenario.
    await expect(
      handleAppleHealthImport(
        bossJob("boss-terminal-failed", {
          userId: user.id,
          uploadPath: join(scratchDir, "gone.bin"),
          uploadBytes: 1234,
          enqueuedAt: new Date().toISOString(),
        }),
      ),
    ).resolves.toEqual({ ok: true, did: { skipped: "already_terminal" } });

    const row = await prisma.importJob.findUnique({
      where: { pgBossJobId: "boss-terminal-failed" },
    });
    expect(row!.status).toBe("failed");
    expect(row!.failureReason).toBe(originalReason);
    expect(row!.failureReason).not.toContain("ENOENT");
  });

  it("ignores a redelivery for a job already done — the completed import stays done", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("import-terminal-done");
    await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-terminal-done",
        status: "done",
        uploadBytes: 5678,
        completedAt: new Date("2026-04-22T10:00:00.000Z"),
      },
    });

    await expect(
      handleAppleHealthImport(
        bossJob("boss-terminal-done", {
          userId: user.id,
          uploadPath: join(scratchDir, "gone-too.bin"),
          uploadBytes: 5678,
          enqueuedAt: new Date().toISOString(),
        }),
      ),
    ).resolves.toEqual({ ok: true, did: { skipped: "already_terminal" } });

    const row = await prisma.importJob.findUnique({
      where: { pgBossJobId: "boss-terminal-done" },
    });
    expect(row!.status).toBe("done");
    expect(row!.failureReason).toBeNull();
  });

  it("a missing staging file on a live job records an honest reason, not a raw ENOENT", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("import-missing-staging");
    await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-missing-staging",
        status: "queued",
        uploadBytes: 999,
      },
    });

    await expect(
      handleAppleHealthImport(
        bossJob("boss-missing-staging", {
          userId: user.id,
          uploadPath: join(scratchDir, "never-existed.bin"),
          uploadBytes: 999,
          enqueuedAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toThrow();

    const row = await prisma.importJob.findUnique({
      where: { pgBossJobId: "boss-missing-staging" },
    });
    expect(row!.status).toBe("failed");
    expect(row!.failureReason).not.toContain("ENOENT");
    expect(row!.failureReason).toContain("no longer available");
  });

  it("a genuine parse failure keeps ITS message and removes the staged upload", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("import-real-failure");
    await prisma.importJob.create({
      data: {
        userId: user.id,
        pgBossJobId: "boss-real-failure",
        status: "queued",
        uploadBytes: 64,
      },
    });

    // Garbage bytes — not a ZIP archive; the extractor throws its own
    // descriptive error, which must reach the ImportJob row verbatim.
    const uploadPath = join(scratchDir, "garbage.bin");
    writeFileSync(uploadPath, Buffer.from("this is not a zip archive"));

    let thrownMessage = "";
    try {
      await handleAppleHealthImport(
        bossJob("boss-real-failure", {
          userId: user.id,
          uploadPath,
          uploadBytes: 64,
          enqueuedAt: new Date().toISOString(),
        }),
      );
      expect.unreachable("handler must rethrow the parse failure");
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    const row = await prisma.importJob.findUnique({
      where: { pgBossJobId: "boss-real-failure" },
    });
    expect(row!.status).toBe("failed");
    expect(row!.failureReason).toBe(thrownMessage.slice(0, 1000));
    expect(row!.failureReason).not.toContain("ENOENT");
    // Deterministic cleanup: the staged upload is gone after the failure.
    expect(existsSync(uploadPath)).toBe(false);
  });
});

describe("an account deleted before the worker reaches its upload", () => {
  it("removes the staged export and does not fail on the missing account", async () => {
    const user = await createUser("deleted-before-import");
    const uploadPath = join(
      scratchDir,
      "healthlog-apple-health-import-gone.bin",
    );
    writeFileSync(uploadPath, "the export, in plain text");
    // The account goes, and its ImportJob row with it by cascade.
    await getPrismaClient().user.delete({ where: { id: user.id } });

    const outcome = await handleAppleHealthImport(
      bossJob("boss-gone-1", {
        userId: user.id,
        uploadPath,
        uploadBytes: 25,
        enqueuedAt: new Date().toISOString(),
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(existsSync(uploadPath)).toBe(false);
    expect(await getPrismaClient().importJob.count()).toBe(0);
  });
});
