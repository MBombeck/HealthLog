/**
 * v1.4.30 — `POST /api/mood-entries/bulk` real-Postgres integration.
 *
 * Asserts the iOS SyncMode bulk-backfill contract:
 *   - inserts a clean batch
 *   - upserts on re-post (last-writer-wins on mood / tags)
 *   - rejects oversize batches
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-mood-bulk";

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
      username: "mood-bulk",
      email: "mood-bulk@example.test",
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

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mood-entries/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/mood-entries/bulk (real Postgres)", () => {
  it("inserts a clean batch of three entries", async () => {
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const res = await POST(
      makeRequest({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
          },
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T14:00:00.000Z",
            tags: ["coffee"],
          },
          {
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-16T20:00:00.000Z",
            source: "DAYLIO",
          },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        processed: number;
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string }>;
      };
    };
    expect(json.data.processed).toBe(3);
    expect(json.data.inserted).toBe(3);
    expect(json.data.duplicates).toBe(0);

    const stored = await getPrismaClient().moodEntry.findMany({
      where: { userId: TEST_USER_ID },
      orderBy: { moodLoggedAt: "asc" },
    });
    expect(stored).toHaveLength(3);
    expect(stored[0].mood).toBe("GUT");
    expect(stored[0].score).toBe(4);
    expect(stored[0].tz).toBe("Europe/Berlin");
  });

  it("upserts when the same (userId, date, moodLoggedAt) tuple is re-posted", async () => {
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const body = {
      entries: [
        {
          mood: "OKAY",
          moodLoggedAt: "2026-05-16T08:00:00.000Z",
        },
      ],
    };

    await POST(makeRequest(body));
    const res = await POST(
      makeRequest({
        entries: [
          {
            // Same timestamp + user but a different mood.
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            tags: ["workout"],
          },
        ],
      }),
    );

    const json = (await res.json()) as {
      data: { duplicates: number; inserted: number };
    };
    expect(json.data.duplicates).toBe(1);
    expect(json.data.inserted).toBe(0);

    const stored = await getPrismaClient().moodEntry.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].mood).toBe("SUPER_GUT");
    expect(stored[0].score).toBe(5);
  });

  it("persists structured tagKeys as MoodEntryTagLink rows (v1.12.0)", async () => {
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const res = await POST(
      makeRequest({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            // Two valid catalog keys (one from the hobbies category, one
            // health key) plus one unknown key that must be dropped
            // silently.
            tagKeys: ["movies", "alcohol", "not_a_real_tag"],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { inserted: number } };
    expect(json.data.inserted).toBe(1);

    const entry = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: TEST_USER_ID },
    });
    const links = await getPrismaClient().moodEntryTagLink.findMany({
      where: { moodEntryId: entry.id },
      select: { moodTag: { select: { key: true } } },
    });
    const keys = links.map((l) => l.moodTag.key).sort();
    // The unknown key is dropped; the two catalog keys round-trip.
    expect(keys).toEqual(["alcohol", "movies"]);
  });

  it("persists a rated factor with its score on the link (v1.12.0)", async () => {
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const res = await POST(
      makeRequest({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            ratedFactors: [
              { key: "factor_work", rating: 4 },
              { key: "factor_sadness", rating: 2 },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { inserted: number } };
    expect(json.data.inserted).toBe(1);

    const entry = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: TEST_USER_ID },
    });
    const links = await getPrismaClient().moodEntryTagLink.findMany({
      where: { moodEntryId: entry.id },
      select: { rating: true, moodTag: { select: { key: true, kind: true } } },
      orderBy: { moodTag: { key: "asc" } },
    });
    expect(
      links.map((l) => ({
        key: l.moodTag.key,
        kind: l.moodTag.kind,
        rating: l.rating,
      })),
    ).toEqual([
      { key: "factor_sadness", kind: "RATED", rating: 2 },
      { key: "factor_work", kind: "RATED", rating: 4 },
    ]);
  });

  it("rejects the batch when a rated factor falls outside the 1..5 envelope (v1.12.0)", async () => {
    // Every seeded RATED factor uses the full 1..5 slider scale, so the
    // outer Zod envelope (1..5) is the binding out-of-range gate — a
    // rating above it fails parse and 422s the whole batch before any
    // row lands. The narrower per-tag-scale path (a factor with a tighter
    // `scaleMin..scaleMax`) is covered by the `resolveRatedFactors` unit
    // tests.
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const res = await POST(
      makeRequest({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            // factor_sadness scale is 1..5; rating 9 is out of range.
            ratedFactors: [{ key: "factor_sadness", rating: 9 }],
          },
        ],
      }),
    );
    expect(res.status).toBe(422);

    // Nothing persisted — the batch was rejected at parse time.
    const entryCount = await getPrismaClient().moodEntry.count({
      where: { userId: TEST_USER_ID },
    });
    expect(entryCount).toBe(0);
  });

  it("ignores tagKeys that resolve to no catalog rows", async () => {
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const res = await POST(
      makeRequest({
        entries: [
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T09:00:00.000Z",
            tagKeys: ["totally_unknown_key"],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const entry = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: TEST_USER_ID },
    });
    const linkCount = await getPrismaClient().moodEntryTagLink.count({
      where: { moodEntryId: entry.id },
    });
    expect(linkCount).toBe(0);
  });

  it("names the unknown and archived keys on the entry's result instead of reporting it whole", async () => {
    const db = getPrismaClient();
    const category = await db.moodTagCategory.findFirstOrThrow({
      select: { id: true },
    });
    const archived = await db.moodTag.create({
      data: {
        categoryId: category.id,
        key: "test_archived_tag",
        labelKey: "mood.tags.test_archived_tag",
        isActive: false,
      },
    });
    try {
      const { POST } = await import("@/app/api/mood-entries/bulk/route");
      const res = await POST(
        makeRequest({
          entries: [
            {
              mood: "GUT",
              moodLoggedAt: "2026-05-16T08:00:00.000Z",
              tagKeys: ["movies", "test_archived_tag", "not_a_real_tag"],
              ratedFactors: [
                { key: "factor_work", rating: 4 },
                { key: "factor_not_real", rating: 2 },
              ],
            },
            {
              mood: "OKAY",
              moodLoggedAt: "2026-05-16T09:00:00.000Z",
              tagKeys: ["movies"],
            },
          ],
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { inserted: number; entries: Array<Record<string, unknown>> };
      };
      expect(json.data.inserted).toBe(2);
      expect(json.data.entries[0]).toMatchObject({
        status: "inserted",
        droppedTagKeys: ["test_archived_tag", "not_a_real_tag"],
        droppedFactorKeys: ["factor_not_real"],
      });
      expect(json.data.entries[1]).not.toHaveProperty("droppedTagKeys");
      expect(json.data.entries[1]).not.toHaveProperty("droppedFactorKeys");

      // What the result says is what is on disk.
      const first = await db.moodEntry.findUniqueOrThrow({
        where: { id: json.data.entries[0].id as string },
        select: {
          tagLinks: { select: { moodTag: { select: { key: true } } } },
        },
      });
      expect(first.tagLinks.map((l) => l.moodTag.key).sort()).toEqual([
        "factor_work",
        "movies",
      ]);
    } finally {
      await db.moodTag.delete({ where: { id: archived.id } });
    }
  });

  it("rejects an over-cap batch with 422 and the documented error code", async () => {
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const entries = Array.from({ length: 501 }, (_, i) => ({
      mood: "OKAY",
      moodLoggedAt: new Date(2026, 4, 16, 8, i % 60).toISOString(),
    }));
    const res = await POST(makeRequest({ entries }));
    expect(res.status).toBe(422);
    const json = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(json.meta?.errorCode).toBe("mood.bulk.too_large");
  });
});
