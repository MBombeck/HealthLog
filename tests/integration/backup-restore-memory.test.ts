/**
 * #1031 — what a restore holds while it writes the measurements, measured.
 *
 * A self-hoster restored 1.8 million readings in the default 1 GB container
 * (V8 heap limit 524 MB). Near the end of the measurement write the server
 * restarted, and the job started over from the beginning. Reproduced against
 * the same restore of 1.8 million Apple Health readings, the restore itself
 * held a steady 60 MB more than the process did before it started, from the
 * hundredth statement to the last: not the rows it was writing, but the
 * parameters of the hundred statements before them.
 *
 * Prisma's debug logger keeps the arguments of its last hundred calls whether
 * or not logging is on, and the client and the Postgres adapter log each
 * statement with its parameters. A restore that wrote 1 000 readings per
 * statement therefore kept about the last 100 000 readings alive as copies.
 * Bounded, and the same at 150 000 readings as at 1.8 million, but 60 MB out
 * of a heap that a long-running server already fills well past half. The
 * insert now carries at most a hundred rows per statement, and the history
 * holds about a tenth of that.
 *
 * How it measures. Every reading is taken after a forced collection, so what
 * is compared is what the restore HOLDS, not what V8 left lying about. The
 * anchor is taken when the measurement write starts, after the checks and the
 * clearing, so the modules and compiled queries they load are not counted.
 * The fixture is sized so the old statement size fills the whole history
 * well before the end: 150 statements of 1 000 readings.
 *
 * Mutation check: set `MEASUREMENT_INSERT_ROWS_PER_STATEMENT` to 1 000 and
 * the growth test goes red at about 64 MB against the 20 MB budget.
 */
import v8 from "node:v8";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER = "restore-memory-owner";
const ROWS = 150_000;

/**
 * How much the heap may grow during the measurement write. Measured, not
 * chosen: about 8 MB with a hundred rows per statement, about 64 MB with a
 * thousand, on this fixture.
 */
const GROWTH_BUDGET_BYTES = 20 * 1024 * 1024;

const forceGc = ((): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

function liveHeapBytes(): number {
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

let backupId = "";

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: OWNER, username: OWNER, role: "ADMIN" },
  });
  const { encryptNote } = await import("@/lib/crypto/note-cipher");
  const note = Buffer.from(encryptNote("a note kept with a reading")!);
  // Apple Health's shape: an external id and a source version on every row,
  // ciphertext on one in twenty-five, a note on one in forty, and a recently
  // deleted row on one in two hundred. One statement, so the fixture costs
  // seconds rather than dominating the file.
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at, notes,
       notes_encrypted, external_id, external_source_version, device_type,
       created_at, updated_at, sync_version, deleted_at)
     SELECT
       'c' || lpad(to_hex(g), 24, '0'),
       $1,
       (ARRAY['PULSE', 'ACTIVITY_STEPS', 'ACTIVE_ENERGY_BURNED',
              'WALKING_RUNNING_DISTANCE'])[1 + (g % 4)]::measurement_type,
       60 + (g % 40),
       'count',
       'APPLE_HEALTH'::measurement_source,
       timestamp '2019-01-01 00:00:00' + (g * interval '47 seconds'),
       CASE WHEN g % 40 = 0 THEN 'a note recorded with reading ' || g END,
       CASE WHEN g % 25 = 0 THEN $2::bytea END,
       '5B3E1C2A-' || lpad(to_hex(g), 8, '0') || '-4A1F-9C3D-8E7F6A5B4C3D',
       '17.4',
       'Apple Watch',
       timestamp '2019-01-01 00:00:00' + (g * interval '47 seconds'),
       timestamp '2019-01-01 00:00:00' + (g * interval '47 seconds'),
       1,
       CASE WHEN g % 200 = 0 THEN now() - interval '1 day' END
     FROM generate_series(1, ${ROWS}) AS g`,
    OWNER,
    note,
  );
  const { storeBackupBlob } = await import("@/lib/export/store-backup-blob");
  const { streamFullBackupJson } =
    await import("@/lib/export/full-backup-stream");
  const stored = await storeBackupBlob(
    prisma,
    { userId: OWNER, type: "WEEKLY_AUTO" },
    (write) =>
      streamFullBackupJson(prisma, OWNER, write, {
        purpose: "disaster-recovery",
      }),
  );
  backupId = stored.id;
}, 240_000);

afterAll(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("backup restore under a memory budget (#1031)", () => {
  it("holds a bounded amount while it writes the measurements", async () => {
    const prisma = getPrismaClient();
    const { restoreBackup } = await import("@/lib/export/restore-backup");
    const { STORED_BACKUP_SELECT } = await import("@/lib/export/stored-backup");
    const backup = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: backupId },
      select: STORED_BACKUP_SELECT,
    });

    let anchor: number | null = null;
    let peak = 0;
    let lastWritten = 0;
    let samples = 0;
    const outcome = await restoreBackup({
      backup,
      actorUserId: OWNER,
      ipAddress: null,
      restoreInstanceSettings: false,
      // Called from inside the write, between two batches, which is where
      // anything the restore holds across batches is visible.
      progress: (phase, progress) => {
        if (phase !== "measurements") return;
        lastWritten = progress.measurementsWritten;
        if (anchor === null) {
          anchor = peak = liveHeapBytes();
          return;
        }
        samples++;
        peak = Math.max(peak, liveHeapBytes());
      },
    });

    expect(outcome.ok).toBe(true);
    expect(await prisma.measurement.count({ where: { userId: OWNER } })).toBe(
      ROWS,
    );
    // Not vacuous: the write was sampled, and sampled past the point where
    // the old statement size had filled the history.
    expect(anchor).not.toBeNull();
    expect(samples).toBeGreaterThan(5);
    expect(lastWritten).toBeGreaterThanOrEqual(120_000);

    const growth = peak - (anchor ?? 0);
    process.stderr.write(
      `[restore-memory] ${ROWS} readings: the heap grew by ${mb(growth)} MB ` +
        `during the measurement write (${samples} samples)\n`,
    );
    expect(
      growth,
      `the restore held ${mb(growth)} MB more while writing the measurements`,
    ).toBeLessThan(GROWTH_BUDGET_BYTES);
  }, 300_000);
});
