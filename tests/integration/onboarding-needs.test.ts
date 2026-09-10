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

async function readState(res: Response): Promise<OnboardingStateDto> {
  const body = (await res.json()) as {
    data: { onboarding: OnboardingStateDto };
  };
  return body.data.onboarding;
}

function statusOf(state: OnboardingStateDto, id: OnboardingStepId) {
  return state.steps.find((step) => step.id === id)?.status;
}

/** The five answers a "blood pressure and medication" setup gives. */
async function answerTheQuestions() {
  await patchAnswer({ step: "who", recordTarget: "me" });
  await patchAnswer({ step: "areas", areas: ["blood-pressure", "labs"] });
  await patchAnswer({ step: "medication", medication: "yes" });
  await patchAnswer({ step: "sources", status: "skipped" });
  await patchAnswer({ step: "visit", visit: "no" });
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

    // Somebody changes their mind in Settings, then the confirm screen is
    // replayed. The second call must leave that decision alone: the latch is
    // what stops a questionnaire from re-applying itself over a later choice.
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { modulePreferencesJson: { ...derived, labs: false } },
    });
    const second = await postComplete();
    expect(second.status).toBe(200);
    expect((await modulePrefs(user.id)).labs).toBe(false);
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

  it("switches cycle tracking on through its own column when the area is chosen", async () => {
    const user = await makeUser("cycle");
    await signIn(user.id);
    await patchAnswer({ step: "who", recordTarget: "me" });
    await patchAnswer({ step: "areas", areas: ["cycle"] });
    await postComplete();

    const profile = await getPrismaClient().cycleProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(profile.cycleTrackingEnabled).toBe(true);
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

describe("POST /api/onboarding/restart", () => {
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
    await postComplete();
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
});
