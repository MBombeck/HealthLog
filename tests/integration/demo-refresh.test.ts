/**
 * The daily demo refresh runs the real `scripts/seed-demo.ts` through the
 * handler, on the pool the handler opens, so the demo reads as freshly seeded
 * every day: the medications without an automatic intake carry yesterday's
 * and this morning's doses, and the latest readings are from the last day.
 * A database with any account besides the demo is refused and left as it was.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handleDemoRefresh } from "@/lib/jobs/demo-refresh";

import { getPrismaClient, truncateAllTables } from "./setup";

const DAY_MS = 24 * 60 * 60 * 1000;

async function refresh() {
  return handleDemoRefresh([], {
    prisma: getPrismaClient(),
    afterSeed: async () => {},
  });
}

beforeAll(async () => {
  vi.stubEnv("DEMO_MODE", "true");
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: { username: "demo", passwordHash: "x" },
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

// One walk by design: the refresh seeds the demo, and the refusal case needs
// those rows to show it left them untouched. The block keeps its order under
// a shuffled run.
describe("demo refresh", { shuffle: false }, () => {
  it("rewrites the demo up to today, every series current", async () => {
    const prisma = getPrismaClient();
    expect(await refresh()).toEqual({
      ok: true,
      did: { accounts_completed: 1 },
    });
    // Twice: the second run replaces the first instead of adding to it.
    expect(await refresh()).toEqual({
      ok: true,
      did: { accounts_completed: 1 },
    });

    const users = await prisma.user.findMany({
      select: { id: true, username: true },
    });
    expect(users.map((u) => u.username)).toEqual(["demo"]);
    const userId = users[0].id;
    const now = Date.now();

    for (const name of ["Ramipril", "Vitamin D3"]) {
      const med = await prisma.medication.findFirstOrThrow({
        where: { userId, name },
        select: { id: true },
      });
      const lastWeek = await prisma.medicationIntakeEvent.count({
        where: {
          medicationId: med.id,
          scheduledFor: { gte: new Date(now - 7 * DAY_MS) },
        },
      });
      // Six past mornings and today's: one random miss at most.
      expect(lastWeek).toBeGreaterThanOrEqual(6);
      const latest = await prisma.medicationIntakeEvent.findFirstOrThrow({
        where: { medicationId: med.id },
        orderBy: { scheduledFor: "desc" },
        select: { scheduledFor: true },
      });
      expect(now - latest.scheduledFor.getTime()).toBeLessThan(DAY_MS);
    }

    const latestReading = await prisma.measurement.findFirstOrThrow({
      where: { userId, deletedAt: null },
      orderBy: { measuredAt: "desc" },
      select: { measuredAt: true },
    });
    expect(now - latestReading.measuredAt.getTime()).toBeLessThan(DAY_MS);
  }, 600_000);

  it("refuses a database with other accounts and leaves it untouched", async () => {
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: { username: "someone-else", passwordHash: "x" },
    });
    const before = await prisma.measurement.count();
    expect(before).toBeGreaterThan(0);

    expect(await refresh()).toEqual({ ok: true, did: { skipped: true } });

    const names = (
      await prisma.user.findMany({ select: { username: true } })
    ).map((u) => u.username);
    expect(names.sort()).toEqual(["demo", "someone-else"]);
    expect(await prisma.measurement.count()).toBe(before);
  });
});
