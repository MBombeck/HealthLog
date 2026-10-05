/**
 * v1.23 — free-text health-note encryption backfill (real Postgres).
 *
 * Seeds legacy plaintext rows (note in the plaintext column, ciphertext null),
 * runs the per-user backfill, and asserts:
 *   - the plaintext is encrypted into `*Encrypted` and the plaintext column is
 *     nulled, in one transaction (no row left both-null when it had content);
 *   - the ciphertext decrypts back to the original (no data loss);
 *   - a note-less row is untouched;
 *   - a second run is a no-op (idempotent).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { readNote } from "@/lib/crypto/note-cipher";
import { runNoteEncryptionBackfillForUser } from "@/lib/jobs/note-encryption-backfill";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-note-backfill";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "note-backfill",
      email: "note-backfill@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("note-encryption backfill (real Postgres)", () => {
  it("migrates legacy plaintext notes to ciphertext and nulls the plaintext", async () => {
    const prisma = getPrismaClient();
    // Legacy rows: plaintext present, ciphertext null (the pre-v1.23 shape).
    const withNote = await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-05-16T08:00:00.000Z"),
        notes: "felt dizzy after",
        updatedAt: new Date("2026-05-16T08:05:00.000Z"),
      },
    });
    const noNote = await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 81,
        unit: "kg",
        measuredAt: new Date("2026-05-17T08:00:00.000Z"),
        notes: null,
      },
    });
    const mood = await prisma.moodEntry.create({
      data: {
        userId: TEST_USER_ID,
        date: "2026-05-16",
        tz: "Europe/Berlin",
        mood: "OKAY",
        score: 3,
        moodLoggedAt: new Date("2026-05-16T08:00:00.000Z"),
        note: "rough night",
        updatedAt: new Date("2026-05-16T08:06:00.000Z"),
      },
    });

    const summary = await runNoteEncryptionBackfillForUser(TEST_USER_ID);
    expect(summary.measurementsMigrated).toBe(1);
    expect(summary.moodEntriesMigrated).toBe(1);

    const m = await prisma.measurement.findUnique({
      where: { id: withNote.id },
    });
    expect(m?.notes).toBeNull();
    expect(m?.notesEncrypted).not.toBeNull();
    expect(readNote(m?.notesEncrypted ?? null, null)).toBe("felt dizzy after");

    const untouched = await prisma.measurement.findUnique({
      where: { id: noNote.id },
    });
    expect(untouched?.notes).toBeNull();
    expect(untouched?.notesEncrypted).toBeNull();

    const x = await prisma.moodEntry.findUnique({ where: { id: mood.id } });
    expect(x?.note).toBeNull();
    expect(readNote(x?.noteEncrypted ?? null, null)).toBe("rough night");

    // updatedAt is the sync cursor: moving a note into ciphertext changes
    // nothing a client reads, so neither row takes a new stamp.
    expect(m?.updatedAt).toEqual(new Date("2026-05-16T08:05:00.000Z"));
    expect(x?.updatedAt).toEqual(new Date("2026-05-16T08:06:00.000Z"));
  });

  it("is idempotent: a second run migrates zero rows and preserves the data", async () => {
    const prisma = getPrismaClient();
    const row = await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-05-16T08:00:00.000Z"),
        notes: "side effect note",
      },
    });

    await runNoteEncryptionBackfillForUser(TEST_USER_ID);
    const first = await prisma.measurement.findUnique({
      where: { id: row.id },
    });
    const firstCipher = Buffer.from(first?.notesEncrypted ?? new Uint8Array());

    const second = await runNoteEncryptionBackfillForUser(TEST_USER_ID);
    expect(second.measurementsMigrated).toBe(0);

    const after = await prisma.measurement.findUnique({
      where: { id: row.id },
    });
    // Same ciphertext, plaintext still null, note still recoverable.
    expect(Buffer.from(after?.notesEncrypted ?? new Uint8Array())).toEqual(
      firstCipher,
    );
    expect(after?.notes).toBeNull();
    expect(readNote(after?.notesEncrypted ?? null, null)).toBe(
      "side effect note",
    );
  });
});
