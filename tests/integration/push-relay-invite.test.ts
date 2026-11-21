/**
 * Registration at a relay that accepts new servers by invitation only.
 *
 * - Without a code the relay refuses with `invite_required`; the admin's
 *   switch answers with that state at once, and the minute pass does not ask
 *   the relay again until the admin enters a code.
 * - A code the relay does not accept reads `invite_rejected`, also without a
 *   retry loop.
 * - A valid code registers the instance; the relay spends it, and the code is
 *   stored nowhere on this server (registration row, audit log).
 * - A malformed code is 422 and never reaches the relay.
 * - `registration_paused` waits out the relay's hint.
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
import { makeAdmin, makeSession, type SessionFixture } from "../kit/factories";

const CODE = "Q2xhc3NpY0ludml0ZUNvZGVz";
const OTHER_CODE = "Tm90VGhlUmlnaHRDb2RlXy0x";

interface Status {
  offered: boolean;
  state: string;
  reason: string | null;
  instanceId: string | null;
}

let fake: FakeRelay;
let adminSession: SessionFixture;

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  fake.invites = new Set([CODE]);
  relay.current = fake;
  adminSession = await makeSession(await makeAdmin());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function turnOn(invite?: unknown) {
  const { PUT } = await import("@/app/api/admin/push-relay/route");
  return callRoute<Status>(PUT, {
    method: "PUT",
    route: "/api/admin/push-relay",
    auth: adminSession,
    body: {
      enabled: true,
      acceptTerms: true,
      householdOnly: true,
      ...(invite === undefined ? {} : { invite }),
    },
  });
}

async function minutePasses(count: number) {
  const { runRelayMaintenance } = await import("@/lib/push-relay/maintenance");
  for (let i = 0; i < count; i++) await runRelayMaintenance();
}

function registrationCalls(): number {
  return fake.calls.filter((c) => c === "POST /v1/instances").length;
}

describe("push relay registration in invite mode", () => {
  it("refuses without a code, says so at once, and does not retry on its own", async () => {
    const res = await turnOn();
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      offered: true,
      instanceId: null,
      state: "down",
      reason: "invite_required",
    });
    expect(fake.registrationInvites).toEqual([undefined]);

    await minutePasses(3);
    expect(registrationCalls()).toBe(1);
  });

  it("names a code the relay did not accept, without a retry loop", async () => {
    const res = await turnOn(OTHER_CODE);
    expect(res.data).toMatchObject({
      instanceId: null,
      reason: "invite_rejected",
    });
    await minutePasses(3);
    expect(registrationCalls()).toBe(1);
    expect(fake.invites?.has(CODE)).toBe(true);
  });

  it("registers with a valid code, which the relay spends and this server never keeps", async () => {
    const refused = await turnOn();
    expect(refused.data.reason).toBe("invite_required");

    const res = await turnOn(CODE);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ state: "ok", reason: null });
    expect(res.data.instanceId).toEqual(expect.any(String));
    expect(fake.registrationInvites).toEqual([undefined, CODE]);
    expect(fake.invites?.size).toBe(0);

    const prisma = getPrismaClient();
    const rows = await prisma.pushRelayRegistration.findMany();
    expect(JSON.stringify(rows)).not.toContain(CODE);
    const audits = await prisma.auditLog.findMany();
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(CODE);

    // Registered: the minute pass has nothing to register.
    await minutePasses(2);
    expect(registrationCalls()).toBe(2);
  });

  it("refuses a malformed code with 422 before anything reaches the relay", async () => {
    for (const invite of [
      "short",
      `${CODE}x`,
      "Q2xhc3NpY0ludml0ZUNvZGV+",
      "Q2xhc3NpY0ludml0ZUNvZGV=",
      42,
    ]) {
      const res = await turnOn(invite);
      expect(res.status).toBe(422);
    }
    expect(fake.calls).toEqual([]);
    expect(await getPrismaClient().pushRelayRegistration.count()).toBe(0);
  });

  it("waits out a paused registration instead of asking every minute", async () => {
    fake.invites = null;
    fake.retryAfter = 3600;
    fake.refuse.set("/v1/instances", {
      status: 503,
      error: "registration_paused",
    });
    const res = await turnOn();
    expect(res.data).toMatchObject({
      instanceId: null,
      reason: "registration_paused",
    });
    const row =
      await getPrismaClient().pushRelayRegistration.findFirstOrThrow();
    expect(row.pausedUntil?.getTime()).toBeGreaterThan(
      Date.now() + 3500 * 1000,
    );
    await minutePasses(3);
    expect(registrationCalls()).toBe(1);
  });
});
