/**
 * The three needs-onboarding writes against real Postgres.
 *
 * The unit suite proves the pure parts — the area map, the merge that never
 * retracts a hand-made decision, the apply function's idempotence. This file
 * proves the four things a unit suite cannot, because each is about what is in
 * the database afterwards:
 *
 *   * **The answers persist and a replay changes nothing.** Idempotence is a
 *     claim on the wire, and a route can satisfy the pure function and still
 *     write a fresh row each time.
 *   * **The derivation happens once.** The second confirm has to leave the
 *     module map alone, including a module switched off in Settings between
 *     the two calls — that is the whole reason the latch exists.
 *   * **A restart resets the steps and not the modules.** The two are written
 *     to different tables by different routes, so only a real run can show
 *     that the second one stays where it was.
 *   * **A delegate cannot write another record's setup.** Proved with a live
 *     accepted grant and a switched session, not with a mocked resolver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  resolveDashboardLayout,
  serializeDashboardLayout,
} from "@/lib/dashboard-layout";
import { toJson } from "@/lib/db";
import { emptyOnboardingNeeds } from "@/lib/onboarding/needs";
import type {
  OnboardingStateDto,
  OnboardingStepId,
} from "@/lib/onboarding/needs";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `onb-${suffix}`,
      email: `onb-${suffix}@example.test`,
      role: "USER",
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

/** Attach the record-session assertion the shipped browser client attaches. */
async function assertCurrentContext(sessionId: string) {
  const row = await getPrismaClient().session.findUniqueOrThrow({
    where: { id: sessionId },
  });
  headerJar.set("x-healthlog-record-epoch", String(row.recordEpoch));
  headerJar.set("x-healthlog-record-scope", row.actingAsUserId ?? "self");
}

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchAnswer(body: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/onboarding/answers/route");
  return (PATCH as (r: Request) => Promise<Response>)(
    jsonRequest("/api/onboarding/answers", "PATCH", body),
  );
}

async function postComplete(body: unknown = {}): Promise<Response> {
  const { POST } = await import("@/app/api/onboarding/complete/route");
  return (POST as (r: Request) => Promise<Response>)(
    jsonRequest("/api/onboarding/complete", "POST", body),
  );
}

async function postRestart(): Promise<Response> {
  const { POST } = await import("@/app/api/onboarding/restart/route");
  return (POST as (r: Request) => Promise<Response>)(
    jsonRequest("/api/onboarding/restart", "POST", {}),
  );
}

/** The `onboarding` field the account payload publishes for the caller. */
async function readMe(): Promise<OnboardingStateDto> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await (GET as (r: Request) => Promise<Response>)(
    new Request("http://localhost/api/auth/me"),
  );
  const body = (await res.json()) as {
    data: { onboarding: OnboardingStateDto };
  };
  return body.data.onboarding;
}

async function readState(res: Response): Promise<OnboardingStateDto> {
  const body = (await res.json()) as {
    data: { onboarding: OnboardingStateDto };
  };
  return body.data.onboarding;
}

function statusOf(state: OnboardingStateDto, id: OnboardingStepId) {
  return state.steps.find((step) => step.id === id)?.status;
}

/**
 * The answers a "blood pressure and medication" setup gives — all six
 * questions, because the confirm screen is only reached once every one of them
 * has an answer or a deliberate pass.
 */
async function answerTheQuestions() {
  await patchAnswer({ step: "who", recordTarget: "me" });
  await patchAnswer({ step: "areas", areas: ["blood-pressure", "labs"] });
  await patchAnswer({ step: "medication", medication: "yes" });
  await patchAnswer({ step: "sources", status: "skipped" });
  await patchAnswer({ step: "visit", visit: "no" });
  await patchAnswer({ step: "units", status: "skipped" });
}

