import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readNote } from "@/lib/crypto/note-cipher";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  decryptRouteGeometry,
  encryptRouteGeometry,
} from "@/lib/workouts/route-geometry-cipher";

// ── in-memory store backing a minimal prisma mock ──────────────────────────
interface ConversationRow {
  id: string;
  userId: string;
  title: string | null;
  titleEncrypted: Uint8Array | null;
  updatedAt?: Date;
}
interface EntryRow {
  id: string;
  userId: string;
  note: string | null;
  noteEncrypted: Uint8Array | null;
}
interface PractitionerRow {
  id: string;
  userId: string;
  phone: string | null;
  location: string | null;
  phoneEncrypted: Uint8Array | null;
  locationEncrypted: Uint8Array | null;
  updatedAt?: Date;
}
interface RouteRow {
  id: string;
  /** The owning workout's user; the real table reaches it through the join. */
  userId: string;
  geometry: unknown;
  geometryEncrypted: Uint8Array | null;
}

const store = vi.hoisted(() => ({
  conversations: [] as ConversationRow[],
  entries: [] as EntryRow[],
  practitioners: [] as PractitionerRow[],
  routes: [] as RouteRow[],
}));

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: () => null }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/db", () => {
  function delegate<R extends { id: string; userId: string }>(
    rows: () => R[],
    readable: Array<keyof R>,
  ) {
    return {
      // The handler pages on the owner plus "a readable column is set": the
      // user id directly, or through the workout for a route.
      findMany: async (args: {
        where: { userId?: string; workout?: { userId: string } };
        take: number;
      }) => {
        const userId = args.where.userId ?? args.where.workout?.userId;
        return rows()
          .filter(
            (r) => r.userId === userId && readable.some((k) => r[k] !== null),
          )
          .slice(0, args.take)
          .map((r) => ({ id: r.id }));
      },
      findUnique: async (args: { where: { id: string } }) =>
        rows().find((x) => x.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Partial<R> }) =>
        write(rows, args.where.id, args.data),
      // The storage-only rewrites match on the row's own `updatedAt` and
      // carry it forward; a row whose stamp moved meanwhile is not written.
      updateMany: async (args: {
        where: { id: string; updatedAt?: Date };
        data: Partial<R>;
      }) => {
        const r = rows().find((x) => x.id === args.where.id) as
          (R & { updatedAt?: Date }) | undefined;
        if (!r) return { count: 0 };
        if (
          args.where.updatedAt !== undefined &&
          r.updatedAt?.getTime() !== args.where.updatedAt?.getTime()
        ) {
          return { count: 0 };
        }
        write(rows, args.where.id, args.data);
        return { count: 1 };
      },
    };
  }
  function write<R extends { id: string }>(
    rows: () => R[],
    id: string,
    patch: Partial<R>,
  ): R {
    const r = rows().find((x) => x.id === id)!;
    // Prisma's DbNull sentinel stores SQL NULL; a Date is a real value.
    const data = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [
        k,
        v !== null &&
        typeof v === "object" &&
        !(v instanceof Uint8Array) &&
        !(v instanceof Date)
          ? null
          : v,
      ]),
    );
    Object.assign(r, data);
    return r;
  }
  const delegates = {
    coachConversation: delegate(() => store.conversations, ["title"]),
    customMetricEntry: delegate(() => store.entries, ["note"]),
    practitioner: delegate(() => store.practitioners, ["phone", "location"]),
    workoutRoute: delegate(() => store.routes, ["geometry"]),
  };
  return {
    prisma: {
      ...delegates,
      // Nothing to clear or scrub in this in-memory store; the real-Postgres
      // test covers both.
      measurementReminder: { updateMany: async () => ({ count: 0 }) },
      auditLog: { findMany: async () => [] },
      $transaction: async (fn: (tx: typeof delegates) => unknown) =>
        fn(delegates),
    },
  };
});

import {
  runFreeTextEncryptionBackfillForUser,
  scrubContactAuditDetails,
} from "@/lib/jobs/free-text-encryption-backfill";

