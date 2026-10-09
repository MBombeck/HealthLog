/**
 * v1.42 (#613) — the day view, its index, the visit preparation, the
 * timeline and life events, driven as routes against real Postgres.
 *
 * What the unit tests cannot show: that each of the three ways this schema
 * stores a day lands on the right local day across a clock change, that a
 * switched-off module's rows are not in the answer, that a grant scoped to
 * some sections reads exactly those sections, that a life event is encrypted
 * at rest, audited, and never reaches the model-facing read of the same day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

let counter = 0;

async function makeUser(label: string, modules: Record<string, boolean> = {}) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `dv-${suffix}`,
      email: `dv-${suffix}@example.test`,
      displayName: `DV ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      modulePreferencesJson: modules,
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function shareWith(
  ownerId: string,
  delegateId: string,
  scope: Array<
    | "measurements"
    | "medications"
    | "labs"
    | "profile"
    | "illness"
    | "mind"
    | "cycle"
    | "documents"
  > | null,
) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: ownerId,
    granteeId: delegateId,
    access: "READ",
    scope,
  });
  await acceptGrant({ grantId: invited.id, granteeId: delegateId });
  const session = await signIn(delegateId);
  await switchSessionTo(session.id, ownerId);
}

async function call(
  handler: Handler,
  method: string,
  url: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<Response> {
  return handler(
    new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  );
}

async function json<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

async function getDay(date: string) {
  const { GET } = await import("@/app/api/day/[date]/route");
  return call(GET as Handler, "GET", `/api/day/${date}`, undefined, { date });
}

type Day = import("@/lib/day/contract").DayResponse;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("a local day across a clock change", () => {
  it("cuts readings, date strings and calendar dates on the record's own day", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("tz");
    // 00:30 local on the spring-forward day is still the 28th in UTC.
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-03-28T23:30:00.000Z"),
      },
    });
    // 23:59 local (CEST) is inside the 23-hour day; midnight is not.
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 81,
        unit: "kg",
        measuredAt: new Date("2026-03-29T21:59:00.000Z"),
      },
    });
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 82,
        unit: "kg",
        measuredAt: new Date("2026-03-29T22:00:00.000Z"),
      },
    });
    // A mood entry filed in New York on the 29th, logged when Berlin was
    // already on the 30th: the row's own date decides.
    await db.moodEntry.create({
      data: {
        userId: owner.id,
        date: "2026-03-29",
        tz: "America/New_York",
        mood: "GUT",
        score: 4,
        moodLoggedAt: new Date("2026-03-30T02:00:00.000Z"),
      },
    });
    // A calendar date: starts on the 29th whatever the zone.
    await db.medication.create({
      data: {
        userId: owner.id,
        name: "Ramipril",
        dose: "5 mg",
        startsOn: dayKeyAsUtcMidnight("2026-03-29"),
      },
    });
    await signIn(owner.id);

    const day = await json<Day>(await getDay("2026-03-29"));
    expect(day.tz).toBe("Europe/Berlin");
    expect(day.values.map((v) => v.value).sort()).toEqual([80, 81]);
    expect(day.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["mood", "medicationStart"]),
    );
    expect(day.running.find((r) => r.kind === "medication")).toMatchObject({
      title: "Ramipril",
      since: "2026-03-29",
      dayIndex: 1,
    });

    const before = await json<Day>(await getDay("2026-03-28"));
    expect(before.values).toEqual([]);
    expect(before.events.some((e) => e.kind === "mood")).toBe(false);

    const after = await json<Day>(await getDay("2026-03-30"));
    expect(after.values.map((v) => v.value)).toEqual([82]);
    expect(after.events.some((e) => e.kind === "mood")).toBe(false);
  });

  it("runs only records with a start of their own, never a profile fact or an entry date", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("run");
    // Filed on the 17th: a person who quit years ago would read "day 13".
    await db.healthProfileFactRevision.create({
      data: {
        userId: owner.id,
        kind: "SMOKING_STATUS",
        valueEncrypted: encryptToBytes("FORMER"),
        validFrom: new Date("2026-03-17T08:00:00.000Z"),
        provenance: "USER_REPORTED",
      },
    });
    // A medication filed on the 17th without a start date.
    await db.medication.create({
      data: {
        userId: owner.id,
        name: "Levothyroxine",
        dose: "50 µg",
        createdAt: new Date("2026-03-17T08:00:00.000Z"),
      },
    });
    await signIn(owner.id);

    const day = await json<Day>(await getDay("2026-03-29"));
    expect(day.running.map((r) => r.kind)).toEqual(["medication"]);
    expect(day.running[0]).toMatchObject({
      title: "Levothyroxine",
      since: null,
      dayIndex: null,
      dayCount: null,
    });
    // The entry's date still bounds which days show it.
    const before = await json<Day>(await getDay("2026-03-16"));
    expect(before.running).toEqual([]);
  });

  it("lists a medication once, with its course and the dose of that day", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("once");
    const glp = await db.medication.create({
      data: {
        userId: owner.id,
        name: "Mounjaro",
        dose: "7.5 mg",
        startsOn: dayKeyAsUtcMidnight("2026-01-15"),
      },
    });
    await db.medicationCourse.create({
      data: {
        userId: owner.id,
        medicationId: glp.id,
        startsOn: dayKeyAsUtcMidnight("2026-01-15"),
      },
    });
    for (const [from, value] of [
      ["2026-01-15", 2.5],
      ["2026-02-12", 5],
      ["2026-04-09", 7.5],
    ] as const) {
      await db.medicationDoseChange.create({
        data: {
          medicationId: glp.id,
          effectiveFrom: new Date(`${from}T08:00:00.000Z`),
          doseValue: value,
          doseUnit: "mg",
        },
      });
    }
    const ace = await db.medication.create({
      data: {
        userId: owner.id,
        name: "Ramipril",
        dose: "5 mg",
        startsOn: dayKeyAsUtcMidnight("2026-03-12"),
      },
    });
    await db.medicationCourse.create({
      data: {
        userId: owner.id,
        medicationId: ace.id,
        startsOn: dayKeyAsUtcMidnight("2026-03-12"),
      },
    });
    const pausedMed = await db.medication.create({
      data: {
        userId: owner.id,
        name: "Metformin",
        dose: "500 mg",
        startsOn: dayKeyAsUtcMidnight("2026-01-01"),
      },
    });
    await db.medicationPauseEra.create({
      data: {
        userId: owner.id,
        medicationId: pausedMed.id,
        pausedAt: new Date("2026-03-01T08:00:00.000Z"),
        resumedAt: new Date("2026-03-20T08:00:00.000Z"),
      },
    });
    await signIn(owner.id);

    const march = await json<Day>(await getDay("2026-03-15"));
    const names = march.running.map((r) => r.title).sort();
    expect(names).toEqual(["Metformin", "Mounjaro", "Ramipril"]);
    const mj = march.running.find((r) => r.title === "Mounjaro");
    // The course lends its days; the dose is the one in effect that day.
    expect(mj).toMatchObject({ kind: "medicationCourse", sub: "5 mg" });
    expect(march.running.find((r) => r.title === "Ramipril")).toMatchObject({
      kind: "medicationCourse",
      sub: "5 mg",
    });
    // Paused that day: one entry, the paused one.
    expect(march.running.find((r) => r.title === "Metformin")).toMatchObject({
      kind: "medicationPause",
      sub: null,
    });

    const january = await json<Day>(await getDay("2026-01-20"));
    expect(january.running.filter((r) => r.title === "Mounjaro")).toEqual([
      expect.objectContaining({ sub: "2.5 mg" }),
    ]);
  });

  it("holds 25 hours on the fall-back day", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("fall");
    // 23:30 CET on the 25th, after the extra hour.
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 79,
        unit: "kg",
        measuredAt: new Date("2026-10-25T22:30:00.000Z"),
      },
    });
    // 00:30 CEST on the 25th, before the change.
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 78,
        unit: "kg",
        measuredAt: new Date("2026-10-24T22:30:00.000Z"),
      },
    });
    await signIn(owner.id);
    const day = await json<Day>(await getDay("2026-10-25"));
    expect(day.values.map((v) => v.value).sort()).toEqual([78, 79]);
  });

  it("refuses a date that is not a calendar date", async () => {
    const owner = await makeUser("bad");
    await signIn(owner.id);
    const response = await getDay("2026-02-30");
    expect(response.status).toBe(422);
  });
});

describe("modules", () => {
  it("leaves a switched-off module's rows out without naming them", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("mod", { mood: false, recovery: false });
    await db.moodEntry.create({
      data: {
        userId: owner.id,
        date: "2026-03-10",
        tz: "Europe/Berlin",
        mood: "GUT",
        score: 4,
        moodLoggedAt: new Date("2026-03-10T08:00:00.000Z"),
      },
    });
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "HEART_RATE_VARIABILITY",
        value: 45,
        unit: "ms",
        measuredAt: new Date("2026-03-10T06:00:00.000Z"),
      },
    });
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-03-10T06:00:00.000Z"),
      },
    });
    await signIn(owner.id);
    const day = await json<Day>(await getDay("2026-03-10"));
    expect(day.events).toEqual([]);
    expect(day.values.map((v) => v.type)).toEqual(["WEIGHT"]);
    expect(day.sections).toEqual({});
  });

  it("answers the timeline only with the opt-in module on", async () => {
    const off = await makeUser("tl-off");
    await signIn(off.id);
    const { GET } = await import("@/app/api/timeline/route");
    const refused = await call(GET as Handler, "GET", "/api/timeline");
    expect(refused.status).toBe(403);

    const on = await makeUser("tl-on", { timeline: true });
    await signIn(on.id);
    const ok = await call(GET as Handler, "GET", "/api/timeline");
    expect(ok.status).toBe(200);
  });
});

describe("sharing", () => {
  async function seedOwner() {
    const db = getPrismaClient();
    const owner = await makeUser("share");
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-03-10T06:00:00.000Z"),
      },
    });
    const med = await db.medication.create({
      data: { userId: owner.id, name: "Ramipril", dose: "5 mg" },
    });
    await db.medicationIntakeEvent.create({
      data: {
        userId: owner.id,
        medicationId: med.id,
        scheduledFor: new Date("2026-03-10T07:00:00.000Z"),
        takenAt: new Date("2026-03-10T07:05:00.000Z"),
      },
    });
    await db.moodEntry.create({
      data: {
        userId: owner.id,
        date: "2026-03-10",
        tz: "Europe/Berlin",
        mood: "GUT",
        score: 4,
        moodLoggedAt: new Date("2026-03-10T08:00:00.000Z"),
      },
    });
    return owner;
  }

  it("reads only the sections a scoped grant covers and names the rest", async () => {
    const owner = await seedOwner();
    const delegate = await makeUser("scoped");
    await shareWith(owner.id, delegate.id, ["measurements"]);
    const response = await getDay("2026-03-10");
    expect(response.status).toBe(200);
    const day = await json<Day>(response);
    expect(day.values.map((v) => v.value)).toEqual([80]);
    expect(day.events).toEqual([]);
    expect(day.sections.medications).toEqual({
      available: false,
      reason: "not_shared",
    });
    expect(day.sections.mood).toEqual({
      available: false,
      reason: "not_shared",
    });
    expect(day.sections.values).toBeUndefined();
  });

  it("opens the covered sections of a wider grant", async () => {
    const owner = await seedOwner();
    const delegate = await makeUser("wider");
    await shareWith(owner.id, delegate.id, ["measurements", "medications"]);
    const day = await json<Day>(await getDay("2026-03-10"));
    expect(day.events.map((e) => e.kind)).toEqual(["intake"]);
    expect(day.sections.mood?.reason).toBe("not_shared");
  });

  it("refuses a grant that does not open the readings", async () => {
    const owner = await seedOwner();
    const delegate = await makeUser("mind-only");
    await shareWith(owner.id, delegate.id, ["mind"]);
    expect((await getDay("2026-03-10")).status).toBe(403);
  });

  it("gives a full grant the record but keeps the environment for the owner", async () => {
    const owner = await seedOwner();
    const delegate = await makeUser("full");
    await shareWith(owner.id, delegate.id, null);
    const day = await json<Day>(await getDay("2026-03-10"));
    expect(day.events.map((e) => e.kind).sort()).toEqual(["intake", "mood"]);
    expect(day.sections).toEqual({
      environment: { available: false, reason: "not_shared" },
    });
  });

  it("narrows the day index the same way", async () => {
    const owner = await seedOwner();
    const delegate = await makeUser("index");
    await shareWith(owner.id, delegate.id, ["measurements"]);
    const { GET } = await import("@/app/api/day/index/route");
    const index = await json<{ days: Record<string, string[]> }>(
      await call(
        GET as Handler,
        "GET",
        "/api/day/index?from=2026-03-01&to=2026-03-31",
      ),
    );
    expect(index.days).toEqual({ "2026-03-10": ["values"] });
  });
});

describe("life events", () => {
  it("encrypts, audits, shows in the day and never reaches the model read", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("le", { timeline: true });
    await signIn(owner.id);
    const { POST, GET } = await import("@/app/api/life-events/route");
    const created = await call(POST as Handler, "POST", "/api/life-events", {
      category: "LOSS",
      startDate: "2026-03-10",
      precision: "DAY",
      title: "Zqx grandmother",
      note: "Zqx note",
    });
    expect(created.status).toBe(201);
    const event = await json<{ id: string; title: string }>(created);
    expect(event.title).toBe("Zqx grandmother");

    const row = await db.lifeEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(Buffer.from(row.titleEncrypted).toString("utf8")).not.toContain(
      "Zqx",
    );
    const audit = await db.auditLog.findFirst({
      where: { action: "life_event.create" },
    });
    expect(audit?.details ?? "").not.toContain("Zqx");

    const list = await json<{ events: Array<{ title: string }> }>(
      await call(GET as Handler, "GET", "/api/life-events"),
    );
    expect(list.events.map((e) => e.title)).toEqual(["Zqx grandmother"]);

    const day = await json<Day>(await getDay("2026-03-10"));
    expect(day.events.map((e) => e.kind)).toEqual(["lifeEvent"]);

    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-03-10T06:00:00.000Z"),
      },
    });
    const { executeCoachTool } = await import("@/lib/ai/coach/tools/executor");
    const forModel = await executeCoachTool({
      userId: owner.id,
      name: "get_day",
      rawArguments: JSON.stringify({ date: "2026-03-10" }),
    });
    expect(forModel.present).toBe(true);
    expect(JSON.stringify(forModel)).not.toMatch(/Zqx|lifeEvent/);

    // Edit with a misaligned precision is refused; a valid one lands.
    const { PATCH, DELETE } = await import("@/app/api/life-events/[id]/route");
    const bad = await call(
      PATCH as Handler,
      "PATCH",
      `/api/life-events/${event.id}`,
      { precision: "YEAR" },
      { id: event.id },
    );
    expect(bad.status).toBe(422);
    const good = await call(
      PATCH as Handler,
      "PATCH",
      `/api/life-events/${event.id}`,
      { category: "FAMILY" },
      { id: event.id },
    );
    expect(good.status).toBe(200);
    const removed = await call(
      DELETE as Handler,
      "DELETE",
      `/api/life-events/${event.id}`,
      undefined,
      { id: event.id },
    );
    expect(removed.status).toBe(200);
    expect(
      (await db.lifeEvent.findUniqueOrThrow({ where: { id: event.id } }))
        .deletedAt,
    ).not.toBeNull();
    const again = await call(
      DELETE as Handler,
      "DELETE",
      `/api/life-events/${event.id}`,
      undefined,
      { id: event.id },
    );
    expect(again.status).toBe(404);
  });

  it("refuses another record's event as not found", async () => {
    const db = getPrismaClient();
    const a = await makeUser("a");
    const b = await makeUser("b");
    const theirs = await db.lifeEvent.create({
      data: {
        userId: a.id,
        category: "HOME",
        startDate: "2020-01-01",
        precision: "YEAR",
        titleEncrypted: encryptToBytes("Moved"),
      },
    });
    await signIn(b.id);
    const { PATCH } = await import("@/app/api/life-events/[id]/route");
    const response = await call(
      PATCH as Handler,
      "PATCH",
      `/api/life-events/${theirs.id}`,
      { category: "WORK" },
      { id: theirs.id },
    );
    expect(response.status).toBe(404);
  });
});

describe("life events are the owner's only", () => {
  async function seedOwnerWithEvent() {
    const db = getPrismaClient();
    const owner = await makeUser("le-owner", { timeline: true });
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-03-10T06:00:00.000Z"),
      },
    });
    const { encryptToBytes } = await import("@/lib/ai/coach/bytes-codec");
    const event = await db.lifeEvent.create({
      data: {
        userId: owner.id,
        category: "LOSS",
        startDate: "2026-03-10",
        precision: "DAY",
        titleEncrypted: encryptToBytes("Zqx private"),
      },
    });
    return { owner, event };
  }

  async function manageWith(ownerId: string, delegateId: string) {
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: ownerId,
      granteeId: delegateId,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegateId });
    const session = await signIn(delegateId);
    await switchSessionTo(session.id, ownerId);
  }

  const grants: Array<
    [string, (ownerId: string, delegateId: string) => Promise<void>]
  > = [
    ["a profile share", (o, d) => shareWith(o, d, ["profile", "measurements"])],
    ["a whole-record share", (o, d) => shareWith(o, d, null)],
    ["a MANAGE share", manageWith],
  ];

  for (const [label, grant] of grants) {
    it(`shows none to ${label}`, async () => {
      const { owner, event } = await seedOwnerWithEvent();
      const delegate = await makeUser("le-delegate");
      await grant(owner.id, delegate.id);

      const routes = await import("@/app/api/life-events/route");
      const byId = await import("@/app/api/life-events/[id]/route");
      expect(
        (await call(routes.GET as Handler, "GET", "/api/life-events")).status,
      ).toBe(403);
      expect(
        (
          await call(routes.POST as Handler, "POST", "/api/life-events", {
            category: "WORK",
            startDate: "2024-01-01",
            precision: "YEAR",
            title: "New job",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            byId.PATCH as Handler,
            "PATCH",
            `/api/life-events/${event.id}`,
            { category: "FAMILY" },
            { id: event.id },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            byId.DELETE as Handler,
            "DELETE",
            `/api/life-events/${event.id}`,
            undefined,
            { id: event.id },
          )
        ).status,
      ).toBe(403);

      const day = await json<Day>(await getDay("2026-03-10"));
      expect(day.values.map((v) => v.value)).toEqual([80]);
      expect(JSON.stringify(day)).not.toMatch(/Zqx|"lifeEvent"/);
      expect(day.sections.lifeEvents).toEqual({
        available: false,
        reason: "not_shared",
      });

      const { GET: index } = await import("@/app/api/day/index/route");
      const days = await json<{ days: Record<string, string[]> }>(
        await call(
          index as Handler,
          "GET",
          "/api/day/index?from=2026-03-01&to=2026-03-31",
        ),
      );
      expect(days.days["2026-03-10"]).not.toContain("lifeEvents");

      const { GET: timeline } = await import("@/app/api/timeline/route");
      const lanes = await call(
        timeline as Handler,
        "GET",
        "/api/timeline?zoom=year&to=2026-03-31",
      );
      if (lanes.status === 200) {
        const body =
          await json<import("@/lib/day/contract").TimelineResponse>(lanes);
        expect(body.lanes.map((l) => l.key)).not.toContain("life");
        expect(JSON.stringify(body)).not.toContain("Zqx");
      } else {
        expect(lanes.status).toBe(403);
      }

      const { GET: readiness } =
        await import("@/app/api/timeline/readiness/route");
      const ready = await call(
        readiness as Handler,
        "GET",
        "/api/timeline/readiness",
      );
      if (ready.status === 200) {
        const body =
          await json<import("@/lib/day/contract").TimelineReadinessResponse>(
            ready,
          );
        expect(body.lanes.map((l) => l.key)).not.toContain("life");
      } else {
        expect(ready.status).toBe(403);
      }

      // The event is untouched.
      const row = await getPrismaClient().lifeEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect([row.category, row.deletedAt]).toEqual(["LOSS", null]);
    });
  }

  it("shows the owner their own events in the timeline", async () => {
    const { owner } = await seedOwnerWithEvent();
    await signIn(owner.id);
    const { GET: timeline } = await import("@/app/api/timeline/route");
    const body = await json<import("@/lib/day/contract").TimelineResponse>(
      await call(
        timeline as Handler,
        "GET",
        "/api/timeline?zoom=year&to=2026-03-31",
      ),
    );
    expect(body.lanes.map((l) => l.key)).toContain("life");
  });
});

describe("notable days", () => {
  it("marks a three-month high in the day, the index and the visit window", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("notable");
    const rows = [];
    for (let i = 0; i < 150; i += 1) {
      rows.push({
        userId: owner.id,
        type: "WEIGHT" as const,
        value: 80,
        unit: "kg",
        measuredAt: new Date(Date.UTC(2025, 10, 1, 7) + i * 86_400_000),
      });
    }
    await db.measurement.createMany({ data: rows });
    // 2026-03-31 (day 150) reads higher than every day before.
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 84,
        unit: "kg",
        measuredAt: new Date("2026-03-31T07:00:00.000Z"),
      },
    });
    await db.encounter.create({
      data: {
        userId: owner.id,
        occurredAt: new Date("2026-02-01T09:00:00.000Z"),
        status: "DONE",
        kind: "ROUTINE",
      },
    });
    await signIn(owner.id);

    const day = await json<Day>(await getDay("2026-03-31"));
    expect(day.notable).toEqual([
      {
        kind: "extremeHigh",
        type: "WEIGHT",
        params: { since: "2025-11-01", value: 84 },
      },
    ]);
    expect(day.values[0].band).toMatchObject({ lo: expect.any(Number) });

    const first = await json<Day>(await getDay("2025-11-01"));
    expect(first.notable).toEqual([
      { kind: "firstValue", type: "WEIGHT", params: { type: "WEIGHT" } },
    ]);

    const { GET: index } = await import("@/app/api/day/index/route");
    const idx = await json<{ notable: string[] }>(
      await call(
        index as Handler,
        "GET",
        "/api/day/index?from=2026-03-01&to=2026-03-31",
      ),
    );
    expect(idx.notable).toEqual(["2026-03-31"]);

    const { GET: notable } = await import("@/app/api/day/notable/route");
    const window = await json<{
      from: string;
      anchor: string;
      observations: Array<{ date: string; kind: string }>;
    }>(await call(notable as Handler, "GET", "/api/day/notable?to=2026-04-30"));
    expect(window.anchor).toBe("lastVisit");
    expect(window.from).toBe("2026-02-01");
    expect(window.observations.map((o) => [o.date, o.kind])).toEqual([
      ["2026-03-31", "extremeHigh"],
      ["2026-04-01", "gap"],
    ]);
  });
});

describe("timeline", () => {
  it("lays the record out, lists the standing items and rates the lanes", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("tl", { timeline: true });
    const med = await db.medication.create({
      data: { userId: owner.id, name: "Metformin", dose: "500 mg" },
    });
    await db.medicationIntakeEvent.create({
      data: {
        userId: owner.id,
        medicationId: med.id,
        scheduledFor: new Date("2026-01-05T07:00:00.000Z"),
        takenAt: new Date("2026-01-05T07:00:00.000Z"),
      },
    });
    await db.medication.create({
      data: { userId: owner.id, name: "Never taken", dose: "1" },
    });
    await db.allergy.create({
      data: { userId: owner.id, substance: "Penicillin" },
    });
    await db.illnessEpisode.create({
      data: {
        userId: owner.id,
        label: "Flu",
        type: "INFECTION",
        onsetAt: new Date("2026-02-01T08:00:00.000Z"),
        resolvedAt: new Date("2026-02-08T08:00:00.000Z"),
      },
    });
    await signIn(owner.id);

    const { GET } = await import("@/app/api/timeline/route");
    const timeline = await json<import("@/lib/day/contract").TimelineResponse>(
      await call(
        GET as Handler,
        "GET",
        "/api/timeline?zoom=year&to=2026-03-31",
      ),
    );
    const meds = timeline.lanes.find((l) => l.key === "medications");
    expect(meds?.items[0]).toMatchObject({
      label: "Metformin",
      start: "2026-01-05",
      startKnown: false,
      open: true,
    });
    expect(
      timeline.lanes.find((l) => l.key === "illness")?.items[0],
    ).toMatchObject({
      start: "2026-02-01",
      end: "2026-02-08",
      kind: "episode",
    });
    expect(timeline.standing.map((s) => s.label).sort()).toEqual([
      "Never taken",
      "Penicillin",
    ]);
    expect(timeline.range.dataFrom).toBe("2026-01-05");

    const bad = await call(GET as Handler, "GET", "/api/timeline?values=NOPE");
    expect(bad.status).toBe(422);

    const { GET: readiness } =
      await import("@/app/api/timeline/readiness/route");
    const inventory = await json<
      import("@/lib/day/contract").TimelineReadinessResponse
    >(await call(readiness as Handler, "GET", "/api/timeline/readiness"));
    const byKey = Object.fromEntries(inventory.lanes.map((l) => [l.key, l]));
    expect(byKey.medications.status).toBe("thin");
    expect(byKey.medications.gaps[0].href).toMatch(
      /^\/medications\/.+\?edit=1$/,
    );
    expect(byKey.illness.status).toBe("carries");
    expect(byKey.allergies).toMatchObject({ status: "thin", gaps: [] });
    expect(byKey.values.status).toBe("empty");
    expect(inventory.verdict).toBe("thin");
  });

  it("averages value series per bucket, counts the readings and leaves gaps out", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("tl-values", { timeline: true });
    const reading = (at: string, value: number) => ({
      userId: owner.id,
      type: "BLOOD_PRESSURE_SYS" as const,
      value,
      unit: "mmHg",
      measuredAt: new Date(at),
    });
    await db.measurement.createMany({
      data: [
        // Two readings on one January day, one on another: three readings,
        // two days, each day weighing one.
        reading("2026-01-10T07:00:00.000Z", 120),
        reading("2026-01-10T19:00:00.000Z", 130),
        reading("2026-01-20T07:00:00.000Z", 135),
        // Nothing in February.
        reading("2026-03-05T07:00:00.000Z", 128),
      ],
    });
    await signIn(owner.id);

    const { GET } = await import("@/app/api/timeline/route");
    const timeline = await json<import("@/lib/day/contract").TimelineResponse>(
      await call(
        GET as Handler,
        "GET",
        "/api/timeline?zoom=year&to=2026-03-31&values=BLOOD_PRESSURE_SYS",
      ),
    );
    expect(timeline.bucket).toBe("month");
    expect(timeline.series).toEqual([
      {
        key: "BLOOD_PRESSURE_SYS",
        unit: "mmHg",
        points: [
          { t: "2026-01-01", mean: 130, count: 3 },
          { t: "2026-03-01", mean: 128, count: 1 },
        ],
      },
    ]);

    const weekly = await json<import("@/lib/day/contract").TimelineResponse>(
      await call(
        GET as Handler,
        "GET",
        "/api/timeline?zoom=quarter&to=2026-03-31&values=BLOOD_PRESSURE_SYS",
      ),
    );
    expect(weekly.bucket).toBe("week");
    expect(weekly.series[0].points.map((p) => [p.t, p.count])).toEqual([
      ["2026-01-05", 2],
      ["2026-01-19", 1],
      ["2026-03-02", 1],
    ]);

    // A chosen range under six weeks averages single days; the two
    // readings of 10 January stay one day.
    const daily = await json<import("@/lib/day/contract").TimelineResponse>(
      await call(
        GET as Handler,
        "GET",
        "/api/timeline?zoom=range&from=2026-01-05&to=2026-01-25&values=BLOOD_PRESSURE_SYS",
      ),
    );
    expect(daily.zoom).toBe("range");
    expect(daily.bucket).toBe("day");
    expect(daily.range).toMatchObject({ from: "2026-01-05", to: "2026-01-25" });
    expect(daily.series[0].points).toEqual([
      { t: "2026-01-10", mean: 125, count: 2 },
      { t: "2026-01-20", mean: 135, count: 1 },
    ]);
    // Four months and more: months, as the fixed zooms draw them.
    const monthly = await json<import("@/lib/day/contract").TimelineResponse>(
      await call(
        GET as Handler,
        "GET",
        "/api/timeline?zoom=range&from=2025-12-01&to=2026-03-31&values=BLOOD_PRESSURE_SYS",
      ),
    );
    expect(monthly.bucket).toBe("month");
    // A range needs both ends, and spans fifteen years at most.
    for (const query of [
      "zoom=range",
      "zoom=range&from=2026-01-01",
      "zoom=range&from=2000-01-01&to=2026-01-01",
    ]) {
      expect(
        (await call(GET as Handler, "GET", `/api/timeline?${query}`)).status,
        query,
      ).toBe(422);
    }

    // No cap on the count: seven, and an unknown name still refused.
    const seven =
      "BLOOD_PRESSURE_SYS,BLOOD_PRESSURE_DIA,WEIGHT,PULSE,BODY_FAT,MOOD,BLOOD_GLUCOSE";
    expect(
      (await call(GET as Handler, "GET", `/api/timeline?values=${seven}`))
        .status,
    ).toBe(200);
    expect(
      (await call(GET as Handler, "GET", `/api/timeline?values=${seven},NOPE`))
        .status,
    ).toBe(422);
  });

  it("tags every item of one medication with its id, so it draws on one row", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("tl-group", { timeline: true });
    const med = await db.medication.create({
      data: {
        userId: owner.id,
        name: "Mounjaro",
        dose: "7.5 mg",
        startsOn: dayKeyAsUtcMidnight("2026-01-05"),
      },
    });
    const other = await db.medication.create({
      data: {
        userId: owner.id,
        name: "Ramipril",
        dose: "5 mg",
        startsOn: dayKeyAsUtcMidnight("2025-06-01"),
      },
    });
    await db.medicationCourse.create({
      data: {
        userId: owner.id,
        medicationId: med.id,
        startsOn: dayKeyAsUtcMidnight("2026-01-05"),
      },
    });
    await db.medicationDoseChange.createMany({
      data: [
        {
          medicationId: med.id,
          effectiveFrom: new Date("2026-01-05T08:00:00.000Z"),
          doseValue: 2.5,
          doseUnit: "mg",
        },
        {
          medicationId: med.id,
          effectiveFrom: new Date("2026-02-02T08:00:00.000Z"),
          doseValue: 5,
          doseUnit: "mg",
        },
      ],
    });
    await db.medicationPauseEra.create({
      data: {
        userId: owner.id,
        medicationId: med.id,
        pausedAt: new Date("2026-03-01T08:00:00.000Z"),
        resumedAt: new Date("2026-03-10T08:00:00.000Z"),
      },
    });
    await signIn(owner.id);

    const { GET } = await import("@/app/api/timeline/route");
    const timeline = await json<import("@/lib/day/contract").TimelineResponse>(
      await call(
        GET as Handler,
        "GET",
        "/api/timeline?zoom=year&to=2026-03-31",
      ),
    );
    const items = timeline.lanes.find((l) => l.key === "medications")!.items;
    const byGroup = new Map<string | null, string[]>();
    for (const i of items) {
      byGroup.set(i.group, [...(byGroup.get(i.group) ?? []), i.kind]);
    }
    // Six items, two medications: Mounjaro's own span, its course, its
    // two dose changes and its pause all carry its id.
    expect(items).toHaveLength(6);
    expect([...byGroup.keys()].sort()).toEqual([med.id, other.id].sort());
    expect(byGroup.get(med.id)!.sort()).toEqual(
      ["course", "doseChange", "doseChange", "medication", "pause"].sort(),
    );
    expect(byGroup.get(other.id)).toEqual(["medication"]);
    expect(
      items.find((i) => i.kind === "doseChange" && i.start === "2026-02-02"),
    ).toMatchObject({ label: "Mounjaro", sub: "5 mg", group: med.id });
  });

  it("offers every value series the record has, and answers fifteen at once", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("tl-many", {
      timeline: true,
      mood: true,
      glucose: true,
      recovery: true,
    });
    const types = [
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "WEIGHT",
      "PULSE",
      "BODY_FAT",
      "BLOOD_GLUCOSE",
      "ACTIVITY_STEPS",
      "OXYGEN_SATURATION",
      "HEART_RATE_VARIABILITY",
      "BODY_TEMPERATURE",
      "VO2_MAX",
      "RESPIRATORY_RATE",
      "MUSCLE_MASS",
      "BONE_MASS",
    ] as const;
    // A reading a day for a year, every type: about five thousand rows.
    const rows = [];
    for (const [i, type] of types.entries()) {
      for (let d = 0; d < 365; d++) {
        const at = new Date(Date.UTC(2025, 3, 1 + d, 7, i));
        rows.push({
          userId: owner.id,
          type,
          value: 50 + (d % 30) + i,
          unit: "x",
          measuredAt: at,
        });
      }
    }
    await db.measurement.createMany({ data: rows });
    // An event type is an occurrence, not a value: never offered.
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "HIGH_HEART_RATE_EVENT",
        value: 1,
        unit: "count",
        measuredAt: new Date("2026-01-10T07:00:00.000Z"),
      },
    });
    await db.moodEntry.create({
      data: {
        userId: owner.id,
        date: "2026-01-10",
        score: 4,
        mood: "GUT",
        moodLoggedAt: new Date("2026-01-10T19:00:00.000Z"),
      },
    });
    await signIn(owner.id);

    const { GET } = await import("@/app/api/timeline/route");
    const values = [...types, "MOOD"].join(",");
    expect(values.split(",")).toHaveLength(15);
    const started = performance.now();
    const res = await call(
      GET as Handler,
      "GET",
      `/api/timeline?zoom=year&to=2026-03-31&values=${values}`,
    );
    const took = performance.now() - started;
    const timeline =
      await json<import("@/lib/day/contract").TimelineResponse>(res);
    expect(timeline.series).toHaveLength(15);
    expect(timeline.series.every((s) => s.points.length > 0)).toBe(true);
    expect(timeline.availableSeries).toEqual(
      expect.arrayContaining([...types, "MOOD"]),
    );
    expect(timeline.availableSeries).toHaveLength(15);
    expect(timeline.availableSeries).not.toContain("HIGH_HEART_RATE_EVENT");
    // Fifteen series over a year of daily readings answer in about a tenth
    // of a second against the test database; the bound is generous so a
    // slow runner does not fail it, and still catches a read gone quadratic.
    expect(took).toBeLessThan(5_000);
  });

  it("averages quarters over the years, live before the fold window and rolled up after it", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("tl-quarters", { timeline: true });
    const reading = (at: string, value: number) => ({
      userId: owner.id,
      type: "WEIGHT" as const,
      value,
      unit: "kg",
      measuredAt: new Date(at),
    });
    await db.measurement.createMany({
      data: [
        // Before the five-year fold window: read live.
        reading("2018-02-10T07:00:00.000Z", 90),
        reading("2018-03-10T07:00:00.000Z", 88),
        // Inside it: read from the rollups. January has three days,
        // February one; the quarter's mean weighs the four days alike.
        reading("2024-01-10T07:00:00.000Z", 80),
        reading("2024-01-11T07:00:00.000Z", 80),
        reading("2024-01-12T07:00:00.000Z", 80),
        reading("2024-02-10T07:00:00.000Z", 84),
        // Nothing from April 2024 to March 2025.
        reading("2025-05-10T07:00:00.000Z", 79),
      ],
    });
    const { recomputeUserRollups } =
      await import("@/lib/rollups/measurement-rollups");
    await recomputeUserRollups(owner.id, {
      types: ["WEIGHT"],
      from: new Date("2018-01-01T00:00:00.000Z"),
      to: new Date(),
    });
    await signIn(owner.id);

    const { GET } = await import("@/app/api/timeline/route");
    const timeline = await json<import("@/lib/day/contract").TimelineResponse>(
      await call(GET as Handler, "GET", "/api/timeline?zoom=all&values=WEIGHT"),
    );
    expect(timeline.bucket).toBe("quarter");
    expect(timeline.series[0].points).toEqual([
      { t: "2018-01-01", mean: 89, count: 2 },
      { t: "2024-01-01", mean: 81, count: 4 },
      { t: "2025-04-01", mean: 79, count: 1 },
    ]);
  });
});

describe("scores", () => {
  const DAY = "2026-03-10";
  const shift = (key: string, days: number) =>
    new Date(Date.parse(`${key}T12:00:00.000Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10);

  /** Ten days of every score up to and including `DAY`. */
  async function seedScores(userId: string) {
    const db = getPrismaClient();
    for (let i = 10; i >= 0; i -= 1) {
      const key = shift(DAY, -i);
      await db.healthScoreRecord.create({
        data: {
          userId,
          dayKey: key,
          timezone: "Europe/Berlin",
          composite: i === 0 ? 74 : 68 + (i % 3),
          band: "green",
          scoreVersion: 1,
          composition: ["sleep"],
          pillarScores: { sleep: 70 },
          inputFingerprint: "a".repeat(64),
        },
      });
      // The nightly proxy is stamped at noon UTC of the day that ended.
      await db.measurement.create({
        data: {
          userId,
          type: "RECOVERY_SCORE",
          value: i === 0 ? 63 : 70 + (i % 4),
          unit: "score",
          source: "COMPUTED",
          measuredAt: new Date(`${shift(key, -1)}T12:00:00.000Z`),
        },
      });
      await db.measurement.create({
        data: {
          userId,
          type: "STRAIN_SCORE",
          value: i === 0 ? 41 : 30 + (i % 5),
          unit: "score",
          source: "COMPUTED",
          measuredAt: new Date(`${key}T12:00:00.000Z`),
        },
      });
      await db.measurement.create({
        data: {
          userId,
          type: "SLEEP_DURATION",
          value: 420 + (i % 3) * 15,
          unit: "min",
          sleepStage: "ASLEEP",
          source: "APPLE_HEALTH",
          measuredAt: new Date(`${key}T05:00:00.000Z`),
        },
      });
    }
    await db.measurement.create({
      data: {
        userId,
        type: "RECOVERY_SCORE",
        value: 55,
        unit: "score",
        source: "WHOOP",
        measuredAt: new Date(`${DAY}T06:30:00.000Z`),
      },
    });
  }

  it("shows every score the day holds, on the day it describes", async () => {
    const owner = await makeUser("scores-all");
    await seedScores(owner.id);
    await signIn(owner.id);
    const day = await json<Day>(await getDay(DAY));
    expect(day.scores.map((s) => s.key)).toEqual([
      "healthScore",
      "readiness",
      "recovery",
      "sleepScore",
      "strain",
    ]);
    const by = Object.fromEntries(day.scores.map((s) => [s.key, s]));
    expect(by.healthScore).toMatchObject({ value: 74, max: 100 });
    // The proxy stamped on the 9th is the readiness of the 10th.
    expect(by.readiness).toMatchObject({ value: 63, source: "COMPUTED" });
    expect(by.recovery).toMatchObject({ value: 55, source: "WHOOP" });
    expect(by.strain).toMatchObject({ value: 41, max: 100 });
    expect(by.sleepScore?.value).toBeGreaterThan(0);
    expect(by.readiness?.band).not.toBeNull();
    expect(by.healthScore?.band?.n).toBe(10);
    // A stored score is not also a reading of the day it is stamped on.
    expect(
      day.values.filter((v) =>
        ["RECOVERY_SCORE", "STRAIN_SCORE", "DAY_STRAIN"].includes(v.type),
      ),
    ).toEqual([]);
  });

  it("shows a device's day strain alone, on its own scale", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("scores-device");
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "DAY_STRAIN",
        value: 12.44,
        unit: "score",
        source: "WHOOP",
        measuredAt: new Date(`${DAY}T07:00:00.000Z`),
      },
    });
    await signIn(owner.id);
    const day = await json<Day>(await getDay(DAY));
    expect(day.scores).toEqual([
      { key: "strain", value: 12.4, max: 21, source: "WHOOP", band: null },
    ]);
    expect(day.values).toEqual([]);
  });

  it("sends no scores for a day without any", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("scores-none");
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(`${DAY}T06:00:00.000Z`),
      },
    });
    await signIn(owner.id);
    const day = await json<Day>(await getDay(DAY));
    expect(day.scores).toEqual([]);
    expect(day.sections.scores).toBeUndefined();
  });

  it("names the scores as not shared under a scoped grant and opens them to a whole-record one", async () => {
    const owner = await makeUser("scores-share");
    await seedScores(owner.id);
    const scoped = await makeUser("scores-scoped");
    await shareWith(owner.id, scoped.id, ["measurements"]);
    const narrow = await json<Day>(await getDay(DAY));
    expect(narrow.scores).toEqual([]);
    expect(narrow.sections.scores).toEqual({
      available: false,
      reason: "not_shared",
    });
    // The stored rows stay readings for a reader who may see them.
    expect(narrow.values.some((v) => v.type === "RECOVERY_SCORE")).toBe(true);

    const full = await makeUser("scores-full");
    await shareWith(owner.id, full.id, null);
    const wide = await json<Day>(await getDay(DAY));
    expect(wide.scores.length).toBe(5);
    expect(wide.sections.scores).toBeUndefined();
  });

  it("leaves out the scores of a switched-off module", async () => {
    const owner = await makeUser("scores-mod", {
      recovery: false,
      sleep: false,
    });
    await seedScores(owner.id);
    await signIn(owner.id);
    const day = await json<Day>(await getDay(DAY));
    expect(day.scores.map((s) => s.key)).toEqual(["healthScore"]);
    expect(day.sections).toEqual({});
  });

  it("reaches the model as names and numbers", async () => {
    const owner = await makeUser("scores-model");
    await seedScores(owner.id);
    const { readDayForTool } = await import("@/lib/ai/coach/tools/day-read");
    const { UNBOUNDED_REACH } = await import("@/lib/ai/coach/history-reach");
    const result = await readDayForTool({
      userId: owner.id,
      date: DAY,
      reach: UNBOUNDED_REACH,
      loadExcluded: async () => new Set(["sleep"]),
    });
    expect(result.present).toBe(true);
    if (!result.present) return;
    expect(result.data.scores.map((s) => s.score)).toEqual(["strain"]);
    expect(Object.keys(result.data.scores[0]!).sort()).toEqual([
      "band",
      "max",
      "score",
      "value",
    ]);
  });

  it("measures what the scores add to the day", async () => {
    const owner = await makeUser("scores-cost");
    await seedScores(owner.id);
    const { loadDay } = await import("@/lib/day/load-day");
    const { resolveDayAccess } = await import("@/lib/day/sections");
    const access = await resolveDayAccess({
      recordId: owner.id,
      domainVisible: () => true,
      owner: true,
    });
    const without = {
      ...access,
      readable: new Set([...access.readable].filter((s) => s !== "scores")),
    };
    const time = async (a: typeof access) => {
      const runs: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const t0 = performance.now();
        await loadDay({ recordId: owner.id, day: DAY, access: a });
        runs.push(performance.now() - t0);
      }
      return runs.sort((x, y) => x - y)[3]!;
    };
    await time(access);
    const base = await time(without);
    const full = await time(access);
    // The scores' own reads, alone and in sequence: what they cost even
    // where nothing runs beside them.
    const { readDayScores } = await import("@/lib/day/scores");
    const alone: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const t0 = performance.now();
      await readDayScores({
        userId: owner.id,
        day: DAY,
        tz: "Europe/Berlin",
        modules: access.modules,
        priorityJson: null,
      });
      alone.push(performance.now() - t0);
    }
    const scoresAlone = alone.sort((x, y) => x - y)[3]!;
    process.stdout.write(
      `[day scores] median loadDay ${base.toFixed(1)} ms without scores, ${full.toFixed(1)} ms with (+${(full - base).toFixed(1)} ms); score reads alone ${scoresAlone.toFixed(1)} ms\n`,
    );
    expect(scoresAlone).toBeLessThan(150);
    expect(full - base).toBeLessThan(150);
  });
});

