/**
 * The scheduled doctor report against a real Postgres: the real collector,
 * the real PDF renderer and the real vault ingest, no mocked Prisma.
 *
 *   1. A due monthly schedule files one DOCTOR_REPORT document keyed
 *      `REPORT_SCHEDULE` / `MONTHLY:<period>`, dated the period's last day,
 *      and stamps the period.
 *   2. A re-run with the stamp lost files nothing twice; a report the owner
 *      deleted is not filed again.
 *   3. With the doctor-report module off, or the account pending deletion,
 *      nothing is rendered or stored.
 *   4. The settings route turns it on, keeps the stamp for the same cadence,
 *      clears it for a new one, refuses with the module off, and turns it off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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

import { Prisma } from "@/generated/prisma/client";
import { latestClosedPeriod } from "@/lib/doctor-report/schedule";
import { runReportScheduleTick } from "@/lib/jobs/report-schedule";
import { STANDARD_TEMPLATE_LEAVES } from "@/lib/report-selection/template";

const TZ = "Europe/Berlin";
const NOW = new Date();
const PERIOD = latestClosedPeriod("MONTHLY", NOW, TZ);

const SCHEDULE = {
  v: 1,
  cadence: "MONTHLY",
  window: "PERIOD",
  lastPeriod: null,
  lastOutcome: null,
  lastRunAt: null,
};

async function seed(
  opts: {
    modules?: Record<string, boolean>;
    pending?: boolean;
  } = {},
) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "scheduled",
      email: "scheduled@example.test",
      role: "USER",
      timezone: TZ,
      locale: "en",
      modulePreferencesJson: {
        doctorReport: true,
        inboundDocuments: true,
        ...opts.modules,
      },
      reportSelectionJson: {
        v: 2,
        leaves: [...STANDARD_TEMPLATE_LEAVES],
        format: "pdf",
        rangeDays: 90,
        includeCharts: true,
      },
      reportScheduleJson: SCHEDULE,
      deletionRequestedAt: opts.pending ? new Date() : null,
    },
  });
  await prisma.measurement.create({
    data: {
      userId: user.id,
      type: "WEIGHT",
      value: 72.5,
      unit: "kg",
      measuredAt: new Date(`${PERIOD.firstDay}T12:00:00Z`),
      source: "MANUAL",
    },
  });
  return user.id;
}

async function storedSchedule(userId: string) {
  const row = await getPrismaClient().user.findUnique({
    where: { id: userId },
    select: { reportScheduleJson: true },
  });
  return row?.reportScheduleJson as Record<string, unknown> | null;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("the scheduled doctor report in the vault", () => {
  it("files the closed period once, and never again after a delete", async () => {
    const prisma = getPrismaClient();
    const userId = await seed();

    const first = await runReportScheduleTick(NOW);
    expect(first).toMatchObject({ due: 1, stored: 1 });
    const docs = await prisma.inboundDocument.findMany({ where: { userId } });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      sourceSystem: "REPORT_SCHEDULE",
      sourceId: `MONTHLY:${PERIOD.key}`,
      kind: "DOCTOR_REPORT",
      mimeType: "application/pdf",
      title: `Doctor report ${PERIOD.key}`,
    });
    expect(docs[0].byteSize).toBeGreaterThan(1000);
    expect(docs[0].documentDate?.toISOString().slice(0, 10)).toBe(
      PERIOD.lastDay,
    );
    expect(await storedSchedule(userId)).toMatchObject({
      lastPeriod: PERIOD.key,
      lastOutcome: "stored",
    });

    // Stamped: the next tick has nothing due.
    expect(await runReportScheduleTick(NOW)).toMatchObject({ due: 0 });

    // The stamp lost (a restore, a second worker): the key answers.
    await prisma.user.update({
      where: { id: userId },
      data: { reportScheduleJson: SCHEDULE },
    });
    expect(await runReportScheduleTick(NOW)).toMatchObject({
      alreadyFiled: 1,
    });
    expect(await prisma.inboundDocument.count({ where: { userId } })).toBe(1);

    // The owner deletes the report: it stays deleted.
    await prisma.inboundDocument.update({
      where: { id: docs[0].id },
      data: { deletedAt: new Date() },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { reportScheduleJson: SCHEDULE },
    });
    expect(await runReportScheduleTick(NOW)).toMatchObject({
      deletedByOwner: 1,
    });
    expect(await prisma.inboundDocument.count({ where: { userId } })).toBe(1);
    expect(await storedSchedule(userId)).toMatchObject({
      lastPeriod: PERIOD.key,
      lastOutcome: "deletedByOwner",
    });
  });

  it("renders nothing with the doctor-report module off", async () => {
    const userId = await seed({ modules: { doctorReport: false } });
    expect(await runReportScheduleTick(NOW)).toMatchObject({ moduleOff: 1 });
    const prisma = getPrismaClient();
    expect(await prisma.inboundDocument.count({ where: { userId } })).toBe(0);
    expect(await storedSchedule(userId)).toMatchObject({ lastPeriod: null });
  });

  it("does not read an account pending deletion", async () => {
    const userId = await seed({ pending: true });
    expect(await runReportScheduleTick(NOW)).toMatchObject({
      scheduled: 0,
      due: 0,
    });
    const prisma = getPrismaClient();
    expect(await prisma.inboundDocument.count({ where: { userId } })).toBe(0);
  });
});

describe("/api/settings/report-schedule", () => {
  const URL = "http://localhost/api/settings/report-schedule";
  const put = (body: unknown) =>
    new NextRequest(URL, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  async function signIn(modules: Record<string, boolean> = {}) {
    const prisma = getPrismaClient();
    const userId = await seed({ modules });
    await prisma.user.update({
      where: { id: userId },
      data: { reportScheduleJson: Prisma.DbNull },
    });
    const session = await prisma.session.create({
      data: { userId, expiresAt: new Date(Date.now() + 600_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    return userId;
  }

  it("is off by default, turns on, keeps or clears the stamp, turns off", async () => {
    const userId = await signIn();
    const route = await import("@/app/api/settings/report-schedule/route");

    const off = await route.GET();
    expect((await off.json()).data).toEqual({ schedule: null });

    const on = await route.PUT(put({ cadence: "MONTHLY", window: "PERIOD" }));
    expect(on.status).toBe(200);
    expect((await on.json()).data.schedule).toMatchObject({
      cadence: "MONTHLY",
      window: "PERIOD",
      lastPeriod: null,
      duePeriod: PERIOD.key,
    });

    // The job files the period; the same cadence keeps the stamp.
    await runReportScheduleTick(NOW);
    const same = await route.PUT(
      put({ cadence: "MONTHLY", window: "LAST_90_DAYS" }),
    );
    expect((await same.json()).data.schedule).toMatchObject({
      window: "LAST_90_DAYS",
      lastPeriod: PERIOD.key,
      lastOutcome: "stored",
      duePeriod: null,
    });

    // A new cadence starts without one.
    const other = await route.PUT(put({ cadence: "YEARLY", window: "PERIOD" }));
    expect((await other.json()).data.schedule).toMatchObject({
      cadence: "YEARLY",
      lastPeriod: null,
    });

    // The server's stamps are never body fields.
    const smuggled = await route.PUT(
      put({ cadence: "YEARLY", window: "PERIOD", lastPeriod: "2099" }),
    );
    expect(smuggled.status).toBe(422);

    const gone = await route.DELETE(new NextRequest(URL, { method: "DELETE" }));
    expect(gone.status).toBe(200);
    expect(await storedSchedule(userId)).toBeNull();
    // Reports already filed stay.
    expect(
      await getPrismaClient().inboundDocument.count({ where: { userId } }),
    ).toBe(1);
  });

  it("refuses to turn on with the doctor-report module off", async () => {
    await signIn({ doctorReport: false });
    const route = await import("@/app/api/settings/report-schedule/route");
    const res = await route.PUT(put({ cadence: "MONTHLY", window: "PERIOD" }));
    expect(res.status).toBe(403);
  });
});
