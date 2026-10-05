import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readNote } from "@/lib/crypto/note-cipher";

// ── in-memory store backing a minimal prisma mock ──────────────────────────
interface SideEffectRow {
  id: string;
  userId: string;
  notes: string | null;
  notesEncrypted: Uint8Array | null;
}
interface DoseChangeRow {
  id: string;
  // Dose-changes carry no userId column — ownership is the parent medication's.
  medicationUserId: string;
  note: string | null;
  noteEncrypted: Uint8Array | null;
}
interface InventoryRow {
  id: string;
  userId: string;
  notes: string | null;
  notesEncrypted: Uint8Array | null;
  updatedAt?: Date;
}

const store = vi.hoisted(() => ({
  sideEffects: [] as SideEffectRow[],
  doseChanges: [] as DoseChangeRow[],
  inventory: [] as InventoryRow[],
}));

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: () => null }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/db", () => {
  const delegates = {
    medicationSideEffect: {
      findMany: async (args: { where: { userId: string }; take: number }) =>
        store.sideEffects
          .filter(
            (r) =>
              r.userId === args.where.userId &&
              r.notes !== null &&
              r.notesEncrypted === null,
          )
          .slice(0, args.take)
          .map((r) => ({ id: r.id })),
      findUnique: async (args: { where: { id: string } }) => {
        const r = store.sideEffects.find((x) => x.id === args.where.id);
        return r ? { notes: r.notes, notesEncrypted: r.notesEncrypted } : null;
      },
      update: async (args: {
        where: { id: string };
        data: { notes: string | null; notesEncrypted: Uint8Array | null };
      }) => {
        const r = store.sideEffects.find((x) => x.id === args.where.id)!;
        r.notes = args.data.notes;
        r.notesEncrypted = args.data.notesEncrypted;
        return r;
      },
    },
    medicationDoseChange: {
      findMany: async (args: {
        where: { medication: { userId: string } };
        take: number;
      }) =>
        store.doseChanges
          .filter(
            (r) =>
              r.medicationUserId === args.where.medication.userId &&
              r.note !== null &&
              r.noteEncrypted === null,
          )
          .slice(0, args.take)
          .map((r) => ({ id: r.id })),
      findUnique: async (args: { where: { id: string } }) => {
        const r = store.doseChanges.find((x) => x.id === args.where.id);
        return r ? { note: r.note, noteEncrypted: r.noteEncrypted } : null;
      },
      update: async (args: {
        where: { id: string };
        data: { note: string | null; noteEncrypted: Uint8Array | null };
      }) => {
        const r = store.doseChanges.find((x) => x.id === args.where.id)!;
        r.note = args.data.note;
        r.noteEncrypted = args.data.noteEncrypted;
        return r;
      },
    },
    medicationInventoryItem: {
      findMany: async (args: { where: { userId: string }; take: number }) =>
        store.inventory
          .filter(
            (r) =>
              r.userId === args.where.userId &&
              r.notes !== null &&
              r.notesEncrypted === null,
          )
          .slice(0, args.take)
          .map((r) => ({ id: r.id })),
      findUnique: async (args: { where: { id: string } }) => {
        const r = store.inventory.find((x) => x.id === args.where.id);
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
        const r = store.inventory.find((x) => x.id === args.where.id);
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
  };
  const prisma = {
    ...delegates,
    $transaction: async (fn: (tx: typeof delegates) => unknown) =>
      fn(delegates),
  };
  return { prisma };
});

import { runMedNotesEncryptionBackfillForUser } from "@/lib/jobs/med-notes-encryption-backfill";