describe("cycle", () => {
  async function cycleUser(label: string) {
    const db = getPrismaClient();
    const owner = await makeUser(label);
    await db.cycleProfile.create({
      data: { userId: owner.id, cycleTrackingEnabled: true },
    });
    return owner;
  }

  it("states the cycle day and phase of a day inside a closed cycle", async () => {
    const db = getPrismaClient();
    const owner = await cycleUser("cycle-closed");
    await db.menstrualCycle.create({
      data: {
        userId: owner.id,
        startDate: "2026-02-20",
        endDate: "2026-03-19",
        periodEndDate: "2026-02-24",
        tz: "Europe/Berlin",
      },
    });
    await db.menstrualCycle.create({
      data: { userId: owner.id, startDate: "2026-03-20", tz: "Europe/Berlin" },
    });
    await signIn(owner.id);
    const day = await json<Day>(await getDay("2026-03-01"));
    const cycle = day.running.find((r) => r.kind === "cyclePhase");
    expect(cycle).toMatchObject({
      dayIndex: 10,
      sub: "FOLLICULAR",
      since: "2026-02-20",
      until: "2026-03-19",
      dayCount: 28,
    });
    const late = await json<Day>(await getDay("2026-03-15"));
    expect(late.running.find((r) => r.kind === "cyclePhase")?.sub).toBe(
      "LUTEAL",
    );
  });

  it("counts the open cycle and stops once it runs past the grace window", async () => {
    const db = getPrismaClient();
    const owner = await cycleUser("cycle-open");
    await db.menstrualCycle.create({
      data: { userId: owner.id, startDate: "2026-01-02", tz: "Europe/Berlin" },
    });
    // A forecast row never stands in for a logged cycle.
    await db.menstrualCycle.create({
      data: {
        userId: owner.id,
        startDate: "2025-12-01",
        isPredicted: true,
        tz: "Europe/Berlin",
      },
    });
    await signIn(owner.id);
    const inside = await json<Day>(await getDay("2026-01-04"));
    expect(inside.running.find((r) => r.kind === "cyclePhase")).toMatchObject({
      dayIndex: 3,
      sub: "MENSTRUAL",
      until: null,
    });
    const before = await json<Day>(await getDay("2025-12-10"));
    expect(before.running.some((r) => r.kind === "cyclePhase")).toBe(false);
    // Months later with nothing logged: no "day 90".
    const stale = await json<Day>(await getDay("2026-04-15"));
    expect(stale.running.some((r) => r.kind === "cyclePhase")).toBe(false);
  });

  it("shows no cycle to an account without cycle tracking", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("cycle-off");
    await db.menstrualCycle.create({
      data: { userId: owner.id, startDate: "2026-03-01", tz: "Europe/Berlin" },
    });
    await signIn(owner.id);
    const day = await json<Day>(await getDay("2026-03-05"));
    expect(day.running.some((r) => r.kind === "cyclePhase")).toBe(false);
  });
});

