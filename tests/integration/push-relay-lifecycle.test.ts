/**
 * The push relay through an account's erasure, an instance key rotation, the
 * admin's test push, and a relay without pinned keys.
 *
 * - Every erasure path (the person's own deletion, an admin's, the purge after
 *   the grace window, a managed profile's purge) queues a relay unbind for
 *   each relay device of the account; the minute pass sends it, the binding
 *   is gone at the relay and no local relay state is left. A relay outage
 *   does not block the deletion: the unbind waits and goes out once the relay
 *   is back. Queueing is idempotent.
 * - The instance key rotates on schedule and on demand through
 *   `POST /v1/instances/self/rotate`; when the relay's answer is lost, the
 *   pending key is used on the next refusal and kept.
 * - The admin's test push reaches the admin's own relay device sealed, with
 *   the relay's signed answer and the delivery state.
 * - Without pinned relay keys nothing is sent and the relay reads unavailable.
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
import { makeSession, makeUser } from "../kit/factories";
import { bindDevice, enableRelay } from "./push-relay-kit";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import { openEnvelope } from "@/lib/push-relay/__tests__/envelope-open";
import { ed25519PublicOf } from "@/lib/push-relay/statements";

let fake: FakeRelay;

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "0");
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function maintenance() {
  const { runRelayMaintenance } = await import("@/lib/push-relay/maintenance");
  return runRelayMaintenance();
}

async function deleteOwn(userId: string) {
  const { requestAccountDeletion } =
    await import("@/lib/account-deletion/request");
  await requestAccountDeletion({
    userId,
    targetIsAdmin: false,
    requestedById: userId,
    inTransaction: async () => {},
  });
}

async function expectUnboundAfterPass(token: string) {
  const prisma = getPrismaClient();
  expect(await prisma.pushRelayUnbind.count({ where: { token } })).toBe(1);
  expect(fake.bindings.has(token)).toBe(true);
  await maintenance();
  expect(fake.bindings.has(token)).toBe(false);
  expect(await prisma.pushRelayUnbind.count()).toBe(0);
  expect(await prisma.device.count({ where: { apnsToken: token } })).toBe(0);
  expect(await prisma.pushRelayDelivery.count()).toBe(0);
}

describe("account erasure unbinds at the relay", () => {
  it("on the person's own deletion", async () => {
    const { instanceId } = await enableRelay();
    const token = "a1".repeat(32);
    const { session } = await bindDevice(instanceId, token);
    await deleteOwn(session.userId);
    expect(
      await getPrismaClient().user.count({ where: { id: session.userId } }),
    ).toBe(0);
    await expectUnboundAfterPass(token);
  });

  it("on an admin's deletion", async () => {
    const { instanceId, adminSession } = await enableRelay();
    const token = "a2".repeat(32);
    const { session } = await bindDevice(instanceId, token);
    const { DELETE } = await import("@/app/api/admin/users/[id]/route");
    const res = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/admin/users/{id}",
      params: { id: session.userId },
      auth: adminSession,
      body: { confirm: "DELETE_ACCOUNT" },
      contract: { skip: "the deletion answer is not what this test is about" },
    });
    expect(res.status).toBe(200);
    await expectUnboundAfterPass(token);
  });

  it("on the purge after the grace window, not before", async () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "14");
    const { instanceId } = await enableRelay();
    const token = "a3".repeat(32);
    const { session } = await bindDevice(instanceId, token);
    const prisma = getPrismaClient();
    await deleteOwn(session.userId);
    expect(await prisma.pushRelayUnbind.count()).toBe(0);
    await prisma.user.update({
      where: { id: session.userId },
      data: { deletionPurgeAt: new Date(Date.now() - 60_000) },
    });
    const { processDueAccountDeletions } =
      await import("@/lib/jobs/account-deletion-purge");
    expect((await processDueAccountDeletions(new Date())).purged).toBe(1);
    await expectUnboundAfterPass(token);
  });

  it("on a managed profile's purge", async () => {
    const { instanceId } = await enableRelay();
    const prisma = getPrismaClient();
    const guardian = await makeUser();
    const profile = await prisma.user.create({
      data: {
        username: "managed-relay",
        managedProfileAt: new Date(),
        deletionRequestedAt: new Date(),
        deletionPurgeAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.accountGrant.create({
      data: {
        grantorId: profile.id,
        granteeId: guardian.id,
        access: "MANAGE",
        acceptedAt: new Date(),
      },
    });
    const token = "a4".repeat(32);
    await bindDevice(instanceId, token);
    // Put the bound device on the profile: the shared erasure is what is tested.
    await prisma.device.updateMany({
      where: { apnsToken: token },
      data: { userId: profile.id },
    });
    const { processDueAccountDeletions } =
      await import("@/lib/jobs/account-deletion-purge");
    expect((await processDueAccountDeletions(new Date())).purged).toBe(1);
    await expectUnboundAfterPass(token);
  });

  it("does not let a relay outage block the deletion, and is idempotent", async () => {
    const { instanceId } = await enableRelay();
    const token = "a5".repeat(32);
    const { session } = await bindDevice(instanceId, token);
    const prisma = getPrismaClient();
    fake.down = true;
    await deleteOwn(session.userId);
    expect(await prisma.user.count({ where: { id: session.userId } })).toBe(0);
    await maintenance();
    const waiting = await prisma.pushRelayUnbind.findUniqueOrThrow({
      where: { token },
    });
    expect(waiting.attempts).toBe(1);
    const { queueRelayUnbindsForAccount } =
      await import("@/lib/push-relay/unbind-queue");
    // The same token on a new account, erased while the first unbind waits:
    // still one queued unbind.
    const next = await makeUser();
    await prisma.device.create({
      data: {
        userId: next.id,
        platform: "ios",
        token: "again",
        bundleId: "dev.healthlog.app",
        apnsToken: token,
        apnsEnvironment: "production",
        relayState: "bound",
      },
    });
    const again = await prisma.device.findFirstOrThrow({
      where: { token: "again" },
    });
    await prisma.$transaction((tx) =>
      queueRelayUnbindsForAccount(tx, again.userId),
    );
    expect(await prisma.pushRelayUnbind.count()).toBe(1);
    fake.down = false;
    await prisma.pushRelayUnbind.updateMany({
      data: { nextAttemptAt: new Date(0) },
    });
    await prisma.pushRelayRegistration.updateMany({
      data: { circuitOpenedAt: null, circuitFailures: 0, nextProbeAt: null },
    });
    await maintenance();
    expect(fake.bindings.has(token)).toBe(false);
    expect(await prisma.pushRelayUnbind.count()).toBe(0);
  });
});

describe("instance key rotation", () => {
  it("rotates on schedule and on demand, signing with the new key afterwards", async () => {
    const { instanceId, adminSession } = await enableRelay();
    const prisma = getPrismaClient();
    const before = Buffer.from(fake.instances.get(instanceId) as Buffer);
    await prisma.pushRelayRegistration.updateMany({
      data: { instanceKeyCreatedAt: new Date(Date.now() - 31 * 24 * 3600_000) },
    });
    expect((await maintenance()).instance_key_rotated).toBe(true);
    const rotated = fake.instances.get(instanceId) as Buffer;
    expect(rotated.equals(before)).toBe(false);
    const row = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(row.previousInstanceKeyEncrypted).not.toBeNull();
    expect(row.pendingInstanceKeyEncrypted).toBeNull();

    const { POST } =
      await import("@/app/api/admin/push-relay/rotate-key/route");
    const res = await callRoute<{ outcome: string }>(POST, {
      method: "POST",
      route: "/api/admin/push-relay/rotate-key",
      auth: adminSession,
    });
    expect(res.data.outcome).toBe("rotated");
    expect((fake.instances.get(instanceId) as Buffer).equals(rotated)).toBe(
      false,
    );

    const { relayCall } = await import("@/lib/push-relay/registration");
    const status = await relayCall(
      await prisma.pushRelayRegistration.findFirstOrThrow(),
      "GET",
      "/v1/status",
    );
    expect(status.kind === "response" && status.status).toBe(200);
  });

  it("keeps the pending key when the relay's answer is lost", async () => {
    const { instanceId } = await enableRelay();
    const prisma = getPrismaClient();
    fake.dropAfterRotate = true;
    const { rotateInstanceKey } = await import("@/lib/push-relay/instance-key");
    expect(
      await rotateInstanceKey(
        await prisma.pushRelayRegistration.findFirstOrThrow(),
      ),
    ).toBe("unreachable");
    const pending = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(pending.pendingInstanceKeyEncrypted).not.toBeNull();
    // The relay already holds the new key; the old one is refused.
    const { relayCall } = await import("@/lib/push-relay/registration");
    const status = await relayCall(pending, "GET", "/v1/status");
    expect(status.kind === "response" && status.status).toBe(200);
    const after = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(after.pendingInstanceKeyEncrypted).toBeNull();
    const { decrypt } = await import("@/lib/crypto");
    const current = fromBase64Url(
      decrypt(after.instanceKeyEncrypted),
      32,
    ) as Buffer;
    expect(
      ed25519PublicOf(current).equals(fake.instances.get(instanceId) as Buffer),
    ).toBe(true);
  });
});

describe("admin test push", () => {
  it("reaches the admin's own relay device with the relay's signed answer", async () => {
    const { instanceId, adminSession } = await enableRelay();
    const token = "b1".repeat(32);
    const { pushKey } = await bindDevice(instanceId, token, adminSession);
    const { POST } = await import("@/app/api/admin/push-relay/test/route");
    const res = await callRoute<{
      outcome: string;
      results: Array<Record<string, unknown>>;
    }>(POST, {
      method: "POST",
      route: "/api/admin/push-relay/test",
      auth: adminSession,
    });
    expect(res.data.outcome).toBe("accepted");
    expect(res.data.results).toEqual([
      expect.objectContaining({
        relayStatus: 200,
        relayResult: "accepted",
        delivery: "accepted",
      }),
    ]);
    const { GET } = await import("@/app/api/auth/me/route");
    const me = await callRoute<{
      push: { relay: { senderKeys: Array<{ publicKey: string }> } };
    }>(GET, {
      method: "GET",
      route: "/api/auth/me",
      auth: adminSession,
      contract: {
        skip: "the account payload's features block predates this check",
      },
    });
    const opened = openEnvelope({
      recipientKeys: [pushKey.privateKey],
      trustedSenders: [
        fromBase64Url(me.data.push.relay.senderKeys[0].publicKey, 32) as Buffer,
      ],
      apnsToken: Buffer.from(token, "hex"),
      envelope: fromBase64Url(fake.apns[0].payload.e as string) as Buffer,
      expectedClass: "alert",
      now: Math.floor(Date.now() / 1000),
    });
    expect(opened.t).toBe("RELAY_TEST");
  });

  it("reports an unsigned answer as no answer", async () => {
    const { instanceId, adminSession } = await enableRelay();
    await bindDevice(instanceId, "b2".repeat(32), adminSession);
    fake.forge = true;
    const { POST } = await import("@/app/api/admin/push-relay/test/route");
    const res = await callRoute<{
      outcome: string;
      results: Array<Record<string, unknown>>;
    }>(POST, {
      method: "POST",
      route: "/api/admin/push-relay/test",
      auth: adminSession,
    });
    expect(res.data.outcome).toBe("waiting");
    expect(res.data.results[0]).toMatchObject({
      relayStatus: 0,
      relayResult: "relay_signature_invalid",
      delivery: "pending",
    });
  });
});

describe("a relay without pinned keys", () => {
  it("is unavailable, cannot be turned on, and sends nothing", async () => {
    // An operator's own relay with no PUSH_RELAY_KEYS: the hosted relay
    // ships its keys pinned, so only a self-run relay can lack them.
    vi.stubEnv("PUSH_RELAY_URL", "https://relay.example.org");
    vi.stubEnv("PUSH_RELAY_KEYS", "");
    const prisma = getPrismaClient();
    const { PUT } = await import("@/app/api/admin/push-relay/route");
    const { makeAdmin } = await import("../kit/factories");
    const adminSession = await makeSession(await makeAdmin());
    const res = await callRoute(PUT, {
      method: "PUT",
      route: "/api/admin/push-relay",
      auth: adminSession,
      body: { enabled: true, acceptTerms: true, householdOnly: true },
    });
    expect(res.status).toBe(409);
    expect(res.meta?.errorCode).toBe("admin.pushRelay.unavailable");
    // A registration left from a configuration that had keys sends nothing now.
    const { encrypt } = await import("@/lib/crypto");
    await prisma.pushRelayRegistration.create({
      data: {
        relayHost: "push.healthlog.dev",
        instanceId: "6f1c2a4e-1b9d-4c3e-8a7f-000000000001",
        instanceKeyEncrypted: encrypt(
          Buffer.alloc(32, 1).toString("base64url"),
        ),
        state: "ok",
        termsVersion: "2026-11-21",
        householdConfirmedAt: new Date(),
      },
    });
    const user = await makeUser();
    await prisma.device.create({
      data: {
        userId: user.id,
        platform: "ios",
        token: "unpinned",
        bundleId: "dev.healthlog.app",
        apnsToken: "c1".repeat(32),
        apnsEnvironment: "production",
        pushKeyPublic: Buffer.alloc(32, 9).toString("base64url"),
        relayState: "bound",
        relayConsentAt: new Date(),
      },
    });
    const { dispatchNotification } =
      await import("@/lib/notifications/dispatcher");
    await dispatchNotification({
      userId: user.id,
      eventType: "MEDICATION_LOW_STOCK",
      title: "t",
      message: "m",
    });
    await maintenance();
    expect(fake.calls).toEqual([]);
    const { GET } = await import("@/app/api/auth/me/route");
    const me = await callRoute<{
      push: { relay: { available: boolean; offered: boolean } };
    }>(GET, {
      method: "GET",
      route: "/api/auth/me",
      auth: await makeSession(user),
      contract: {
        skip: "the account payload's features block predates this check",
      },
    });
    expect(me.data.push.relay).toMatchObject({
      available: false,
      offered: false,
    });
  });
});

describe("a newer relay terms text", () => {
  it("asks the admin to confirm it once and keeps the relay running", async () => {
    const { instanceId, adminSession } = await enableRelay();
    const token = "b7".repeat(32);
    await bindDevice(instanceId, token, adminSession);
    const prisma = getPrismaClient();
    // An acceptance of the text before the current one.
    await prisma.pushRelayRegistration.updateMany({
      data: { termsVersion: "2026-11-21" },
    });
    const route = await import("@/app/api/admin/push-relay/route");
    type Status = {
      offered: boolean;
      state: string;
      instanceId: string | null;
      termsConfirmationNeeded: boolean;
      devices: { bound: number };
    };
    const status = () =>
      callRoute<Status>(route.GET, {
        method: "GET",
        route: "/api/admin/push-relay",
        auth: adminSession,
      });
    expect((await status()).data).toMatchObject({
      offered: true,
      state: "ok",
      instanceId,
      termsConfirmationNeeded: true,
      devices: { bound: 1 },
    });

    // Pushes keep going while the confirmation is open.
    const { sendRelayTestPush } = await import("@/lib/push-relay/test-push");
    expect((await sendRelayTestPush(adminSession.userId)).outcome).toBe(
      "accepted",
    );
    await maintenance();
    expect(fake.bindings.has(token)).toBe(true);

    fake.calls.length = 0;
    const confirmed = await callRoute<Status>(route.PUT, {
      method: "PUT",
      route: "/api/admin/push-relay",
      auth: adminSession,
      body: { enabled: true, acceptTerms: true, householdOnly: true },
    });
    expect(confirmed.data).toMatchObject({
      offered: true,
      state: "ok",
      instanceId,
      termsConfirmationNeeded: false,
      devices: { bound: 1 },
    });
    // Confirming changed the record of the acceptance and nothing at the relay.
    expect(fake.calls).toEqual([]);
    expect(fake.bindings.has(token)).toBe(true);
    const { RELAY_TERMS_VERSION } = await import("@/lib/push-relay/config");
    const row = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(row.termsVersion).toBe(RELAY_TERMS_VERSION);
    expect(row.enabledByUserId).toBe(adminSession.userId);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.push_relay.terms_confirmed" },
    });
    expect(JSON.parse(audit.details ?? "{}")).toMatchObject({
      termsVersion: RELAY_TERMS_VERSION,
      previousTermsVersion: "2026-11-21",
    });
  });
});

describe("unbinds while the relay cannot be reached", () => {
  it("keeps them queued under PUSH_RELAY_MODE=off and shows them to the admin", async () => {
    const { instanceId, adminSession } = await enableRelay();
    const token = "b8".repeat(32);
    const { session } = await bindDevice(instanceId, token);
    const prisma = getPrismaClient();
    vi.stubEnv("PUSH_RELAY_MODE", "off");
    await deleteOwn(session.userId);
    expect(await prisma.pushRelayUnbind.count({ where: { token } })).toBe(1);

    const facts = await maintenance();
    expect(facts).toMatchObject({ unbound: 0, unbinds_moot: 0 });
    // Nothing reached the relay, so nothing counts as confirmed.
    expect(fake.bindings.has(token)).toBe(true);
    expect(await prisma.pushRelayUnbind.count({ where: { token } })).toBe(1);

    const { GET } = await import("@/app/api/admin/push-relay/route");
    const status = await callRoute<{
      allowed: boolean;
      unbindsPending: number;
      unreachableRegistrations: string[];
    }>(GET, {
      method: "GET",
      route: "/api/admin/push-relay",
      auth: adminSession,
    });
    expect(status.data).toMatchObject({
      allowed: false,
      unbindsPending: 1,
      unreachableRegistrations: [new URL(RELAY_URL).hostname],
    });

    // With the relay reachable again the queued unbind goes and is confirmed.
    vi.stubEnv("PUSH_RELAY_MODE", "allowed");
    await prisma.pushRelayUnbind.updateMany({
      data: { nextAttemptAt: new Date(0) },
    });
    expect((await maintenance()).unbound).toBe(1);
    expect(fake.bindings.has(token)).toBe(false);
    expect(await prisma.pushRelayUnbind.count()).toBe(0);
  });

  it("drops them as moot, not confirmed, when no relay holds a binding", async () => {
    const prisma = getPrismaClient();
    await prisma.pushRelayUnbind.create({ data: { token: "b9".repeat(32) } });
    const facts = await maintenance();
    expect(facts).toMatchObject({ unbound: 0, unbinds_moot: 1 });
    expect(await prisma.pushRelayUnbind.count()).toBe(0);
  });
});
