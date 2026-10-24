/**
 * "End course" (#1280) against a real Postgres, through the shipped routes,
 * the reminder worker, the today projector and the auto-miss pass.
 *
 * What the file pins:
 *   - the medication's PUT takes `endsOn` as a date (the request the End
 *     button used to send as a full instant was refused with 422), and an
 *     end date set that way keeps meaning the whole day;
 *   - `POST /courses/end` ends the running course at that moment: the last
 *     day is today on the person's clock and `endedAt` the instant, and the
 *     reads serve it ENDED with `canEndCourse` false at once;
 *   - a dose slot later that day is not due (no placeholder on the today
 *     list), not reminded and never missed, while a dose taken earlier that
 *     day still counts in compliance;
 *   - `canEndCourse` is true only while a course runs, and the action refuses
 *     an ended or upcoming course with 409;
 *   - an edit that moves the end clears the instant.
 *
 * The person lives in Europe/Berlin (UTC+2 in June). The medication doses at
 * 08:00 and 20:00 local, 06:00Z and 18:00Z.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue({
    dispatched: true,
    channelsAttempted: 1,
    channelsSucceeded: 1,
  }),
}));
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

const { dispatchNotification } = await import("@/lib/notifications/dispatcher");
const { runIntakeAutoSkipPass } = await import("@/lib/jobs/intake-auto-skip");
const { handleReminderCheck } =
  await import("@/lib/jobs/reminder/medication-reminder-check");

const TZ = "Europe/Berlin";
const MORNING = "2026-06-10T06:00:00.000Z";
const EVENING = "2026-06-10T18:00:00.000Z";
const ENDED_AT = "2026-06-10T10:00:00.000Z";

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

function req(method: string, path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(
  modulePath: string,
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  params: Record<string, string>,
  body?: unknown,
) {
  const route = (await import(/* @vite-ignore */ modulePath)) as Record<
    string,
    Handler
  >;
  const res = await route[method](req(method, path, body), {
    params: Promise.resolve(params),
  });
  return { status: res.status, body: await res.json() };
}

const endCourse = (id: string) =>
  call(
    "@/app/api/medications/[id]/courses/end/route",
    "POST",
    `/api/medications/${id}/courses/end`,
    { id },
  );
const putMedication = (id: string, body: unknown) =>
  call(
    "@/app/api/medications/[id]/route",
    "PUT",
    `/api/medications/${id}`,
    { id },
    body,
  );
const detail = async (id: string) =>
  (
    await call(
      "@/app/api/medications/[id]/route",
      "GET",
      `/api/medications/${id}`,
      { id },
    )
  ).body.data;

async function makeUser(): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "course-end",
      email: "course-end@example.test",
      timezone: TZ,
      locale: "en",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

/** Twice a day, 08:00 and 20:00, created early on the 10th. */
async function seedTwiceDaily(
  userId: string,
  window: { startsOn?: Date; endsOn?: Date } = {},
): Promise<string> {
  const medication = await getPrismaClient().medication.create({
    data: {
      userId,
      name: "Amoxicillin",
      dose: "500 mg",
      createdAt: new Date("2026-06-10T03:00:00.000Z"),
      notificationsEnabled: true,
      ...window,
      schedules: {
        create: {
          windowStart: "08:00",
          windowEnd: "08:00",
          timesOfDay: ["08:00", "20:00"],
          rrule: "FREQ=DAILY",
          scheduleType: "SCHEDULED",
        },
      },
    },
    select: { id: true },
  });
  return medication.id;
}

async function takeMorningDose(userId: string, medicationId: string) {
  await getPrismaClient().medicationIntakeEvent.create({
    data: {
      userId,
      medicationId,
      scheduledFor: new Date(MORNING),
      takenAt: new Date("2026-06-10T06:10:00.000Z"),
      source: "WEB",
    },
  });
}

async function liveRowsOn(medicationId: string, scheduledFor: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: {
      medicationId,
      deletedAt: null,
      scheduledFor: new Date(scheduledFor),
    },
  });
}

