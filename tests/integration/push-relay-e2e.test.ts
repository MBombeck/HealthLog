/**
 * The push relay end to end: this server, a fake relay built from the relay
 * specification (`push-relay-fake.ts`) standing in for the network, a fake
 * APNs that records what the relay would send, and a fake device that opens
 * the envelopes with its own keys.
 *
 * 1. The operator turns the relay on with both confirmations; the instance
 *    registers with a proof of possession.
 * 2. The account payload offers the relay with the instance id and the
 *    sender keys to pin.
 * 3. The device registers its push key, consent and signed binding; the
 *    binding reaches the relay and the device is `bound`.
 * 4. A dose recorded elsewhere reaches the device as a sealed alert the
 *    device opens, with the contract's flat fields and no medication name.
 * 5. The silent sync goes sealed; a Live Activity ends over the relay only
 *    with the device's signed statement.
 * 6. The device's envelope receipt confirms the delivery.
 * 7. Turning the relay off deletes the instance at the relay and returns
 *    every device to `none`.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import {
  FakeRelay,
  RELAY_HOST,
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
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";
import { makeAdmin, makeSession, makeUser } from "../kit/factories";
import { generateX25519 } from "@/lib/push-relay/hpke";
import { fromBase64Url, tokenTagHex } from "@/lib/push-relay/encoding";
import {
  activityText,
  bindText,
  generateEd25519,
  signText,
} from "@/lib/push-relay/statements";
import { openEnvelope } from "@/lib/push-relay/__tests__/envelope-open";

/** Wire JSON as the relay protocol carries it; read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON
type Wire = Record<string, any>;

const TOKEN = "0f".repeat(32);
const LA_TOKEN = "2e".repeat(32);

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

afterEach(() => {
  vi.restoreAllMocks();
});

async function routes() {
  return {
    admin: await import("@/app/api/admin/push-relay/route"),
    devices: await import("@/app/api/devices/route"),
    me: await import("@/app/api/auth/me/route"),
    syncState: await import("@/app/api/sync/state/route"),
  };
}

function deviceKeys() {
  const pushKey = generateX25519();
  const binding = generateEd25519();
  return { pushKey, binding };
}

function bindingFor(
  instanceId: string,
  binding: { seed: Buffer; publicKey: Buffer },
  seq = 1,
) {
  const statement = {
    instanceId,
    tokenTag: tokenTagHex(TOKEN) as string,
    kind: "device" as const,
    seq,
    iat: Math.floor(Date.now() / 1000),
  };
  return {
    bindingKey: binding.publicKey.toString("base64url"),
    statement,
    signature: signText(
      binding.seed,
      bindText({ host: RELAY_HOST, ...statement }),
    ).toString("base64url"),
  };
}

async function setUp() {
  const r = await routes();
  const admin = await makeAdmin();
  const adminSession = await makeSession(admin);
  const refused = await callRoute(r.admin.PUT, {
    method: "PUT",
    route: "/api/admin/push-relay",
    auth: adminSession,
    body: { enabled: true, acceptTerms: true },
  });
  expect(refused.status).toBe(422);
  const on = await callRoute<{ offered: boolean; instanceId: string }>(
    r.admin.PUT,
    {
      method: "PUT",
      route: "/api/admin/push-relay",
      auth: adminSession,
      body: { enabled: true, acceptTerms: true, householdOnly: true },
    },
  );
  expect(on.status).toBe(200);
  expect(on.data.offered).toBe(true);
  expect(fake.instances.size).toBe(1);

  const user = await makeUser();
  const session = await makeSession(user);
  const me = await callRoute<{ push: { relay: Wire } }>(r.me.GET, {
    method: "GET",
    route: "/api/auth/me",
    auth: session,
    contract: {
      skip: "the account payload's features block predates this check",
    },
  });
  const relayCap = me.data.push.relay;
  expect(relayCap.offered).toBe(true);
  expect(relayCap.host).toBe(RELAY_HOST);
  expect(relayCap.instanceId).toBe(on.data.instanceId);
  expect(relayCap.envelopeVersions).toEqual([1]);
  expect(relayCap.senderKeys[0].status).toBe("current");

  const keys = deviceKeys();
  const registered = await callRoute<{ id: string; push: Wire }>(
    r.devices.POST,
    {
      method: "POST",
      route: "/api/devices",
      auth: session,
      body: {
        token: "device-relay-1",
        bundleId: "dev.healthlog.app",
        apnsToken: TOKEN,
        apnsEnvironment: "production",
        medicationDelivery: "client",
        pushKey: {
          v: 1,
          suites: [1],
          publicKey: keys.pushKey.publicKey.toString("base64url"),
        },
        relayConsent: {
          granted: true,
          textVersion: relayCap.consentTextVersion,
        },
        relayBinding: bindingFor(relayCap.instanceId, keys.binding),
      },
    },
  );
  expect(registered.status).toBe(201);
  expect(registered.data.push).toMatchObject({
    transport: "relay",
    envelope: 1,
    consent: true,
    relayState: "bound",
    intakeSync: "ok",
  });
  expect(fake.bindings.get(TOKEN)?.instanceId).toBe(relayCap.instanceId);
  const senderKey = fromBase64Url(
    relayCap.senderKeys[0].publicKey,
    32,
  ) as Buffer;
  return {
    r,
    user,
    session,
    adminSession,
    keys,
    relayCap,
    senderKey,
    deviceId: registered.data.id,
  };
}

function open(
  delivery: { payload: Record<string, unknown> },
  keys: { pushKey: { privateKey: Buffer } },
  senderKey: Buffer,
  cls: "alert" | "silent",
) {
  return openEnvelope({
    recipientKeys: [keys.pushKey.privateKey],
    trustedSenders: [senderKey],
    apnsToken: Buffer.from(TOKEN, "hex"),
    envelope: fromBase64Url(delivery.payload.e as string) as Buffer,
    expectedClass: cls,
    now: Math.floor(Date.now() / 1000),
  });
}

describe("push relay end to end", () => {
  it("delivers a recorded dose sealed, confirms it by receipt, and turns off cleanly", async () => {
    const { r, user, session, adminSession, keys, senderKey, deviceId } =
      await setUp();
    const prisma = getPrismaClient();
    const medication = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5 mg" },
    });
    const { queueIntakeRecorded } =
      await import("@/lib/notifications/medication-intake-recorded");
    const slot = new Date(Date.now() - 10 * 60_000);
    queueIntakeRecorded({
      userId: user.id,
      event: {
        medicationId: medication.id,
        intakeId: "intake-1",
        slotInstant: slot,
        outcome: "taken",
        takenAt: new Date(),
        takenVia: "INTEGRATION",
      },
      originDeviceToken: null,
    });
    await eventually(() => fake.apns.some((a) => a.pushClass === "alert"));
    const alert = fake.apns.find((a) => a.pushClass === "alert")!;
    expect(Object.keys(alert.payload).sort()).toEqual(["aps", "e"]);
    const plaintext = open(alert, keys, senderKey, "alert");
    expect(plaintext.t).toBe("MEDICATION_INTAKE_RECORDED");
    expect(plaintext.d).toEqual({
      medicationId: medication.id,
      intakeId: "intake-1",
      slotInstant: slot.toISOString(),
      outcome: "taken",
      takenAt: expect.any(String),
      takenVia: "INTEGRATION",
      asOf: expect.any(String),
    });
    expect(JSON.stringify(plaintext)).not.toContain("Ramipril");
    // Over the relay the confirmation lives as long as every other alert.
    expect((plaintext.exp as number) - (plaintext.iat as number)).toBe(15 * 60);

    // The confirmation's delivery; the silent sync beside it has its own. The
    // fake has the push as soon as the relay call arrives, but the server
    // records the relay's answer after that call returns, in a send nothing
    // awaits; read the row once it has been written, not as the request lands.
    await eventually(
      async () =>
        (await prisma.pushRelayDelivery.count({
          where: { deviceId, pushClass: "alert", status: { not: "pending" } },
        })) > 0,
    );
    const delivery = await prisma.pushRelayDelivery.findFirstOrThrow({
      where: { deviceId, pushClass: "alert" },
    });
    expect(delivery).toMatchObject({
      status: "accepted",
      ref: plaintext.id,
      confirmedAt: null,
    });

    const state = await callRoute<{ push: { receiptsRecorded: boolean } }>(
      r.syncState.GET,
      {
        method: "GET",
        route: "/api/sync/state",
        auth: session,
        query: { openedAlert: plaintext.id as string },
        headers: { "x-device-id": "device-relay-1" },
      },
    );
    expect(state.data.push.receiptsRecorded).toBe(true);
    // The receipt write runs after the answer, detached.
    await settleBackgroundTasks();
    const confirmed = await prisma.pushRelayDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(confirmed.confirmedAt).not.toBeNull();

    const off = await callRoute<{ offered: boolean }>(r.admin.PUT, {
      method: "PUT",
      route: "/api/admin/push-relay",
      auth: adminSession,
      body: { enabled: false },
    });
    expect(off.data.offered).toBe(false);
    expect(fake.instances.size).toBe(0);
    expect(fake.bindings.size).toBe(0);
    const device = await prisma.device.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.relayState).toBe("none");
  });

  it("sends the silent sync sealed and ends a Live Activity only with its statement", async () => {
    const { user, keys, relayCap, senderKey, deviceId } = await setUp();
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
    const statement = {
      instanceId: relayCap.instanceId,
      tokenTag: tokenTagHex(TOKEN) as string,
      laTokenTag: tokenTagHex(LA_TOKEN) as string,
      iat: Math.floor(Date.now() / 1000) - 60,
    };
    await prisma.liveActivityToken.createMany({
      data: [
        {
          deviceId,
          pushToken: LA_TOKEN,
          medicationId: medication.id,
          slotInstant: slot,
          activityStatement: statement,
          activitySignature: signText(
            keys.binding.seed,
            activityText({ host: RELAY_HOST, ...statement }),
          ).toString("base64url"),
        },
        // An Activity an older app build registered: no statement, no relay end.
        {
          deviceId,
          pushToken: "3e".repeat(32),
          medicationId: medication.id,
          slotInstant: slot,
        },
      ],
    });
    const { queueMedicationIntakeSync } =
      await import("@/lib/notifications/medication-intake-sync");
    queueMedicationIntakeSync({ userId: user.id, originDeviceToken: null });
    await eventually(
      () =>
        fake.apns.some((a) => a.pushClass === "silent") &&
        fake.apns.some((a) => a.pushClass === "liveactivity"),
    );
    const silent = fake.apns.find((a) => a.pushClass === "silent")!;
    expect(open(silent, keys, senderKey, "silent").t).toBe(
      "MEDICATION_INTAKE_SYNC",
    );
    const ends = fake.apns.filter((a) => a.pushClass === "liveactivity");
    expect(ends.map((e) => e.token)).toEqual([LA_TOKEN]);
    await eventually(
      async () =>
        (await prisma.liveActivityToken.count({
          where: { pushToken: LA_TOKEN },
        })) === 0,
    );
    expect(await prisma.liveActivityToken.count({ where: { deviceId } })).toBe(
      1,
    );
  });
});