async function modulePrefs(userId: string) {
  const row = await getPrismaClient().user.findUniqueOrThrow({
    where: { id: userId },
    select: { modulePreferencesJson: true },
  });
  return (row.modulePreferencesJson ?? {}) as Record<string, boolean>;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PATCH /api/onboarding/answers", () => {
  it("saves one step at a time and answers with the full nine", async () => {
    const user = await makeUser("answers");
    await signIn(user.id);

    const first = await patchAnswer({ step: "who", recordTarget: "both" });
    expect(first.status).toBe(200);
    const state = await readState(first);
    expect(state.needs.recordTarget).toBe("both");
    expect(state.steps).toHaveLength(9);
    expect(statusOf(state, "who")).toBe("done");
    expect(statusOf(state, "areas")).toBe("pending");

    const second = await readState(
      await patchAnswer({ step: "areas", areas: ["sleep"] }),
    );
    expect(second.needs.recordTarget).toBe("both");
    expect(second.needs.areas).toEqual(["sleep"]);
    expect(statusOf(second, "areas")).toBe("done");
  });

  it("is idempotent — a replay leaves one row and the same state", async () => {
    const user = await makeUser("replay");
    await signIn(user.id);

    const once = await readState(
      await patchAnswer({ step: "medication", medication: "sometimes" }),
    );
    const twice = await readState(
      await patchAnswer({ step: "medication", medication: "sometimes" }),
    );
    expect(twice).toEqual(once);
    expect(
      await getPrismaClient().onboardingRecord.count({
        where: { userId: user.id },
      }),
    ).toBe(1);
  });

  it("records a skip without erasing the answer already given", async () => {
    const user = await makeUser("skip");
    await signIn(user.id);

    await patchAnswer({ step: "visit", visit: "within-a-month" });
    const skipped = await readState(
      await patchAnswer({ step: "visit", status: "skipped" }),
    );
    expect(statusOf(skipped, "visit")).toBe("skipped");
    expect(skipped.needs.visit).toBe("within-a-month");
  });

  it("writes the record's real unit columns, and records the answer beside them", async () => {
    const user = await makeUser("units");
    await signIn(user.id);

    const state = await readState(
      await patchAnswer({
        step: "units",
        units: { glucoseUnit: "mmol/L", unitPreference: "imperial" },
      }),
    );
    expect(state.needs.units).toEqual({
      glucoseUnit: "mmol/L",
      unitPreference: "imperial",
    });
    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { glucoseUnit: true, unitPreference: true },
    });
    expect(row).toEqual({ glucoseUnit: "mmol/L", unitPreference: "imperial" });

    // Same trail as the two dedicated settings routes, so it does not matter
    // which surface the person changed the units from.
    const actions = (
      await getPrismaClient().auditLog.findMany({
        where: { userId: user.id },
        select: { action: true },
      })
    ).map((entry) => entry.action);
    expect(actions).toContain("user.glucose-unit.update");
    expect(actions).toContain("user.unit-preference.update");
  });

  it("does not re-ask the units the account already holds", async () => {
    const user = await makeUser("units-held");
    await signIn(user.id);
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { glucoseUnit: "mg/dL", unitPreference: "metric" },
    });

    const state = await readState(
      await patchAnswer({ step: "who", recordTarget: "me" }),
    );
    // Nobody answered Q6; the account's own columns did.
    expect(statusOf(state, "units")).toBe("done");
    expect(state.needs.units).toEqual({
      glucoseUnit: null,
      unitPreference: null,
    });

    // Half a preference is not an answer.
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { unitPreference: null },
    });
    const half = await readState(
      await patchAnswer({ step: "who", recordTarget: "me" }),
    );
    expect(statusOf(half, "units")).toBe("pending");
  });

  it("refuses a body that names a step it does not answer", async () => {
    const user = await makeUser("invalid");
    await signIn(user.id);

    const res = await patchAnswer({ step: "areas", medication: "yes" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("onboarding.answers.invalid");
    expect(
      await getPrismaClient().onboardingRecord.count({
        where: { userId: user.id },
      }),
    ).toBe(0);
  });
});

