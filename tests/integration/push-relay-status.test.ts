/**
 * What the relay says reaches this server and the people reading it, against
 * the fake relay of `push-relay-fake.ts`:
 *
 * - the hourly signed `GET /v1/status`: one request an hour, none while the
 *   relay paused this server; an instance the relay forgot goes back to
 *   registering at once, with every device asked to bind again; the relay's
 *   own state and this instance's bindings there reach the admin card;
 * - a run of refused signatures (`401 bad_signature`) turns the relay state
 *   `degraded` with that reason, on the admin card, in the device's push
 *   diagnostics and as the ledger reason of what waits;
 * - a binding conflict the app has not settled in 30 minutes reads and
 *   becomes `rebind_needed`, so the app posts a fresh binding.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { callRoute, type RouteAuth } from "../kit/call-route";
import type { SessionFixture } from "../kit/factories";
import {
  bindDevice,
  deviceBody,
  enableRelay,
  registerDevice,
} from "./push-relay-kit";
import type { DevicePushDiagnostics } from "@/lib/push-relay/diagnostics";

const prisma = getPrismaClient();
const MIN = 60_000;
const TOKEN = "7d".repeat(32);
const DEVICE_HEADER = `device-${TOKEN.slice(0, 6)}`;

let fake: FakeRelay;

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await truncateAllTables(prisma);
  fake = new FakeRelay();
  relay.current = fake;
});

async function maintenance(now?: Date) {
  const { runRelayMaintenance } = await import("@/lib/push-relay/maintenance");
  return runRelayMaintenance(now);
}

const statusCalls = () =>
  fake.calls.filter((c) => c === "GET /v1/status").length;

interface AdminCard {
  state: string;
  reason: string | null;
  notice: { id: string; level: string | null } | null;
  relayCheck: {
    checkedAt: string | null;
    answeredAt: string | null;
    state: string | null;
    devices: { active: number; provisional: number; limit: number } | null;
  } | null;
  instanceId: string | null;
}

async function adminCard(auth: RouteAuth) {
  const { GET } = await import("@/app/api/admin/push-relay/route");
  const res = await callRoute<AdminCard>(GET, {
    method: "GET",
    route: "/api/admin/push-relay",
    auth,
  });
  expect(res.status).toBe(200);
  return res.data;
}

async function diagnostics(session: SessionFixture) {
  const { GET } = await import("@/app/api/devices/me/push-diagnostics/route");
  const res = await callRoute<DevicePushDiagnostics>(GET, {
    method: "GET",
    route: "/api/devices/me/push-diagnostics",
    auth: session,
    headers: { "x-device-id": DEVICE_HEADER },
  });
  expect(res.status).toBe(200);
  return res.data;
}

async function devicePush(session: SessionFixture) {
  const { GET } = await import("@/app/api/auth/me/route");
  const me = await callRoute<{
    push: { device: { relayState: string } | null };
  }>(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth: session,
    headers: { "x-device-id": DEVICE_HEADER },
    contract: {
      skip: "the account payload's features block predates this check",
    },
  });
  return me.data.push.device;
}

async function stockAlert(userId: string) {
  const { dispatchNotification } =
    await import("@/lib/notifications/dispatcher");
  return dispatchNotification({
    userId,
    eventType: "MEDICATION_LOW_STOCK",
    title: "Running low",
    message: "Five days left",
  });
}

describe("the hourly relay status", () => {
  it("asks once an hour and shows the answer on the admin card", async () => {
    const { adminSession, instanceId } = await enableRelay();
    await bindDevice(instanceId, TOKEN);
    fake.status = {
      devices: { active: 1, provisional: 0, limit: 50 },
      notice: { id: "planned_maintenance", level: "planned" },
      registration: "open",
    };
    const t0 = new Date();
    expect((await maintenance(t0)).status_checked).toBe(true);
    expect(statusCalls()).toBe(1);
    // Within the hour nothing more is asked.
    await maintenance(new Date(t0.getTime() + 59 * MIN));
    expect(statusCalls()).toBe(1);
    await maintenance(new Date(t0.getTime() + 60 * MIN));
    expect(statusCalls()).toBe(2);

    const card = await adminCard(adminSession);
    expect(card.state).toBe("ok");
    expect(card.notice).toEqual({
      id: "planned_maintenance",
      level: "planned",
    });
    expect(card.relayCheck).toMatchObject({
      state: "ok",
      devices: { active: 1, provisional: 0, limit: 50 },
    });
    expect(card.relayCheck?.checkedAt).not.toBeNull();
    expect(card.relayCheck?.answeredAt).not.toBeNull();
  });

  it("is not asked while the relay paused this server", async () => {
    await enableRelay();
    await prisma.pushRelayRegistration.updateMany({
      data: { pausedUntil: new Date(Date.now() + 10 * MIN) },
    });
    expect((await maintenance()).status_checked).toBe(false);
    expect(statusCalls()).toBe(0);
  });

  it("learns that the relay forgot the instance without a push", async () => {
    const { instanceId } = await enableRelay();
    const { deviceId } = await bindDevice(instanceId, TOKEN);
    // The relay lost the instance (retention, a restore): only the status
    // tells, no push is due.
    fake.instances.clear();
    fake.bindings.clear();
    await maintenance();
    const row = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(row).toMatchObject({
      state: "pending",
      stateReason: "unknown_instance",
      instanceId: null,
    });
    expect(
      (await prisma.device.findUniqueOrThrow({ where: { id: deviceId } }))
        .relayState,
    ).toBe("rebind_needed");
    // The next minute registers again (open registration here).
    await maintenance();
    expect(
      (await prisma.pushRelayRegistration.findFirstOrThrow()).instanceId,
    ).not.toBeNull();
  });

  it("keeps the relay's own disruption until Apple takes a push again", async () => {
    const { adminSession, instanceId } = await enableRelay();
    const { session } = await bindDevice(instanceId, TOKEN);
    fake.status = { state: "maintenance" };
    await maintenance();
    let card = await adminCard(adminSession);
    expect(card).toMatchObject({
      state: "degraded",
      reason: "relay_maintenance",
      relayCheck: { state: "maintenance" },
    });
    // A push the relay answers without delivering anything proves nothing.
    fake.itemAnswer = () => ({
      status: 503,
      error: "apns_unavailable",
      retryAfter: 60,
    });
    await stockAlert(session.userId);
    card = await adminCard(adminSession);
    expect(card.reason).toBe("relay_maintenance");
    // One Apple accepted does.
    fake.itemAnswer = null;
    await stockAlert(session.userId);
    card = await adminCard(adminSession);
    expect(card).toMatchObject({ state: "ok", reason: null });
  });
});

describe("a refused signature", () => {
  it("turns the state degraded after three, visibly, and clears on the next signed answer", async () => {
    const { adminSession, instanceId } = await enableRelay();
    const { session } = await bindDevice(instanceId, TOKEN);
    fake.refuse.set("/v1/push", { status: 401, error: "bad_signature" });

    await stockAlert(session.userId);
    await stockAlert(session.userId);
    expect((await adminCard(adminSession)).state).toBe("ok");
    await stockAlert(session.userId);
    const card = await adminCard(adminSession);
    expect(card).toMatchObject({ state: "degraded", reason: "bad_signature" });

    // The device's diagnostics say the same, and the push waiting at the
    // relay names what it waits on.
    const diag = await diagnostics(session);
    expect(diag.relay).toMatchObject({
      state: "degraded",
      reason: "bad_signature",
    });
    expect(diag.lastDelivery.alert).toMatchObject({
      outcome: "pending",
      reason: "bad_signature",
    });
    // The notification ledger tells it from an ordinary wait.
    const attempts = await prisma.pushAttempt.findMany({
      where: { userId: session.userId, eventType: "MEDICATION_LOW_STOCK" },
      select: { result: true, reason: true },
    });
    expect(attempts.map((a) => a.reason)).toContain("relay_bad_signature");

    // A signed answer that is no refusal ends the run.
    fake.refuse.delete("/v1/push");
    await stockAlert(session.userId);
    expect(await adminCard(adminSession)).toMatchObject({
      state: "ok",
      reason: null,
    });
    expect(
      (await prisma.pushRelayRegistration.findFirstOrThrow()).badSignatureCount,
    ).toBe(0);
  });

  it("counts on the hourly status too, not on a binding", async () => {
    const { instanceId } = await enableRelay();
    const { session } = await bindDevice(instanceId, TOKEN);
    fake.refuse.set("/v1/bindings", { status: 401, error: "bad_signature" });
    const again = deviceBody(instanceId, TOKEN);
    await registerDevice(session, again.body);
    expect(
      (await prisma.pushRelayRegistration.findFirstOrThrow()).badSignatureCount,
    ).toBe(0);
    fake.refuse.set("/v1/status", { status: 401, error: "bad_signature" });
    await maintenance();
    expect(
      (await prisma.pushRelayRegistration.findFirstOrThrow()).badSignatureCount,
    ).toBe(1);
  });
});

describe("a binding conflict nobody settles", () => {
  it("asks for a fresh binding after 30 minutes", async () => {
    const { instanceId } = await enableRelay();
    const { session, deviceId } = await bindDevice(instanceId, TOKEN);
    // Another binding key for the same token: the relay answers with a
    // challenge to the device and a conflict to this server.
    const other = deviceBody(instanceId, TOKEN);
    const res = await registerDevice(session, other.body);
    expect(res.data.push.relayState).toBe("conflict");
    expect((await devicePush(session))?.relayState).toBe("conflict");
    expect((await diagnostics(session)).binding.state).toBe("conflict");

    // Still unsettled half an hour later: every reader says rebind_needed
    // at once, and the minute pass stores it.
    await prisma.device.update({
      where: { id: deviceId },
      data: { relayConflictAt: new Date(Date.now() - 31 * MIN) },
    });
    expect((await devicePush(session))?.relayState).toBe("rebind_needed");
    expect((await diagnostics(session)).binding.state).toBe("rebind_needed");
    expect((await maintenance()).conflicts_expired).toBe(1);
    expect(
      await prisma.device.findUniqueOrThrow({
        where: { id: deviceId },
        select: { relayState: true, relayConflictAt: true },
      }),
    ).toEqual({ relayState: "rebind_needed", relayConflictAt: null });

    // The app answered the challenge at the relay and posts a fresh
    // binding: the relay now holds its key, and the device is bound.
    fake.bindings.set(TOKEN, {
      instanceId,
      bindingKey: other.binding.publicKey.toString("base64url"),
      seq: 1,
    });
    const fresh = await registerDevice(session, other.body);
    expect(fresh.data.push.relayState).toBe("bound");
  });

  it("leaves a fresh conflict alone", async () => {
    const { instanceId } = await enableRelay();
    const { session } = await bindDevice(instanceId, TOKEN);
    await registerDevice(session, deviceBody(instanceId, TOKEN).body);
    expect((await maintenance()).conflicts_expired).toBe(0);
    expect((await devicePush(session))?.relayState).toBe("conflict");
  });
});
