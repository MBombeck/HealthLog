/**
 * #1028 — a medication added in the afternoon, dosed 09:00 / 14:00 / 21:00.
 *
 * The 14:00 dose of the creation day is recorded afterwards through the real
 * intake route, the 21:00 dose likewise, and the 09:00 slot of that day holds
 * only the pending placeholder the today projector mints for every slot of
 * the day, stamped auto-missed by the hourly pass. The Verlauf ledger and the
 * compliance payload must both read that day as two slots taken on time: the
 * 14:00 dose on its own slot (not an off-schedule take "due" at 21:00), and
 * no 09:00 row at all, since the medication did not exist yet.
 *
 * Everything goes through the shipped `POST` / `GET` exports against Postgres,
 * so the write-side slot resolution, the stored rows and both read models are
 * exercised in one pipe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getMissFreeDayKeys } from "@/lib/gamification/care-metrics";
import { runIntakeAutoSkipPass } from "@/lib/jobs/intake-auto-skip";
import { localHmAsUtc } from "@/lib/tz/local-day";
import { userDayKey } from "@/lib/tz/format";

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

const DAY_MS = 24 * 60 * 60 * 1000;

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

let counter = 0;

async function signedInUser(tz: string) {
  const suffix = `precreation-${counter++}`;
  const user = await getPrismaClient().user.create({
    data: {
      username: `pc-${suffix}`,
      email: `pc-${suffix}@example.test`,
      role: "USER",
      timezone: tz,
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function postIntake(medicationId: string, body: unknown) {
  const { POST } = await import("@/app/api/medications/[id]/intake/route");
  return (POST as Handler)(
    new NextRequest(`http://localhost/api/medications/${medicationId}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: medicationId }) },
  );
}

async function getJson(path: string, medicationId: string) {
  const route =
    path === "dose-history"
      ? await import("@/app/api/medications/[id]/dose-history/route")
      : await import("@/app/api/medications/[id]/compliance/route");
  const from = new Date(Date.now() - 90 * DAY_MS).toISOString();
  const response = await (route.GET as Handler)(
    new NextRequest(
      `http://localhost/api/medications/${medicationId}/${path}?from=${encodeURIComponent(from)}`,
      { method: "GET" },
    ),
    { params: Promise.resolve({ id: medicationId }) },
  );
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("a medication added mid-day (#1028)", () => {
  for (const tz of ["Asia/Kolkata", "America/New_York"]) {
    it(`reads the creation day as two slots taken on time (${tz})`, async () => {
      const prisma = getPrismaClient();
      const user = await signedInUser(tz);
      // Two days back, so every slot of the creation day is long settled
      // whatever the clock says when the suite runs.
      const day = new Date(Date.now() - 2 * DAY_MS);
      const at = (h: number, m = 0) => localHmAsUtc(day, tz, h, m);

      const med = await prisma.medication.create({
        data: {
          userId: user.id,
          name: "Amoxicillin",
          dose: "500mg",
          active: true,
          createdAt: at(16, 5),
          schedules: {
            create: {
              windowStart: "09:00",
              windowEnd: "09:00",
              timesOfDay: ["09:00", "14:00", "21:00"],
              daysOfWeek: null,
              scheduleType: "SCHEDULED",
            },
          },
        },
      });

      // The placeholder the today projector minted for the 09:00 slot,
      // stamped by the auto-miss pass.
      await prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: med.id,
          scheduledFor: at(9),
          takenAt: null,
          skipped: false,
          autoMissed: true,
          source: "REMINDER",
        },
      });

      for (const h of [14, 21]) {
        const response = await postIntake(med.id, {
          skipped: false,
          scheduledFor: at(h).toISOString(),
          takenAt: at(h).toISOString(),
        });
        expect(response.status).toBe(201);
      }

      const dayKey = userDayKey(at(12), tz);
      const ledger = await getJson("dose-history", med.id);
      const creationDay = (
        ledger.rows as Array<{
          kind: string;
          at: string;
          status: string;
        }>
      ).filter((r) => userDayKey(new Date(r.at), tz) === dayKey);
      expect(creationDay.map((r) => [r.at, r.kind, r.status])).toEqual([
        [at(14).toISOString(), "slot", "taken_on_time"],
        [at(21).toISOString(), "slot", "taken_on_time"],
      ]);

      const compliance = await getJson("compliance", med.id);
      expect(compliance.dailyCompliance[dayKey]).toMatchObject({
        expected: 2,
        taken: 2,
        onTime: 2,
      });
    });
  }
});

/**
 * The placeholder itself. The auto-miss pass must leave a placeholder on a
 * slot before the medication existed pending, so the raw-row readers (the
 * miss-free streak first) never see a forgotten dose on the creation day;
 * and the migration returns the ones an earlier pass already stamped,
 * without touching an auto-miss that history carried in from before.
 */
