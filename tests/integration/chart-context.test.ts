/**
 * The context marks on metric charts, driven through
 * `GET /api/insights/context` against real Postgres.
 *
 * What the unit tests cannot show: that the marks are the timeline's own
 * lanes (the same starts, stops, dose changes and episodes `GET
 * /api/timeline` sends, no second cut), that an instant is put on the
 * record's local day across both DST changes with the clock pinned on the
 * changeover itself, that the cycle phases are the cycle engine's, that a
 * switched-off module sends nothing, that a grant scoped to some sections and
 * a narrow token are refused, and how many statements one read sends (the
 * budget). All data invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { hashToken } from "@/lib/auth/hmac";
import type { ChartContextResponse } from "@/lib/charts/context-markers-contract";
import { addDays } from "@/lib/cycle/day-math";
import { phaseForDay } from "@/lib/cycle/phase";
import type { TimelineResponse } from "@/lib/day/contract";

import { cookieJar, headerJar } from "./mock-next-headers";
import { countStatements, summariseStatements } from "./query-counter";
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

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

/**
 * Statements per read on the fixture below, measured when the test was
 * written; see `query-budget-hot-routes.test.ts` for how a budget moves.
 * The session, the user and the instance settings; the module map (the
 * user's module column and the cycle switch); the medications lane, five
 * reads plus the medication names its courses, dose changes and pauses
 * join (one statement each); the illness lane; the cycle rows and the
 * luteal length. A fixed number, whatever the size of the record: the
 * fixture holds a dozen medications more than it needs to show that.
 */
const BUDGET = 16;

let counter = 0;

const MODULES = { timeline: true, medications: true, illness: true };

async function makeUser(label: string, timezone = "Europe/Berlin") {
  const suffix = `${label}-${counter++}`;
  const user = await getPrismaClient().user.create({
    data: {
      username: `chart-ctx-${suffix}`,
      email: `chart-ctx-${suffix}@example.test`,
      displayName: `CC ${suffix}`,
      role: "USER",
      timezone,
      locale: "en",
      modulePreferencesJson: MODULES,
    },
  });
  await getPrismaClient().cycleProfile.create({
    data: {
      userId: user.id,
      cycleTrackingEnabled: true,
      lutealPhaseLength: 13,
    },
  });
  return user;
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    // Past the pinned clocks below and the real one alike.
    data: { userId, expiresAt: new Date("2030-01-01T00:00:00Z") },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function mintToken(userId: string, permissions: string[]) {
  const raw = `hlk_${userId}-${counter++}`.padEnd(20, "0");
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "chart-context-test",
      tokenHash: hashToken(raw),
      permissions,
    },
  });
  return raw;
}

async function getContext(query = ""): Promise<Response> {
  const { GET } = await import("@/app/api/insights/context/route");
  return (GET as Handler)(
    new NextRequest(`http://localhost/api/insights/context?${query}`),
    { params: Promise.resolve({}) },
  );
}

async function getTimeline(query: string): Promise<Response> {
  const { GET } = await import("@/app/api/timeline/route");
  return (GET as Handler)(
    new NextRequest(`http://localhost/api/timeline?${query}`),
    { params: Promise.resolve({}) },
  );
}

async function data<T = ChartContextResponse>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: T }).data;
}

/**
 * A record whose instants sit on the night of a DST change: the dose change
 * and the illness onset fall on one UTC day and another local one.
 */