describe("performance smoke", () => {
  it("loads a dense day in well under a second", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("perf");
    // Ninety days of minute-level pulse around the day, plus a daily weight.
    const rows = [];
    const start = Date.UTC(2026, 0, 1);
    for (let d = 0; d < 90; d += 1) {
      for (let m = 0; m < 24 * 60; m += 5) {
        rows.push({
          userId: owner.id,
          type: "PULSE" as const,
          value: 60 + (m % 30),
          unit: "bpm",
          source: "APPLE_HEALTH" as const,
          measuredAt: new Date(start + d * 86_400_000 + m * 60_000),
        });
      }
      rows.push({
        userId: owner.id,
        type: "WEIGHT" as const,
        value: 80 + (d % 3),
        unit: "kg",
        source: "MANUAL" as const,
        measuredAt: new Date(start + d * 86_400_000 + 7 * 3_600_000),
      });
    }
    for (let i = 0; i < rows.length; i += 5000) {
      await db.measurement.createMany({ data: rows.slice(i, i + 5000) });
    }
    await db.$executeRawUnsafe(`ANALYZE "measurements"`);
    await signIn(owner.id);
    await getDay("2026-03-15");
    const t0 = performance.now();
    const response = await getDay("2026-03-15");
    const elapsed = performance.now() - t0;
    expect(response.status).toBe(200);
    const day = await json<Day>(response);
    expect(day.values.find((v) => v.type === "PULSE")?.band).not.toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });
});
