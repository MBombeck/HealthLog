/**
 * A backup an older release wrote keeps restoring.
 *
 * Every other backup test exports with today's code and restores with
 * today's code, so a change that moves both ends at once (a renamed field, a
 * section that changes shape, a new required value) passes every one of them
 * and still breaks the file a self-hoster downloaded last month. This file
 * holds the other end still: each release commits the disaster-recovery file
 * its own exporter wrote (`tests/fixtures/golden-backups/v<release>.json`),
 * with a manifest of what that file held, and every later release has to
 * restore each committed file into an empty account and get the same counts
 * back, section by section.
 *
 * The files go in through the admin routes an operator uses, the upload and
 * then the restore (`restore-job-driver.ts` runs the queued job in-process),
 * so the upload's own checks of an old file are part of the claim. The counts
 * are read back through the current exporter, which is the reading a person
 * gets when they export again.
 *
 * Ciphertext inside the files is sealed under the suite's fixed key
 * (`ENCRYPTION_KEY` in `vitest.integration.config.mts`), so they open on any
 * machine that runs the suite.
 *
 * `GOLDEN_BACKUP_WRITE=1` writes the current release's file instead of
 * restoring; `tests/fixtures/golden-backups/README.md` says when and how.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";

import {
  OWNER_ID,
  createOwner,
  seedAdminSession,
  seedColumnShapes,
  seedEveryTwoEndedModel,
} from "./backup-fixture";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const FIXTURE_DIR = resolve(__dirname, "../fixtures/golden-backups");
const WRITE = process.env.GOLDEN_BACKUP_WRITE === "1";
const SLOW = 240_000;

/** What a committed file held when its release wrote it. */
interface GoldenManifest {
  release: string;
  schemaVersion: string;
  userId: string;
  exportedAt: string;
  sha256: string;
  bytes: number;
  counts: Record<string, number>;
}

/**
 * Rows the restore is documented to drop by age rather than carry, so a file
 * restored long after it was written comes back without them. Each entry is
 * a count key and the reason; the count may only go down, never up.
 */
const AGES_OUT: Readonly<Record<string, string>> = {
  measurements:
    "a measurement tombstone older than TOMBSTONE_RETENTION_DAYS is not written back (`measurements-restore.ts`)",
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function goldenFiles(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => /^v\d+\.\d+\.\d+\.json$/.test(name))
    .sort();
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe.runIf(WRITE)("golden backups: write this release's file", () => {
  it(
    "writes the disaster-recovery file of the seeded account",
    async () => {
      const prisma = getPrismaClient();
      const release = JSON.parse(
        readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
      ).version as string;
      await createOwner(prisma);
      await seedEveryTwoEndedModel(prisma);
      await seedColumnShapes(prisma);
      // The shared seed files its illness symptom under a catalogue key of
      // its own. A file restored on another instance resolves catalogue keys
      // against what that instance ships, so the committed file names a
      // shipped symptom instead and every link has somewhere to land.
      const shipped = await prisma.illnessSymptom.findFirstOrThrow({
        where: { key: { not: "round_trip_cough" } },
        orderBy: { key: "asc" },
      });
      const own = await prisma.illnessSymptom.findUniqueOrThrow({
        where: { key: "round_trip_cough" },
      });
      await prisma.illnessSymptomLink.updateMany({
        where: { symptomId: own.id },
        data: { symptomId: shipped.id },
      });
      await prisma.illnessSymptom.delete({ where: { id: own.id } });

      const exportedAt = new Date();
      let json = "";
      const counts = await streamFullBackupJson(
        prisma,
        OWNER_ID,
        (chunk) => {
          json += chunk;
        },
        { purpose: "disaster-recovery", exportedAt },
      );
      const bytes = Buffer.from(json, "utf8");
      const payload = JSON.parse(json) as { schemaVersion: string };
      const manifest: GoldenManifest = {
        release,
        schemaVersion: payload.schemaVersion,
        userId: OWNER_ID,
        exportedAt: exportedAt.toISOString(),
        sha256: sha256(bytes),
        bytes: bytes.length,
        counts: { ...counts },
      };
      writeFileSync(resolve(FIXTURE_DIR, `v${release}.json`), bytes);
      writeFileSync(
        resolve(FIXTURE_DIR, `v${release}.manifest.json`),
        JSON.stringify(manifest, null, 2) + "\n",
      );
    },
    SLOW,
  );
});

describe.skipIf(WRITE)("golden backups: every committed file restores", () => {
  it("has at least one committed file, each with its manifest", () => {
    const files = goldenFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readdirSync(FIXTURE_DIR)).toContain(
        file.replace(/\.json$/, ".manifest.json"),
      );
    }
  });

  for (const file of goldenFiles()) {
    it(
      `restores ${file} into an empty account with the counts it was written with`,
      async () => {
        const prisma = getPrismaClient();
        const bytes = readFileSync(resolve(FIXTURE_DIR, file));
        const manifest = JSON.parse(
          readFileSync(
            resolve(FIXTURE_DIR, file.replace(/\.json$/, ".manifest.json")),
            "utf8",
          ),
        ) as GoldenManifest;
        // The file is the release's own bytes. Regenerating it from today's
        // exporter would turn this into one more same-code round trip.
        expect(sha256(bytes), `${file} was rewritten`).toBe(manifest.sha256);
        // A file that held nearly nothing would agree with nearly nothing.
        const nonEmpty = Object.values(manifest.counts).filter((n) => n > 0);
        expect(nonEmpty.length).toBeGreaterThan(40);

        await seedAdminSession(prisma);
        // The empty account the file is restored into: the restore writes
        // into the account the file names, which has to exist.
        await prisma.user.create({
          data: {
            id: manifest.userId,
            username: `golden-${manifest.release}`,
            email: `golden-${manifest.release}@example.test`,
          },
        });

        const { POST: upload } =
          await import("@/app/api/admin/backups/upload/route");
        const uploaded = await upload(
          new Request("http://localhost/api/admin/backups/upload", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: bytes,
          }) as unknown as Parameters<typeof upload>[0],
        );
        const uploadBody = (await uploaded.json()) as {
          data: { id: string } | null;
          error: string | null;
        };
        expect(uploaded.status, JSON.stringify(uploadBody)).toBe(201);
        const backupId = uploadBody.data!.id;

        const { POST: restore } = await import("./restore-job-driver");
        const restored = await restore(
          new Request(
            `http://localhost/api/admin/backups/${backupId}/restore`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ confirm: "RESTORE" }),
            },
          ) as unknown as Parameters<typeof restore>[0],
          { params: Promise.resolve({ id: backupId }) },
        );
        const restoreBody = (await restored.json()) as {
          data: { skipped: { links: number } } | null;
          error: string | null;
          meta?: unknown;
        };
        expect(restored.status, JSON.stringify(restoreBody)).toBe(200);
        expect(
          restoreBody.data!.skipped.links,
          JSON.stringify(restoreBody.data!.skipped),
        ).toBe(0);

        const { counts } = await buildFullBackupPayload(
          prisma,
          manifest.userId,
          { purpose: "disaster-recovery" },
        );
        const now: Record<string, number> = { ...counts };
        for (const [section, expected] of Object.entries(manifest.counts)) {
          if (section in AGES_OUT) {
            expect(now[section], `${section} grew`).toBeLessThanOrEqual(
              expected,
            );
            expect(now[section], `${section} came back empty`).toBeGreaterThan(
              0,
            );
            continue;
          }
          expect(now[section], `${section} after restoring ${file}`).toBe(
            expected,
          );
        }
      },
      SLOW,
    );
  }
});
