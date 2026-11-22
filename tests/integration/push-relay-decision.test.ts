/**
 * The operator's one answer to "Send push notifications through the HealthLog
 * relay?" (`POST /api/admin/push-relay/decision`, `push.relay.operatorDecision`
 * and `canDecide` on `/api/auth/me`).
 *
 * - A fresh server whose relay is available is `undecided`; `canDecide` is
 *   true for an admin and false for anyone else.
 * - No sets `off`, audited, and the question is never open again: a second
 *   answer is 409, on every admin account.
 * - Yes needs the switch's confirmations, and is `on` only once the
 *   registration succeeded: a refused or unreachable registration leaves the
 *   question open, and the minute pass that finishes the registration later
 *   makes it `on`.
 * - The switch writes the same decision: off is `off`, on again is `on`.
 * - A Bearer token, a wildcard one of an admin included, never reaches the
 *   answer route, nor does a non-admin cookie session.
 * - With the relay not available there is nothing to decide: `off`, and
 *   `canDecide` false.
 * - A restore of instance settings never contradicts a running relay: the
 *   registration does not travel, so onto a registered host the file's
 *   `null` or `off` is not written, and a column that disagrees anyway still
 *   publishes `on` while the registration sends. Onto a host that is not
 *   registered, the file's answer is restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { FakeRelay, RELAY_PUBLIC_KEY, RELAY_URL } from "./push-relay-fake";

const relay = vi.hoisted(() => ({
  current: null as null | {
    handle: (url: string | URL, init?: RequestInit) => Promise<Response>;
  },
}));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: (url: string | URL, init?: RequestInit) => {
      if (!relay.current) throw new Error("no fake relay");
      return relay.current.handle(url, init);
    },
  };
});

import { getPrismaClient, truncateAllTables } from "./setup";
import { callRoute } from "../kit/call-route";
import {
  makeAdmin,
  makeSession,
  makeToken,
  makeUser,
  type BearerFixture,
  type SessionFixture,
} from "../kit/factories";

const CODE = "Q2xhc3NpY0ludml0ZUNvZGVz";

interface Status {
  offered: boolean;
  instanceId: string | null;
  reason: string | null;
  operatorDecision: "undecided" | "on" | "off";
}

let fake: FakeRelay;
let adminSession: SessionFixture;

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
  adminSession = await makeSession(await makeAdmin());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function answer(
  body: Record<string, unknown>,
  auth: SessionFixture | BearerFixture = adminSession,
) {
  const { POST } = await import("@/app/api/admin/push-relay/decision/route");
  return callRoute<Status>(POST, {
    method: "POST",
    route: "/api/admin/push-relay/decision",
    auth,
    body,
  });
}

const YES = { enabled: true, acceptTerms: true, householdOnly: true };

async function relayOnMe(auth: SessionFixture | BearerFixture = adminSession) {
  const { GET } = await import("@/app/api/auth/me/route");
  const me = await callRoute<{
    push: { relay: { operatorDecision: string; canDecide: boolean } };
  }>(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth,
    contract: {
      skip: "the account payload's features block predates this check",
    },
  });
  expect(me.status).toBe(200);
  return me.data.push.relay;
}

/**
 * Put back the instance settings of a disaster-recovery file written while
 * the relay answer was `decision`, the way the restore job does.
 */
async function restoreSettingsFile(decision: "on" | "off" | null) {
  const prisma = getPrismaClient();
  const { serialiseAppSettings, restoreAppSettings } =
    await import("@/lib/export/app-settings-backup");
  const row = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  const appSettings = {
    ...serialiseAppSettings(row),
    pushRelayDecision: decision,
  };
  await prisma.$transaction(async (tx) => {
    await restoreAppSettings({
      tx,
      payload: { appSettings },
      restoreInstanceSettings: true,
    } as unknown as Parameters<typeof restoreAppSettings>[0]);
  });
}

async function adminStatus(): Promise<Status> {
  const { adminRelayStatus } = await import("@/lib/push-relay/admin-status");
  return (await adminRelayStatus()) as unknown as Status;
}

async function stored(): Promise<string | null> {
  const row = await getPrismaClient().appSettings.findUnique({
    where: { id: "singleton" },
    select: { pushRelayDecision: true },
  });
  return row?.pushRelayDecision ?? null;
}

