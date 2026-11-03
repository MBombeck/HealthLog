/**
 * The display name round-trips through the profile save and the account
 * payload, against a real account row.
 *
 * The profile card seeds its display-name field from `GET /api/auth/me` and
 * saves it through `PUT /api/auth/profile`. Until now `/me` did not publish
 * the name at all, so the two ends could not meet; this pins the pipe: a save
 * lands in the column and comes back on the payload, and an emptied field
 * clears it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

async function seed(displayName: string | null): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "display-name",
      email: "display-name@example.test",
      displayName,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

async function save(body: Record<string, unknown>): Promise<Response> {
  const { PUT } = await import("@/app/api/auth/profile/route");
  return PUT(
    new NextRequest("http://localhost/api/auth/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function me(): Promise<{ displayName?: string | null }> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { displayName?: string | null } }).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("display name: profile save and account payload", () => {
  it("publishes the stored name on /api/auth/me", async () => {
    await seed("Sam");
    expect((await me()).displayName).toBe("Sam");
  });

  it("a save lands in the column and comes back on the payload", async () => {
    const userId = await seed("Sam");

    const res = await save({ displayName: "  Alex  " });
    expect(res.status).toBe(200);

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: userId },
      select: { displayName: true },
    });
    expect(row.displayName).toBe("Alex");
    expect((await me()).displayName).toBe("Alex");
  });

  it("an emptied field clears the name", async () => {
    await seed("Sam");
    expect((await save({ displayName: null })).status).toBe(200);
    expect((await me()).displayName).toBeNull();
  });
});
