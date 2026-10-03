/**
 * Several courses per medication (#1024) against a real Postgres, through the
 * shipped route exports and the shipped migration backfill.
 *
 * What the file pins:
 *   - the migration's backfill turns every medication window into one course
 *     (an end-only window starting on the creation day), leaves a medication
 *     without a window course-less, and is a no-op on a re-run;
 *   - after every course write (create, edit, delete) the medication row
 *     carries the latest course as its window, so reminders and the dose
 *     actions read the right one;
 *   - overlapping courses, a course queued behind a running one and a second
 *     course on a one-time medication are refused, and a refused write
 *     changes nothing;
 *   - the medication's own PUT edits the latest course;
 *   - the list and detail reads publish the resolved course fields.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER = "user-med-courses";
const D = (key: string) => new Date(`${key}T00:00:00.000Z`);
const key = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

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

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: {
      id: OWNER,
      username: OWNER,
      email: `${OWNER}@example.test`,
      timezone: "UTC",
    },
  });
  const session = await prisma.session.create({
    data: { userId: OWNER, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

function req(method: string, path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function makeMedication(window: {
  startsOn?: string | null;
  endsOn?: string | null;
  oneShot?: boolean;
}) {
  const { POST } = await import("@/app/api/medications/route");
  const res = await POST(
    req("POST", "/api/medications", {
      name: "Tamiflu",
      dose: "75 mg",
      schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      ...window,
    }),
  );
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body.data as { id: string };
}

async function postCourse(id: string, body: unknown) {
  const { POST } = await import("@/app/api/medications/[id]/courses/route");
  return POST(req("POST", `/api/medications/${id}/courses`, body), {
    params: Promise.resolve({ id }),
  });
}

async function window(id: string) {
  const row = await getPrismaClient().medication.findUniqueOrThrow({
    where: { id },
    select: { startsOn: true, endsOn: true },
  });
  return { startsOn: key(row.startsOn), endsOn: key(row.endsOn) };
}

async function courses(id: string) {
  const rows = await getPrismaClient().medicationCourse.findMany({
    where: { medicationId: id },
    orderBy: { startsOn: "asc" },
  });
  return rows.map((r) => [key(r.startsOn), key(r.endsOn)]);
}

describe("migration 0368 backfill", () => {
  const SQL = readFileSync(
    join(
      process.cwd(),
      "prisma/migrations/0368_medication_courses_and_custom_categories/migration.sql",
    ),
    "utf8",
  );
  const backfill = SQL.slice(SQL.indexOf('INSERT INTO "medication_courses"'));

  it("makes one course of every window and none of no window, idempotently", async () => {
    const prisma = getPrismaClient();
    const created = new Date("2026-02-10T09:00:00.000Z");
    const base = { userId: OWNER, dose: "1", createdAt: created };
    const both = await prisma.medication.create({
      data: {
        ...base,
        name: "both",
        startsOn: D("2026-03-01"),
        endsOn: D("2026-03-07"),
      },
    });
    const startOnly = await prisma.medication.create({
      data: { ...base, name: "start", startsOn: D("2026-03-01") },
    });
    const endOnly = await prisma.medication.create({
      data: { ...base, name: "end", endsOn: D("2026-04-01") },
    });
    const backdated = await prisma.medication.create({
      data: { ...base, name: "backdated", endsOn: D("2026-01-15") },
    });
    const chronic = await prisma.medication.create({
      data: { ...base, name: "chronic" },
    });

    const eligible = await prisma.medication.count({
      where: { OR: [{ startsOn: { not: null } }, { endsOn: { not: null } }] },
    });
    const inserted = await prisma.$executeRawUnsafe(backfill);
    expect(inserted).toBe(eligible);
    expect(await prisma.$executeRawUnsafe(backfill)).toBe(0);

    expect(await courses(both.id)).toEqual([["2026-03-01", "2026-03-07"]]);
    expect(await courses(startOnly.id)).toEqual([["2026-03-01", null]]);
    expect(await courses(endOnly.id)).toEqual([["2026-02-10", "2026-04-01"]]);
    expect(await courses(backdated.id)).toEqual([["2026-01-15", "2026-01-15"]]);
    expect(await courses(chronic.id)).toEqual([]);
    // Start after end (an older row): a one-day course on the end day.
    // Created in a far-east zone: the creation day is the account's day,
    // not the UTC one. An unknown stored zone falls back to the default.
    const prismaKiri = getPrismaClient();
    for (const [id, tz] of [
      ["kiri-user", "Pacific/Kiritimati"],
      ["mars-user", "Mars/Olympus_Mons"],
    ] as const) {
      await prismaKiri.user.create({
        data: { id, username: id, email: `${id}@example.test`, timezone: tz },
      });
    }
    const late = new Date("2026-02-10T12:00:00.000Z"); // Feb 11 at UTC+14
    const kiri = await prismaKiri.medication.create({
      data: {
        userId: "kiri-user",
        name: "k",
        dose: "1",
        createdAt: late,
        endsOn: D("2026-04-01"),
      },
    });
    const mars = await prismaKiri.medication.create({
      data: {
        userId: "mars-user",
        name: "m",
        dose: "1",
        createdAt: new Date("2026-02-10T23:30:00.000Z"),
        endsOn: D("2026-04-01"),
      },
    });
    const inverted = await prismaKiri.medication.create({
      data: {
        ...base,
        name: "inverted",
        startsOn: D("2026-05-10"),
        endsOn: D("2026-05-01"),
      },
    });
    await prismaKiri.medicationCourse.deleteMany({});
    await prismaKiri.$executeRawUnsafe(backfill);
    expect(await courses(kiri.id)).toEqual([["2026-02-11", "2026-04-01"]]);
    // Europe/Berlin: 23:30 UTC on Feb 10 is Feb 11.
    expect(await courses(mars.id)).toEqual([["2026-02-11", "2026-04-01"]]);
    expect(await courses(inverted.id)).toEqual([["2026-05-01", "2026-05-01"]]);
    expect(await prismaKiri.$executeRawUnsafe(backfill)).toBe(0);

    // Data-preserving: the medication columns are untouched.
    expect(await window(endOnly.id)).toEqual({
      startsOn: null,
      endsOn: "2026-04-01",
    });
  });
});

describe("course writes keep the projection", () => {
  it("projects the latest course after create, edit and delete", async () => {
    const med = await makeMedication({
      startsOn: "2026-03-01",
      endsOn: "2026-03-07",
    });
    expect(await courses(med.id)).toEqual([["2026-03-01", "2026-03-07"]]);

    const created = await postCourse(med.id, {
      startsOn: "2026-06-10",
      endsOn: "2026-06-16",
      note: "flu again",
    });
    const createdBody = await created.json();
    expect(created.status, JSON.stringify(createdBody)).toBe(201);
    expect(await window(med.id)).toEqual({
      startsOn: "2026-06-10",
      endsOn: "2026-06-16",
    });

    const { PATCH, DELETE } =
      await import("@/app/api/medications/[id]/courses/[courseId]/route");
    const ctx = {
      params: Promise.resolve({ id: med.id, courseId: createdBody.data.id }),
    };
    const patched = await PATCH(
      req("PATCH", "/x", { endsOn: "2026-06-20" }),
      ctx,
    );
    expect(patched.status).toBe(200);
    expect(await window(med.id)).toEqual({
      startsOn: "2026-06-10",
      endsOn: "2026-06-20",
    });

    const deleted = await DELETE(req("DELETE", "/x"), {
      params: Promise.resolve({ id: med.id, courseId: createdBody.data.id }),
    });
    expect(deleted.status).toBe(200);
    expect(await window(med.id)).toEqual({
      startsOn: "2026-03-01",
      endsOn: "2026-03-07",
    });

    // Deleting the only course makes the medication continuous again.
    const [only] = await getPrismaClient().medicationCourse.findMany({
      where: { medicationId: med.id },
    });
    await DELETE(req("DELETE", "/x"), {
      params: Promise.resolve({ id: med.id, courseId: only.id }),
    });
    expect(await window(med.id)).toEqual({ startsOn: null, endsOn: null });
  });

  it("refuses an overlap, a queued course and a second one-time course, changing nothing", async () => {
    const med = await makeMedication({
      startsOn: "2026-03-01",
      endsOn: "2026-03-07",
    });
    const overlap = await postCourse(med.id, {
      startsOn: "2026-03-05",
      endsOn: "2026-03-09",
    });
    expect(overlap.status).toBe(422);
    expect((await overlap.json()).meta.errorCode).toBe(
      "medications.course.overlap",
    );

    // A course that has not ended yet cannot have another one queued after
    // it, even without sharing a day.
    const shift = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const running = await makeMedication({
      startsOn: shift(-2),
      endsOn: shift(5),
    });
    const queued = await postCourse(running.id, {
      startsOn: shift(10),
      endsOn: shift(12),
    });
    expect(queued.status).toBe(422);
    expect((await queued.json()).meta.errorCode).toBe(
      "medications.course.currentOpen",
    );

    const once = await makeMedication({
      startsOn: "2026-03-01",
      oneShot: true,
    });
    const second = await postCourse(once.id, { startsOn: "2026-04-01" });
    expect(second.status).toBe(422);
    expect((await second.json()).meta.errorCode).toBe(
      "medications.course.oneShot",
    );

    expect(await courses(med.id)).toEqual([["2026-03-01", "2026-03-07"]]);
    expect(await window(med.id)).toEqual({
      startsOn: "2026-03-01",
      endsOn: "2026-03-07",
    });
  });

  it("never lets a first course cut off a chronic medication's history", async () => {
    // Taken continuously since creation: no window, no course row. A course
    // added beside it would project the medication into ending.
    const chronic = await makeMedication({});
    const refused = await postCourse(chronic.id, {
      startsOn: "2026-03-01",
      endsOn: "2026-03-31",
    });
    expect(refused.status).toBe(422);
    expect((await refused.json()).meta.errorCode).toBe(
      "medications.course.currentOpen",
    );
    expect(await courses(chronic.id)).toEqual([]);
    expect(await window(chronic.id)).toEqual({ startsOn: null, endsOn: null });

    // A window the rows never recorded (written past the course writer, as
    // an older restore could) becomes the first course before the new one.
    const legacy = await makeMedication({});
    await getPrismaClient().medication.update({
      where: { id: legacy.id },
      data: { startsOn: D("2026-01-10"), endsOn: D("2026-01-20") },
    });
    const added = await postCourse(legacy.id, {
      startsOn: "2026-03-01",
      endsOn: "2026-03-05",
    });
    expect(added.status).toBe(201);
    expect(await courses(legacy.id)).toEqual([
      ["2026-01-10", "2026-01-20"],
      ["2026-03-01", "2026-03-05"],
    ]);
  });

  it("lists every course's slots in the dose history, none in the gap", async () => {
    // Daily 08:00 UTC (the account is on UTC). Course A five days, the third
    // missed; a gap; course B five days, all taken. Both ended before today.
    const shift = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const med = await makeMedication({
      startsOn: shift(-20),
      endsOn: shift(-16),
    });
    await postCourse(med.id, { startsOn: shift(-10), endsOn: shift(-6) });
    const taken = [-20, -19, -17, -16, -10, -9, -8, -7, -6].map(shift);
    await getPrismaClient().medicationIntakeEvent.createMany({
      data: taken.map((day) => ({
        userId: OWNER,
        medicationId: med.id,
        scheduledFor: new Date(`${day}T08:00:00.000Z`),
        takenAt: new Date(`${day}T08:02:00.000Z`),
      })),
    });
    // The medication existed long before course A.
    await getPrismaClient().medication.update({
      where: { id: med.id },
      data: { createdAt: new Date(Date.now() - 40 * 86_400_000) },
    });

    const { GET } =
      await import("@/app/api/medications/[id]/dose-history/route");
    const body = await (
      await GET(req("GET", `/api/medications/${med.id}/dose-history`), {
        params: Promise.resolve({ id: med.id }),
      })
    ).json();
    const slots = (
      body.data.rows as Array<{ kind: string; at: string; status: string }>
    ).filter((r) => r.kind === "slot");
    const days = slots.map((r) => r.at.slice(0, 10)).sort();
    const courseDays = [-20, -19, -18, -17, -16, -10, -9, -8, -7, -6].map(
      shift,
    );
    expect(days).toEqual(courseDays.sort());
    expect(
      slots.filter((r) => r.status === "missed").map((r) => r.at.slice(0, 10)),
    ).toEqual([shift(-18)]);
  });

  it("lets the medication's own PUT edit the latest course", async () => {
    const med = await makeMedication({
      startsOn: "2026-03-01",
      endsOn: "2026-03-07",
    });
    await postCourse(med.id, { startsOn: "2026-06-10", endsOn: "2026-06-16" });
    const { PUT } = await import("@/app/api/medications/[id]/route");
    const res = await PUT(
      req("PUT", `/api/medications/${med.id}`, { endsOn: "2026-06-18" }),
      { params: Promise.resolve({ id: med.id }) },
    );
    expect(res.status).toBe(200);
    expect(await courses(med.id)).toEqual([
      ["2026-03-01", "2026-03-07"],
      ["2026-06-10", "2026-06-18"],
    ]);

    // Clearing the window would drop the history: refused, nothing changes.
    const cleared = await PUT(
      req("PUT", `/api/medications/${med.id}`, {
        startsOn: null,
        endsOn: null,
      }),
      { params: Promise.resolve({ id: med.id }) },
    );
    expect(cleared.status).toBe(422);
    expect((await cleared.json()).meta.errorCode).toBe(
      "medications.course.windowRequired",
    );
    expect(await window(med.id)).toEqual({
      startsOn: "2026-06-10",
      endsOn: "2026-06-18",
    });
  });

  it("publishes the resolved course fields on the list and the detail", async () => {
    const med = await makeMedication({
      startsOn: "2026-03-01",
      endsOn: "2026-03-07",
    });
    await postCourse(med.id, { startsOn: "2026-04-01", endsOn: "2026-04-03" });
    await getPrismaClient().medicationIntakeEvent.create({
      data: {
        userId: OWNER,
        medicationId: med.id,
        scheduledFor: new Date("2026-03-02T08:00:00.000Z"),
        takenAt: new Date("2026-03-02T08:03:00.000Z"),
      },
    });

    const { GET } = await import("@/app/api/medications/[id]/route");
    const body = await (
      await GET(req("GET", `/api/medications/${med.id}`), {
        params: Promise.resolve({ id: med.id }),
      })
    ).json();
    expect(body.data).toMatchObject({
      startsOn: expect.stringContaining("2026-04-01"),
      courseCount: 2,
      previousCourseEndedOn: "2026-04-03",
      canStartCourse: true,
      courseStatus: "ENDED",
    });
    expect(
      body.data.courses.map(
        (c: { startsOn: string; status: string; takenDoses: number }) => [
          c.startsOn,
          c.status,
          c.takenDoses,
        ],
      ),
    ).toEqual([
      ["2026-03-01", "ENDED", 1],
      ["2026-04-01", "ENDED", 0],
    ]);

    const { GET: list } = await import("@/app/api/medications/route");
    const listBody = await (await list()).json();
    expect(listBody.data[0]).toMatchObject({
      courseCount: 2,
      canStartCourse: true,
    });
  });
});