describe("POST /api/onboarding/complete", () => {
  it("derives the module map from the answers, once", async () => {
    const user = await makeUser("derive");
    await signIn(user.id);
    await answerTheQuestions();

    const first = await postComplete();
    expect(first.status).toBe(200);

    const derived = await modulePrefs(user.id);
    // What the answers named.
    expect(derived.medications).toBe(true);
    expect(derived.labs).toBe(true);
    expect(derived.insights).toBe(true);
    expect(derived.achievements).toBe(true);
    // What they did not.
    expect(derived.workouts).toBe(false);
    expect(derived.mood).toBe(false);
    expect(derived.doctorReport).toBe(false);
    expect(derived.vaccinations).toBe(false);
    // The delegated keys are never written into the blob.
    expect(derived).not.toHaveProperty("cycle");
    expect(derived).not.toHaveProperty("coach");

    const state = await readState(first);
    expect(statusOf(state, "confirm")).toBe("done");
    expect(state.completedAt).not.toBeNull();

    // The activity panel has to be able to answer "why did my modules change".
    const audit = await getPrismaClient().auditLog.findMany({
      where: { userId: user.id, action: "user.modules.update" },
    });
    expect(audit).toHaveLength(1);
    const details = JSON.parse(audit[0].details ?? "{}") as {
      changed?: string[];
      source?: string;
    };
    expect(details.changed).toContain("medications");
    expect(details.source).toBe("onboarding");

    // Somebody changes their mind in Settings, then the confirm screen is
    // replayed. The second call must leave that decision alone: the latch is
    // what stops a questionnaire from re-applying itself over a later choice.
    // The completion instant is latched with it — a replay does not move the
    // moment the setup finished at.
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { modulePreferencesJson: { ...derived, labs: false } },
    });
    const second = await postComplete();
    expect(second.status).toBe(200);
    expect((await modulePrefs(user.id)).labs).toBe(false);
    expect((await readState(second)).completedAt).toBe(state.completedAt);
  });

  it("seeds the dashboard order from the answers, and only while the layout is unset", async () => {
    const user = await makeUser("seed");
    await signIn(user.id);
    await answerTheQuestions();
    expect((await postComplete()).status).toBe(200);

    const stored = async () =>
      (
        await getPrismaClient().user.findUniqueOrThrow({
          where: { id: user.id },
          select: { dashboardWidgetsJson: true },
        })
      ).dashboardWidgetsJson;

    // Blood pressure and a daily medication were answered: their tiles lead,
    // visible on both surfaces, and nothing is dropped.
    const seeded = await stored();
    expect(seeded).not.toBeNull();
    const layout = resolveDashboardLayout(seeded);
    const order = [...layout.widgets]
      .sort((a, b) => a.order - b.order)
      .map((w) => w.id);
    expect(new Set(order.slice(0, 4))).toEqual(
      new Set(["bp", "bpInTarget", "pulse", "medications"]),
    );
    for (const id of ["bp", "bpInTarget", "pulse", "medications"]) {
      const widget = layout.widgets.find((w) => w.id === id);
      expect(widget?.visible, id).toBe(true);
      expect(widget?.tileVisible, id).toBe(true);
    }
    expect(layout.widgets.length).toBe(DEFAULT_DASHBOARD_LAYOUT.widgets.length);

    // A layout somebody arranged is never clobbered: put the default back
    // (weight first), ask the questions again, confirm again — the seed sees
    // a set column and writes nothing.
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: {
        dashboardWidgetsJson: toJson(
          serializeDashboardLayout(DEFAULT_DASHBOARD_LAYOUT),
        ),
      },
    });
    expect((await postRestart()).status).toBe(200);
    await answerTheQuestions();
    expect((await postComplete()).status).toBe(200);
    const kept = resolveDashboardLayout(await stored());
    expect([...kept.widgets].sort((a, b) => a.order - b.order)[0]?.id).toBe(
      "weight",
    );
  });

  it("never switches off a module the person switched on by hand", async () => {
    const user = await makeUser("handmade");
    await signIn(user.id);
    // The remote MCP endpoint is off by default and nothing in the flow asks
    // for it, so a derivation that ignored the stored map would retract it.
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { modulePreferencesJson: { mcp: true } },
    });
    await answerTheQuestions();
    await postComplete();

    expect((await modulePrefs(user.id)).mcp).toBe(true);
  });

  it("never switches off a domain the record already holds rows in", async () => {
    const user = await makeUser("established");
    await signIn(user.id);
    // An account that has been running for years: mood entries and workouts,
    // no stored module preference at all, because both were default-on and
    // nobody ever touched a toggle. The questions below name neither.
    await getPrismaClient().moodEntry.create({
      data: {
        userId: user.id,
        date: "2026-09-01",
        mood: "GUT",
        score: 4,
        moodLoggedAt: new Date("2026-09-01T18:00:00.000Z"),
      },
    });
    await getPrismaClient().workout.create({
      data: {
        userId: user.id,
        sportType: "RUNNING",
        startedAt: new Date("2026-09-01T06:00:00.000Z"),
        endedAt: new Date("2026-09-01T06:30:00.000Z"),
        durationSec: 1800,
      },
    });

    await answerTheQuestions();
    await postComplete();

    const prefs = await modulePrefs(user.id);
    // Left alone rather than written false: absence is what "on" looks like
    // in the stored map, and the surfaces stay.
    expect(prefs).not.toHaveProperty("mood");
    expect(prefs).not.toHaveProperty("workouts");
    // A domain with nothing in it is still switched off by the answers.
    expect(prefs.illness).toBe(false);
    expect(prefs.vaccinations).toBe(false);
  });

  it("switches cycle tracking on through its own column when the area is chosen", async () => {
    const user = await makeUser("cycle");
    await signIn(user.id);
    await patchAnswer({ step: "who", recordTarget: "me" });
    await patchAnswer({ step: "areas", areas: ["cycle"] });
    await patchAnswer({ step: "medication", status: "skipped" });
    await patchAnswer({ step: "sources", status: "skipped" });
    await patchAnswer({ step: "visit", status: "skipped" });
    await patchAnswer({ step: "units", status: "skipped" });
    await postComplete();

    const profile = await getPrismaClient().cycleProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(profile.cycleTrackingEnabled).toBe(true);
  });

  it("derives nothing from a questionnaire that was never finished", async () => {
    const user = await makeUser("half");
    await signIn(user.id);
    // Q1 and nothing else — the tab was closed, or the legacy four-step wizard
    // posted here afterwards. Either way the remaining five questions have no
    // answer, and reading them as their conservative defaults would switch off
    // eleven surfaces and latch the result.
    await patchAnswer({ step: "who", recordTarget: "me" });

    const res = await postComplete();
    expect(res.status).toBe(200);

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { modulePreferencesJson: true },
    });
    expect(row.modulePreferencesJson).toBeNull();

    const record = await getPrismaClient().onboardingRecord.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(record.modulesDerivedAt).toBeNull();
    expect(record.completedAt).toBeNull();

    const state = await readState(res);
    expect(statusOf(state, "confirm")).toBe("pending");

    // Finishing the questions later still derives, so the gate defers the
    // work rather than losing it.
    await answerTheQuestions();
    await postComplete();
    expect((await modulePrefs(user.id)).medications).toBe(true);
  });

  it("leaves a record that never answered the questions exactly as it was", async () => {
    const user = await makeUser("legacy");
    await signIn(user.id);

    const res = await postComplete({ heightCm: 180 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { completed: boolean; onboarding?: unknown };
    };
    expect(body.data.completed).toBe(true);
    expect(body.data.onboarding).toBeUndefined();

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { modulePreferencesJson: true, onboardingCompletedAt: true },
    });
    expect(row.modulePreferencesJson).toBeNull();
    expect(row.onboardingCompletedAt).not.toBeNull();
  });
});

