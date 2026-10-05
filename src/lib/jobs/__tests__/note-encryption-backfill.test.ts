import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readNote } from "@/lib/crypto/note-cipher";

// ── in-memory store backing a minimal prisma mock ──────────────────────────
interface MeasRow {
  id: string;
  userId: string;
  notes: string | null;
  notesEncrypted: Uint8Array | null;
  updatedAt?: Date;
}
interface MoodRow {
  id: string;
  userId: string;
  note: string | null;
  noteEncrypted: Uint8Array | null;
  updatedAt?: Date;
}

const store = vi.hoisted(() => ({
  measurements: [] as MeasRow[],
  mood: [] as MoodRow[],
}));

// A `notes`/`note` write that is meant to throw on encrypt (simulates a
// fail-closed key error) so we can assert no data loss.
const fail = vi.hoisted(() => ({ encryptThrows: false }));

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: () => null }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/db", () => {
  // `delegates` is fully typed before `$transaction` closes over it, so the
  // interactive-transaction mock has no self-referential `typeof prisma`.
  const delegates = {
    measurement: {
      findMany: async (args: { where: { userId: string }; take: number }) =>
        store.measurements
          .filter(
            (r) =>
              r.userId === args.where.userId &&
              r.notes !== null &&
              r.notesEncrypted === null,
          )
          .slice(0, args.take)
          .map((r) => ({ id: r.id })),
      findUnique: async (args: { where: { id: string } }) => {
        const r = store.measurements.find((x) => x.id === args.where.id);
        return r
          ? {
              notes: r.notes,
              notesEncrypted: r.notesEncrypted,
              updatedAt: r.updatedAt,
            }
          : null;
      },
      updateMany: async (args: {
        where: { id: string; updatedAt?: Date };
        data: {
          notes: string | null;
          notesEncrypted: Uint8Array | null;
          updatedAt?: Date;
        };
      }) => {
        const r = store.measurements.find((x) => x.id === args.where.id);
        if (!r || r.updatedAt?.getTime() !== args.where.updatedAt?.getTime()) {
          return { count: 0 };
        }
        r.notes = args.data.notes;
        r.notesEncrypted = args.data.notesEncrypted;
        // Prisma stamps now unless the write names the column.
        r.updatedAt = args.data.updatedAt ?? new Date();
        return { count: 1 };
      },
    },
    moodEntry: {
      findMany: async (args: { where: { userId: string }; take: number }) =>
        store.mood
          .filter(
            (r) =>
              r.userId === args.where.userId &&
              r.note !== null &&
              r.noteEncrypted === null,
          )
          .slice(0, args.take)
          .map((r) => ({ id: r.id })),
      findUnique: async (args: { where: { id: string } }) => {
        const r = store.mood.find((x) => x.id === args.where.id);
        return r
          ? {
              note: r.note,
              noteEncrypted: r.noteEncrypted,
              updatedAt: r.updatedAt,
            }
          : null;
      },
      updateMany: async (args: {
        where: { id: string; updatedAt?: Date };
        data: {
          note: string | null;
          noteEncrypted: Uint8Array | null;
          updatedAt?: Date;
        };
      }) => {
        const r = store.mood.find((x) => x.id === args.where.id);
        if (!r || r.updatedAt?.getTime() !== args.where.updatedAt?.getTime()) {
          return { count: 0 };
        }
        r.note = args.data.note;
        r.noteEncrypted = args.data.noteEncrypted;
        r.updatedAt = args.data.updatedAt ?? new Date();
        return { count: 1 };
      },
    },
  };
  const prisma = {
    ...delegates,
    $transaction: async (fn: (tx: typeof delegates) => unknown) =>
      fn(delegates),
  };
  return { prisma };
});

import { runNoteEncryptionBackfillForUser } from "@/lib/jobs/note-encryption-backfill";

const KEY = "a".repeat(64);

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY);
  store.measurements = [
    {
      id: "m1",
      userId: "u1",
      notes: "felt dizzy",
      notesEncrypted: null,
      updatedAt: new Date("2026-02-01T07:00:00.000Z"),
    },
    { id: "m2", userId: "u1", notes: null, notesEncrypted: null }, // no note
    {
      id: "m3",
      userId: "u1",
      notes: null,
      notesEncrypted: new Uint8Array(0), // already migrated-ish; left alone
    },
  ];
  store.mood = [
    {
      id: "x1",
      userId: "u1",
      note: "rough night",
      noteEncrypted: null,
      updatedAt: new Date("2026-02-03T22:00:00.000Z"),
    },
    { id: "x2", userId: "u2", note: "other user", noteEncrypted: null },
  ];
  fail.encryptThrows = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runNoteEncryptionBackfillForUser", () => {
  it("encrypts the plaintext note, nulls the plaintext, and round-trips", async () => {
    const summary = await runNoteEncryptionBackfillForUser("u1");

    expect(summary.measurementsMigrated).toBe(1);
    expect(summary.moodEntriesMigrated).toBe(1);

    const m1 = store.measurements.find((r) => r.id === "m1")!;
    expect(m1.notes).toBeNull();
    expect(m1.notesEncrypted).not.toBeNull();
    // No data loss: the ciphertext decrypts back to the original.
    expect(readNote(m1.notesEncrypted, null)).toBe("felt dizzy");

    const x1 = store.mood.find((r) => r.id === "x1")!;
    expect(x1.note).toBeNull();
    expect(readNote(x1.noteEncrypted, null)).toBe("rough night");

    // updatedAt is the sync cursor: a storage-only rewrite keeps it.
    expect(m1.updatedAt).toEqual(new Date("2026-02-01T07:00:00.000Z"));
    expect(x1.updatedAt).toEqual(new Date("2026-02-03T22:00:00.000Z"));
  });

  it("leaves note-less rows untouched and never writes a both-null content row", async () => {
    await runNoteEncryptionBackfillForUser("u1");
    const m2 = store.measurements.find((r) => r.id === "m2")!;
    expect(m2.notes).toBeNull();
    expect(m2.notesEncrypted).toBeNull(); // never had content -> nothing written
  });

  it("does not touch another user's rows", async () => {
    await runNoteEncryptionBackfillForUser("u1");
    const x2 = store.mood.find((r) => r.id === "x2")!;
    expect(x2.note).toBe("other user");
    expect(x2.noteEncrypted).toBeNull();
  });

  it("is idempotent: a second run migrates zero rows and keeps one ciphertext", async () => {
    await runNoteEncryptionBackfillForUser("u1");
    const m1First = store.measurements.find(
      (r) => r.id === "m1",
    )!.notesEncrypted;

    const second = await runNoteEncryptionBackfillForUser("u1");
    expect(second.measurementsMigrated).toBe(0);
    expect(second.moodEntriesMigrated).toBe(0);

    const m1 = store.measurements.find((r) => r.id === "m1")!;
    // Unchanged ciphertext, plaintext still null, value still recoverable.
    expect(m1.notesEncrypted).toBe(m1First);
    expect(m1.notes).toBeNull();
    expect(readNote(m1.notesEncrypted, null)).toBe("felt dizzy");
  });

  it("is fail-closed: a key error leaves the plaintext row intact (no data loss)", async () => {
    // Unset every key so encryptNote throws inside the per-row transaction.
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("ENCRYPTION_KEYS", "");
    await expect(runNoteEncryptionBackfillForUser("u1")).rejects.toThrow();
    const m1 = store.measurements.find((r) => r.id === "m1")!;
    // The transaction rolled back: plaintext preserved, no ciphertext written.
    expect(m1.notes).toBe("felt dizzy");
    expect(m1.notesEncrypted).toBeNull();
  });
});
