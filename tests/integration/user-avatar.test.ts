/**
 * v1.5.5 — self-hosted avatar storage end-to-end guard.
 *
 * Confirms that the upload + read + delete cycle round-trips the raw
 * image bytes through Postgres without truncation, encoding drift,
 * or owner-scope leaks:
 *
 *   1. POST /api/user/avatar with a valid PNG returns 201 + the
 *      `avatarUrl` the /me payload would return.
 *   2. GET /api/user/avatar/{userId} for the same session echoes the
 *      bytes verbatim with the persisted Content-Type.
 *   3. GET /api/user/avatar/{otherUserId} from the first session
 *      returns 403 — the owner-scope gate covers cross-user reads.
 *   4. DELETE /api/user/avatar wipes the columns and the subsequent
 *      GET returns 404.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

async function seedSessionUser(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return { user, session };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("self-hosted avatar — end-to-end", () => {
  it("round-trips the bytes through Postgres without drift", async () => {
    const { user } = await seedSessionUser("avatar-owner");
    cookieJar.set(
      "healthlog_session",
      (await getPrismaClient().session.findFirst({
        where: { userId: user.id },
      }))!.id,
    );

    const { POST, DELETE } = await import("@/app/api/user/avatar/route");
    const { GET } = await import("@/app/api/user/avatar/[id]/route");

    // Narrow the apiHandler signature for the test fixtures (see
    // tests/integration/timezone-per-user.test.ts for the precedent).
    type RouteCtx = { params: Promise<{ id: string }> };
    const post = POST as (r: Request) => Promise<Response>;
    const del = DELETE as (r: Request) => Promise<Response>;
    const get = GET as (r: Request, ctx: RouteCtx) => Promise<Response>;

    // ── POST: upload the 1×1 PNG ──────────────────────────────
    const fd = new FormData();
    fd.append(
      "file",
      new Blob([PNG_1X1], { type: "image/png" }),
      "avatar.png",
    );
    const uploadReq = new Request("http://localhost/api/user/avatar", {
      method: "POST",
      body: fd,
    });
    const uploadRes = await post(uploadReq);
    expect(uploadRes.status).toBe(201);
    const uploadEnv = (await uploadRes.json()) as {
      data: { avatarUrl: string; contentType: string };
    };
    expect(uploadEnv.data.contentType).toBe("image/png");
    expect(uploadEnv.data.avatarUrl).toMatch(
      new RegExp(`^/api/user/avatar/${user.id}\\?v=\\d+$`),
    );

    // ── GET (owner): bytes round-trip exactly ────────────────
    const getRes = await get(
      new Request(`http://localhost/api/user/avatar/${user.id}`),
      { params: Promise.resolve({ id: user.id }) },
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    const echoed = Buffer.from(await getRes.arrayBuffer());
    expect(echoed.equals(PNG_1X1)).toBe(true);

    // ── GET (cross-user): 403 ────────────────────────────────
    const { user: other } = await seedSessionUser("other-user");
    const crossRes = await get(
      new Request(`http://localhost/api/user/avatar/${other.id}`),
      { params: Promise.resolve({ id: other.id }) },
    );
    expect(crossRes.status).toBe(403);

    // ── DELETE: clears the row ───────────────────────────────
    const delRes = await del(
      new Request("http://localhost/api/user/avatar", { method: "DELETE" }),
    );
    expect(delRes.status).toBe(204);

    const fresh = await getPrismaClient().user.findUnique({
      where: { id: user.id },
      select: {
        avatarBytes: true,
        avatarContentType: true,
        avatarUpdatedAt: true,
      },
    });
    expect(fresh?.avatarBytes).toBeNull();
    expect(fresh?.avatarContentType).toBeNull();
    expect(fresh?.avatarUpdatedAt).toBeNull();

    // ── GET (after delete): 404 ──────────────────────────────
    const post404 = await get(
      new Request(`http://localhost/api/user/avatar/${user.id}`),
      { params: Promise.resolve({ id: user.id }) },
    );
    expect(post404.status).toBe(404);
  });
});
