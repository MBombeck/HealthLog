/**
 * The push relay when things go wrong, against the fake relay of
 * `push-relay-fake.ts`. Each case is a review finding of the relay concept:
 *
 * - A relay outage never counts against the APNs channel: five and more
 *   failed dispatches leave it enabled with its failure counter at zero (the
 *   5-soft-failures auto-disable used to switch it off).
 * - Three transport failures open the breaker; the device's `intakeSync`
 *   turns `degraded`; nothing is deleted.
 * - A response not signed by the pinned relay key is never acted on, even
 *   when it says `410 unregistered`.
 * - `404 binding_unknown` asks the device to bind again and keeps its row.
 * - `410 unregistered` deletes the device row, and only below the cap of a
 *   third of the relay devices per hour.
 * - A push past its deadline is dropped, not delivered late, and the device
 *   reads `degraded`.
 * - The device registration refuses a low-order key, a binding without
 *   consent and a statement for another instance.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import {
  FakeRelay,
  RELAY_HOST,
  RELAY_PUBLIC_KEY,
  RELAY_URL,
} from "./push-relay-fake";

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
  makeUser,
  type SessionFixture,
} from "../kit/factories";
import { generateX25519 } from "@/lib/push-relay/hpke";
import { tokenTagHex } from "@/lib/push-relay/encoding";
import {
  bindText,
  generateEd25519,
  signText,
} from "@/lib/push-relay/statements";

let fake: FakeRelay;

beforeAll(() => {
  process.env.PUSH_RELAY_URL = RELAY_URL;
  process.env.PUSH_RELAY_KEYS = RELAY_PUBLIC_KEY;
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
});

async function enable() {
  const { PUT } = await import("@/app/api/admin/push-relay/route");
  const admin = await makeAdmin();
  const res = await callRoute<{ instanceId: string }>(PUT, {
    method: "PUT",
    route: "/api/admin/push-relay",
    auth: await makeSession(admin),
    body: { enabled: true, acceptTerms: true, householdOnly: true },
  });
  return res.data.instanceId;
}

function bodyFor(
  instanceId: string,
  token: string,
  extra: Record<string, unknown> = {},
) {
  const binding = generateEd25519();
  const statement = {
    instanceId,
    tokenTag: tokenTagHex(token) as string,
    kind: "device" as const,
    seq: 1,
    iat: Math.floor(Date.now() / 1000),
  };
  return {
    token: `device-${token.slice(0, 6)}`,
    bundleId: "dev.healthlog.app",
    apnsToken: token,
    apnsEnvironment: "production",
    medicationDelivery: "client",
    pushKey: {
      v: 1,
      suites: [1],
      publicKey: generateX25519().publicKey.toString("base64url"),
    },
    relayConsent: { granted: true, textVersion: "2026-12-01" },
    relayBinding: {
      bindingKey: binding.publicKey.toString("base64url"),
      statement,
      signature: signText(
        binding.seed,
        bindText({ host: RELAY_HOST, ...statement }),
      ).toString("base64url"),
    },
    ...extra,
  };
}

async function register(
  session: SessionFixture,
  body: Record<string, unknown>,
) {
  const { POST } = await import("@/app/api/devices/route");
  return callRoute<{ id: string; push: Record<string, unknown> }>(POST, {
    method: "POST",
    route: "/api/devices",
    auth: session,
    body,
  });
}

async function boundDevice(instanceId: string, token: string) {
  const user = await makeUser();
  const session = await makeSession(user);
  const res = await register(session, bodyFor(instanceId, token));
  expect(res.data.push.relayState).toBe("bound");
  return { user, session, deviceId: res.data.id };
}

async function deviceState(session: SessionFixture, deviceToken: string) {
  const { GET } = await import("@/app/api/auth/me/route");
  const me = await callRoute<{
    push: { relay: Record<string, unknown>; device: Record<string, unknown> };
  }>(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth: session,
    headers: { "x-device-id": deviceToken },
    contract: {
      skip: "the account payload's features block predates this check",
    },
  });
  return me.data.push;
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

describe("push relay failures", () => {
  it("keeps the APNs channel on through a relay outage and opens the breaker", async () => {
    const instanceId = await enable();
    const token = "a1".repeat(32);
    const { user, session, deviceId } = await boundDevice(instanceId, token);
    fake.down = true;
    for (let i = 0; i < 6; i++) await stockAlert(user.id);
    const prisma = getPrismaClient();
    const channel = await prisma.notificationChannel.findUniqueOrThrow({
      where: { userId_type: { userId: user.id, type: "APNS" } },
    });
    expect(channel.enabled).toBe(true);
    expect(channel.consecutiveFailures).toBe(0);
    expect(channel.disabledReason).toBeNull();
    const registration = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(registration.circuitOpenedAt).not.toBeNull();
    expect(await prisma.device.count({ where: { id: deviceId } })).toBe(1);
    const push = await deviceState(session, `device-${token.slice(0, 6)}`);
    expect(push.relay.state).toBe("down");
    expect(push.device.intakeSync).toBe("degraded");
    expect(
      await prisma.pushRelayDelivery.count({ where: { status: "pending" } }),
    ).toBeGreaterThan(0);
  });

  it("never acts on a response the pinned relay key did not sign", async () => {
    const instanceId = await enable();
    const token = "b2".repeat(32);
    const { user, deviceId } = await boundDevice(instanceId, token);
    fake.apnsAnswer.set(token, "unregistered");
    fake.forge = true;
    await stockAlert(user.id);
    const prisma = getPrismaClient();
    expect(await prisma.device.count({ where: { id: deviceId } })).toBe(1);
    const delivery = await prisma.pushRelayDelivery.findFirstOrThrow({
      where: { deviceId },
    });
    expect(delivery.status).toBe("pending");
  });

  it("asks for a fresh binding on binding_unknown and keeps the device", async () => {
    const instanceId = await enable();
    const token = "c3".repeat(32);
    const { user, deviceId } = await boundDevice(instanceId, token);
    fake.bindings.delete(token);
    await stockAlert(user.id);
    const device = await getPrismaClient().device.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.relayState).toBe("rebind_needed");
  });

  it("deletes the device on unregistered, and holds deletions past a third of the devices", async () => {
    const instanceId = await enable();
    const prisma = getPrismaClient();
    const tokens = ["d4", "d5", "d6", "d7", "d8", "d9"].map((b) =>
      b.repeat(32),
    );
    const devices = [];
    for (const token of tokens)
      devices.push({ token, ...(await boundDevice(instanceId, token)) });
    for (const token of tokens) fake.apnsAnswer.set(token, "unregistered");
    for (const d of devices) await stockAlert(d.user.id);
    const left = await prisma.device.findMany({
      where: { id: { in: devices.map((d) => d.deviceId) } },
    });
    // Six bound devices: two deletions are allowed in the hour, the rest held.
    expect(left).toHaveLength(4);
    expect(left.every((d) => d.relayState === "rebind_needed")).toBe(true);
    const registration = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(registration.deletionHoldUntil).not.toBeNull();
  });

  it("drops a push past its deadline and reports the device degraded", async () => {
    const instanceId = await enable();
    const token = "e5".repeat(32);
    const { session, deviceId } = await boundDevice(instanceId, token);
    const prisma = getPrismaClient();
    await prisma.pushRelayDelivery.create({
      data: {
        deviceId,
        ref: "01JTESTVECT000000000000009",
        pushClass: "alert",
        eventType: "MEDICATION_INTAKE_RECORDED",
        item: { envelope: "x" },
        expiresAt: new Date(Date.now() - 1000),
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });
    const { runRelayMaintenance } =
      await import("@/lib/push-relay/maintenance");
    await runRelayMaintenance();
    const row = await prisma.pushRelayDelivery.findFirstOrThrow({
      where: { deviceId },
    });
    expect(row.status).toBe("dropped");
    expect(fake.apns).toHaveLength(0);
    const push = await deviceState(session, `device-${token.slice(0, 6)}`);
    expect(push.device.intakeSync).toBe("degraded");
  });

  it("refuses a low-order key, a binding without consent and a statement for another instance", async () => {
    const instanceId = await enable();
    const session = await makeSession(await makeUser());
    const token = "f6".repeat(32);
    const lowOrder = await register(
      session,
      bodyFor(instanceId, token, {
        pushKey: {
          v: 1,
          suites: [1],
          publicKey: Buffer.alloc(32).toString("base64url"),
        },
      }),
    );
    expect(lowOrder.status).toBe(422);
    expect(lowOrder.meta?.errorCode).toBe("devices.push.invalid_push_key");
    const noConsent = await register(
      session,
      bodyFor(instanceId, token, { relayConsent: undefined }),
    );
    expect(noConsent.meta?.errorCode).toBe("devices.push.consent_required");
    const other = await register(
      session,
      bodyFor("00000000-0000-4000-8000-000000000000", token),
    );
    expect(other.meta?.errorCode).toBe("devices.push.instance_mismatch");
    expect(fake.bindings.size).toBe(0);
    expect(await getPrismaClient().device.count()).toBe(0);
  });
});
