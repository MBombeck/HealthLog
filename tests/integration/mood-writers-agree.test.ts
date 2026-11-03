/**
 * v1.37 — every mood writer resolves the same pleasantness value.
 *
 * Five paths write a `MoodEntry`, and only one of them is the web form. If
 * the derivation lived at the call site, a mood tapped in a chat and the same
 * mood typed into the form would drift apart the first time one of the five
 * was edited without the others. This test posts the identical mood through
 * all five and asserts the rows agree, against real Postgres and the real
 * handlers:
 *
 *   1. POST /api/mood-entries            (web + iOS single)
 *   2. POST /api/mood-entries/bulk       (iOS backfill)
 *   3. logTelegramMood                   (the bot)
 *   4. POST /api/import                  (JSON restore)
 *   5. logMcpMood                        (the assistant tool)
 *
 * It also pins the three rules the columns exist for: a re-post refreshes the
 * value rather than leaving a stale one beside a fresh mood, an explicit
 * client value beats the derivation, and nothing ever invents A2 to A5.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "user-mood-writers-agree";

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

async function createUserSession() {
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "mood-writers-agree",
      email: "mood-writers-agree@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: USER,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

function jsonRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
});

describe("mood writers agree on the derived level-A value", () => {
  it("writes the same moodA1 through all five writers for the same mood", async () => {
    await createUserSession();

    const { POST: postSingle } = await import("@/app/api/mood-entries/route");
    const { POST: postBulk } =
      await import("@/app/api/mood-entries/bulk/route");
    const { POST: postImport } = await import("@/app/api/import/route");
    const { logTelegramMood } = await import("@/lib/mood/create-from-telegram");
    const { logMcpMood } = await import("@/lib/mcp/writes");

    // 1 — single create.
    const single = await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-16T08:00:00.000Z",
        externalId: "writer-single",
      }),
    );
    expect(single.status).toBe(201);

    // 2 — bulk backfill. The request shape carries no level-A field and the
    // server derives it, which is why the published contract does not move:
    // this batch path is the one in `docs/api/openapi.yaml`, and it is
    // byte-identical. The unpublished single routes DO answer five new keys
    // on their reads, which is additive and which the client ignores.
    const bulk = await postBulk(
      jsonRequest("/api/mood-entries/bulk", {
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T09:00:00.000Z",
            externalId: "writer-bulk",
          },
        ],
      }),
    );
    expect(bulk.status).toBe(200);

    // 3 — the bot. Its input is the 1-5 score; it resolves the label itself.
    const telegram = await logTelegramMood({
      userId: USER,
      score: 4,
      tz: "Europe/Berlin",
      externalId: "telegram:mood:1:2:4",
    });
    expect(telegram.created).toBe(true);

    // 4 — the JSON import. Deliberately carries a `score` that disagrees with
    // its own label: this is the one writer whose score comes out of the file
    // rather than out of the label, and the self-assessment column has to
    // follow the label the user picked, not the number the file asserts.
    const imported = await postImport(
      jsonRequest("/api/import", {
        moodEntries: [
          {
            date: "2026-05-16",
            mood: "GUT",
            score: 2,
            loggedAt: "2026-05-16T10:00:00.000Z",
            externalId: "writer-import",
          },
        ],
      }),
    );
    expect(imported.status).toBe(200);

    // 5 — the assistant tool.
    const mcp = await logMcpMood({
      userId: USER,
      score: 4,
      tz: "Europe/Berlin",
      idempotencyKey: "writer-mcp-1",
    });
    expect(mcp.status).toBe("written");

    const rows = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER },
      orderBy: { source: "asc" },
      select: {
        source: true,
        mood: true,
        score: true,
        moodA1: true,
        stressA2: true,
        energyA3: true,
        connectionA4: true,
        stabilityA5: true,
      },
    });

    // Five writers, five rows — and one of them is the bulk path, which must
    // not have been folded into the single path's row.
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.source).sort()).toEqual([
      "IMPORT",
      "MANUAL",
      "MANUAL",
      "MCP",
      "TELEGRAM",
    ]);

    for (const row of rows) {
      expect(row.mood).toBe("GUT");
      // GUT sits at 7 on the level-A scale. Asserted by value on every row,
      // not by comparing the rows to each other: five rows agreeing on a
      // wrong number would pass a same-value assertion.
      expect(row.moodA1).toBe(7);
      // Nothing derives the other four, on any path.
      expect(row.stressA2).toBeNull();
      expect(row.energyA3).toBeNull();
      expect(row.connectionA4).toBeNull();
      expect(row.stabilityA5).toBeNull();
    }

    // The imported row keeps the file's own score while its level-A value
    // follows the label — the disagreement the file carried is not copied
    // into the new column.
    const importedRow = rows.find((r) => r.source === "IMPORT");
    expect(importedRow?.score).toBe(2);
    expect(importedRow?.moodA1).toBe(7);
  });

  it("refreshes moodA1 when an externalId is re-posted with a different mood", async () => {
    await createUserSession();
    const { POST: postSingle } = await import("@/app/api/mood-entries/route");
    const { POST: postBulk } =
      await import("@/app/api/mood-entries/bulk/route");

    await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "LAUSIG",
        moodLoggedAt: "2026-05-16T08:00:00.000Z",
        externalId: "repost-single",
      }),
    );
    await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "SUPER_GUT",
        moodLoggedAt: "2026-05-16T08:10:00.000Z",
        externalId: "repost-single",
      }),
    );

    await postBulk(
      jsonRequest("/api/mood-entries/bulk", {
        entries: [
          {
            mood: "LAUSIG",
            moodLoggedAt: "2026-05-16T11:00:00.000Z",
            externalId: "repost-bulk",
          },
        ],
      }),
    );
    await postBulk(
      jsonRequest("/api/mood-entries/bulk", {
        entries: [
          {
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-16T11:10:00.000Z",
            externalId: "repost-bulk",
          },
        ],
      }),
    );

    const rows = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER },
      orderBy: { externalId: "asc" },
      select: { externalId: true, mood: true, score: true, moodA1: true },
    });

    // One row per externalId — the re-post updated in place, as before.
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.mood).toBe("SUPER_GUT");
      expect(row.score).toBe(5);
      // The update arm of both upserts restates the value. Without it the row
      // would carry LAUSIG's 1 beside SUPER_GUT's 5.
      expect(row.moodA1).toBe(9);
    }
  });

  it("leaves a dimension the re-post said nothing about exactly where it was", async () => {
    await createUserSession();
    const { POST: postSingle } = await import("@/app/api/mood-entries/route");
    const { POST: postBulk } =
      await import("@/app/api/mood-entries/bulk/route");

    // Somebody answers the sliders on the web.
    await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "OKAY",
        moodLoggedAt: "2026-05-16T08:00:00.000Z",
        externalId: "preserve-single",
        a2: 9,
        a3: 2,
      }),
    );

    // The phone re-posts the same entry it holds: label, timestamp, id, and no
    // sliders, because its build has none. This must not blank what the web
    // wrote. Absence in a request means "nothing to say", not "set to
    // nothing" — a request that cleared four columns by staying silent would
    // destroy answers on every sync round.
    await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-16T08:05:00.000Z",
        externalId: "preserve-single",
      }),
    );

    const afterRepost = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: USER, externalId: "preserve-single" },
    });
    expect(afterRepost.mood).toBe("GUT");
    // Pleasantness DOES follow the label: the request carried one, and a
    // stale A1 beside a changed face would contradict the entry itself.
    expect(afterRepost.moodA1).toBe(7);
    // The four the request said nothing about are untouched.
    expect(afterRepost.stressA2).toBe(9);
    expect(afterRepost.energyA3).toBe(2);
    expect(afterRepost.connectionA4).toBeNull();
    expect(afterRepost.stabilityA5).toBeNull();

    // An explicit null is how an answer is taken back — the other route out of
    // the same three-state contract.
    await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-16T08:06:00.000Z",
        externalId: "preserve-single",
        a2: null,
      }),
    );
    const afterClear = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: USER, externalId: "preserve-single" },
    });
    expect(afterClear.stressA2).toBeNull();
    // Clearing one says nothing about the others.
    expect(afterClear.energyA3).toBe(2);

    // The batch path answers the same way, and always has: it carries no
    // level-A input at all, so every re-import preserves.
    await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "OKAY",
        moodLoggedAt: "2026-05-16T12:00:00.000Z",
        externalId: "preserve-bulk",
        a4: 6,
      }),
    );
    await postBulk(
      jsonRequest("/api/mood-entries/bulk", {
        entries: [
          {
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-16T12:30:00.000Z",
            externalId: "preserve-bulk",
          },
        ],
      }),
    );
    const afterBulk = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: USER, externalId: "preserve-bulk" },
    });
    expect(afterBulk.mood).toBe("SUPER_GUT");
    expect(afterBulk.moodA1).toBe(9);
    expect(afterBulk.connectionA4).toBe(6);
  });

  it("lets an explicit client value win over the derivation, and stores the other four literally", async () => {
    await createUserSession();
    const { POST: postSingle } = await import("@/app/api/mood-entries/route");

    const res = await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "OKAY",
        moodLoggedAt: "2026-05-16T12:00:00.000Z",
        // A day that felt middling overall but was genuinely stressful: the
        // whole reason five values beat one.
        a1: 4,
        a2: 9,
        a3: 2,
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: Record<string, unknown> & {
        a1: number;
        a2: number;
        a3: number;
        a4: null;
        a5: null;
      };
    };
    // The response echoes the values under the keys the request used.
    expect(json.data.a1).toBe(4);
    expect(json.data.a2).toBe(9);
    expect(json.data.a5).toBeNull();
    // And under those keys ONLY. The routes spread the whole row, so simply
    // adding the wire keys shipped every value twice under two spellings; a
    // client would then have picked one and been stuck with it.
    const keys = Object.keys(json.data as Record<string, unknown>);
    expect(keys).not.toContain("moodA1");
    expect(keys).not.toContain("stressA2");
    expect(keys).not.toContain("energyA3");
    expect(keys).not.toContain("connectionA4");
    expect(keys).not.toContain("stabilityA5");

    const row = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: USER },
    });
    // Not 5 — OKAY's derived value lost to the number the user set.
    expect(row.moodA1).toBe(4);
    // Stored literally, higher meaning more stress. A value flipped on the
    // way in could never be recovered.
    expect(row.stressA2).toBe(9);
    expect(row.energyA3).toBe(2);
    // Untouched sliders write nothing at all.
    expect(row.connectionA4).toBeNull();
    expect(row.stabilityA5).toBeNull();
    // The five-point axis is untouched by any of this.
    expect(row.score).toBe(3);
  });

  it("re-derives A1 when an entry's mood is corrected, and clears a value on an explicit null", async () => {
    await createUserSession();
    const { POST: postSingle } = await import("@/app/api/mood-entries/route");
    const { PUT } = await import("@/app/api/mood-entries/[id]/route");

    const created = await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "SCHLECHT",
        moodLoggedAt: "2026-05-16T13:00:00.000Z",
        a2: 8,
      }),
    );
    const createdJson = (await created.json()) as { data: { id: string } };
    const id = createdJson.data.id;

    const corrected = await PUT(
      new NextRequest(`http://localhost/api/mood-entries/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mood: "GUT", a2: null }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(corrected.status).toBe(200);

    const row = await getPrismaClient().moodEntry.findUniqueOrThrow({
      where: { id },
    });
    expect(row.mood).toBe("GUT");
    expect(row.score).toBe(4);
    // The label moved, so pleasantness moved with it — the same way `score`
    // does. A stale 3 here would contradict the entry's own label.
    expect(row.moodA1).toBe(7);
    // An explicit null takes back an answer.
    expect(row.stressA2).toBeNull();
  });

  it("will not empty pleasantness, on either route", async () => {
    await createUserSession();
    const { POST: postSingle } = await import("@/app/api/mood-entries/route");
    const { PUT } = await import("@/app/api/mood-entries/[id]/route");

    // An entry always carries a five-point label, so it always implies a
    // pleasantness value. A null asks for one that cannot exist, and both
    // routes answer it the same way: derive from the label. The capture
    // surfaces therefore offer no clear control for this one field, which is
    // the UI half of the same rule.
    const created = await postSingle(
      jsonRequest("/api/mood-entries", {
        mood: "SUPER_GUT",
        moodLoggedAt: "2026-05-16T14:00:00.000Z",
        a1: null,
      }),
    );
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as {
      data: { id: string; a1: number };
    };
    expect(createdJson.data.a1).toBe(9);
    const id = createdJson.data.id;

    const cleared = await PUT(
      new NextRequest(`http://localhost/api/mood-entries/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a1: null }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(cleared.status).toBe(200);

    const row = await getPrismaClient().moodEntry.findUniqueOrThrow({
      where: { id },
    });
    // Derived from the entry's own stored label, not emptied.
    expect(row.moodA1).toBe(9);
  });
});
