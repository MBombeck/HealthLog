/**
 * A dose recorded on another surface reaches a relay-bound device as a
 * silent sync, whether or not the recorded-dose confirmation is on, and
 * whether or not that confirmation goes to the same device.
 *
 * The relay leg used to skip the silent sync whenever the flush carried a
 * recorded dose, on the assumption that the confirmation alert would trigger
 * the sync in the extension. First for every account, so a pill box take on
 * a server without its own APNs key reached a server-reminded device as
 * neither; then only while the confirmation was on, which still left the
 * device without its sync whenever the alert did not arrive. No push stands
 * in for another now.
 *
 * The same file holds the other ways a dose that is answered could stay
 * shown as due: a sync the relay drops, an end the relay did not take, and a
 * slot the app names a few seconds off the stored one.
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
  it("sends the silent sync beside the confirmation when it is on", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const registeredKeys = deviceBody(instanceId, TOKEN);
    const { body } = registeredKeys;
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
    // The alert and the sync are independent: an alert that does not arrive
    // (it lives 15 minutes over the relay, and the person's settings may
    // keep it from the extension) must not leave the device without the
    // sync. This used to send the alert alone.
    await eventually(() => fake.apns.some((a) => a.pushClass === "alert"));
    const sender = await senderKey(session);
    const { pushKey } = registeredKeys;
    await eventually(() =>
      silentTypes(TOKEN, pushKey, sender).some(
        (p) => p.t === "MEDICATION_INTAKE_SYNC",
      ),
    );
    expect(
      await prisma.pushWake.count({
        where: { kind: "MEDICATION_INTAKE_SYNC" },
      }),
    ).toBe(1);
    await eventually(
      async () =>
        (await prisma.pushAttempt.count({
          where: { userId: user.id, eventType: "MEDICATION_INTAKE_SYNC" },
        })) === 1,
    );
    expect(
      await prisma.pushAttempt.findMany({
        where: { userId: user.id, eventType: "MEDICATION_INTAKE_SYNC" },
        select: { result: true, reason: true },
      }),
    ).toEqual([{ result: "ok", reason: null }]);
  });

  it("owes the sync again when the relay drops it at its deadline", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const registered = await registerDevice(
      session,
      deviceBody(instanceId, TOKEN).body,
    );
    const deviceId = registered.data.id;
    const prisma = getPrismaClient();
    // The relay's own count says the device has had its silent pushes for
    // this hour and more (its limit halves after a restart): the hint lies
    // beyond the sync's one-hour lifetime.
    fake.itemAnswer = (item) =>
      item.class === "silent"
        ? {
            status: 429,
            error: "device_quota",
            scope: "device",
            retryAfter: 7200,
          }
        : null;
    const { queueMedicationIntakeSync } =
      await import("@/lib/notifications/medication-intake-sync");
    queueMedicationIntakeSync({ userId: user.id, originDeviceToken: null });
    await eventually(
      async () =>
        (await prisma.pushDataChange.findUnique({ where: { deviceId } }))
          ?.intakeSyncOwedAt != null,
    );
    expect(
      await prisma.pushRelayDelivery.findMany({
        where: { deviceId, eventType: "MEDICATION_INTAKE_SYNC" },
        select: { status: true, reason: true },
      }),
    ).toEqual([{ status: "dropped", reason: "deadline" }]);
    // Dropped is failed with the relay's code, never "waiting" (which the
    // flush reads as sent).
    await eventually(
      async () =>
        (await prisma.pushAttempt.count({
          where: { userId: user.id, eventType: "MEDICATION_INTAKE_SYNC" },
        })) === 1,
    );
    expect(
      await prisma.pushAttempt.findMany({
        where: { userId: user.id, eventType: "MEDICATION_INTAKE_SYNC" },
        select: { result: true, reason: true },
      }),
    ).toEqual([{ result: "error", reason: "relay_item_failed:device_quota" }]);
    expect(fake.apns.filter((a) => a.pushClass === "silent")).toHaveLength(0);

    // While the relay still refuses, the minute pass tries and the sync
    // stays owed: the pass must not settle what the outbox has just dropped.
    const { flushDueDataChanges } =
      await import("@/lib/push-relay/data-changed");
    expect((await flushDueDataChanges(new Date())).owedSynced).toBe(1);
    expect(
      (await prisma.pushDataChange.findUniqueOrThrow({ where: { deviceId } }))
        .intakeSyncOwedAt,
    ).not.toBeNull();
    expect(fake.apns.filter((a) => a.pushClass === "silent")).toHaveLength(0);

    // The relay takes it again: the minute pass sends the owed sync, once.
    fake.itemAnswer = null;
    expect((await flushDueDataChanges(new Date())).owedSynced).toBe(1);
    await eventually(() =>
      fake.apns.some((a) => a.pushClass === "silent" && a.token === TOKEN),
    );
    expect(
      (await prisma.pushDataChange.findUniqueOrThrow({ where: { deviceId } }))
        .intakeSyncOwedAt,
    ).toBeNull();
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

  it("keeps a managed profile's sync off a Guardian's relay device", async () => {
    const { instanceId } = await enableRelay();
    const guardian = await makeUser();
    const guardianSession = await makeSession(guardian);
    await registerDevice(guardianSession, deviceBody(instanceId, TOKEN).body);
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
    // A device of the profile's own, so the flush is seen to have run.
    const PROFILE_TOKEN = "5b".repeat(32);
    await registerDevice(
      await makeSession(profile),
      deviceBody(instanceId, PROFILE_TOKEN).body,
    );
    const { queueMedicationIntakeSync } =
      await import("@/lib/notifications/medication-intake-sync");
    queueMedicationIntakeSync({ userId: profile.id, originDeviceToken: null });
    await eventually(() =>
      fake.apns.some(
        (a) => a.pushClass === "silent" && a.token === PROFILE_TOKEN,
      ),
    );
    await settle();
    // A push about another person's record never goes over the relay: the
    // Guardian's device gets neither the sync nor anything else, and owes
    // nothing for later.
    expect(fake.wire.filter((item) => item.token === TOKEN)).toHaveLength(0);
    const guardianDevice = await prisma.device.findFirstOrThrow({
      where: { userId: guardian.id },
      select: { id: true },
    });
    expect(
      await prisma.pushDataChange.findUnique({
        where: { deviceId: guardianDevice.id },
      }),
    ).toBeNull();
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
      route: "/api/medications/{id}",
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

/** A registered Activity of `deviceId`, with the statement its device signed. */
async function registerActivity(args: {
  deviceId: string;
  instanceId: string;
  binding: { seed: Buffer };
  medicationId: string;
  slotInstant: Date;
  laToken: string;
}) {
  const statement = {
    instanceId: args.instanceId,
    tokenTag: tokenTagHex(TOKEN) as string,
    laTokenTag: tokenTagHex(args.laToken) as string,
    iat: Math.floor(Date.now() / 1000) - 60,
  };
  return getPrismaClient().liveActivityToken.create({
    data: {
      deviceId: args.deviceId,
      pushToken: args.laToken,
      medicationId: args.medicationId,
      slotInstant: args.slotInstant,
      activityStatement: statement,
      activitySignature: signText(
        args.binding.seed,
        activityText({ host: RELAY_HOST, ...statement }),
      ).toString("base64url"),
    },
  });
}

