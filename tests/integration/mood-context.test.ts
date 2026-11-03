/**
 * v1.38 — the day context on a mood entry, against real Postgres and the real
 * handlers.
 *
 * The claims that matter here are all about ABSENCE, which is the part a unit
 * test with a mocked client cannot make honestly:
 *
 *   - an entry whose sections were never opened stores NO context row;
 *   - one filled field stores one row with that field set and every other
 *     column NULL, not a row of defaulted middles;
 *   - re-posting the same `externalId` updates the context in place rather
 *     than accumulating rows or leaving a stale one behind;
 *   - the note goes in through `encryptNote` and comes back through
 *     `readNote`, with no plaintext column holding it;
 *   - a value outside the vocabulary is a 422 carrying every issue, not a
 *     silently dropped field.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readNote } from "@/lib/crypto/note-cipher";
import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-mood-context";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "mood-context",
      email: "mood-context@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

function postRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("mood context write path (real Postgres)", () => {
  it("stores no context row for an entry that carries none", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const res = await POST(
      postRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-16T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(201);
    expect(await getPrismaClient().moodContext.count()).toBe(0);
  });

  it("stores no context row for an empty context object", async () => {
    // A client that renders the sections and sends them back untouched has
    // said the same thing as one that sent nothing at all. A row of NULLs
    // would record "asked and answered nothing" where the truth is
    // "never asked".
    const { POST } = await import("@/app/api/mood-entries/route");
    const res = await POST(
      postRequest("/api/mood-entries", {
        mood: "OKAY",
        moodLoggedAt: "2026-05-16T09:00:00.000Z",
        context: { contactCircles: [], leisureCategories: [], note: "" },
      }),
    );
    expect(res.status).toBe(201);
    expect(await getPrismaClient().moodContext.count()).toBe(0);
  });

  it("stores exactly the one field that was filled, everything else NULL", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const res = await POST(
      postRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-16T10:00:00.000Z",
        context: { workStatus: "regular" },
      }),
    );
    expect(res.status).toBe(201);

    const rows = await getPrismaClient().moodContext.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.userId).toBe(TEST_USER_ID);
    expect(row.workStatus).toBe("regular");
    expect(row.workMinutes).toBeNull();
    expect(row.workLoad).toBeNull();
    expect(row.contactCircles).toBeNull();
    expect(row.contactQuality).toBeNull();
    expect(row.leisureCategories).toBeNull();
    expect(row.eventType).toBeNull();
    expect(row.eventValence).toBeNull();
    expect(row.eventAt).toBeNull();
    expect(row.notesEncrypted).toBeNull();
  });

  it("round-trips every section, with a zero that stays a zero", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const res = await POST(
      postRequest("/api/mood-entries", {
        mood: "SCHLECHT",
        moodLoggedAt: "2026-05-16T11:00:00.000Z",
        context: {
          workStatus: "overtime",
          workMinutes: 540,
          overtimeMinutes: 90,
          workLoad: 9,
          // Zero is a real answer. A carrier that treated it as absence would
          // round-trip it to NULL and pass every truthy check on the way.
          workSatisfaction: 0,
          contactCircles: ["partner", "colleagues"],
          contactForm: "inPerson",
          contactExtent: "brief",
          contactQuality: 6,
          contactSupport: 4,
          leisureCategories: ["reading"],
          leisureMinutes: 45,
          leisureJoy: 7,
          leisureRecovery: 5,
          eventType: "conflict",
          eventValence: -3,
          eventAt: "2026-05-16T16:30:00.000Z",
          note: "Long meeting ran over.",
        },
      }),
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      data: { context: Record<string, unknown> };
    };
    expect(body.data.context).toMatchObject({
      workStatus: "overtime",
      workSatisfaction: 0,
      contactCircles: ["partner", "colleagues"],
      leisureCategories: ["reading"],
      eventValence: -3,
      note: "Long meeting ran over.",
    });

    const row = await getPrismaClient().moodContext.findFirstOrThrow();
    expect(row.workMinutes).toBe(540);
    expect(row.overtimeMinutes).toBe(90);
    expect(row.workLoad).toBe(9);
    expect(row.workSatisfaction).toBe(0);
    expect(row.contactCircles).toBe('["partner","colleagues"]');
    expect(row.leisureCategories).toBe('["reading"]');
    expect(row.eventAt?.toISOString()).toBe("2026-05-16T16:30:00.000Z");
    // The note is bytes at rest and decrypts back to the same text; nothing
    // on this table holds it in the clear.
    expect(row.notesEncrypted).not.toBeNull();
    expect(readNote(row.notesEncrypted, null)).toBe("Long meeting ran over.");
    expect(JSON.stringify(row)).not.toContain("Long meeting ran over.");
  });

  it("re-posting the same externalId updates the context in place", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const first = await POST(
      postRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-17T08:00:00.000Z",
        externalId: "ios-row-4711",
        context: { workStatus: "regular", workLoad: 5 },
      }),
    );
    expect(first.status).toBe(201);

    const second = await POST(
      postRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-17T08:00:00.000Z",
        externalId: "ios-row-4711",
        context: { workStatus: "overtime" },
      }),
    );
    expect(second.status).toBe(201);

    const rows = await getPrismaClient().moodContext.findMany();
    expect(rows).toHaveLength(1);
    // The write replaces the context whole: the capture surface always sends
    // the sections it is showing, so a field the payload omits is one the
    // person cleared.
    expect(rows[0].workStatus).toBe("overtime");
    expect(rows[0].workLoad).toBeNull();
  });

  it("leaves a stored context alone when a re-post carries none", async () => {
    // The phone. Its build has no context surface, so it re-posts the entry
    // without one — and that must not blank what somebody filled in on the
    // web.
    const { POST } = await import("@/app/api/mood-entries/route");
    await POST(
      postRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-18T08:00:00.000Z",
        externalId: "ios-row-4712",
        context: { leisureCategories: ["music"], leisureJoy: 8 },
      }),
    );
    await POST(
      postRequest("/api/mood-entries", {
        mood: "SUPER_GUT",
        moodLoggedAt: "2026-05-18T08:00:00.000Z",
        externalId: "ios-row-4712",
      }),
    );

    const rows = await getPrismaClient().moodContext.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].leisureCategories).toBe('["music"]');
    expect(rows[0].leisureJoy).toBe(8);
  });

  it("PUT replaces the context and an explicit null removes the row", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const created = await POST(
      postRequest("/api/mood-entries", {
        mood: "OKAY",
        moodLoggedAt: "2026-05-19T08:00:00.000Z",
        context: { eventType: "goodNews", eventValence: 4 },
      }),
    );
    const { data } = (await created.json()) as { data: { id: string } };

    const { PUT } = await import("@/app/api/mood-entries/[id]/route");
    const replaced = await PUT(
      putRequest(`/api/mood-entries/${data.id}`, {
        context: { eventType: "appointment", note: "Dentist." },
      }),
      { params: Promise.resolve({ id: data.id }) },
    );
    expect(replaced.status).toBe(200);
    const afterReplace = await getPrismaClient().moodContext.findFirstOrThrow();
    expect(afterReplace.eventType).toBe("appointment");
    expect(afterReplace.eventValence).toBeNull();
    expect(readNote(afterReplace.notesEncrypted, null)).toBe("Dentist.");

    const cleared = await PUT(
      putRequest(`/api/mood-entries/${data.id}`, { context: null }),
      { params: Promise.resolve({ id: data.id }) },
    );
    expect(cleared.status).toBe(200);
    expect(await getPrismaClient().moodContext.count()).toBe(0);
  });

  it("the GET surfaces the stored context on the entry", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const created = await POST(
      postRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-20T08:00:00.000Z",
        context: { contactCircles: ["family"], contactQuality: 9 },
      }),
    );
    const { data } = (await created.json()) as { data: { id: string } };

    const { GET } = await import("@/app/api/mood-entries/[id]/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/mood-entries/${data.id}`),
      { params: Promise.resolve({ id: data.id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { context: { contactCircles: string[]; contactQuality: number } };
    };
    expect(body.data.context.contactCircles).toEqual(["family"]);
    expect(body.data.context.contactQuality).toBe(9);
  });

  it("refuses a value the vocabulary does not name, reporting every issue", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const res = await POST(
      postRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-21T08:00:00.000Z",
        context: {
          workStatus: "sabbatical",
          workLoad: 42,
          contactCircles: ["pets"],
        },
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; meta?: unknown };
    expect(body.error).toBeTruthy();
    expect(await getPrismaClient().moodContext.count()).toBe(0);
    // The entry rolls back with it: a refused context is a refused request,
    // not a half-saved one.
    expect(await getPrismaClient().moodEntry.count()).toBe(0);
  });

  it("the bulk path stores a context and skips only the entry that is wrong", async () => {
    // The contract this endpoint states in its own description: a bad row is
    // skipped and the batch lands. A phone draining a year of local history
    // must not lose the year to one row carrying a retired key.
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const res = await POST(
      postRequest("/api/mood-entries/bulk", {
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-23T08:00:00.000Z",
            externalId: "ios-bulk-1",
            a2: 6,
            context: { workStatus: "partial", workMinutes: 240 },
          },
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-23T12:00:00.000Z",
            externalId: "ios-bulk-2",
            context: { workStatus: "sabbatical" },
          },
          {
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-23T18:00:00.000Z",
            externalId: "ios-bulk-3",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        inserted: number;
        skipped: Array<{ index: number; reason: string }>;
      };
    };
    expect(body.data.inserted).toBe(2);
    expect(body.data.skipped).toEqual([
      { index: 1, reason: "invalid_context" },
    ]);

    const entries = await getPrismaClient().moodEntry.findMany({
      orderBy: { moodLoggedAt: "asc" },
      include: { context: true },
    });
    expect(entries).toHaveLength(2);
    // The good row landed whole: the level-A value it sent, the derived one it
    // did not, and its context.
    expect(entries[0].stressA2).toBe(6);
    expect(entries[0].moodA1).toBe(7);
    expect(entries[0].context?.workStatus).toBe("partial");
    expect(entries[0].context?.workMinutes).toBe(240);
    // The row that carried no context has none, rather than an empty one.
    expect(entries[1].context).toBeNull();
    expect(entries[1].moodA1).toBe(9);
  });

  it("the bulk path skips an out-of-range dimension without failing the batch", async () => {
    // The endpoint's own description promises that a bad value marks THAT
    // entry skipped and never the batch. `a1`..`a5` sat in the batch schema
    // and 422'd all of it, so the words and the behaviour disagreed.
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const res = await POST(
      postRequest("/api/mood-entries/bulk", {
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-25T08:00:00.000Z",
            externalId: "ios-dim-1",
            a3: 7,
          },
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-25T12:00:00.000Z",
            externalId: "ios-dim-2",
            a1: 11,
          },
          {
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-25T18:00:00.000Z",
            externalId: "ios-dim-3",
          },
        ],
      }),
    );
    // Not 422: one bad row must not cost the other two.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        inserted: number;
        skipped: Array<{ index: number; reason: string }>;
      };
    };
    expect(body.data.inserted).toBe(2);
    expect(body.data.skipped).toEqual([
      { index: 1, reason: "invalid_dimensions" },
    ]);

    const entries = await getPrismaClient().moodEntry.findMany({
      orderBy: { moodLoggedAt: "asc" },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].energyA3).toBe(7);
    expect(entries[1].moodA1).toBe(9);
  });

  it("the sync feed carries both levels under the keys the write path takes", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    await POST(
      postRequest("/api/mood-entries", {
        mood: "SCHLECHT",
        moodLoggedAt: "2026-05-24T08:00:00.000Z",
        a2: 8,
        context: {
          eventType: "badNews",
          eventValence: -4,
          note: "Called in the afternoon.",
        },
      }),
    );

    const { GET } = await import("@/app/api/sync/changes/route");
    const res = await GET(new NextRequest("http://localhost/api/sync/changes"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        changes: {
          mood: {
            upserts: Array<{
              a1: number | null;
              a2: number | null;
              a5: number | null;
              context: {
                eventType: string | null;
                eventValence: number | null;
                note: string | null;
                contactCircles: string[];
              } | null;
            }>;
          };
        };
      };
    };
    const upsert = body.data.changes.mood.upserts[0];
    // Derived server-side, so a client that sent only a label still mirrors a
    // complete row.
    expect(upsert.a1).toBe(3);
    expect(upsert.a2).toBe(8);
    // Untouched dimensions stay absent rather than arriving as a middle value.
    expect(upsert.a5).toBeNull();
    expect(upsert.context?.eventType).toBe("badNews");
    expect(upsert.context?.eventValence).toBe(-4);
    // The note is decrypted for the client; the ciphertext never rides.
    expect(upsert.context?.note).toBe("Called in the afternoon.");
    expect(upsert.context?.contactCircles).toEqual([]);
    expect(JSON.stringify(upsert)).not.toContain("notesEncrypted");
  });

  it("deleting the entry takes its context with it", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const created = await POST(
      postRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-22T08:00:00.000Z",
        context: { workStatus: "off" },
      }),
    );
    const { data } = (await created.json()) as { data: { id: string } };
    expect(await getPrismaClient().moodContext.count()).toBe(1);

    // A user-facing DELETE is a tombstone, so the context stays with the row
    // it describes; a hard delete cascades.
    await getPrismaClient().moodEntry.delete({ where: { id: data.id } });
    expect(await getPrismaClient().moodContext.count()).toBe(0);
  });
});
