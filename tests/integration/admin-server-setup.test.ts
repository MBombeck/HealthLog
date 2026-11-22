/**
 * 1.49 — the first-admin server setup's state and its health check, against
 * real Postgres.
 *
 *   * An admin's cookie session reads and records the steps; the last settled
 *     step stamps the setup finished, once.
 *   * The routes are admin-only and cookie-only: a non-admin (a delegate
 *     included) is refused with 403, and an admin's own wildcard Bearer token
 *     with 401, because `requireAdmin()` never accepts a Bearer.
 *   * The start-page notice is dismissed per admin.
 *   * A demo deploy refuses the write.
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
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";
import {
  SERVER_SETUP_NOTICE_ID,
  SERVER_SETUP_STEP_IDS,
  type ServerSetupState,
} from "@/lib/admin/server-setup";
import type { SetupHealth } from "@/lib/admin/setup-health-model";

let counter = 0;

async function makeUser(role: "ADMIN" | "USER") {
  const suffix = `${role.toLowerCase()}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `setup-${suffix}`,
      email: `setup-${suffix}@example.test`,
      role,
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

async function useBearer(userId: string) {
  const raw = `hlk_setup${"0".repeat(59)}`;
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "setup",
      tokenHash: hashToken(raw),
      permissions: ["*"],
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

async function getState(): Promise<Response> {
  const { GET } = await import("@/app/api/admin/server-setup/route");
  return (GET as (r: Request) => Promise<Response>)(
    request("/api/admin/server-setup"),
  );
}

async function patchStep(body: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/admin/server-setup/route");
  return (PATCH as (r: Request) => Promise<Response>)(
    request("/api/admin/server-setup", "PATCH", body),
  );
}

async function dismissNotice(): Promise<Response> {
  const { POST } = await import("@/app/api/admin/server-setup/notice/route");
  return (POST as (r: Request) => Promise<Response>)(
    request("/api/admin/server-setup/notice", "POST"),
  );
}

async function getHealth(): Promise<Response> {
  const { GET } = await import("@/app/api/admin/setup-health/route");
  return (GET as (r: Request) => Promise<Response>)(
    request("/api/admin/setup-health"),
  );
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  // The singleton the migrations create, as on a fresh install.
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: { serverSetupCompletedAt: null, serverSetupStepsJson: undefined },
  });
  cookieJar.clear();
  headerJar.clear();
  delete process.env.DEMO_MODE;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DEMO_MODE;
});

describe("the server setup for an admin", () => {
  it("records each step and stamps the setup finished once", async () => {
    const admin = await makeUser("ADMIN");
    await signIn(admin.id);

    const fresh = await data<ServerSetupState>(await getState());
    expect(fresh.offered).toBe(true);
    expect(fresh.completedAt).toBeNull();
    expect(fresh.noticePending).toBe(true);
    expect(fresh.steps.map((s) => s.id)).toEqual([...SERVER_SETUP_STEP_IDS]);
    expect(fresh.steps.every((s) => s.status === "pending")).toBe(true);
    // Facts are names and booleans only.
    expect(Array.isArray(fresh.facts.smtp.missing)).toBe(true);

    for (const [index, id] of SERVER_SETUP_STEP_IDS.entries()) {
      const res = await patchStep({
        step: id,
        status: index % 2 === 0 ? "done" : "skipped",
      });
      expect(res.status, id).toBe(200);
      const state = await data<ServerSetupState>(res);
      const last = index === SERVER_SETUP_STEP_IDS.length - 1;
      expect(state.completedAt === null, id).toBe(!last);
    }

    const finished = await data<ServerSetupState>(await getState());
    expect(finished.noticePending).toBe(false);
    const stamp = finished.completedAt;

    // Passing a step again keeps the first stamp.
    await patchStep({ step: "ai", status: "done" });
    const again = await data<ServerSetupState>(await getState());
    expect(again.completedAt).toBe(stamp);

    const audit = await getPrismaClient().auditLog.count({
      where: { userId: admin.id, action: "admin.server-setup.step" },
    });
    expect(audit).toBe(SERVER_SETUP_STEP_IDS.length + 1);
  });

  it("refuses a body it does not read", async () => {
    const admin = await makeUser("ADMIN");
    await signIn(admin.id);
    expect(
      (await patchStep({ step: "accounts", status: "pending" })).status,
    ).toBe(422);
    expect(
      (await patchStep({ step: "accounts", status: "done", extra: 1 })).status,
    ).toBe(422);
    expect((await patchStep({ step: "billing", status: "done" })).status).toBe(
      422,
    );
  });

  it("dismisses the start-page notice for this admin only", async () => {
    const first = await makeUser("ADMIN");
    const second = await makeUser("ADMIN");
    await signIn(first.id);
    expect((await dismissNotice()).status).toBe(200);
    expect((await dismissNotice()).status).toBe(200);
    expect((await data<ServerSetupState>(await getState())).noticePending).toBe(
      false,
    );
    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: first.id },
      select: { adminNoticesDismissed: true },
    });
    expect(
      row.adminNoticesDismissed.filter((id) => id === SERVER_SETUP_NOTICE_ID),
    ).toHaveLength(1);

    cookieJar.clear();
    await signIn(second.id);
    expect((await data<ServerSetupState>(await getState())).noticePending).toBe(
      true,
    );
  });

  it("is not offered on a demo deploy", async () => {
    const admin = await makeUser("ADMIN");
    await signIn(admin.id);
    process.env.DEMO_MODE = "true";
    const state = await data<ServerSetupState>(await getState());
    expect(state.offered).toBe(false);
    expect(state.noticePending).toBe(false);
    const res = await patchStep({ step: "accounts", status: "done" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("admin.serverSetup.notOffered");
  });

  it("answers the setup health as closed signals", async () => {
    const admin = await makeUser("ADMIN");
    await signIn(admin.id);
    const res = await getHealth();
    expect(res.status).toBe(200);
    const health = await data<SetupHealth>(res);
    expect(health.signals.map((s) => s.id)).toEqual([
      "encryption_keys",
      "secure_cookie",
      "app_url",
      "database_dump",
    ]);
    const keys = health.signals.find((s) => s.id === "encryption_keys");
    expect(keys?.state).toBe("ok");
    // Never key material: only the count and the id.
    expect(JSON.stringify(health)).not.toContain(
      process.env.ENCRYPTION_KEY ?? "no-key",
    );
  });
});

describe("who is refused", () => {
  const calls = [
    ["GET server-setup", () => getState()],
    [
      "PATCH server-setup",
      () => patchStep({ step: "accounts", status: "done" }),
    ],
    ["POST notice", () => dismissNotice()],
    ["GET setup-health", () => getHealth()],
  ] as const;

  it("refuses an anonymous request with 401", async () => {
    for (const [name, call] of calls) {
      expect((await call()).status, name).toBe(401);
    }
  });

  it("refuses a non-admin, a delegate on an admin's record included, with 403", async () => {
    const admin = await makeUser("ADMIN");
    const delegate = await makeUser("USER");
    const invited = await inviteGrant({
      grantorId: admin.id,
      granteeId: delegate.id,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    const session = await signIn(delegate.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: admin.id },
    });
    const row = await getPrismaClient().session.findUniqueOrThrow({
      where: { id: session.id },
    });
    headerJar.set("x-healthlog-record-epoch", String(row.recordEpoch));
    headerJar.set("x-healthlog-record-scope", admin.id);
    for (const [name, call] of calls) {
      expect((await call()).status, name).toBe(403);
    }
    // Nothing was written for the admin.
    const settings = await getPrismaClient().appSettings.findUniqueOrThrow({
      where: { id: "singleton" },
      select: { serverSetupStepsJson: true },
    });
    expect(settings.serverSetupStepsJson).toBeNull();
  });

  it("refuses an admin's own wildcard Bearer token with 401", async () => {
    const admin = await makeUser("ADMIN");
    await useBearer(admin.id);
    for (const [name, call] of calls) {
      expect((await call()).status, name).toBe(401);
    }
  });
});