async function seed(userId: string) {
  const db = getPrismaClient();
  const ramipril = await db.medication.create({
    data: {
      userId,
      name: "Ramipril",
      dose: "10 mg",
      startsOn: new Date("2026-03-02T00:00:00Z"),
    },
  });
  // 23:30 UTC on 28 March is 00:30 on the 29th in Berlin, the night summer
  // time starts.
  await db.medicationDoseChange.create({
    data: {
      medicationId: ramipril.id,
      effectiveFrom: new Date("2026-03-28T23:30:00Z"),
      doseValue: 10,
      doseUnit: "mg",
    },
  });
  // The starting dose, on the start day: folds into the start.
  await db.medicationDoseChange.create({
    data: {
      medicationId: ramipril.id,
      effectiveFrom: new Date("2026-03-02T08:00:00Z"),
      doseValue: 5,
      doseUnit: "mg",
    },
  });
  await db.medicationPauseEra.create({
    data: {
      userId,
      medicationId: ramipril.id,
      pausedAt: new Date("2026-06-01T10:00:00Z"),
      resumedAt: new Date("2026-06-08T10:00:00Z"),
    },
  });
  const amoxicillin = await db.medication.create({
    data: {
      userId,
      name: "Amoxicillin",
      dose: "500 mg",
      startsOn: new Date("2026-10-20T00:00:00Z"),
      endsOn: new Date("2026-10-27T00:00:00Z"),
    },
  });
  // A one-off dose is not a change of treatment.
  await db.medication.create({
    data: {
      userId,
      name: "Single shot",
      dose: "1",
      oneShot: true,
      startsOn: new Date("2026-05-05T00:00:00Z"),
    },
  });
  // 22:30 UTC on 24 October is 00:30 on the 25th in Berlin, the night
  // summer time ends.
  const flu = await db.illnessEpisode.create({
    data: {
      userId,
      label: "Flu",
      type: "INFECTION",
      onsetAt: new Date("2026-10-24T22:30:00Z"),
      resolvedAt: new Date("2026-10-30T09:00:00Z"),
    },
  });
  await db.illnessEpisode.create({
    data: {
      userId,
      label: "Asthma",
      type: "CHRONIC",
      lifecycle: "CHRONIC_ONGOING",
      onsetAt: new Date("2020-01-01T12:00:00Z"),
    },
  });
  await db.menstrualCycle.createMany({
    data: [
      {
        userId,
        startDate: "2026-09-01",
        endDate: "2026-09-28",
        periodEndDate: "2026-09-05",
        lengthDays: 28,
      },
      {
        userId,
        startDate: "2026-09-29",
        endDate: "2026-10-27",
        periodEndDate: "2026-10-03",
        lengthDays: 29,
      },
      { userId, startDate: "2026-10-28", periodEndDate: "2026-11-01" },
      // A forecast is not an observed cycle.
      { userId, startDate: "2026-11-25", isPredicted: true },
    ],
  });
  return { ramipril, amoxicillin, flu };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  // Pinned on the night winter time starts in Berlin, inside the repeated
  // hour (02:30 CET, the second time round).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T01:30:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/insights/context", () => {
  it("puts every mark on the record's local day, the timeline's lanes being the source", async () => {
    // Later, so the whole fixture lies in the past.
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const owner = await makeUser("owner");
    const { ramipril, amoxicillin, flu } = await seed(owner.id);
    await signIn(owner.id);

    const context = await data(await getContext());
    expect(context.today).toBe("2026-11-03");
    expect(
      context.medications.map((m) => [m.name, m.kind, m.date, m.dose]),
    ).toEqual([
      ["Ramipril", "start", "2026-03-02", "5 mg"],
      ["Ramipril", "doseChange", "2026-03-29", "10 mg"],
      ["Ramipril", "pause", "2026-06-01", null],
      ["Ramipril", "resume", "2026-06-08", null],
      ["Amoxicillin", "start", "2026-10-20", null],
      ["Amoxicillin", "stop", "2026-10-27", null],
    ]);
    expect(context.medications[1].href).toBe(
      `/medications/${ramipril.id}/history`,
    );
    expect(context.medications[4].href).toBe(`/medications/${amoxicillin.id}`);
    expect(context.illnesses).toEqual([
      {
        id: flu.id,
        start: "2026-10-25",
        end: "2026-10-30",
        label: "Flu",
        href: `/illness/${flu.id}`,
      },
    ]);

    // No second cut: the timeline's lanes carry the same days.
    const timeline = await data<TimelineResponse>(
      await getTimeline("zoom=all"),
    );
    const lane = (key: string) =>
      timeline.lanes.find((l) => l.key === key)?.items ?? [];
    const doseDays = lane("medications")
      .filter((i) => i.kind === "doseChange")
      .map((i) => i.start)
      .sort();
    expect(doseDays).toEqual(["2026-03-02", "2026-03-29"]);
    expect(
      lane("illness")
        .filter((i) => i.kind === "episode")
        .map((i) => [i.start, i.end]),
    ).toEqual([["2026-10-25", "2026-10-30"]]);

    // The cycle phases are the engine's, day by day, the open cycle up to
    // today and the forecast left out.
    expect(context.cyclePhases[0]).toEqual({
      phase: "MENSTRUAL",
      start: "2026-09-01",
      end: "2026-09-05",
    });
    expect(context.cyclePhases.at(-1)?.end).toBe("2026-11-03");
    for (const span of context.cyclePhases.slice(0, 8)) {
      const cycle =
        span.start < "2026-09-29"
          ? {
              startDate: "2026-09-01",
              nextStart: "2026-09-29",
              periodLength: 5,
            }
          : {
              startDate: "2026-09-29",
              nextStart: "2026-10-28",
              periodLength: 5,
            };
      for (let day = span.start; day <= span.end; day = addDays(day, 1)) {
        expect(
          phaseForDay(day, { ...cycle, ovulationDate: null, lutealLength: 13 })
            .phase,
        ).toBe(span.phase);
      }
    }
  });

  it("names today by the record's zone on the night of a DST change", async () => {
    const berlin = await makeUser("berlin");
    await signIn(berlin.id);
    // 01:30 UTC on 25 October: 02:30 CET in Berlin, the second time round.
    expect((await data(await getContext())).today).toBe("2026-10-25");

    // 08:30 UTC on 1 November: 01:30 PDT in Los Angeles, still 1 November;
    // an hour later the clocks go back and it is 01:30 PST, still the 1st.
    const la = await makeUser("la", "America/Los_Angeles");
    await signIn(la.id);
    vi.setSystemTime(new Date("2026-11-01T08:30:00Z"));
    expect((await data(await getContext())).today).toBe("2026-11-01");
    vi.setSystemTime(new Date("2026-11-01T09:30:00Z"));
    expect((await data(await getContext())).today).toBe("2026-11-01");
    // 07:30 UTC on 2 November is still the 1st there.
    vi.setSystemTime(new Date("2026-11-02T07:30:00Z"));
    expect((await data(await getContext())).today).toBe("2026-11-01");
  });

  it("cuts a window: a span is sent when it touches it", async () => {
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const owner = await makeUser("owner");
    await seed(owner.id);
    await signIn(owner.id);

    const window = await data(
      await getContext("from=2026-10-28&to=2026-11-03"),
    );
    expect(window.medications).toEqual([]);
    expect(window.illnesses.map((s) => s.label)).toEqual(["Flu"]);
    expect(window.cyclePhases.every((p) => p.end >= "2026-10-28")).toBe(true);

    expect((await getContext("from=2026-11-03&to=2026-10-01")).status).toBe(
      422,
    );
    expect((await getContext("from=yesterday")).status).toBe(422);
  });

  it("sends nothing of a switched-off module", async () => {
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const owner = await makeUser("owner");
    await seed(owner.id);
    await signIn(owner.id);
    const db = getPrismaClient();
    await db.user.update({
      where: { id: owner.id },
      data: {
        modulePreferencesJson: {
          ...MODULES,
          medications: false,
          illness: false,
        },
      },
    });
    await db.cycleProfile.update({
      where: { userId: owner.id },
      data: { cycleTrackingEnabled: false },
    });
    const context = await data(await getContext());
    expect(context).toMatchObject({
      medications: [],
      illnesses: [],
      cyclePhases: [],
    });
  });

  it("admits the owner, a whole-record grant and a full token; refuses a scoped grant, a narrow token and nobody", async () => {
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const owner = await makeUser("owner");
    await seed(owner.id);
    expect((await getContext()).status).toBe(401);

    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const share = async (scope: Array<"measurements"> | null) => {
      const delegate = await makeUser("delegate");
      const invited = await inviteGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
        access: "READ",
        scope,
      });
      await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
      const session = await signIn(delegate.id);
      await switchSessionTo(session.id, owner.id);
    };
    await share(["measurements"]);
    expect((await getContext()).status).toBe(403);
    await share(null);
    expect((await data(await getContext())).medications.length).toBe(6);

    cookieJar.clear();
    const narrow = await mintToken(owner.id, ["fhir:read"]);
    headerJar.set("authorization", `Bearer ${narrow}`);
    expect((await getContext()).status).toBe(403);
    const full = await mintToken(owner.id, ["*"]);
    headerJar.set("authorization", `Bearer ${full}`);
    expect((await data(await getContext())).illnesses).toHaveLength(1);
  });

  it(`reads in at most ${BUDGET} statements, whatever the record holds`, async () => {
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const owner = await makeUser("owner");
    await seed(owner.id);
    // More of everything must not cost a statement more.
    const db = getPrismaClient();
    for (let i = 0; i < 12; i++) {
      const med = await db.medication.create({
        data: {
          userId: owner.id,
          name: `Extra ${i}`,
          dose: "1 mg",
          startsOn: new Date(Date.UTC(2025, i, 3)),
        },
      });
      await db.medicationDoseChange.create({
        data: {
          medicationId: med.id,
          effectiveFrom: new Date(Date.UTC(2025, i, 20, 9)),
          doseValue: 2,
          doseUnit: "mg",
        },
      });
    }
    await signIn(owner.id);
    expect((await getContext()).status).toBe(200);
    const measured = await countStatements(async () => {
      const res = await getContext();
      await res.arrayBuffer();
      return res.status;
    });
    expect(measured.result).toBe(200);
    expect(
      measured.count,
      `${measured.count} statements against a budget of ${BUDGET}.\n` +
        summariseStatements(measured.statements),
    ).toBeLessThanOrEqual(BUDGET);
  });
});
