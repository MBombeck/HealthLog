/**
 * The pre-launch review findings on the server side of the push relay, each
 * against the fake relay of `push-relay-fake.ts`:
 *
 * - H3: a 429 from the receipts or the binding endpoint pauses nothing; only
 *   push and status answers govern the instance, and a refused receipt
 *   report waits its interval instead of being retried every minute.
 * - H4: a new sender key is announced as `next` and seals nothing for 7
 *   days, then becomes `current` with the old one `previous` for 30 days,
 *   then the old one is deleted; never more than three keys are published.
 * - M6: revoking a device, withdrawing consent and switching the relay off
 *   reach the relay even when it is down at that moment.
 * - M7: one APNs token in other letters is the same token for the ownership
 *   guard.
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
import { callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import {
  bindDevice,
  deviceBody,
  enableRelay,
  registerDevice,
} from "./push-relay-kit";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import { openEnvelope } from "@/lib/push-relay/__tests__/envelope-open";

let fake: FakeRelay;
const DAY = 24 * 3600 * 1000;

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
});

async function maintenance() {
  const { runRelayMaintenance } = await import("@/lib/push-relay/maintenance");
  return runRelayMaintenance();
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

async function senderKeys(session: Awaited<ReturnType<typeof makeSession>>) {
  const { GET } = await import("@/app/api/auth/me/route");
  const me = await callRoute<{
    push: {
      relay: { senderKeys: Array<{ publicKey: string; status: string }> };
    };
  }>(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth: session,
    contract: {
      skip: "the account payload's features block predates this check",
    },
  });
  return me.data.push.relay.senderKeys;
}

describe("H3: only push and status answers pause the instance", () => {
  it("ignores a refused receipt report and a refused binding", async () => {
    const { instanceId } = await enableRelay();
    const token = "d1".repeat(32);
    const { session, deviceId } = await bindDevice(instanceId, token);
    const prisma = getPrismaClient();
    const now = Date.now();
    await prisma.pushRelayDelivery.create({
      data: {
        deviceId,
        ref: "01JTESTVECT000000000000001",
        pushClass: "alert",
        eventType: "MEDICATION_LOW_STOCK",
        expiresAt: new Date(now - 6 * 3600_000),
        status: "accepted",
        acceptedAt: new Date(now - 7 * 3600_000),
      },
    });
    await prisma.device.update({
      where: { id: deviceId },
      data: { envelopeReportedAt: new Date(now - 3600_000) },
    });
    fake.retryAfter = 3600;
    fake.refuse.set("/v1/receipts", { status: 429, error: "instance_rate" });
    fake.refuse.set("/v1/bindings", { status: 429, error: "binding_quota" });
    await maintenance();
    await maintenance();
    expect(fake.calls.filter((c) => c === "POST /v1/receipts")).toHaveLength(1);
    const second = deviceBody(instanceId, "d2".repeat(32));
    await registerDevice(await makeSession(await makeUser()), second.body);
    const row = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(row.pausedUntil).toBeNull();
    expect(row.circuitOpenedAt).toBeNull();
    await stockAlert(session.userId);
    expect(fake.apns.filter((a) => a.token === token)).toHaveLength(1);
  });

  it("does pause on a signed 429 from the push path", async () => {
    const { instanceId } = await enableRelay();
    const { session } = await bindDevice(instanceId, "d3".repeat(32));
    fake.retryAfter = 120;
    fake.refuse.set("/v1/push", { status: 429, error: "instance_rate" });
    await stockAlert(session.userId);
    const row =
      await getPrismaClient().pushRelayRegistration.findFirstOrThrow();
    expect(row.pausedUntil).not.toBeNull();
  });
});

describe("H4: staged sender keys", () => {
  it("announces, seals with current only, promotes after 7 days, retires after 30", async () => {
    const { instanceId } = await enableRelay();
    const token = "e1".repeat(32);
    const { session, pushKey } = await bindDevice(instanceId, token);
    const prisma = getPrismaClient();
    const original = (await senderKeys(session))[0].publicKey;
    await prisma.pushEnvelopeKeys.update({
      where: { id: "singleton" },
      data: { senderCreatedAt: new Date(Date.now() - 358 * DAY) },
    });
    await maintenance();
    const announced = await senderKeys(session);
    expect(announced.map((k) => k.status)).toEqual(["next", "current"]);
    const next = announced[0].publicKey;

    await stockAlert(session.userId);
    const envelope = fromBase64Url(
      fake.apns.at(-1)!.payload.e as string,
    ) as Buffer;
    const open = (sender: string) =>
      openEnvelope({
        recipientKeys: [pushKey.privateKey],
        trustedSenders: [fromBase64Url(sender, 32) as Buffer],
        apnsToken: Buffer.from(token, "hex"),
        envelope,
        expectedClass: "alert",
        now: Math.floor(Date.now() / 1000),
      });
    expect(open(original).t).toBe("MEDICATION_LOW_STOCK");
    expect(() => open(next)).toThrow();

    await prisma.pushEnvelopeKeys.update({
      where: { id: "singleton" },
      data: { nextAnnouncedAt: new Date(Date.now() - 7 * DAY) },
    });
    await maintenance();
    expect(await senderKeys(session)).toEqual([
      { publicKey: next, status: "current" },
      { publicKey: original, status: "previous" },
    ]);

    await prisma.pushEnvelopeKeys.update({
      where: { id: "singleton" },
      data: { previousRetiredAt: new Date(Date.now() - 30 * DAY) },
    });
    await maintenance();
    expect(await senderKeys(session)).toEqual([
      { publicKey: next, status: "current" },
    ]);
    const row = await prisma.pushEnvelopeKeys.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(row.previousSenderPublicKey).toBeNull();
  });

  it("keeps the emergency rotation behind a fresh second factor", async () => {
    const { adminSession } = await enableRelay();
    const { POST } =
      await import("@/app/api/admin/push-relay/rotate-sender-key/route");
    const res = await callRoute(POST, {
      method: "POST",
      route: "/api/admin/push-relay/rotate-sender-key",
      auth: adminSession,
      contract: { skip: "a step-up refusal is the shared auth envelope" },
    });
    expect(res.status).toBe(401);
    const { rotateSenderKey } = await import("@/lib/push-relay/sender-keys");
    const before = await getPrismaClient().pushEnvelopeKeys.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(await rotateSenderKey()).toBe(true);
    const after = await getPrismaClient().pushEnvelopeKeys.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(after.senderPublicKey).not.toBe(before.senderPublicKey);
    expect(after.previousSenderPublicKey).toBeNull();
    expect(after.nextSenderPublicKey).toBeNull();
  });
});

describe("M6: unbinds reach the relay through an outage", () => {
  it("for a revoked device and a withdrawn consent", async () => {
    const { instanceId } = await enableRelay();
    const revoked = "f1".repeat(32);
    const withdrawn = "f2".repeat(32);
    const a = await bindDevice(instanceId, revoked);
    const b = await bindDevice(instanceId, withdrawn);
    fake.down = true;
    const { DELETE } = await import("@/app/api/devices/[id]/route");
    const res = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/devices/{id}",
      params: { id: a.deviceId },
      auth: a.session,
    });
    expect(res.status).toBe(200);
    const again = deviceBody(instanceId, withdrawn, {
      relayConsent: { granted: false, textVersion: "2026-12-01" },
      relayBinding: undefined,
    });
    await registerDevice(b.session, again.body);
    const prisma = getPrismaClient();
    expect(await prisma.pushRelayUnbind.count()).toBe(2);
    expect(fake.bindings.has(revoked) && fake.bindings.has(withdrawn)).toBe(
      true,
    );
    fake.down = false;
    await prisma.pushRelayUnbind.updateMany({
      data: { nextAttemptAt: new Date(0) },
    });
    await maintenance();
    expect(fake.bindings.has(revoked)).toBe(false);
    expect(fake.bindings.has(withdrawn)).toBe(false);
    expect(await prisma.pushRelayUnbind.count()).toBe(0);
  });

  it("keeps a switched-off registration until the relay confirmed deleting it", async () => {
    const { instanceId, adminSession } = await enableRelay();
    const { session } = await bindDevice(instanceId, "f3".repeat(32));
    fake.down = true;
    const { PUT } = await import("@/app/api/admin/push-relay/route");
    const off = await callRoute<{ offered: boolean }>(PUT, {
      method: "PUT",
      route: "/api/admin/push-relay",
      auth: adminSession,
      body: { enabled: false },
    });
    expect(off.data.offered).toBe(false);
    const prisma = getPrismaClient();
    const kept = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(kept.state).toBe("deleting");
    expect(fake.instances.has(instanceId)).toBe(true);
    fake.down = false;
    const before = fake.calls.length;
    await stockAlert(session.userId);
    expect(
      fake.calls.slice(before).filter((c) => c.startsWith("POST /v1/push")),
    ).toHaveLength(0);
    await maintenance();
    expect(fake.instances.has(instanceId)).toBe(false);
    expect(await prisma.pushRelayRegistration.count()).toBe(0);
  });
});

describe("M7: token ownership ignores letter case", () => {
  it("refuses another account the same token in other letters", async () => {
    const { POST } = await import("@/app/api/devices/route");
    const token = "AbCdEf01".repeat(8);
    const base = {
      bundleId: "dev.healthlog.app",
      apnsEnvironment: "production",
    };
    const first = await callRoute(POST, {
      method: "POST",
      route: "/api/devices",
      auth: await makeSession(await makeUser()),
      body: { ...base, token: "device-upper", apnsToken: token.toUpperCase() },
    });
    expect(first.status).toBe(201);
    const stored = await getPrismaClient().device.findFirstOrThrow({
      where: { token: "device-upper" },
    });
    expect(stored.apnsToken).toBe(token.toLowerCase());
    const second = await callRoute(POST, {
      method: "POST",
      route: "/api/devices",
      auth: await makeSession(await makeUser()),
      body: { ...base, token: "device-lower", apnsToken: token.toLowerCase() },
    });
    expect(second.status).toBe(409);
  });
});
