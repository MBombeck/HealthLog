/**
 * A restore or a delete-all-data expires every delta cursor issued before it.
 *
 * A restore writes rows back with their original `updatedAt` and removes rows
 * without leaving tombstones. A paired client that kept its cursor would, on
 * its next incremental pull, miss both: the restored rows sit behind its
 * watermarks and the removed ones never show up as deletions. So the restore
 * stamps `User.syncResetAt`, and `/api/sync/changes` answers `cursorExpired`
 * to any cursor issued before it. A cursor the feed hands out after the
 * reset keeps working, although it may carry watermarks older than the reset
 * (the restored rows'), which is why the comparison is on the cursor's issue
 * time.
 *
 * Mutation checks: drop the `beforeReset` arm in the route and the first two
 * tests go red on `cursorExpired`; compare the reset against the cursor's
 * watermarks instead of its issue time and the cursor issued after the
 * restore expires too.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";

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
  headerJar.clear();
});

interface Page {
  cursor: string | null;
  hasMore: boolean;
  cursorExpired: boolean;
  changes: {
    measurements: {
      upserts: Array<{ id: string }>;
      tombstones: Array<{ id: string }>;
    };
  };
}

async function pull(cursor?: string): Promise<Page> {
  const { GET } = await import("@/app/api/sync/changes/route");
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const res = await GET(
    new NextRequest(`http://localhost/api/sync/changes${query}`),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Page }).data;
}

/** Drain the feed from `cursor` to the end; the last page's cursor. */
async function drain(
  cursor?: string,
): Promise<{ cursor: string; ids: string[] }> {
  const ids: string[] = [];
  let next = cursor;
  for (;;) {
    const page = await pull(next);
    expect(page.cursorExpired).toBe(false);
    ids.push(...page.changes.measurements.upserts.map((m) => m.id));
    next = page.cursor!;
    if (!page.hasMore) return { cursor: next, ids };
  }
}

async function seedAccount() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "sync-reset",
      email: "sync-reset@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  const earlier = Date.now() - 3 * 86_400_000;
  await prisma.measurement.createMany({
    data: Array.from({ length: 5 }, (_, i) => ({
      id: `m-${i}`,
      userId: user.id,
      type: "WEIGHT" as const,
      value: 80 + i,
      unit: "kg",
      measuredAt: new Date(earlier + i * 60_000),
      // Old row times, as a restored row carries.
      createdAt: new Date(earlier),
      updatedAt: new Date(earlier + i),
    })),
  });
  return user;
}

async function restoreBackup(backupId: string) {
  const { POST } = await import("./restore-job-driver");
  const res = await POST(
    new Request(`http://localhost/api/admin/backups/${backupId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as never,
    { params: Promise.resolve({ id: backupId }) },
  );
  expect(res.status).toBe(200);
}

describe("sync reset after a restore or a wipe", () => {
  it("expires a cursor issued before a restore, and not one issued after it", async () => {
    const user = await seedAccount();
    const prisma = getPrismaClient();
    const { id: backupId } = await storeBackupBlob(
      prisma,
      { userId: user.id, type: "WEEKLY_AUTO" },
      (write) =>
        streamFullBackupJson(prisma, user.id, write, {
          purpose: "disaster-recovery",
        }),
    );

    // A client caught up, then a reading arrived and was synced, and then
    // the account was restored to the backup, which removes that reading
    // without a tombstone.
    const before = await drain();
    await prisma.measurement.create({
      data: {
        id: "m-after-backup",
        userId: user.id,
        type: "WEIGHT",
        value: 90,
        unit: "kg",
        measuredAt: new Date(),
      },
    });
    const caughtUp = await drain(before.cursor);
    expect(caughtUp.ids).toEqual(["m-after-backup"]);

    await restoreBackup(backupId);
    expect(
      await prisma.measurement.findUnique({ where: { id: "m-after-backup" } }),
    ).toBeNull();

    // The old cursor would have reported nothing: the removal left no
    // tombstone and the restored rows sit behind its watermarks.
    const stale = await pull(caughtUp.cursor);
    expect(stale.cursorExpired).toBe(true);
    expect(stale.changes.measurements.upserts).toEqual([]);

    // Re-initialised: the whole restored record, and the new cursor holds
    // although every restored row is older than the reset.
    const fresh = await drain();
    expect(fresh.ids.sort()).toEqual(["m-0", "m-1", "m-2", "m-3", "m-4"]);
    const next = await pull(fresh.cursor);
    expect(next.cursorExpired).toBe(false);
  });

  it("expires a cursor issued before the person deleted all their data", async () => {
    await seedAccount();
    const { cursor } = await drain();

    const { DELETE } = await import("@/app/api/settings/data/route");
    const res = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );
    expect(res.status).toBe(200);

    expect((await pull(cursor)).cursorExpired).toBe(true);
    const fresh = await drain();
    expect(fresh.ids).toEqual([]);
    expect((await pull(fresh.cursor)).cursorExpired).toBe(false);
  });

  it("leaves an account that was never restored alone", async () => {
    await seedAccount();
    const { cursor } = await drain();
    expect((await pull(cursor)).cursorExpired).toBe(false);
  });
});
