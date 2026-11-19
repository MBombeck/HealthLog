/**
 * #1408 — a guardian opens a managed profile's medication and runs its
 * schedule; an adult's delegate reads it and changes none of the schedule.
 *
 * Driven over the real route handlers, the real grant table and real
 * Postgres:
 *
 *   1. inside a managed profile, the detail page's reads (compliance, dose
 *      history, Effect view, courses) answer 200 with the profile's data;
 *   2. the guardian starts, edits and removes a course and pins the Effect
 *      target; every row lands on the profile and every audit row is filed
 *      under the profile with the guardian named as the actor;
 *   3. an adult's share at READ reads the same pages, and at READ and MANAGE
 *      reaches none of the course or Effect-target writes;
 *   4. a session pointed at a record it holds no grant on is refused;
 *   5. the compliance cache cell belongs to the record: a cell warmed inside
 *      one profile is never served inside another.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

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

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `gm-${suffix}`,
      email: `gm-${suffix}@example.test`,
      displayName: `Guardian medication ${suffix}`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
    },
  });
}

async function signIn(userId: string) {
  headerJar.clear();
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function makeProfile(guardianId: string, name: string) {
  const { createManagedProfile } =
    await import("@/lib/managed-profiles/create");
  const { profile } = await createManagedProfile({
    creatorId: guardianId,
    displayName: name,
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  return profile;
}

/** A guardian signed in and switched into a fresh managed profile. */
async function guardianInside() {
  const guardian = await makeUser("guardian");
  const profile = await makeProfile(guardian.id, "Managed record");
  const session = await signIn(guardian.id);
  await switchSessionTo(session.id, profile.id);
  return { guardian, profile, session };
}

/** An adult delegate signed in and switched into an adult owner's record. */
async function adultInside(access: "READ" | "WRITE" | "MANAGE") {
  const owner = await makeUser("owner");
  const delegate = await makeUser("delegate");
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: owner.id,
    granteeId: delegate.id,
    access,
    scope: null,
  });
  await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
  const session = await signIn(delegate.id);
  await switchSessionTo(session.id, owner.id);
  return { owner, delegate, session };
}

/** A daily medication with one dose taken yesterday, on `userId`'s record. */
async function seedMedication(userId: string, name = "Levothyroxine") {
  const prisma = getPrismaClient();
  const created = new Date(Date.now() - 20 * 86_400_000);
  const med = await prisma.medication.create({
    data: {
      userId,
      name,
      dose: "50 µg",
      createdAt: created,
      schedules: { create: [{ windowStart: "08:00", windowEnd: "09:00" }] },
    },
  });
  const yesterday = new Date(Date.now() - 86_400_000);
  yesterday.setUTCHours(8, 0, 0, 0);
  await prisma.medicationIntakeEvent.create({
    data: {
      userId,
      medicationId: med.id,
      scheduledFor: yesterday,
      takenAt: new Date(yesterday.getTime() + 10 * 60_000),
    },
  });
  return med;
}

/**
 * A course that ended before the ones the tests start: a medication that is
 * still running refuses a new course until the open one is ended.
 */
