/**
 * A medication PUT the course writer refuses changes nothing.
 *
 * The PUT checks the window against the other courses first, then writes the
 * row, then writes the course. A course written by another request between
 * the check and the course write makes the course write refuse. If the row
 * write had already committed, the client got an error while the name, the
 * schedule and `oneShot` were changed anyway: a one-time medication with a
 * window that spans more than its one day.
 *
 * The race is reproduced by letting the up-front check pass (it is the check
 * the other request outran), so the real course writer meets the conflicting
 * courses and refuses, through the shipped route and a real Postgres.
 *
 * Mutation: move the row update back out of the transaction the course write
 * runs in, and the name and `oneShot` assertions turn red.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER = "user-med-put-race";

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

// The check the concurrent request outran: it saw no conflict.
vi.mock("@/lib/medications/courses", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/medications/courses")>()),
  checkCurrentWindow: vi.fn(async () => null),
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

describe("a medication PUT refused by the course writer", () => {
  it("leaves the medication row, its schedule and its courses as they were", async () => {
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/medications/route");
    const created = await POST(
      req("POST", "/api/medications", {
        name: "Tamiflu",
        dose: "75 mg",
        startsOn: "2026-03-01",
        endsOn: "2026-03-07",
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()).data as { id: string };

    // The course the other request wrote.
    const { POST: postCourse } =
      await import("@/app/api/medications/[id]/courses/route");
    const course = await postCourse(
      req("POST", `/api/medications/${id}/courses`, {
        startsOn: "2026-06-10",
        endsOn: "2026-06-16",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(course.status).toBe(201);

    const before = await prisma.medication.findUniqueOrThrow({
      where: { id },
      include: { schedules: true, courses: { orderBy: { startsOn: "asc" } } },
    });
    const revisionsBefore = await prisma.medicationScheduleRevision.count({
      where: { medicationId: id },
    });

    // A one-time medication cannot carry two courses: the writer refuses.
    const { PUT } = await import("@/app/api/medications/[id]/route");
    const res = await PUT(
      req("PUT", `/api/medications/${id}`, {
        name: "Oseltamivir",
        oneShot: true,
        startsOn: "2026-03-05",
        schedules: [{ windowStart: "20:00", windowEnd: "21:00" }],
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).meta.errorCode).toMatch(/^medications\.course\./);

    const after = await prisma.medication.findUniqueOrThrow({
      where: { id },
      include: { schedules: true, courses: { orderBy: { startsOn: "asc" } } },
    });
    expect(after.name).toBe("Tamiflu");
    expect(after.oneShot).toBe(false);
    expect(after.startsOn).toEqual(before.startsOn);
    expect(after.endsOn).toEqual(before.endsOn);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.schedules.map((s) => s.id)).toEqual(
      before.schedules.map((s) => s.id),
    );
    expect(after.schedules.map((s) => s.windowStart)).toEqual(["08:00"]);
    expect(after.courses.map((c) => [c.startsOn, c.endsOn])).toEqual(
      before.courses.map((c) => [c.startsOn, c.endsOn]),
    );
    expect(
      await prisma.medicationScheduleRevision.count({
        where: { medicationId: id },
      }),
    ).toBe(revisionsBefore);
  });
});
