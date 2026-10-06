/**
 * v1.41 — `coachReasoning` on `GET /api/auth/me`, through the real routes
 * against real Postgres.
 *
 * The resolution order is proven exhaustively by the unit table in
 * `src/lib/ai/reasoning/__tests__/resolve.test.ts`. What only this file can
 * prove is the wiring end to end: the person's choice written through
 * `PUT /api/auth/me/coach-prefs`, the operator's switch and cap written
 * through `PUT /api/admin/settings/assistant-flags` (migration 0376's two
 * columns), and the provider read off the record, all arriving at the one
 * block the web settings and the native client read.
 *
 * Mutation check: drop the `admin` argument's switch in `resolveReasoning`
 * (return the preference whatever `enabled` says) and the operator-off case
 * goes red; publish the raw preference as `level` and the cap case does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

interface CoachReasoning {
  level: string;
  preference: string;
  maxLevel: string;
  available: boolean;
  offIsReal: boolean;
  source: string;
}

let counter = 0;

async function makeUser(overrides: Record<string, unknown> = {}) {
  const suffix = `${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `reason-${suffix}`,
      email: `reason-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      aiProvider: "ANTHROPIC",
      aiModel: "claude-sonnet-4-6",
      // Presence only: the probe never decrypts, so any value will do.
      aiAnthropicKeyEncrypted: "v1:presence-only",
      ...overrides,
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function readReasoning(): Promise<CoachReasoning> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { coachReasoning: CoachReasoning } })
    .data.coachReasoning;
}

async function putPrefs(body: Record<string, unknown>) {
  const { PUT } = await import("@/app/api/auth/me/coach-prefs/route");
  const res = await (PUT as (r: Request) => Promise<Response>)(
    new Request("http://localhost/api/auth/me/coach-prefs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
}

/** Flip the operator's controls through the admin route, as an admin. */
async function putControls(body: Record<string, unknown>) {
  const admin = await getPrismaClient().user.create({
    data: {
      username: `admin-${counter++}`,
      email: `admin-${counter}@example.test`,
      role: "ADMIN",
    },
  });
  const previous = cookieJar.get("healthlog_session");
  await signIn(admin.id);
  const { PUT } =
    await import("@/app/api/admin/settings/assistant-flags/route");
  const { NextRequest } = await import("next/server");
  const res = await PUT(
    new NextRequest("http://localhost/api/admin/settings/assistant-flags", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  if (previous) cookieJar.set("healthlog_session", previous);
  return (await res.json()) as {
    data: { reasoning: { enabled: boolean; maxEffort: string } };
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("GET /api/auth/me — coachReasoning", () => {
  it("runs a person who never chose at medium, uncapped", async () => {
    const user = await makeUser();
    await signIn(user.id);
    expect(await readReasoning()).toEqual({
      level: "medium",
      preference: "medium",
      maxLevel: "high",
      available: true,
      offIsReal: true,
      source: "user",
    });
  });

  it("publishes the level the person stored through the Coach settings", async () => {
    const user = await makeUser();
    await signIn(user.id);
    await putPrefs({ reasoning: "high" });
    const stored = await getPrismaClient().user.findUnique({
      where: { id: user.id },
      select: { coachPrefsJson: true },
    });
    expect(stored?.coachPrefsJson).toMatchObject({ reasoning: "high" });
    expect(await readReasoning()).toMatchObject({
      level: "high",
      preference: "high",
      source: "user",
    });
  });

  it("clamps the person's level to the operator's cap", async () => {
    const user = await makeUser();
    await signIn(user.id);
    await putPrefs({ reasoning: "high" });
    const controls = await putControls({ aiReasoningMaxEffort: "low" });
    expect(controls.data.reasoning).toEqual({
      enabled: true,
      maxEffort: "low",
    });
    const row = await getPrismaClient().appSettings.findUnique({
      where: { id: "singleton" },
      select: { aiReasoningMaxEffort: true },
    });
    expect(row?.aiReasoningMaxEffort).toBe("low");
    expect(await readReasoning()).toMatchObject({
      level: "low",
      preference: "high",
      maxLevel: "low",
      source: "admin_cap",
    });
  });

  it("is off everywhere once the operator switches reasoning off", async () => {
    const user = await makeUser();
    await signIn(user.id);
    await putPrefs({ reasoning: "high" });
    await putControls({ aiReasoningEnabled: false });
    expect(await readReasoning()).toEqual({
      level: "off",
      preference: "high",
      maxLevel: "off",
      available: false,
      offIsReal: true,
      source: "admin_off",
    });
  });

  it("holds an operator-funded provider to medium", async () => {
    await getPrismaClient().appSettings.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        adminAiKeyEncrypted: "v1:presence-only",
        adminAiModel: "gpt-5.5",
      },
      update: {
        adminAiKeyEncrypted: "v1:presence-only",
        adminAiModel: "gpt-5.5",
      },
    });
    const user = await makeUser({
      aiProvider: null,
      aiModel: null,
      aiAnthropicKeyEncrypted: null,
    });
    await signIn(user.id);
    await putPrefs({ reasoning: "high" });
    expect(await readReasoning()).toMatchObject({
      level: "medium",
      maxLevel: "medium",
      available: true,
      source: "cost_cap",
    });
  });

  it("says the lowest option is not a real off on a model that always thinks", async () => {
    const user = await makeUser({ aiModel: "claude-opus-5" });
    await signIn(user.id);
    expect(await readReasoning()).toMatchObject({
      offIsReal: false,
      available: true,
    });
  });

  it("is unavailable on a provider that cannot reason", async () => {
    const user = await makeUser({
      aiProvider: "OPENAI",
      aiModel: "gpt-4o",
      aiAnthropicKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "v1:presence-only",
    });
    await signIn(user.id);
    expect(await readReasoning()).toMatchObject({
      level: "off",
      available: false,
      source: "unsupported",
    });
  });
});