describe("POST /api/onboarding/complete for somebody else's record", () => {
  async function guardianWithChild() {
    const guardian = await makeUser("guardian");
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Child record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    await signIn(guardian.id);
    await patchAnswer({ step: "who", recordTarget: "someone-else" });
    await patchAnswer({ step: "areas", areas: ["blood-pressure"] });
    await patchAnswer({ step: "medication", medication: "no" });
    await patchAnswer({ step: "sources", sources: ["manual"] });
    await patchAnswer({ step: "visit", visit: "no" });
    await patchAnswer({ step: "units", status: "skipped" });
    return { guardian, profile };
  }

  it("derives onto the managed record and leaves the guardian's own map alone", async () => {
    // The review's H1: a parent setting up a child's record must not have
    // their own modules switched off around the child's answers. The
    // derivation is the same function, applied through the same record-keyed
    // write the guardian's modules route uses — to the child.
    const { guardian, profile } = await guardianWithChild();

    const res = await postComplete({ managedRecordId: profile.id });
    expect(res.status).toBe(200);

    const child = await modulePrefs(profile.id);
    expect(child.vaccinations).toBe(true);
    expect(child.insights).toBe(true);
    expect(child.glucose).toBe(false);
    expect(child.medications).toBe(false);
    expect(child.doctorReport).toBe(false);

    // Untouched: a fresh account carries no map at all, and still does.
    expect(await modulePrefs(guardian.id)).toEqual({});

    // The guardian's own flow is complete and its derivation latched, so a
    // later confirm cannot derive the child's answers onto the guardian.
    const own = await getPrismaClient().onboardingRecord.findUniqueOrThrow({
      where: { userId: guardian.id },
    });
    expect(own.completedAt).not.toBeNull();
    expect(own.modulesDerivedAt).not.toBeNull();
    expect(statusOf(await readState(res), "confirm")).toBe("done");

    // The child's own setup row reads as finished, from the same answers.
    const theirs = await getPrismaClient().onboardingRecord.findUniqueOrThrow({
      where: { userId: profile.id },
    });
    expect(theirs.completedAt).not.toBeNull();
    expect(theirs.modulesDerivedAt).not.toBeNull();
    const dashboard = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: profile.id },
      select: { dashboardWidgetsJson: true },
    });
    expect(dashboard.dashboardWidgetsJson).not.toBeNull();

    // A second confirm derives nowhere: the guardian is latched, and the
    // child keeps what it has.
    expect((await postComplete({ managedRecordId: profile.id })).status).toBe(
      200,
    );
    expect(await modulePrefs(guardian.id)).toEqual({});
  });

  it("refuses a record the caller does not guard, and touches nothing", async () => {
    const { guardian } = await guardianWithChild();
    const stranger = await makeUser("stranger-guardian");
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const { profile: theirs } = await createManagedProfile({
      creatorId: stranger.id,
      displayName: "Somebody else's child",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });

    const res = await postComplete({ managedRecordId: theirs.id });
    expect(res.status).toBe(403);
    expect(await modulePrefs(theirs.id)).toEqual({});
    expect(await modulePrefs(guardian.id)).toEqual({});
    const own = await getPrismaClient().onboardingRecord.findUniqueOrThrow({
      where: { userId: guardian.id },
    });
    expect(own.completedAt).toBeNull();
    // Nothing stamped the first-run gate either.
    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: guardian.id },
      select: { onboardingCompletedAt: true },
    });
    expect(row.onboardingCompletedAt).toBeNull();
  });

  it("refuses a managed record when the answers were given for the caller", async () => {
    const guardian = await makeUser("guardian-me");
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Child record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    await signIn(guardian.id);
    await answerTheQuestions(); // Q1 = "me"

    const res = await postComplete({ managedRecordId: profile.id });
    expect(res.status).toBe(422);
    expect(await modulePrefs(profile.id)).toEqual({});
    expect(await modulePrefs(guardian.id)).toEqual({});
  });
});

