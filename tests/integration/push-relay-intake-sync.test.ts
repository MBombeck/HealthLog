/**
 * A dose recorded on another surface reaches a relay-bound device as a
 * silent sync, whether or not the recorded-dose confirmation is on.
 *
 * The relay leg used to skip the silent sync whenever the flush carried a
 * recorded dose, on the assumption that the confirmation alert would trigger
 * the sync in the extension. The confirmation is opt-in and off by default
 * (on only for an account whose phone keeps its own reminders), so a pill
 * box take on a server without its own APNs key reached a server-reminded
 * device as neither: the widget and the app kept showing the dose as due.
 *
 * And a Live Activity end over the relay that failed once (a relay outage
 * past the end's deadline) is sent again by the next flush. Its ref is fixed
 * per Activity, so the outbox used to skip the new end as a duplicate of the
 * failed one, and the Activity never ended.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-relay-intake-sync-ingest-32-bytes-min-123456";

import {
  FakeRelay,
  RELAY_PUBLIC_KEY,
  RELAY_URL,
  eventually,
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
import { makeSession, makeToken, makeUser } from "../kit/factories";
import { deviceBody, enableRelay, registerDevice } from "./push-relay-kit";
import { fromBase64Url, tokenTagHex } from "@/lib/push-relay/encoding";
import { openEnvelope } from "@/lib/push-relay/__tests__/envelope-open";
import { activityText, signText } from "@/lib/push-relay/statements";
import { RELAY_HOST } from "./push-relay-fake";

const TOKEN = "4a".repeat(32);

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

describe("a dose recorded elsewhere wakes a relay device", () => {
  it("sends the silent sync to a server-reminded device when the confirmation is off", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const { body } = deviceBody(instanceId, TOKEN, {
      medicationDelivery: "server",
    });
    const registered = await registerDevice(session, body);
    expect(registered.data.push.relayState).toBe("bound");

    const prisma = getPrismaClient();
    const medication = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5 mg" },
    });
    const pillBox = await makeToken(user, {
      permissions: ["medication:ingest", `medication:${medication.id}:ingest`],
    });
    const { POST } = await import("@/app/api/ingest/medication/route");
    const res = await callRoute(POST, {
      method: "POST",
      route: "/api/ingest/medication",
      auth: pillBox,
      body: { medicationName: "Ramipril", idempotencyKey: "box-1" },
    });
    expect(res.status).toBe(201);

    await eventually(() => fake.apns.some((a) => a.pushClass === "silent"));
    // The confirmation is off for this account, so no alert stands in for
    // the sync.
    expect(fake.apns.some((a) => a.pushClass === "alert")).toBe(false);
  });

  it("sends a Live Activity end again after the first one failed", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const { body, binding } = deviceBody(instanceId, TOKEN);
    const registered = await registerDevice(session, body);
    const deviceId = registered.data.id;
    const prisma = getPrismaClient();
    const medication = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5 mg" },
    });
    const slot = new Date(Date.now() - 5 * 60_000);
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: medication.id,
        scheduledFor: slot,
        takenAt: new Date(),
      },
    });
    const laToken = "7c".repeat(32);
    const statement = {
      instanceId,
      tokenTag: tokenTagHex(TOKEN) as string,
      laTokenTag: tokenTagHex(laToken) as string,
      iat: Math.floor(Date.now() / 1000) - 60,
    };
    const activity = await prisma.liveActivityToken.create({
      data: {
        deviceId,
        pushToken: laToken,
        medicationId: medication.id,
        slotInstant: slot,
        activityStatement: statement,
        activitySignature: signText(
          binding.seed,
          activityText({ host: RELAY_HOST, ...statement }),
        ).toString("base64url"),
      },
    });
    // The first end, dropped past its deadline during a relay outage.
    await prisma.pushRelayDelivery.create({
      data: {
        deviceId,
        ref: `end-${activity.id}`,
        pushClass: "liveactivity",
        eventType: "LIVE_ACTIVITY_END",
        expiresAt: new Date(Date.now() - 60_000),
        status: "dropped",
        reason: "expired",
      },
    });
    const { queueMedicationIntakeSync } =
      await import("@/lib/notifications/medication-intake-sync");
    queueMedicationIntakeSync({ userId: user.id, originDeviceToken: null });
    await eventually(() =>
      fake.apns.some(
        (a) => a.pushClass === "liveactivity" && a.token === laToken,
      ),
    );
    await eventually(
      async () =>
        (await prisma.liveActivityToken.count({
          where: { id: activity.id },
        })) === 0,
    );
  });
});

/** The sender key `/api/auth/me` publishes for `session`. */
async function senderKey(session: Awaited<ReturnType<typeof makeSession>>) {
  const { GET } = await import("@/app/api/auth/me/route");
  const me = await callRoute<{
    push: { relay: { senderKeys: Array<{ publicKey: string }> } };
  }>(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth: session,
    contract: { skip: "only the sender key is read here" },
  });
  return me.data.push.relay.senderKeys[0]!.publicKey;
}