const KEY = "a".repeat(64);
const TRACK = {
  type: "LineString",
  coordinates: [
    [13.4012, 52.5201],
    [13.4051, 52.5233],
  ],
};

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY);
  store.conversations = [
    {
      id: "c1",
      userId: "u1",
      title: "Why is my pressure up after the new tablets?",
      titleEncrypted: null,
      updatedAt: new Date("2026-03-02T09:15:00.000Z"),
    },
    // Already migrated: left alone.
    {
      id: "c2",
      userId: "u1",
      title: null,
      titleEncrypted: encryptToBytes("Sleep this week"),
    },
    { id: "c3", userId: "u2", title: "other user", titleEncrypted: null },
  ];
  store.entries = [
    {
      id: "e1",
      userId: "u1",
      note: "after the long ride",
      noteEncrypted: null,
    },
    { id: "e2", userId: "u1", note: null, noteEncrypted: null }, // no note
    // An empty legacy note is still a readable value; it migrates to "none".
    { id: "e3", userId: "u1", note: "", noteEncrypted: null },
    { id: "e4", userId: "u2", note: "other user", noteEncrypted: null },
  ];
  store.practitioners = [
    {
      id: "p1",
      userId: "u1",
      phone: "+49 30 1234567",
      location: "Hauptstr. 1, Berlin",
      phoneEncrypted: null,
      locationEncrypted: null,
    },
    // Only an address: the phone ciphertext column stays as it was.
    {
      id: "p2",
      userId: "u1",
      phone: null,
      location: "Am Markt 3",
      phoneEncrypted: null,
      locationEncrypted: null,
    },
    // Already sealed, nothing readable.
    {
      id: "p3",
      userId: "u1",
      phone: null,
      location: null,
      phoneEncrypted: encryptToBytes("+49 40 7654321"),
      locationEncrypted: null,
    },
    {
      id: "p4",
      userId: "u2",
      phone: "other user",
      location: null,
      phoneEncrypted: null,
      locationEncrypted: null,
    },
  ];
  store.routes = [
    { id: "r1", userId: "u1", geometry: TRACK, geometryEncrypted: null },
    {
      id: "r2",
      userId: "u1",
      geometry: null,
      geometryEncrypted: encryptRouteGeometry(TRACK),
    },
    { id: "r3", userId: "u2", geometry: TRACK, geometryEncrypted: null },
  ];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runFreeTextEncryptionBackfillForUser", () => {
  it("seals titles and notes, nulls the readable column, and reads back the same text", async () => {
    const summary = await runFreeTextEncryptionBackfillForUser("u1");

    expect(summary).toEqual({
      conversationTitlesMigrated: 1,
      metricNotesMigrated: 2,
      practitionerContactsMigrated: 2,
      routeGeometriesMigrated: 1,
      appointmentAddressesCleared: 0,
      contactAuditRowsScrubbed: 0,
    });

    const c1 = store.conversations.find((r) => r.id === "c1")!;
    expect(c1.title).toBeNull();
    expect(readNote(c1.titleEncrypted, null)).toBe(
      "Why is my pressure up after the new tablets?",
    );
    // Sealing a title is not activity: the Coach panel orders and groups by
    // updatedAt, so the conversation keeps the stamp it had.
    expect(c1.updatedAt).toEqual(new Date("2026-03-02T09:15:00.000Z"));

    const e1 = store.entries.find((r) => r.id === "e1")!;
    expect(e1.note).toBeNull();
    expect(readNote(e1.noteEncrypted, null)).toBe("after the long ride");

    const e3 = store.entries.find((r) => r.id === "e3")!;
    expect(e3.note).toBeNull();
    expect(e3.noteEncrypted).toBeNull();
  });

  it("keeps an already sealed row and a row without a note as they were", async () => {
    const before = store.conversations.find(
      (r) => r.id === "c2",
    )!.titleEncrypted;
    await runFreeTextEncryptionBackfillForUser("u1");
    const c2 = store.conversations.find((r) => r.id === "c2")!;
    expect(c2.titleEncrypted).toBe(before);
    const e2 = store.entries.find((r) => r.id === "e2")!;
    expect(e2).toMatchObject({ note: null, noteEncrypted: null });
  });

  it("seals the readable value when a row holds both, since only an older writer can have put it there", async () => {
    store.conversations[1].title = "Renamed by the previous release";
    await runFreeTextEncryptionBackfillForUser("u1");
    const c2 = store.conversations.find((r) => r.id === "c2")!;
    expect(c2.title).toBeNull();
    expect(readNote(c2.titleEncrypted, null)).toBe(
      "Renamed by the previous release",
    );
  });

  it("does not touch another account's rows", async () => {
    await runFreeTextEncryptionBackfillForUser("u1");
    expect(store.conversations.find((r) => r.id === "c3")).toMatchObject({
      title: "other user",
      titleEncrypted: null,
    });
    expect(store.entries.find((r) => r.id === "e4")).toMatchObject({
      note: "other user",
      noteEncrypted: null,
    });
  });

  it("seals practitioner phone numbers and addresses and nulls the readable columns", async () => {
    await runFreeTextEncryptionBackfillForUser("u1");
    const p1 = store.practitioners.find((r) => r.id === "p1")!;
    expect(p1).toMatchObject({ phone: null, location: null });
    expect(readNote(p1.phoneEncrypted, null)).toBe("+49 30 1234567");
    expect(readNote(p1.locationEncrypted, null)).toBe("Hauptstr. 1, Berlin");
    const p2 = store.practitioners.find((r) => r.id === "p2")!;
    expect(p2.location).toBeNull();
    expect(p2.phoneEncrypted).toBeNull();
    expect(readNote(p2.locationEncrypted, null)).toBe("Am Markt 3");
    const p3Before = store.practitioners.find(
      (r) => r.id === "p3",
    )!.phoneEncrypted;
    expect(store.practitioners.find((r) => r.id === "p3")!.phoneEncrypted).toBe(
      p3Before,
    );
    expect(store.practitioners.find((r) => r.id === "p4")).toMatchObject({
      phone: "other user",
      phoneEncrypted: null,
    });
  });

  it("seals workout GPS tracks through the workout's owner and nulls the readable column", async () => {
    const r2Before = store.routes.find((r) => r.id === "r2")!.geometryEncrypted;
    await runFreeTextEncryptionBackfillForUser("u1");
    const r1 = store.routes.find((r) => r.id === "r1")!;
    expect(r1.geometry).toBeNull();
    expect(decryptRouteGeometry(r1.geometryEncrypted!)).toEqual(TRACK);
    expect(store.routes.find((r) => r.id === "r2")!.geometryEncrypted).toBe(
      r2Before,
    );
    expect(store.routes.find((r) => r.id === "r3")).toMatchObject({
      geometry: TRACK,
      geometryEncrypted: null,
    });
  });

  it("is idempotent: a second run changes nothing", async () => {
    await runFreeTextEncryptionBackfillForUser("u1");
    const sealed = store.conversations.find(
      (r) => r.id === "c1",
    )!.titleEncrypted;
    const second = await runFreeTextEncryptionBackfillForUser("u1");
    expect(second).toEqual({
      conversationTitlesMigrated: 0,
      metricNotesMigrated: 0,
      practitionerContactsMigrated: 0,
      routeGeometriesMigrated: 0,
      appointmentAddressesCleared: 0,
      contactAuditRowsScrubbed: 0,
    });
    expect(store.conversations.find((r) => r.id === "c1")!.titleEncrypted).toBe(
      sealed,
    );
  });

  it("is fail-closed: without a key every readable row stays intact", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("ENCRYPTION_KEYS", "");
    await expect(runFreeTextEncryptionBackfillForUser("u1")).rejects.toThrow();
    expect(store.conversations.find((r) => r.id === "c1")).toMatchObject({
      title: "Why is my pressure up after the new tablets?",
      titleEncrypted: null,
    });
  });
});

describe("scrubContactAuditDetails", () => {
  it("removes the phone number and address from previous and keeps them named", () => {
    const out = scrubContactAuditDetails(
      JSON.stringify({
        practitionerId: "p1",
        fields: ["location", "name"],
        previous: { location: "Hauptstr. 1", name: "Alt", phone: "+49 30 1" },
      }),
    );
    expect(JSON.parse(out!)).toEqual({
      practitionerId: "p1",
      fields: ["location", "name", "phone"],
      previous: { name: "Alt" },
    });
  });

  it("leaves a row without contact values, or that is not this JSON, alone", () => {
    expect(
      scrubContactAuditDetails(
        JSON.stringify({ fields: ["location"], previous: {} }),
      ),
    ).toBeNull();
    expect(scrubContactAuditDetails("not json")).toBeNull();
    expect(scrubContactAuditDetails(null)).toBeNull();
  });
});