describe("the relay question", () => {
  it("is open on a fresh server, and only an admin may answer it", async () => {
    expect(await relayOnMe()).toMatchObject({
      operatorDecision: "undecided",
      canDecide: true,
    });
    const member = await makeSession(await makeUser());
    expect(await relayOnMe(member)).toMatchObject({
      operatorDecision: "undecided",
      canDecide: false,
    });
    const refused = await answer({ enabled: false }, member);
    expect(refused.status).toBe(403);
    expect(await stored()).toBeNull();
  });

  it("never reaches the answer route with a Bearer token, an admin's wildcard one included", async () => {
    const admin = await makeAdmin();
    const token = await makeToken(admin);
    // Informational on the app's transport: the account may decide, on the
    // web admin page.
    expect((await relayOnMe(token)).canDecide).toBe(true);
    // `requireAdmin()` reads the cookie only: to it, a Bearer request is not
    // signed in at all.
    const res = await answer({ enabled: false }, token);
    expect(res.status).toBe(401);
    expect(await stored()).toBeNull();
  });

  it("no keeps the relay off and is never asked again", async () => {
    const res = await answer({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ operatorDecision: "off", offered: false });
    expect(await stored()).toBe("off");
    expect((await relayOnMe()).operatorDecision).toBe("off");

    const audit = await getPrismaClient().auditLog.findMany({
      where: { action: "admin.push_relay.declined" },
    });
    expect(audit).toHaveLength(1);

    // A second admin, or a stale card, cannot reopen or overturn it.
    const other = await makeSession(await makeAdmin());
    for (const body of [{ enabled: false }, YES]) {
      const again = await answer(body, other);
      expect(again.status).toBe(409);
      expect(again.meta?.errorCode).toBe("admin.pushRelay.decisionNotOpen");
    }
    expect(fake.calls.filter((c) => c === "POST /v1/instances")).toEqual([]);
    expect(await stored()).toBe("off");
  });

  it("yes needs both confirmations and is on once the registration succeeded", async () => {
    const bare = await answer({ enabled: true });
    expect(bare.status).toBe(422);
    expect(bare.meta?.errorCode).toBe("admin.pushRelay.confirmationsRequired");
    expect(await stored()).toBeNull();

    const res = await answer(YES);
    expect(res.status).toBe(200);
    expect(res.data.instanceId).toEqual(expect.any(String));
    expect(res.data.operatorDecision).toBe("on");
    expect(await stored()).toBe("on");
    expect((await relayOnMe()).operatorDecision).toBe("on");

    const again = await answer({ enabled: false });
    expect(again.status).toBe(409);
    expect(await stored()).toBe("on");
    expect(await getPrismaClient().pushRelayRegistration.count()).toBe(1);
  });

  it("a refused registration leaves the question open, and a code then answers it", async () => {
    fake.invites = new Set([CODE]);
    const refused = await answer(YES);
    expect(refused.status).toBe(200);
    expect(refused.data).toMatchObject({
      offered: true,
      instanceId: null,
      reason: "invite_required",
      operatorDecision: "undecided",
    });
    expect(await stored()).toBeNull();

    const res = await answer({ ...YES, invite: CODE });
    expect(res.data.operatorDecision).toBe("on");
    expect(await stored()).toBe("on");
  });

  it("no after a refused registration takes the unfinished registration with it", async () => {
    fake.invites = new Set([CODE]);
    expect((await answer(YES)).data.offered).toBe(true);
    const res = await answer({ enabled: false });
    expect(res.data).toMatchObject({ operatorDecision: "off", offered: false });
    expect(await getPrismaClient().pushRelayRegistration.count()).toBe(0);
  });

  it("an unreachable relay stays undecided until the minute pass registers", async () => {
    fake.down = true;
    const res = await answer(YES);
    expect(res.data).toMatchObject({
      offered: true,
      instanceId: null,
      operatorDecision: "undecided",
    });
    fake.down = false;
    const { runRelayMaintenance } =
      await import("@/lib/push-relay/maintenance");
    await runRelayMaintenance();
    expect(await stored()).toBe("on");
    expect((await relayOnMe()).operatorDecision).toBe("on");
  });

  it("the switch writes the same decision", async () => {
    const { PUT } = await import("@/app/api/admin/push-relay/route");
    const turn = (body: Record<string, unknown>) =>
      callRoute<Status>(PUT, {
        method: "PUT",
        route: "/api/admin/push-relay",
        auth: adminSession,
        body,
      });
    expect((await turn(YES)).data.operatorDecision).toBe("on");
    const off = await turn({ enabled: false });
    expect(off.data.operatorDecision).toBe("off");
    expect(await stored()).toBe("off");
    // Changing one's mind goes through the switch, not the question.
    expect((await turn(YES)).data.operatorDecision).toBe("on");
  });

  it("has nothing to decide while the relay is not available", async () => {
    vi.stubEnv("PUSH_RELAY_MODE", "off");
    expect(await relayOnMe()).toMatchObject({
      operatorDecision: "off",
      canDecide: false,
    });
    const res = await answer({ enabled: false });
    expect(res.status).toBe(409);
    expect(await stored()).toBeNull();
  });

  it.each([null, "off"] as const)(
    "a restored %s keeps the host's yes while the relay runs",
    async (decision) => {
      expect((await answer(YES)).data.operatorDecision).toBe("on");
      await restoreSettingsFile(decision);
      expect(await stored()).toBe("on");
      expect((await relayOnMe()).operatorDecision).toBe("on");
      expect((await adminStatus()).operatorDecision).toBe("on");
    },
  );

  it("publishes on while registered even when the column says otherwise", async () => {
    expect((await answer(YES)).data.operatorDecision).toBe("on");
    await getPrismaClient().appSettings.update({
      where: { id: "singleton" },
      data: { pushRelayDecision: "off" },
    });
    expect((await relayOnMe()).operatorDecision).toBe("on");
    expect((await adminStatus()).operatorDecision).toBe("on");
  });

  it("restores the file's answer onto a host that is not registered", async () => {
    await restoreSettingsFile("off");
    expect(await stored()).toBe("off");
    expect((await relayOnMe()).operatorDecision).toBe("off");

    // A switched-off relay whose deletion the relay has not confirmed yet is
    // not a registration that sends: the file's answer is written.
    await getPrismaClient().appSettings.update({
      where: { id: "singleton" },
      data: { pushRelayDecision: null },
    });
    const { PUT } = await import("@/app/api/admin/push-relay/route");
    await callRoute<Status>(PUT, {
      method: "PUT",
      route: "/api/admin/push-relay",
      auth: adminSession,
      body: YES,
    });
    fake.down = true;
    await callRoute<Status>(PUT, {
      method: "PUT",
      route: "/api/admin/push-relay",
      auth: adminSession,
      body: { enabled: false },
    });
    const left = await getPrismaClient().pushRelayRegistration.findMany();
    expect(left.map((r) => r.state)).toEqual(["deleting"]);
    await restoreSettingsFile(null);
    expect(await stored()).toBeNull();
  });
});
