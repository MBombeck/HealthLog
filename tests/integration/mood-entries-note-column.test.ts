/**
 * v1.4.30 — `MoodEntry.note` column round-trip integration.
 *
 * Asserts:
 *   - POST /api/mood-entries accepts the new `note` field
 *   - PUT /api/mood-entries/[id] updates `note` (and accepts null to clear)
 *   - POST /api/mood-entries/bulk persists `note` per entry
 *   - The Zod cap (500 chars) rejects oversize prose
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-mood-note";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "mood-note",
      email: "mood-note@example.test",
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

describe("MoodEntry.note round-trip (real Postgres)", () => {
  it("POST /api/mood-entries persists `note`", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const res = await POST(
      postRequest("/api/mood-entries", {
        mood: "GUT",
        moodLoggedAt: "2026-05-16T08:00:00.000Z",
        note: "Long run before breakfast.",
      }),
    );
    expect(res.status).toBe(201);
    const stored = await getPrismaClient().moodEntry.findFirst({
      where: { userId: TEST_USER_ID },
    });
    expect(stored?.note).toBe("Long run before breakfast.");
  });

  it("PUT /api/mood-entries/[id] updates `note` and accepts null to clear it", async () => {
    const created = await getPrismaClient().moodEntry.create({
      data: {
        userId: TEST_USER_ID,
        date: "2026-05-16",
        tz: "Europe/Berlin",
        mood: "OKAY",
        score: 3,
        moodLoggedAt: new Date("2026-05-16T08:00:00.000Z"),
        note: "initial note",
      },
    });
    const { PUT } = await import("@/app/api/mood-entries/[id]/route");

    const res1 = await PUT(
      putRequest(`/api/mood-entries/${created.id}`, { note: "revised note" }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res1.status).toBe(200);
    const after1 = await getPrismaClient().moodEntry.findUnique({
      where: { id: created.id },
    });
    expect(after1?.note).toBe("revised note");

    const res2 = await PUT(
      putRequest(`/api/mood-entries/${created.id}`, { note: null }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res2.status).toBe(200);
    const after2 = await getPrismaClient().moodEntry.findUnique({
      where: { id: created.id },
    });
    expect(after2?.note).toBeNull();
  });

  it("POST /api/mood-entries/bulk persists `note` per entry", async () => {
    const { POST } = await import("@/app/api/mood-entries/bulk/route");
    const res = await POST(
      postRequest("/api/mood-entries/bulk", {
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            note: "Morning",
          },
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T14:00:00.000Z",
            note: "Afternoon dip",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const stored = await getPrismaClient().moodEntry.findMany({
      where: { userId: TEST_USER_ID },
      orderBy: { moodLoggedAt: "asc" },
    });
    expect(stored.map((r) => r.note)).toEqual(["Morning", "Afternoon dip"]);
  });

  it("rejects an oversize note (501 chars) with 422", async () => {
    const { POST } = await import("@/app/api/mood-entries/route");
    const oversize = "x".repeat(501);
    const res = await POST(
      postRequest("/api/mood-entries", {
        mood: "OKAY",
        moodLoggedAt: "2026-05-16T08:00:00.000Z",
        note: oversize,
      }),
    );
    expect(res.status).toBe(422);
  });
});
