/**
 * 1.50 — `GET /api/setup` and `PATCH /api/setup` against real Postgres.
 *
 *   * A fresh account resumes on "who"; the answer to "who" pins the plan.
 *   * An account that finished before 1.50 reads done, with no setup card.
 *   * The instance half reaches an admin on a cookie session only: null on
 *     the admin's own wildcard Bearer, and a narrow token is refused.
 *   * A "no" is a settled value: the relay switched off reads declined.
 *   * The card's hide is kept on the server; a demo deploy writes nothing.
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

const { hashToken } = await import("@/lib/auth/hmac");
import type { SetupStateDto } from "@/lib/setup/types";

let counter = 0;

async function makeUser(role: "ADMIN" | "USER") {
  const suffix = `${role.toLowerCase()}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `state-${suffix}`,
      email: `state-${suffix}@example.test`,
      role,
    },
  });
}

async function signIn(userId: string) {
  await getPrismaClient()
    .session.create({
      data: { userId, expiresAt: new Date(Date.now() + 60_000) },
    })
    .then((session) => cookieJar.set("healthlog_session", session.id));
}

async function useBearer(userId: string, permissions: string[]) {
  const raw = `hlk_state${String(counter++).padStart(59, "0")}`;
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "state",
      tokenHash: hashToken(raw),
      permissions,
    },
  });
  headerJar.set("authorization", `Bearer ${raw}`);
}

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function getSetup(): Promise<Response> {
  const { GET } = await import("@/app/api/setup/route");
  return (GET as (r: Request) => Promise<Response>)(request("/api/setup"));
}

async function patchSetup(body: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/setup/route");
  return (PATCH as (r: Request) => Promise<Response>)(
    request("/api/setup", "PATCH", body),
  );
}

async function answer(body: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/onboarding/answers/route");
  return (PATCH as (r: Request) => Promise<Response>)(
    request("/api/onboarding/answers", "PATCH", body),
  );
}

async function state(res: Response): Promise<SetupStateDto> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: SetupStateDto }).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  cookieJar.clear();
  headerJar.clear();
  delete process.env.DEMO_MODE;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DEMO_MODE;
});

describe("the person half", () => {
  it("resumes a fresh account on who, and pins the plan on the answer", async () => {
    const user = await makeUser("USER");
    await signIn(user.id);

    const fresh = await state(await getSetup());
    expect(fresh.person.status).toBe("pending");
    expect(fresh.person.currentStep).toBe("who");
    expect(fresh.person.planned).toBe(false);
    expect(fresh.person.cardShown).toBe(false);
    expect(fresh.instance).toBeNull();

    expect((await answer({ step: "who", recordTarget: "me" })).status).toBe(
      200,
    );
    const pinned = await state(await getSetup());
    expect(pinned.person.planned).toBe(true);
    expect(pinned.person.currentStep).toBe("areas");
    expect(pinned.person.segments.map((s) => s.id)).toEqual([
      "you",
      "sources",
      "reminders",
    ]);
    const row = await getPrismaClient().onboardingRecord.findUniqueOrThrow({
      where: { userId: user.id },
      select: { planJson: true },
    });
    expect(row.planJson).toEqual(["you", "sources", "reminders"]);
  });

  it("reads an account that finished before 1.50 as done, with no card", async () => {
    const user = await makeUser("USER");
    const at = new Date("2026-10-01T09:00:00.000Z");
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { onboardingCompletedAt: at },
    });
    await getPrismaClient().onboardingRecord.create({
      data: {
        userId: user.id,
        needsJson: { recordTarget: "me", areas: ["sleep"] },
        stepsJson: [
          "who",
          "areas",
          "medication",
          "sources",
          "visit",
          "units",
          "confirm",
          "first-result",
          "done",
        ].map((id) => ({ id, status: "done" })),
        completedAt: at,
        modulesDerivedAt: at,
      },
    });
    await signIn(user.id);
    const read = await state(await getSetup());
    expect(read.person.status).toBe("done");
    expect(read.person.planned).toBe(false);
    expect(read.person.cardShown).toBe(false);
  });

  it("keeps the card's hide on the server, and shows it again", async () => {
    const user = await makeUser("USER");
    await signIn(user.id);
    await answer({ step: "who", recordTarget: "me" });

    const shown = await state(await getSetup());
    expect(shown.person.cardShown).toBe(true);

    const hidden = await state(await patchSetup({ cardDismissed: true }));
    expect(hidden.person.cardDismissed).toBe(true);
    expect(hidden.person.cardShown).toBe(false);

    const back = await state(await patchSetup({ cardDismissed: false }));
    expect(back.person.cardShown).toBe(true);

    expect((await patchSetup({ cardDismissed: "yes" })).status).toBe(422);
  });

  it("writes nothing on a demo deploy", async () => {
    const user = await makeUser("USER");
    await signIn(user.id);
    process.env.DEMO_MODE = "true";
    expect((await patchSetup({ cardDismissed: true })).status).toBe(403);
    const read = await state(await getSetup());
    expect(read.person.tasks).toEqual([]);
    expect(read.person.segments.map((s) => s.id)).toEqual(["you"]);
  });
});

describe("the instance half", () => {
  it("reaches an admin on a cookie session, with every decision's value", async () => {
    const admin = await makeUser("ADMIN");
    await getPrismaClient().appSettings.update({
      where: { id: "singleton" },
      data: { registrationEnabled: false, pushRelayDecision: "off" },
    });
    await signIn(admin.id);
    const read = await state(await getSetup());
    expect(read.instance).not.toBeNull();
    const tasks = Object.fromEntries(
      (read.instance?.tasks ?? []).map((task) => [task.id, task]),
    );
    expect(tasks.signups).toMatchObject({ status: "done", value: "invited" });
    expect(tasks["error-reporting"]).toMatchObject({
      status: "declined",
      value: "off",
    });
    expect(read.offers.relay).toBe("off");
  });

  it("is null on the admin's own wildcard Bearer token", async () => {
    const admin = await makeUser("ADMIN");
    await useBearer(admin.id, ["*"]);
    const read = await state(await getSetup());
    expect(read.instance).toBeNull();
  });

  it("refuses a narrow token", async () => {
    const user = await makeUser("USER");
    await useBearer(user.id, ["fhir:read"]);
    expect((await getSetup()).status).toBe(403);
  });

  it("refuses an anonymous request", async () => {
    expect((await getSetup()).status).toBe(401);
  });
});
