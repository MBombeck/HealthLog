/**
 * An admin deletes another account, against real Postgres.
 *
 * `DELETE /api/admin/users/{id}` takes the account's own deletion path: with
 * a grace window the account is locked at once (credentials revoked, record
 * untouched) and the admin undo gives it back until the purge date; with the
 * window at 0 it is erased in the request. Mutations that must turn this red:
 *   - erase instead of lock (the row is gone after the request);
 *   - lock without revoking (the target's session survives);
 *   - drop the fresh-proof gate (an old admin session deletes);
 *   - drop the self, managed-profile or already-pending refusals.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type Handler = (
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

async function seedUser(id: string, role = "USER", managed = false) {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      role,
      onboardingCompletedAt: new Date(),
      ...(managed ? { managedProfileAt: new Date() } : {}),
    },
  });
  await prisma.measurement.create({
    data: {
      userId: id,
      type: "WEIGHT",
      value: 80,
      unit: "kg",
      measuredAt: new Date(Date.UTC(2026, 8, 1, 7)),
      source: "MANUAL",
    },
  });
}

/** Sign the admin in; `createdAgoMs` ages the session past the proof window. */
async function signInAdmin(createdAgoMs = 0) {
  const now = Date.now();
  const session = await getPrismaClient().session.create({
    data: {
      userId: "admin-1",
      createdAt: new Date(now - createdAgoMs),
      expiresAt: new Date(now + HOUR_MS),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function deleteUser(
  id: string,
  body: unknown = { confirm: "DELETE_ACCOUNT" },
) {
  const { DELETE } = await import("@/app/api/admin/users/[id]/route");
  return (DELETE as unknown as Handler)(
    new NextRequest(`http://localhost/api/admin/users/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function errorCode(res: Response) {
  return ((await res.json()) as { meta?: { errorCode?: string } }).meta
    ?.errorCode;
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.rateLimit.deleteMany();
  cookieJar.clear();
  headerJar.clear();
  vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "14");
  await seedUser("admin-1", "ADMIN");
  await seedUser("target-1");
  await prisma.session.create({
    data: {
      userId: "target-1",
      expiresAt: new Date(Date.now() + HOUR_MS),
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DELETE /api/admin/users/{id}", () => {
  it("locks the account for the grace window, revokes it and keeps the record", async () => {
    await signInAdmin();
    const before = Date.now();
    const res = await deleteUser("target-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { deleted: boolean; scheduledPurgeAt: string | null };
    };
    expect(body.data.deleted).toBe(true);
    const purgeAt = new Date(body.data.scheduledPurgeAt!).getTime();
    expect(purgeAt).toBeGreaterThanOrEqual(before + 14 * DAY_MS - 1000);
    expect(purgeAt).toBeLessThanOrEqual(Date.now() + 14 * DAY_MS + 1000);

    const prisma = getPrismaClient();
    const target = await prisma.user.findUniqueOrThrow({
      where: { id: "target-1" },
      select: { deletionRequestedAt: true, deletionRequestedById: true },
    });
    expect(target.deletionRequestedAt).not.toBeNull();
    expect(target.deletionRequestedById).toBe("admin-1");
    expect(await prisma.session.count({ where: { userId: "target-1" } })).toBe(
      0,
    );
    expect(
      await prisma.measurement.count({ where: { userId: "target-1" } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { userId: "admin-1", action: "admin.user.delete" },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { userId: "target-1", action: "user.account.delete" },
      }),
    ).toBe(1);

    // The list names the admin as the one who asked, and the undo gives the
    // account back.
    const list = await import("@/app/api/admin/users/route");
    const listed = (await (await list.GET()).json()) as {
      data: Array<{ id: string; deletion: { requestedBy: string } | null }>;
    };
    expect(
      listed.data.find((u) => u.id === "target-1")?.deletion?.requestedBy,
    ).toBe("admin");

    const undo = await import("@/app/api/admin/users/[id]/undo-deletion/route");
    const undone = await (undo.POST as unknown as Handler)(
      new NextRequest(
        "http://localhost/api/admin/users/target-1/undo-deletion",
        {
          method: "POST",
        },
      ),
      { params: Promise.resolve({ id: "target-1" }) },
    );
    expect(undone.status).toBe(200);
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: "target-1" },
          select: { deletionRequestedAt: true },
        })
      ).deletionRequestedAt,
    ).toBeNull();
  });

  it("erases at once when the server keeps no grace window", async () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "0");
    await signInAdmin();
    const res = await deleteUser("target-1");
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { scheduledPurgeAt: string | null } }).data
        .scheduledPurgeAt,
    ).toBeNull();
    expect(
      await getPrismaClient().user.count({ where: { id: "target-1" } }),
    ).toBe(0);
  });

  it("asks for a fresh proof from an old admin session", async () => {
    await signInAdmin(HOUR_MS);
    const res = await deleteUser("target-1");
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("auth.reproof.required");
    expect(
      (
        await getPrismaClient().user.findUniqueOrThrow({
          where: { id: "target-1" },
          select: { deletionRequestedAt: true },
        })
      ).deletionRequestedAt,
    ).toBeNull();
  });

  it("refuses the admin's own account", async () => {
    await signInAdmin();
    const res = await deleteUser("admin-1");
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("admin.users.delete.self");
  });

  it("refuses without the typed confirmation", async () => {
    await signInAdmin();
    const res = await deleteUser("target-1", {});
    expect(res.status).toBe(422);
  });

  it("refuses a managed profile and an account already pending deletion", async () => {
    await seedUser("profile-1", "USER", true);
    await signInAdmin();
    const managed = await deleteUser("profile-1");
    expect(managed.status).toBe(409);
    expect(await errorCode(managed)).toBe("admin.users.delete.managed_profile");

    expect((await deleteUser("target-1")).status).toBe(200);
    const again = await deleteUser("target-1");
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("account.deletion.already_pending");
  });

  it("refuses a caller who is not an admin", async () => {
    await getPrismaClient().user.update({
      where: { id: "admin-1" },
      data: { role: "USER" },
    });
    await signInAdmin();
    await expect(deleteUser("target-1")).resolves.toHaveProperty("status", 403);
  });

  it("deletes another admin while the caller stays", async () => {
    await seedUser("admin-2", "ADMIN");
    await signInAdmin();
    expect((await deleteUser("admin-2")).status).toBe(200);
  });
});
