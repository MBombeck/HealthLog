/**
 * v1.4.23 H4 — per-user Coach prompt-tuning preferences route.
 *
 * Round-trips through GET → PUT → GET and asserts that:
 *   - the GET returns the documented defaults when the row is null
 *   - the PUT persists the supplied shape and returns the canonical
 *     defaulted form
 *   - subsequent GETs reflect the persisted values
 *   - malformed input is rejected with 422
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";

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
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, email: `${username}@example.test` },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

describe("GET /api/auth/me/coach-prefs", () => {
  it("returns documented defaults when the user has never saved prefs", async () => {
    await seedSession("coach-prefs-defaults");

    const { GET } = await import("@/app/api/auth/me/coach-prefs/route");
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/coach-prefs"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: typeof DEFAULT_COACH_PREFS };
    expect(env.data).toEqual(DEFAULT_COACH_PREFS);
  });
});

describe("PUT /api/auth/me/coach-prefs", () => {
  it("persists the supplied shape and round-trips through GET", async () => {
    const user = await seedSession("coach-prefs-roundtrip");
    const prisma = getPrismaClient();

    const { PUT, GET } = await import("@/app/api/auth/me/coach-prefs/route");
    // The request body omits `defaultWindow`; the schema (v1.4.25 W5)
    // defaults it to "allTime", so the canonical PUT response and the
    // persisted row both carry the defaulted field even when the
    // caller didn't pass it.
    const body = {
      tone: "concise" as const,
      verbosity: "brief" as const,
      excludeMetrics: ["mood" as const, "compliance" as const],
      showEvidenceByDefault: true,
    };
    const expected = { ...body, defaultWindow: "allTime" as const };
    const putRes = await (PUT as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/coach-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(putRes.status).toBe(200);
    const putEnv = (await putRes.json()) as { data: typeof expected };
    expect(putEnv.data).toEqual(expected);

    // DB row reflects the canonical defaulted form.
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { coachPrefsJson: true },
    });
    expect(row?.coachPrefsJson).toEqual(expected);

    // GET reads the saved values back.
    const getRes = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/coach-prefs"),
    );
    expect(getRes.status).toBe(200);
    const getEnv = (await getRes.json()) as { data: typeof expected };
    expect(getEnv.data).toEqual(expected);
  });

  it("rejects unknown tone values with 422", async () => {
    await seedSession("coach-prefs-invalid");

    const { PUT } = await import("@/app/api/auth/me/coach-prefs/route");
    const res = await (PUT as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/coach-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tone: "stoic" }),
      }),
    );
    expect(res.status).toBe(422);
  });
});