describe("POST /api/onboarding/restart", () => {
  it("clears the first result so a re-run offers the task again", async () => {
    // M2: kept, the old result painted the re-run's first-result screen as
    // done, "Next" skipped the write, and the step stayed pending forever.
    const user = await makeUser("restart-first-result");
    await signIn(user.id);
    await answerTheQuestions();
    expect((await postComplete()).status).toBe(200);
    await patchAnswer({
      step: "first-result",
      firstResult: { task: "add-medication", target: null, completed: true },
    });
    expect((await readMe()).firstResult?.completedAt).not.toBeNull();

    expect((await postRestart()).status).toBe(200);
    const after = await readMe();
    expect(after.firstResult).toBeNull();
    expect(statusOf(after, "first-result")).toBe("pending");
  });

  it("resets the steps and leaves the modules where they are", async () => {
    const user = await makeUser("restart");
    await signIn(user.id);
    await answerTheQuestions();
    await postComplete();
    const derived = await modulePrefs(user.id);

    const res = await postRestart();
    expect(res.status).toBe(200);
    const state = await readState(res);
    expect(state.steps.every((step) => step.status === "pending")).toBe(true);
    expect(state.completedAt).toBeNull();
    // The answers survive as the prefill for the re-run.
    expect(state.needs.medication).toBe("yes");
    expect(await modulePrefs(user.id)).toEqual(derived);

    // The latch is cleared, so the next confirm may derive again — and a
    // module switched off by hand in between still survives it.
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { modulePreferencesJson: { ...derived, labs: true } },
    });
    await patchAnswer({ step: "who", recordTarget: "me" });
    await patchAnswer({ step: "areas", areas: [] });
    await patchAnswer({ step: "medication", medication: "no" });
    await patchAnswer({ step: "sources", status: "skipped" });
    await patchAnswer({ step: "visit", status: "skipped" });
    await patchAnswer({ step: "units", status: "skipped" });
    await postComplete();
    // The derivation really did run the second time round, so the survival
    // below is the merge protecting a hand-made decision and not the gate
    // refusing to look.
    const reran = await getPrismaClient().onboardingRecord.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(reran.modulesDerivedAt).not.toBeNull();
    expect((await modulePrefs(user.id)).labs).toBe(true);
  });

  it("leaves the first-run redirect's own stamp alone", async () => {
    const user = await makeUser("redirect");
    await signIn(user.id);
    await answerTheQuestions();
    await postComplete();
    await postRestart();

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { onboardingCompletedAt: true },
    });
    expect(row.onboardingCompletedAt).not.toBeNull();
  });
});