const endsFor = (laToken: string) =>
  fake.apns.filter(
    (a) => a.pushClass === "liveactivity" && a.token === laToken,
  );

describe("an answered dose leaves no Live Activity showing it as due", () => {
  it("leaves the Activity of the device that recorded the dose to the app", async () => {
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
    const laToken = "7d".repeat(32);
    const activity = await registerActivity({
      deviceId,
      instanceId,
      binding,
      medicationId: medication.id,
      slotInstant: slot,
      laToken,
    });
    // The device itself recorded the dose (`X-Device-Id`). The app runs
    // there and ends its own Activity. A push from here would show the relay
    // and Apple the moment of a dose recorded on the phone itself, which the
    // consent text says they do not see.
    const { queueMedicationIntakeSync } =
      await import("@/lib/notifications/medication-intake-sync");
    queueMedicationIntakeSync({
      userId: user.id,
      originDeviceToken: body.token,
    });
    await eventually(
      async () =>
        (await prisma.pushAttempt.count({
          where: { userId: user.id, eventType: "MEDICATION_INTAKE_SYNC" },
        })) === 1,
    );
    expect(
      await prisma.pushAttempt.findMany({
        where: { userId: user.id, eventType: "MEDICATION_INTAKE_SYNC" },
        select: { result: true, reason: true },
      }),
    ).toEqual([{ result: "skipped", reason: "intake_sync_no_other_devices" }]);
    await settle();
    expect(fake.wire).toHaveLength(0);
    // Nor does the five-minute pass end it later: it only sends again what
    // the flush had decided to send.
    const { retryLostActivityEnds } =
      await import("@/lib/notifications/live-activity-answered");
    expect(await retryLostActivityEnds()).toEqual({
      retried: 0,
      ended: 0,
      failed: 0,
    });
    expect(fake.wire).toHaveLength(0);
    expect(
      await prisma.liveActivityToken.count({ where: { id: activity.id } }),
    ).toBe(1);
  });

  it("sends an end the relay did not take again, and no other", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const { body, binding } = deviceBody(instanceId, TOKEN);
    const deviceId = (await registerDevice(session, body)).data.id;
    const prisma = getPrismaClient();
    const medication = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5 mg" },
    });
    const taken = new Date(Date.now() - 50 * 60_000);
    const open = new Date(Date.now() - 10 * 60_000);
    await prisma.medicationIntakeEvent.createMany({
      data: [
        {
          userId: user.id,
          medicationId: medication.id,
          scheduledFor: taken,
          takenAt: new Date(),
        },
        { userId: user.id, medicationId: medication.id, scheduledFor: open },
      ],
    });
    const base = { deviceId, instanceId, binding, medicationId: medication.id };
    const lostRow = (activityId: string, status: string, reason: string) =>
      prisma.pushRelayDelivery.create({
        data: {
          deviceId,
          ref: `end-${activityId}`,
          pushClass: "liveactivity",
          eventType: "LIVE_ACTIVITY_END",
          expiresAt: new Date(Date.now() - 60_000),
          status,
          reason,
        },
      });
    // Dropped past its deadline during a relay outage: its dose is taken.
    const lost = await registerActivity({
      ...base,
      slotInstant: taken,
      laToken: "8a".repeat(32),
    });
    await lostRow(lost.id, "dropped", "deadline");
    // An end was lost for this one too, but its dose is open again (the take
    // was undone): nothing to end.
    const reopened = await registerActivity({
      ...base,
      slotInstant: open,
      laToken: "8b".repeat(32),
    });
    await lostRow(reopened.id, "dropped", "deadline");
    // Refused a minute ago: that one waits half an hour before the next try.
    const refused = await registerActivity({
      ...base,
      slotInstant: new Date(taken.getTime() + 1000),
      laToken: "8c".repeat(32),
    });
    await lostRow(refused.id, "failed", "activity_refused");
    // No end was ever sent for this one: the pass leaves it alone.
    const untouched = await registerActivity({
      ...base,
      slotInstant: new Date(taken.getTime() + 2000),
      laToken: "8d".repeat(32),
    });

    const { retryLostActivityEnds } =
      await import("@/lib/notifications/live-activity-answered");
    expect(await retryLostActivityEnds()).toEqual({
      retried: 1,
      ended: 1,
      failed: 0,
    });
    expect(endsFor("8a".repeat(32))).toHaveLength(1);
    expect(
      fake.apns.filter((a) => a.pushClass === "liveactivity"),
    ).toHaveLength(1);
    const left = await prisma.liveActivityToken.findMany({
      where: { deviceId },
      select: { id: true },
    });
    expect(left.map((r) => r.id).sort()).toEqual(
      [reopened.id, refused.id, untouched.id].sort(),
    );
    // Half an hour on, the refused one is due as well.
    expect(
      await retryLostActivityEnds(new Date(Date.now() + 31 * 60_000)),
    ).toMatchObject({ retried: 1, ended: 1 });
    expect(endsFor("8c".repeat(32))).toHaveLength(1);
    expect(endsFor("8d".repeat(32))).toHaveLength(0);
  });

  it("ends an Activity whose slot the app named a few seconds off", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const { body, binding } = deviceBody(instanceId, TOKEN);
    const deviceId = (await registerDevice(session, body)).data.id;
    const prisma = getPrismaClient();
    const medication = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5 mg" },
    });
    const slot = new Date(Date.now() - 20 * 60_000);
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: medication.id,
        scheduledFor: slot,
        skipped: true,
      },
    });
    const base = { deviceId, instanceId, binding, medicationId: medication.id };
    // Named from the app's own schedule, 30 seconds off: the same dose.
    const near = await registerActivity({
      ...base,
      slotInstant: new Date(slot.getTime() + 30_000),
      laToken: "9a".repeat(32),
    });
    // Two minutes off is another slot, and no dose of it is answered.
    const far = await registerActivity({
      ...base,
      slotInstant: new Date(slot.getTime() + 120_000),
      laToken: "9b".repeat(32),
    });
    const { queueMedicationIntakeSync } =
      await import("@/lib/notifications/medication-intake-sync");
    queueMedicationIntakeSync({ userId: user.id, originDeviceToken: null });
    await eventually(() => endsFor("9a".repeat(32)).length === 1);
    await eventually(
      async () =>
        (await prisma.liveActivityToken.count({ where: { id: near.id } })) ===
        0,
    );
    await settle();
    expect(endsFor("9b".repeat(32))).toHaveLength(0);
    expect(
      await prisma.liveActivityToken.count({ where: { id: far.id } }),
    ).toBe(1);
  });
});