/** The silent pushes `token` got, opened. */
function silentTypes(
  token: string,
  pushKey: { privateKey: Buffer },
  sender: string,
) {
  return fake.apns
    .filter((a) => a.token === token && a.pushClass === "silent")
    .map((a) =>
      openEnvelope({
        recipientKeys: [pushKey.privateKey],
        trustedSenders: [fromBase64Url(sender, 32) as Buffer],
        apnsToken: Buffer.from(token, "hex"),
        envelope: fromBase64Url(a.payload.e as string) as Buffer,
        expectedClass: "silent",
        now: Math.floor(Date.now() / 1000),
      }),
    );
}

const settle = () => new Promise((r) => setTimeout(r, 400));

describe("the intake sync's budget, audience and triggers", () => {
  it("lets the confirmation stand in for the silent sync when it is on", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const { body } = deviceBody(instanceId, TOKEN);
    await registerDevice(session, body);
    const prisma = getPrismaClient();
    const channel = await prisma.notificationChannel.findUniqueOrThrow({
      where: { userId_type: { userId: user.id, type: "APNS" } },
    });
    await prisma.notificationPreference.create({
      data: {
        channelId: channel.id,
        eventType: "MEDICATION_INTAKE_RECORDED",
        enabled: true,
      },
    });
    const medication = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5 mg" },
    });
    const pillBox = await makeToken(user, {
      permissions: ["medication:ingest", `medication:${medication.id}:ingest`],
    });
    const { POST } = await import("@/app/api/ingest/medication/route");
    const res = await callRoute(POST, {
      method: "POST",
      route: "/api/ingest/medication",
      auth: pillBox,
      body: { medicationName: "Ramipril", idempotencyKey: "box-2" },
    });
    expect(res.status).toBe(201);
    await eventually(() => fake.apns.some((a) => a.pushClass === "alert"));
    // The alert triggers the sync in the extension; a silent push beside it
    // would spend the relay's budget twice for one dose.
    await settle();
    expect(fake.apns.filter((a) => a.pushClass === "silent")).toHaveLength(0);
    expect(
      await prisma.pushWake.count({
        where: { kind: "MEDICATION_INTAKE_SYNC" },
      }),
    ).toBe(0);
  });

  it("owes the sync past the silent budget and sends it once the hour frees up", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const { body } = deviceBody(instanceId, TOKEN);
    const registered = await registerDevice(session, body);
    const deviceId = registered.data.id;
    const prisma = getPrismaClient();
    const now = new Date();
    await prisma.pushWake.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        deviceId,
        kind: i < 2 ? "DATA_CHANGED" : "MEDICATION_INTAKE_SYNC",
        createdAt: new Date(now.getTime() - 30 * 60_000),
      })),
    });
    const { queueMedicationIntakeSync } =
      await import("@/lib/notifications/medication-intake-sync");
    queueMedicationIntakeSync({ userId: user.id, originDeviceToken: null });
    await eventually(
      async () =>
        (await prisma.pushDataChange.findUnique({ where: { deviceId } }))
          ?.intakeSyncOwedAt != null,
    );
    expect(fake.apns.filter((a) => a.pushClass === "silent")).toHaveLength(0);
    await eventually(
      async () =>
        (await prisma.pushAttempt.count({
          where: {
            userId: user.id,
            eventType: "MEDICATION_INTAKE_SYNC",
            reason: "intake_sync_deferred_budget",
          },
        })) === 1,
    );

    // Still inside the hour: the minute pass keeps it owed.
    const { flushDueDataChanges } =
      await import("@/lib/push-relay/data-changed");
    expect(
      (await flushDueDataChanges(new Date(now.getTime() + 60_000))).owedSynced,
    ).toBe(0);
    // Once the budget frees up it goes, once, and is settled.
    const later = new Date(now.getTime() + 31 * 60_000);
    expect((await flushDueDataChanges(later)).owedSynced).toBe(1);
    await eventually(() =>
      fake.apns.some((a) => a.pushClass === "silent" && a.token === TOKEN),
    );
    expect(
      (await prisma.pushDataChange.findUniqueOrThrow({ where: { deviceId } }))
        .intakeSyncOwedAt,
    ).toBeNull();
    expect((await flushDueDataChanges(later)).owedSynced).toBe(0);
  });

  it("wakes a Guardian's device for a change to the managed profile", async () => {
    const { instanceId } = await enableRelay();
    const guardian = await makeUser();
    const guardianSession = await makeSession(guardian);
    const { body } = deviceBody(instanceId, TOKEN);
    await registerDevice(guardianSession, body);
    const prisma = getPrismaClient();
    const profile = await makeUser();
    await prisma.user.update({
      where: { id: profile.id },
      data: { managedProfileAt: new Date() },
    });
    await prisma.accountGrant.create({
      data: {
        grantorId: profile.id,
        granteeId: guardian.id,
        access: "MANAGE",
        acceptedAt: new Date(),
      },
    });
    const { queueMedicationIntakeSync } =
      await import("@/lib/notifications/medication-intake-sync");
    queueMedicationIntakeSync({ userId: profile.id, originDeviceToken: null });
    await eventually(() =>
      fake.apns.some((a) => a.pushClass === "silent" && a.token === TOKEN),
    );

    // A revoked grant: nothing reaches the former Guardian.
    fake.apns.length = 0;
    await prisma.accountGrant.updateMany({
      where: { grantorId: profile.id },
      data: { revokedAt: new Date() },
    });
    await new Promise((r) => setTimeout(r, 2200));
    queueMedicationIntakeSync({ userId: profile.id, originDeviceToken: null });
    await settle();
    expect(fake.apns.filter((a) => a.pushClass === "silent")).toHaveLength(0);
  });

  it("wakes the devices on a medication change, with the dose domains on DATA_CHANGED", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const { body, pushKey } = deviceBody(instanceId, TOKEN);
    await registerDevice(session, body);
    const prisma = getPrismaClient();
    const medication = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5 mg" },
    });
    const { DELETE } = await import("@/app/api/medications/[id]/route");
    const res = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/medications/[id]",
      params: { id: medication.id },
      auth: session,
    });
    expect(res.status).toBe(200);
    const sender = await senderKey(session);
    await eventually(() => {
      const types = silentTypes(TOKEN, pushKey, sender).map((p) => p.t);
      return (
        types.includes("MEDICATION_INTAKE_SYNC") &&
        types.includes("DATA_CHANGED")
      );
    });
    const dataChanged = silentTypes(TOKEN, pushKey, sender).find(
      (p) => p.t === "DATA_CHANGED",
    );
    expect(dataChanged?.d).toMatchObject({
      domains: ["intakes", "medications"],
    });
  });
});