describe("a delegate and somebody else's record", () => {
  it("refuses every setup write while the session is acting on another record", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });

    const session = await signIn(delegate.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });
    await assertCurrentContext(session.id);

    for (const call of [
      () => patchAnswer({ step: "who", recordTarget: "me" }),
      () => postComplete(),
      () => postRestart(),
    ]) {
      const res = await call();
      expect(res.status).toBe(403);
      const body = (await res.json()) as { meta?: { errorCode?: string } };
      expect(body.meta?.errorCode).toBe("sharing.not_permitted");
    }

    // Neither record acquired a setup row — not the owner's, and not the
    // delegate's own, which is the quiet failure a fall-back would produce.
    expect(await getPrismaClient().onboardingRecord.count()).toBe(0);
    const ownerRow = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { modulePreferencesJson: true, onboardingCompletedAt: true },
    });
    expect(ownerRow.modulePreferencesJson).toBeNull();
    expect(ownerRow.onboardingCompletedAt).toBeNull();
  });

  it("publishes the RECORD's setup state on the account payload, not the actor's", async () => {
    const owner = await makeUser("scoped-owner");
    const delegate = await makeUser("scoped-delegate");

    // The owner sets up; the delegate never does.
    await signIn(owner.id);
    await answerTheQuestions();
    await postComplete();

    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });

    cookieJar.clear();
    headerJar.clear();
    const session = await signIn(delegate.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });
    await assertCurrentContext(session.id);

    // The checklist reads this beside the record's reading count and
    // medication count, both of which answer for the record under a switch.
    // Answering it for the actor would order one record's rows by another
    // person's answers.
    const state = await readMe();
    expect(state.needs.medication).toBe("yes");
    expect(state.needs.areas).toEqual(["blood-pressure", "labs"]);
    expect(state.completedAt).not.toBeNull();
    expect(statusOf(state, "confirm")).toBe("done");
  });

  it("empties the answers under a grant that opens only one section", async () => {
    const owner = await makeUser("section-owner");
    const delegate = await makeUser("section-delegate");

    await signIn(owner.id);
    await answerTheQuestions();
    await postComplete();

    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: ["measurements"],
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });

    cookieJar.clear();
    headerJar.clear();
    const session = await signIn(delegate.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });
    await assertCurrentContext(session.id);

    // The answers name the domains the record tracks — the same thing the
    // module map is masked for. The shape of the flow still comes through.
    const state = await readMe();
    expect(state.needs).toEqual(emptyOnboardingNeeds());
    expect(state.completedAt).not.toBeNull();
  });
});