const KEY = "a".repeat(64);

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY);
  store.sideEffects = [
    { id: "se1", userId: "u1", notes: "felt dizzy", notesEncrypted: null },
    { id: "se2", userId: "u1", notes: null, notesEncrypted: null }, // no note
    { id: "se3", userId: "u2", notes: "other user", notesEncrypted: null },
  ];
  store.doseChanges = [
    {
      id: "dc1",
      medicationUserId: "u1",
      note: "stepped up to 7.5mg",
      noteEncrypted: null,
    },
    {
      id: "dc2",
      medicationUserId: "u2",
      note: "other user dose note",
      noteEncrypted: null,
    },
  ];
  store.inventory = [
    {
      id: "i1",
      userId: "u1",
      notes: "opened pen #2",
      notesEncrypted: null,
      updatedAt: new Date("2026-01-12T10:00:00.000Z"),
    },
    {
      id: "i2",
      userId: "u1",
      notes: null,
      notesEncrypted: new Uint8Array(0), // already migrated-ish; left alone
    },
  ];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runMedNotesEncryptionBackfillForUser", () => {
  it("encrypts plaintext notes, nulls the plaintext, and round-trips each table", async () => {
    const summary = await runMedNotesEncryptionBackfillForUser("u1");

    expect(summary.sideEffectsMigrated).toBe(1);
    expect(summary.doseChangesMigrated).toBe(1);
    expect(summary.inventoryItemsMigrated).toBe(1);

    const se1 = store.sideEffects.find((r) => r.id === "se1")!;
    expect(se1.notes).toBeNull();
    expect(readNote(se1.notesEncrypted, null)).toBe("felt dizzy");

    const dc1 = store.doseChanges.find((r) => r.id === "dc1")!;
    expect(dc1.note).toBeNull();
    expect(readNote(dc1.noteEncrypted, null)).toBe("stepped up to 7.5mg");

    const i1 = store.inventory.find((r) => r.id === "i1")!;
    expect(i1.notes).toBeNull();
    expect(readNote(i1.notesEncrypted, null)).toBe("opened pen #2");
    // A storage-only rewrite keeps the row's own updatedAt.
    expect(i1.updatedAt).toEqual(new Date("2026-01-12T10:00:00.000Z"));
  });

  it("leaves note-less rows untouched and never writes a both-null content row", async () => {
    await runMedNotesEncryptionBackfillForUser("u1");
    const se2 = store.sideEffects.find((r) => r.id === "se2")!;
    expect(se2.notes).toBeNull();
    expect(se2.notesEncrypted).toBeNull();
  });

  it("does not touch another user's rows (incl. dose-changes via the parent medication)", async () => {
    await runMedNotesEncryptionBackfillForUser("u1");
    const se3 = store.sideEffects.find((r) => r.id === "se3")!;
    expect(se3.notes).toBe("other user");
    expect(se3.notesEncrypted).toBeNull();
    const dc2 = store.doseChanges.find((r) => r.id === "dc2")!;
    expect(dc2.note).toBe("other user dose note");
    expect(dc2.noteEncrypted).toBeNull();
  });

  it("is idempotent: a second run migrates zero rows and keeps the ciphertext", async () => {
    await runMedNotesEncryptionBackfillForUser("u1");
    const se1First = store.sideEffects.find(
      (r) => r.id === "se1",
    )!.notesEncrypted;

    const second = await runMedNotesEncryptionBackfillForUser("u1");
    expect(second.sideEffectsMigrated).toBe(0);
    expect(second.doseChangesMigrated).toBe(0);
    expect(second.inventoryItemsMigrated).toBe(0);

    const se1 = store.sideEffects.find((r) => r.id === "se1")!;
    expect(se1.notesEncrypted).toBe(se1First);
    expect(se1.notes).toBeNull();
    expect(readNote(se1.notesEncrypted, null)).toBe("felt dizzy");
  });

  it("is fail-closed: a key error leaves every plaintext row intact (no data loss)", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("ENCRYPTION_KEYS", "");
    await expect(runMedNotesEncryptionBackfillForUser("u1")).rejects.toThrow();
    const se1 = store.sideEffects.find((r) => r.id === "se1")!;
    expect(se1.notes).toBe("felt dizzy");
    expect(se1.notesEncrypted).toBeNull();
  });
});