function dispatchedFor(medicationId: string): number {
  return vi
    .mocked(dispatchNotification)
    .mock.calls.filter(
      ([arg]) =>
        (arg as { metadata?: { medicationId?: string } }).metadata
          ?.medicationId === medicationId,
    ).length;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(dispatchNotification).mockClear();
  cookieJar.clear();
  headerJar.clear();
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the medication PUT takes the end as a date (#1280)", () => {
  it("answers 200 for a date and 422 for the full instant the button used to send", async () => {
    at(ENDED_AT);
    const userId = await makeUser();
    const id = await seedTwiceDaily(userId);

    const instant = await putMedication(id, { endsOn: ENDED_AT });
    expect(instant.status).toBe(422);

    const date = await putMedication(id, { endsOn: "2026-06-10" });
    expect(date.status, JSON.stringify(date.body)).toBe(200);
    // An end date written this way is the whole day: still running, still
    // offering End, no instant recorded.
    const read = await detail(id);
    expect(read.courseStatus).toBe("CURRENT");
    expect(read.canEndCourse).toBe(true);
    expect(read.endedAt).toBeNull();
    expect(read.courses[0]).toMatchObject({
      endsOn: "2026-06-10",
      endedAt: null,
    });
  });
});

describe("POST /courses/end ends the course now", () => {
  it("records today and the instant, and the reads serve it ended at once", async () => {
    at(ENDED_AT);
    const userId = await makeUser();
    const id = await seedTwiceDaily(userId);
    expect((await detail(id)).canEndCourse).toBe(true);

    const res = await endCourse(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({
      startsOn: "2026-06-10",
      endsOn: "2026-06-10",
      endedAt: ENDED_AT,
    });

    const course = await getPrismaClient().medicationCourse.findFirstOrThrow({
      where: { medicationId: id },
    });
    expect(course.endedAt?.toISOString()).toBe(ENDED_AT);
    const read = await detail(id);
    expect(read).toMatchObject({
      endedAt: ENDED_AT,
      courseStatus: "ENDED",
      canEndCourse: false,
      intakeActionable: false,
      remindersActive: false,
      canStartCourse: true,
    });
    expect(read.courses[0]).toMatchObject({
      status: "ENDED",
      endsOn: "2026-06-10",
      endedAt: ENDED_AT,
    });

    // A second press finds nothing running.
    const again = await endCourse(id);
    expect(again.status).toBe(409);
    expect(again.body.meta.errorCode).toBe("medications.course.notRunning");
  });

  it("drops the evening dose: not listed, not reminded, never missed", async () => {
    at("2026-06-10T09:00:00.000Z");
    const userId = await makeUser();
    const id = await seedTwiceDaily(userId);
    // The today list mints both placeholders before the course is ended.
    const today = () =>
      call(
        "@/app/api/medications/intake/route",
        "GET",
        "/api/medications/intake?scope=today",
        {},
      );
    expect((await today()).status).toBe(200);
    expect(await liveRowsOn(id, EVENING)).toHaveLength(1);

    at(ENDED_AT);
    expect((await endCourse(id)).status).toBe(200);
    expect(await liveRowsOn(id, EVENING)).toHaveLength(0);

    // The today list does not bring it back.
    at("2026-06-10T12:00:00.000Z");
    expect((await today()).status).toBe(200);
    expect(await liveRowsOn(id, EVENING)).toHaveLength(0);

    // Through the evening window and its follow-ups: no reminder, no
    // missed-dose placeholder.
    for (const tick of [
      "2026-06-10T18:00:00.000Z",
      "2026-06-10T18:45:00.000Z",
      "2026-06-10T19:30:00.000Z",
      "2026-06-10T21:00:00.000Z",
    ]) {
      at(tick);
      await handleReminderCheck([]);
    }
    expect(dispatchedFor(id)).toBe(0);
    expect(await liveRowsOn(id, EVENING)).toHaveLength(0);

    // Two days on, the auto-miss pass stamps the morning dose, which fell
    // due while the course ran and was never taken, and nothing after the
    // end.
    await runIntakeAutoSkipPass(getPrismaClient(), {
      nowMs: Date.parse("2026-06-12T12:00:00.000Z"),
    });
    const missed = await getPrismaClient().medicationIntakeEvent.findMany({
      where: { medicationId: id, autoMissed: true },
      select: { scheduledFor: true },
    });
    expect(missed.map((r) => r.scheduledFor.toISOString())).toEqual([MORNING]);
  });

  it("lists no evening dose when the day's list is first read after the end", async () => {
    at(ENDED_AT);
    const userId = await makeUser();
    const id = await seedTwiceDaily(userId);
    expect((await endCourse(id)).status).toBe(200);
    const today = await call(
      "@/app/api/medications/intake/route",
      "GET",
      "/api/medications/intake?scope=today",
      {},
    );
    expect(today.status).toBe(200);
    expect(await liveRowsOn(id, MORNING)).toHaveLength(1);
    expect(await liveRowsOn(id, EVENING)).toHaveLength(0);
  });

  it("keeps the morning dose taken before the end in compliance", async () => {
    at(ENDED_AT);
    const userId = await makeUser();
    const id = await seedTwiceDaily(userId);
    await takeMorningDose(userId, id);
    expect((await endCourse(id)).status).toBe(200);

    at("2026-06-11T08:00:00.000Z");
    const compliance = await call(
      "@/app/api/medications/[id]/compliance/route",
      "GET",
      `/api/medications/${id}/compliance`,
      { id },
    );
    expect(compliance.status).toBe(200);
    expect(compliance.body.data.compliance7).toMatchObject({
      totalExpected: 1,
      taken: 1,
      missed: 0,
      rate: 100,
    });

    const history = await call(
      "@/app/api/medications/[id]/dose-history/route",
      "GET",
      `/api/medications/${id}/dose-history?from=2026-06-10T00:00:00.000Z`,
      { id },
    );
    expect(history.status).toBe(200);
    const slots = (
      history.body.data.rows as Array<{
        kind: string;
        at: string;
        status: string;
      }>
    ).filter((r) => r.kind === "slot");
    expect(slots.map((r) => [r.at, r.status])).toEqual([
      [MORNING, "taken_on_time"],
    ]);
  });

  it("ends a medication without dates from its creation day", async () => {
    at(ENDED_AT);
    const userId = await makeUser();
    const id = await seedTwiceDaily(userId);
    expect(
      await getPrismaClient().medicationCourse.count({
        where: { medicationId: id },
      }),
    ).toBe(0);
    expect((await endCourse(id)).status).toBe(200);
    const row = await getPrismaClient().medication.findUniqueOrThrow({
      where: { id },
      select: { startsOn: true, endsOn: true, endedAt: true },
    });
    expect(row.startsOn?.toISOString().slice(0, 10)).toBe("2026-06-10");
    expect(row.endsOn?.toISOString().slice(0, 10)).toBe("2026-06-10");
    expect(row.endedAt?.toISOString()).toBe(ENDED_AT);
  });
});

describe("canEndCourse follows the course", () => {
  it.each([
    ["running (no dates)", {}, true],
    [
      "running (dated)",
      { startsOn: new Date("2026-06-01T00:00:00.000Z") },
      true,
    ],
    ["upcoming", { startsOn: new Date("2026-06-20T00:00:00.000Z") }, false],
    [
      "ended",
      {
        startsOn: new Date("2026-05-01T00:00:00.000Z"),
        endsOn: new Date("2026-05-31T00:00:00.000Z"),
      },
      false,
    ],
  ] as const)("%s → %s", async (_label, window, expected) => {
    at(ENDED_AT);
    const userId = await makeUser();
    const id = await seedTwiceDaily(userId, window);
    expect((await detail(id)).canEndCourse).toBe(expected);
    const list = await call(
      "@/app/api/medications/route",
      "GET",
      "/api/medications",
      {},
    );
    const entry = (
      list.body.data as Array<{ id: string; canEndCourse: boolean }>
    ).find((m) => m.id === id);
    expect(entry?.canEndCourse).toBe(expected);

    const res = await endCourse(id);
    expect(res.status).toBe(expected ? 200 : 409);
  });
});

describe("End follows what the caller may do in a shared record", () => {
  /** A second person who signs in and opens the owner's record at `access`. */
  async function openAs(
    ownerId: string,
    access: "READ" | "WRITE" | "MANAGE",
  ): Promise<string> {
    const prisma = getPrismaClient();
    const delegate = await prisma.user.create({
      data: {
        username: `course-end-${access.toLowerCase()}`,
        email: `course-end-${access.toLowerCase()}@example.test`,
        timezone: TZ,
        locale: "en",
      },
    });
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: ownerId,
      granteeId: delegate.id,
      access,
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    const session = await prisma.session.create({
      data: {
        userId: delegate.id,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    cookieJar.set("healthlog_session", session.id);
    await switchSessionTo(session.id, ownerId);
    return delegate.id;
  }

  async function listed(id: string) {
    const list = await call(
      "@/app/api/medications/route",
      "GET",
      "/api/medications",
      {},
    );
    expect(list.status).toBe(200);
    return (
      list.body.data as Array<{
        id: string;
        canEndCourse: boolean;
        canStartCourse: boolean;
      }>
    ).find((m) => m.id === id);
  }

  it("lets a manager end the course and names them in the trail", async () => {
    at(ENDED_AT);
    const ownerId = await makeUser();
    const id = await seedTwiceDaily(ownerId);
    const managerId = await openAs(ownerId, "MANAGE");

    expect((await detail(id)).canEndCourse).toBe(true);
    expect((await listed(id))?.canEndCourse).toBe(true);

    const res = await endCourse(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await getPrismaClient().medication.findUniqueOrThrow({
      where: { id },
      select: { endedAt: true },
    });
    expect(row.endedAt?.toISOString()).toBe(ENDED_AT);

    const audit = await getPrismaClient().auditLog.findFirstOrThrow({
      where: { action: "medication.course.end" },
    });
    expect(audit.userId).toBe(ownerId);
    expect(audit.actorUserId).toBe(managerId);
    expect(
      typeof audit.details === "string"
        ? JSON.parse(audit.details)
        : audit.details,
    ).toMatchObject({
      medicationId: id,
      fields: ["endedAt", "endsOn"],
      previous: { endsOn: null, endedAt: null },
    });
  });

  it.each(["READ", "WRITE"] as const)(
    "offers a %s delegate neither End nor Start, and refuses End",
    async (access) => {
      at(ENDED_AT);
      const ownerId = await makeUser();
      const id = await seedTwiceDaily(ownerId);
      await openAs(ownerId, access);

      const read = await detail(id);
      expect(read.courseStatus).toBe("CURRENT");
      expect(read.canEndCourse).toBe(false);
      expect(read.canStartCourse).toBe(false);
      const entry = await listed(id);
      expect(entry?.canEndCourse).toBe(false);
      expect(entry?.canStartCourse).toBe(false);

      const res = await endCourse(id);
      expect(res.status).toBe(403);
      const row = await getPrismaClient().medication.findUniqueOrThrow({
        where: { id },
        select: { endedAt: true },
      });
      expect(row.endedAt).toBeNull();
    },
  );

  it("does not let the delegate's view leak into the owner's cached list", async () => {
    at(ENDED_AT);
    const ownerId = await makeUser();
    const id = await seedTwiceDaily(ownerId);
    const ownerSession = cookieJar.get("healthlog_session")!;
    await openAs(ownerId, "READ");
    expect((await listed(id))?.canEndCourse).toBe(false);

    cookieJar.set("healthlog_session", ownerSession);
    expect((await listed(id))?.canEndCourse).toBe(true);
  });
});

describe("an edit that moves the end clears the instant", () => {
  it("reopens the course to the end of its new last day", async () => {
    at(ENDED_AT);
    const userId = await makeUser();
    const id = await seedTwiceDaily(userId);
    expect((await endCourse(id)).status).toBe(200);
    const course = await getPrismaClient().medicationCourse.findFirstOrThrow({
      where: { medicationId: id },
    });

    // Same last day, only the note: the instant stays.
    const note = await call(
      "@/app/api/medications/[id]/courses/[courseId]/route",
      "PATCH",
      `/api/medications/${id}/courses/${course.id}`,
      { id, courseId: course.id },
      { note: "Stopped after the morning dose" },
    );
    expect(note.status, JSON.stringify(note.body)).toBe(200);
    expect((await detail(id)).endedAt).toBe(ENDED_AT);

    // A later last day: a whole-day end again, running once more.
    const moved = await call(
      "@/app/api/medications/[id]/courses/[courseId]/route",
      "PATCH",
      `/api/medications/${id}/courses/${course.id}`,
      { id, courseId: course.id },
      { endsOn: "2026-06-12" },
    );
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const read = await detail(id);
    expect(read).toMatchObject({
      endedAt: null,
      courseStatus: "CURRENT",
      canEndCourse: true,
    });
  });
});
