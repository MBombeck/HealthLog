/**
 * Two confirmation dialogs promised permanence over a soft delete.
 *
 * `records.allergies.deleteConfirmDescription` says it can't be undone and
 * `measurementReminders.deleteConfirmDescription` says the reminder is
 * permanently deleted, while both handlers stamped `deletedAt` and kept the
 * row — with no restore route, no undo affordance, and no purge job to give
 * the tombstone a horizon. The row then rode the nightly disaster-recovery
 * backup off the host, indefinitely.
 *
 * Neither tombstone bought anything: neither model is in the
 * `/api/sync/changes` delta feed, nothing references either table, and every
 * read already filtered `deletedAt: null`. So the behaviour moved to match
 * the copy rather than the copy retreating.
 *
 * Asserted against the real database because the whole question is whether a
 * row is still there. `src/__tests__/copy-matches-behaviour-guard.test.ts`
 * holds the other end — that the copy keeps claiming permanence.
 *
 * Mutation check: put either handler back on `update({ data: { deletedAt } })`
 * and the matching test goes red on the surviving row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function signIn(username: string): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, email: `${username}@example.test` },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("deletes that promise permanence remove the row", () => {
  it("an allergy is gone from the database, not hidden", async () => {
    const prisma = getPrismaClient();
    const userId = await signIn("allergy-deleter");

    const allergy = await prisma.allergy.create({
      data: { userId, substance: "Penicillin" },
    });

    const { DELETE } = await import("@/app/api/allergies/[id]/route");
    const response = await DELETE(
      new Request(`http://localhost/api/allergies/${allergy.id}`, {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: allergy.id }) } as never,
    );
    expect(response.status).toBe(200);

    expect(await prisma.allergy.count({ where: { id: allergy.id } })).toBe(0);
  });

  it("a checkup reminder is gone from the database, not hidden", async () => {
    const prisma = getPrismaClient();
    const userId = await signIn("reminder-deleter");

    const reminder = await prisma.measurementReminder.create({
      data: {
        userId,
        label: "Dental checkup",
        intervalDays: 180,
        notifyHour: 9,
        nextDueAt: new Date(Date.now() + 86_400_000),
      },
    });

    const { DELETE } =
      await import("@/app/api/measurement-reminders/[id]/route");
    const response = await DELETE(
      new Request(`http://localhost/api/measurement-reminders/${reminder.id}`, {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: reminder.id }) } as never,
    );
    expect(response.status).toBe(200);

    expect(
      await prisma.measurementReminder.count({ where: { id: reminder.id } }),
    ).toBe(0);
  });
});