describe("placeholders on slots before the medication existed (#1028)", () => {
  const tz = "Asia/Kolkata";

  async function seed() {
    const prisma = getPrismaClient();
    const user = await signedInUser(tz);
    const day = new Date(Date.now() - 2 * DAY_MS);
    const at = (h: number, m = 0) => localHmAsUtc(day, tz, h, m);
    const med = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Amoxicillin",
        dose: "500mg",
        createdAt: at(16, 5),
        schedules: {
          create: {
            windowStart: "09:00",
            windowEnd: "09:00",
            timesOfDay: ["09:00", "14:00", "21:00"],
            scheduleType: "SCHEDULED",
          },
        },
      },
    });
    const row = (
      scheduledFor: Date,
      extra: { takenAt?: Date; autoMissed?: boolean } = {},
    ) =>
      prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: med.id,
          scheduledFor,
          takenAt: extra.takenAt ?? null,
          skipped: false,
          autoMissed: extra.autoMissed ?? false,
          source: "REMINDER",
        },
      });
    return { prisma, user, med, at, row };
  }

  it("the auto-miss pass leaves it pending and the miss-free streak keeps the day", async () => {
    const { prisma, user, at, row } = await seed();
    const placeholder = await row(at(9));
    await row(at(14), { takenAt: at(14) });
    await row(at(21), { takenAt: at(21) });

    await runIntakeAutoSkipPass(prisma, { nowMs: Date.now() });

    const after = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: placeholder.id },
    });
    expect(after.autoMissed).toBe(false);

    const events = await prisma.medicationIntakeEvent.findMany({
      where: { userId: user.id, deletedAt: null },
      select: {
        scheduledFor: true,
        takenAt: true,
        skipped: true,
        autoMissed: true,
      },
    });
    expect(getMissFreeDayKeys(events, tz)).toContain(userDayKey(at(12), tz));
  });

  it("the migration returns an already stamped placeholder and nothing else", async () => {
    const { prisma, at, row } = await seed();
    const placeholder = await row(at(9), { autoMissed: true });
    // An auto-miss from well before the creation (history a restore carried
    // in) and one after it are real misses and stay.
    const carried = await row(new Date(at(9).getTime() - 3 * DAY_MS), {
      autoMissed: true,
    });
    const afterCreation = await row(at(21), { autoMissed: true });

    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/0350_release_pre_creation_placeholder_misses/migration.sql",
      ),
      "utf8",
    );
    await prisma.$executeRawUnsafe(sql);

    const read = (id: string) =>
      prisma.medicationIntakeEvent.findUniqueOrThrow({ where: { id } });
    const released = await read(placeholder.id);
    expect(released.autoMissed).toBe(false);
    expect(released.syncVersion).toBe(placeholder.syncVersion + 1);
    expect((await read(carried.id)).autoMissed).toBe(true);
    expect((await read(afterCreation.id)).autoMissed).toBe(true);
  });
});