async function endedCourse(userId: string, medicationId: string) {
  const prisma = getPrismaClient();
  const startsOn = new Date("2025-12-01T00:00:00.000Z");
  const endsOn = new Date("2025-12-31T00:00:00.000Z");
  await prisma.medication.update({
    where: { id: medicationId },
    data: { startsOn, endsOn },
  });
  return prisma.medicationCourse.create({
    data: { userId, medicationId, startsOn, endsOn },
  });
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Ctx = { params: Promise<Record<string, string>> };
type Handler = (r: Request, c: Ctx) => Promise<Response>;
const ctx = (params: Record<string, string>): Ctx => ({
  params: Promise.resolve(params),
});

async function routes() {
  const compliance =
    await import("@/app/api/medications/[id]/compliance/route");
  const doseHistory =
    await import("@/app/api/medications/[id]/dose-history/route");
  const efficacy = await import("@/app/api/medications/[id]/efficacy/route");
  const target =
    await import("@/app/api/medications/[id]/efficacy/target/route");
  const courses = await import("@/app/api/medications/[id]/courses/route");
  const course =
    await import("@/app/api/medications/[id]/courses/[courseId]/route");
  const detail = await import("@/app/api/medications/[id]/route");
  const cast = (h: unknown) => h as Handler;
  const base = (id: string) => `/api/medications/${id}`;
  return {
    compliance: (id: string) =>
      cast(compliance.GET)(
        jsonRequest(`${base(id)}/compliance`, "GET"),
        ctx({ id }),
      ),
    doseHistory: (id: string) =>
      cast(doseHistory.GET)(
        // The dose-history route reads `request.nextUrl`.
        new NextRequest(`http://localhost${base(id)}/dose-history`),
        ctx({ id }),
      ),
    efficacy: (id: string) =>
      cast(efficacy.GET)(
        jsonRequest(`${base(id)}/efficacy`, "GET"),
        ctx({ id }),
      ),
    setTarget: (id: string, body: unknown) =>
      cast(target.PUT)(
        jsonRequest(`${base(id)}/efficacy/target`, "PUT", body),
        ctx({ id }),
      ),
    detail: (id: string) =>
      cast(detail.GET)(jsonRequest(base(id), "GET"), ctx({ id })),
    listCourses: (id: string) =>
      cast(courses.GET)(jsonRequest(`${base(id)}/courses`, "GET"), ctx({ id })),
    startCourse: (id: string, body: unknown) =>
      cast(courses.POST)(
        jsonRequest(`${base(id)}/courses`, "POST", body),
        ctx({ id }),
      ),
    editCourse: (id: string, courseId: string, body: unknown) =>
      cast(course.PATCH)(
        jsonRequest(`${base(id)}/courses/${courseId}`, "PATCH", body),
        ctx({ id, courseId }),
      ),
    removeCourse: (id: string, courseId: string) =>
      cast(course.DELETE)(
        jsonRequest(`${base(id)}/courses/${courseId}`, "DELETE"),
        ctx({ id, courseId }),
      ),
  };
}

async function auditRows(action: string) {
  return getPrismaClient().auditLog.findMany({
    where: { action },
    orderBy: { createdAt: "asc" },
    select: { userId: true, actorUserId: true },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
});

describe("a guardian on a managed profile's medication", () => {
  it("reads the detail page's compliance, dose history, Effect view and courses", async () => {
    const { guardian, profile } = await guardianInside();
    const med = await seedMedication(profile.id);
    const r = await routes();

    const compliance = await r.compliance(med.id);
    expect(compliance.status).toBe(200);
    const rates = (await compliance.json()).data;
    expect(rates.applicable).toBe(true);
    expect(rates.compliance7.rate).toBeGreaterThan(0);

    const history = await r.doseHistory(med.id);
    expect(history.status).toBe(200);
    const rows = (await history.json()).data.rows as {
      intake: { takenAt: string | null } | null;
    }[];
    expect(rows.some((row) => row.intake?.takenAt)).toBe(true);

    expect((await r.efficacy(med.id)).status).toBe(200);
    expect((await r.listCourses(med.id)).status).toBe(200);

    // The three reads that spend a quota spend the guardian's, never the
    // profile's.
    const keys = (
      await getPrismaClient().rateLimit.findMany({ select: { key: true } })
    )
      .map((row) => row.key)
      .filter((key) => key.startsWith("medication-"));
    expect(keys.sort()).toEqual(
      [
        `medication-compliance:${guardian.id}`,
        `medication-dose-history:${guardian.id}`,
        `medication-efficacy:${guardian.id}`,
      ].sort(),
    );
  });

  it("starts, edits and removes a course on the profile, audited with the guardian as actor", async () => {
    const { guardian, profile } = await guardianInside();
    const med = await seedMedication(profile.id);
    await endedCourse(profile.id, med.id);
    const r = await routes();

    // The detail read offers the start to the guardian: the flag answers as
    // the course route would.
    const read = await r.detail(med.id);
    expect(read.status).toBe(200);
    expect((await read.json()).data.canStartCourse).toBe(true);

    const started = await r.startCourse(med.id, {
      startsOn: "2026-01-05",
      endsOn: "2026-01-20",
    });
    const startedBody = await started.json();
    expect(started.status, JSON.stringify(startedBody)).toBe(201);
    const courseId = startedBody.data.id as string;

    const row = await getPrismaClient().medicationCourse.findUniqueOrThrow({
      where: { id: courseId },
    });
    expect(row.userId).toBe(profile.id);

    const edited = await r.editCourse(med.id, courseId, {
      endsOn: "2026-01-25",
    });
    expect(edited.status).toBe(200);
    expect((await edited.json()).data.endsOn).toBe("2026-01-25");

    expect((await r.removeCourse(med.id, courseId)).status).toBe(200);
    expect(
      await getPrismaClient().medicationCourse.count({
        where: { id: courseId },
      }),
    ).toBe(0);

    for (const action of [
      "medication.course.create",
      "medication.course.update",
      "medication.course.delete",
    ]) {
      expect(await auditRows(action)).toEqual([
        { userId: profile.id, actorUserId: guardian.id },
      ]);
    }
  });

  it("pins and clears the Effect target, audited with the guardian as actor", async () => {
    const { guardian, profile } = await guardianInside();
    const med = await seedMedication(profile.id);
    const r = await routes();

    expect(
      (await r.setTarget(med.id, { measurementType: "WEIGHT" })).status,
    ).toBe(200);
    expect(
      await getPrismaClient().medicationEfficacyTarget.count({
        where: { medicationId: med.id },
      }),
    ).toBe(1);
    expect((await r.setTarget(med.id, { clear: true })).status).toBe(200);

    expect(await auditRows("medication.efficacy.target.set")).toEqual([
      { userId: profile.id, actorUserId: guardian.id },
    ]);
    expect(await auditRows("medication.efficacy.target.clear")).toEqual([
      { userId: profile.id, actorUserId: guardian.id },
    ]);
  });
});

describe("an adult's share", () => {
  it("at READ reads the detail page and changes none of the schedule", async () => {
    const { owner } = await adultInside("READ");
    const med = await seedMedication(owner.id);
    const r = await routes();

    expect((await r.compliance(med.id)).status).toBe(200);
    expect((await r.doseHistory(med.id)).status).toBe(200);
    expect((await r.efficacy(med.id)).status).toBe(200);
    expect((await r.listCourses(med.id)).status).toBe(200);

    expect(
      (await r.startCourse(med.id, { startsOn: "2026-01-05" })).status,
    ).toBe(403);
    expect(
      (await r.setTarget(med.id, { measurementType: "WEIGHT" })).status,
    ).toBe(403);
  });

  it("at MANAGE still reaches none of the course or Effect-target writes", async () => {
    const { owner } = await adultInside("MANAGE");
    const med = await seedMedication(owner.id);
    const course = await getPrismaClient().medicationCourse.create({
      data: {
        userId: owner.id,
        medicationId: med.id,
        startsOn: new Date("2026-01-05T00:00:00.000Z"),
        endsOn: new Date("2026-01-20T00:00:00.000Z"),
      },
    });
    await getPrismaClient().medication.update({
      where: { id: med.id },
      data: {
        startsOn: new Date("2026-01-05T00:00:00.000Z"),
        endsOn: new Date("2026-01-20T00:00:00.000Z"),
      },
    });
    const r = await routes();

    // A course could start, but not by this caller: the read says so.
    const read = await r.detail(med.id);
    expect(read.status).toBe(200);
    expect((await read.json()).data.canStartCourse).toBe(false);

    expect(
      (await r.startCourse(med.id, { startsOn: "2026-02-05" })).status,
    ).toBe(403);
    expect(
      (await r.editCourse(med.id, course.id, { endsOn: "2026-01-25" })).status,
    ).toBe(403);
    expect((await r.removeCourse(med.id, course.id)).status).toBe(403);
    expect(
      (await r.setTarget(med.id, { measurementType: "WEIGHT" })).status,
    ).toBe(403);

    const after = await getPrismaClient().medicationCourse.findMany({
      where: { medicationId: med.id },
    });
    expect(after).toHaveLength(1);
    expect(after[0].endsOn?.toISOString().slice(0, 10)).toBe("2026-01-20");
    expect(
      await getPrismaClient().medicationEfficacyTarget.count({
        where: { medicationId: med.id },
      }),
    ).toBe(0);
  });
});

describe("without a grant", () => {
  it("a session pointed at somebody else's record reads none of it", async () => {
    const { session } = await guardianInside();
    const otherGuardian = await makeUser("other-guardian");
    const other = await makeProfile(otherGuardian.id, "Someone else's");
    const foreign = await seedMedication(other.id);
    const r = await routes();

    await switchSessionTo(session.id, other.id);
    expect((await r.compliance(foreign.id)).status).toBe(403);
    expect((await r.doseHistory(foreign.id)).status).toBe(403);
    expect((await r.efficacy(foreign.id)).status).toBe(403);
    expect((await r.listCourses(foreign.id)).status).toBe(403);
    expect(
      (await r.startCourse(foreign.id, { startsOn: "2026-01-05" })).status,
    ).toBe(403);
  });
});

describe("the compliance cache", () => {
  it("keys on the record: a cell warmed in one profile is not served in another", async () => {
    const guardian = await makeUser("guardian");
    const first = await makeProfile(guardian.id, "First child");
    const second = await makeProfile(guardian.id, "Second child");
    const firstMed = await seedMedication(first.id, "First's tablets");
    const session = await signIn(guardian.id);
    const r = await routes();

    await switchSessionTo(session.id, first.id);
    expect((await r.compliance(firstMed.id)).status).toBe(200);

    // Same guardian, same medication id, the other profile: the warm cell
    // belongs to the first record and the second one owns no such row.
    await switchSessionTo(session.id, second.id);
    expect((await r.compliance(firstMed.id)).status).toBe(404);
    expect((await r.doseHistory(firstMed.id)).status).toBe(404);
    expect((await r.efficacy(firstMed.id)).status).toBe(404);
  });
});
