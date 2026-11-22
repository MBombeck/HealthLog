/**
 * Which devices get the server's medication reminder, over the relay and over
 * this server's own APNs key, through the real dispatcher.
 *
 * The decision is made once per dispatch (`resolveApnsDeliveryTargets`,
 * `deviceDeliversLocally`): the device's override, else the account switch,
 * and a device that delivers locally only while its local plan can run (its
 * reported runway, else 3 days after its last request). Both transports read
 * that one decision. On an instance without its own APNs key the relay is the
 * only path, so a device the relay refuses never gets the reminder.
 *
 * The one deliberate difference: a follow-up for a dose still open reaches
 * every device over the server's own key, but over the relay only the devices
 * that get the server's reminder (#190 section 11; a follow-up over the relay
 * to a device that plans locally leaks the "dose still open" timing).
 */
import { generateKeyPairSync } from "node:crypto";

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

const apnsSendMock = vi.hoisted(() => vi.fn());
vi.mock("@parse/node-apn", () => {
  class Provider {
    constructor(_opts: unknown) {
      void _opts;
    }
    send(...args: unknown[]) {
      return apnsSendMock(...args);
    }
    shutdown() {}
  }
  class Notification {
    public topic = "";
    public alert: unknown;
    public sound: string | undefined;
    public badge: number | undefined;
    public threadId: string | undefined;
    public collapseId: string | undefined;
    public payload: unknown;
  }
  return { default: { Provider, Notification }, Provider, Notification };
});

import type { EventType } from "@/lib/notifications/types";
import { getPrismaClient, truncateAllTables } from "./setup";
import { callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import {
  bindDevice,
  deviceBody,
  enableRelay,
  registerDevice,
} from "./push-relay-kit";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const APNS_ENV_KEYS = [
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_BUNDLE_ID",
  "APNS_KEY",
  "APNS_KEY_FILE",
  "APNS_PRODUCTION",
] as const;

let fake: FakeRelay;

async function resetApns(): Promise<void> {
  const apns = await import("@/lib/notifications/senders/apns");
  apns.resetApnsForTesting();
}

/** This server without an APNs key of its own: the relay is the only path. */
async function withoutOwnApnsKey(): Promise<void> {
  for (const k of APNS_ENV_KEYS) vi.stubEnv(k, "");
  await resetApns();
}

/** This server with its own APNs key (a throwaway P-256 key). */
async function withOwnApnsKey(): Promise<void> {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  vi.stubEnv("APNS_KEY_ID", "ABCDE12345");
  vi.stubEnv("APNS_TEAM_ID", "TEAM123456");
  vi.stubEnv("APNS_BUNDLE_ID", "dev.healthlog.app");
  vi.stubEnv(
    "APNS_KEY",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  await resetApns();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await withoutOwnApnsKey();
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
  apnsSendMock.mockImplementation(async (_note: unknown, token: string) => ({
    sent: [{ device: token }],
    failed: [],
  }));
});

/** A device's medication-delivery state, as the matrix names it. */
interface DeviceState {
  medicationDelivery: "server" | "client" | null;
  lastSeen: Date;
  localRunwayUntil: Date | null;
}

function states(now: number): Record<string, DeviceState> {
  return {
    "inherit-fresh": {
      medicationDelivery: null,
      lastSeen: new Date(now),
      localRunwayUntil: null,
    },
    "inherit-quiet": {
      medicationDelivery: null,
      lastSeen: new Date(now - 4 * DAY),
      localRunwayUntil: null,
    },
    "client-fresh": {
      medicationDelivery: "client",
      lastSeen: new Date(now),
      localRunwayUntil: null,
    },
    "client-quiet": {
      medicationDelivery: "client",
      lastSeen: new Date(now - 4 * DAY),
      localRunwayUntil: null,
    },
    "client-planned": {
      medicationDelivery: "client",
      lastSeen: new Date(now - 5 * DAY),
      localRunwayUntil: new Date(now + 2 * DAY),
    },
    "client-dry": {
      medicationDelivery: "client",
      lastSeen: new Date(now),
      localRunwayUntil: new Date(now - HOUR),
    },
    server: {
      medicationDelivery: "server",
      lastSeen: new Date(now),
      localRunwayUntil: null,
    },
  };
}

async function setAccountDeliversLocally(
  userId: string,
  on: boolean,
): Promise<void> {
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { notificationPrefs: { medication: { clientManaged: on } } },
  });
}

async function remind(userId: string, followUp = false): Promise<void> {
  const { dispatchNotification } =
    await import("@/lib/notifications/dispatcher");
  await dispatchNotification({
    userId,
    eventType: "MEDICATION_REMINDER",
    title: "Time for your medication",
    message: "1 tablet",
    metadata: {
      medicationId: "med-1",
      scheduledAt: "2026-11-22T08:00:00.000Z",
      ...(followUp ? { followUp: true } : {}),
    },
  });
}

/** Hex APNs token for the matrix row `i`; its first 6 characters differ. */
function tokenFor(i: number): string {
  return (0xa0 + i).toString(16).repeat(32);
}

/** A set of accounts whose devices carry the matrix labels. */
interface Accounts {
  userIds: string[];
  /** The matrix labels of the devices a reminder to every account reached. */
  selected(followUp?: boolean): Promise<string[]>;
}

async function remindAll(userIds: string[], followUp: boolean): Promise<void> {
  for (const userId of userIds) await remind(userId, followUp);
}

/**
 * Relay-bound devices in the given states, spread over accounts of at most
 * `RELAY_DEVICES_PER_ACCOUNT` devices each.
 */
async function relayAccounts(
  rows: Record<string, DeviceState>,
): Promise<Accounts> {
  const { RELAY_DEVICES_PER_ACCOUNT } = await import("@/lib/push-relay/config");
  const { instanceId } = await enableRelay();
  const labelOf = new Map<string, string>();
  const userIds: string[] = [];
  let session: Awaited<ReturnType<typeof makeSession>> | null = null;
  for (const [i, label] of Object.keys(rows).entries()) {
    if (i % RELAY_DEVICES_PER_ACCOUNT === 0) {
      session = await makeSession(await makeUser());
      userIds.push(session.userId);
    }
    const token = tokenFor(i);
    const { deviceId } = await bindDevice(instanceId, token, session!);
    await getPrismaClient().device.update({
      where: { id: deviceId },
      data: rows[label],
    });
    labelOf.set(token, label);
  }
  return {
    userIds,
    async selected(followUp = false) {
      fake.apns.length = 0;
      await remindAll(userIds, followUp);
      return fake.apns
        .filter((a) => a.pushClass === "alert")
        .map((a) => labelOf.get(a.token) ?? `unknown:${a.token}`)
        .sort();
    },
  };
}

/** Plaintext devices over this server's own APNs key, on one account. */
async function directAccount(
  rows: Record<string, DeviceState>,
): Promise<Accounts> {
  const user = await makeUser();
  const { encrypt } = await import("@/lib/crypto");
  const prisma = getPrismaClient();
  await prisma.notificationChannel.create({
    data: {
      userId: user.id,
      type: "APNS",
      enabled: true,
      config: encrypt("{}"),
    },
  });
  const labelOf = new Map<string, string>();
  for (const [i, label] of Object.keys(rows).entries()) {
    // Other tokens than the relay devices: a token is unique per instance.
    const token = tokenFor(i + 0x20);
    await prisma.device.create({
      data: {
        userId: user.id,
        platform: "ios",
        token: `direct-${label}`,
        bundleId: "dev.healthlog.app",
        apnsToken: token,
        apnsEnvironment: "production",
        ...rows[label],
      },
    });
    labelOf.set(token, label);
  }
  return {
    userIds: [user.id],
    async selected(followUp = false) {
      apnsSendMock.mockClear();
      await remindAll([user.id], followUp);
      return apnsSendMock.mock.calls
        .map((c) => labelOf.get(c[1] as string) ?? `unknown:${c[1]}`)
        .sort();
    },
  };
}

describe("medication reminders on an instance whose only path is the relay", () => {
  async function oneDevice(
    state: DeviceState,
    accountDeliversLocally: boolean,
  ): Promise<number> {
    const account = await relayAccounts({ device: state });
    await setAccountDeliversLocally(account.userIds[0], accountDeliversLocally);
    return (await account.selected()).length;
  }

  it("reaches a device that inherits an account set to server delivery", async () => {
    const now = Date.now();
    expect(await oneDevice(states(now)["inherit-fresh"], false)).toBe(1);
  });

  it("reaches a client device whose local plan has run out", async () => {
    const now = Date.now();
    expect(await oneDevice(states(now)["client-dry"], false)).toBe(1);
  });

  it("reaches a client device that has been quiet for over 3 days", async () => {
    const now = Date.now();
    expect(await oneDevice(states(now)["client-quiet"], true)).toBe(1);
  });

  it("stays off a client device whose local plan still runs", async () => {
    const now = Date.now();
    expect(await oneDevice(states(now)["client-planned"], false)).toBe(0);
  });

  it("reaches a device set to server delivery", async () => {
    const now = Date.now();
    expect(await oneDevice(states(now).server, true)).toBe(1);
  });
});

describe("the relay and the server's own APNs key select the same devices", () => {
  const ALL = Object.keys(states(0)).sort();
  /** Who gets the server's reminder, by the account switch. */
  const SERVER_DELIVERED: Record<"local" | "server", string[]> = {
    local: ["client-dry", "client-quiet", "inherit-quiet", "server"],
    server: [
      "client-dry",
      "client-quiet",
      "inherit-fresh",
      "inherit-quiet",
      "server",
    ],
  };

  it("for every device state and both account switches", async () => {
    const now = Date.now();
    const relayRows = await relayAccounts(states(now));
    await withOwnApnsKey();
    const directRows = await directAccount(states(now));

    for (const account of ["local", "server"] as const) {
      for (const userId of [...relayRows.userIds, ...directRows.userIds]) {
        await setAccountDeliversLocally(userId, account === "local");
      }

      await withoutOwnApnsKey();
      const relayDose = await relayRows.selected();
      const relayFollowUp = await relayRows.selected(true);
      await withOwnApnsKey();
      const directDose = await directRows.selected();
      const directFollowUp = await directRows.selected(true);

      const why = `account delivers ${account}`;
      expect(directDose, why).toEqual(SERVER_DELIVERED[account]);
      expect(relayDose, why).toEqual(directDose);
      // A follow-up reaches every device over the server's own key, and over
      // the relay exactly the devices that get the server's reminder.
      expect(directFollowUp, why).toEqual(ALL);
      expect(relayFollowUp, why).toEqual(directDose);
    }
  });
});

describe("an event the relay does not carry leaves the channel alone", () => {
  async function dispatch(
    userId: string,
    eventType: EventType,
    metadata: Record<string, unknown> = {},
  ) {
    const { dispatchNotification } =
      await import("@/lib/notifications/dispatcher");
    return dispatchNotification({
      userId,
      eventType,
      title: "HealthLog",
      message: "Something for you",
      metadata,
    });
  }

  async function apnsChannel(userId: string) {
    return getPrismaClient().notificationChannel.findUniqueOrThrow({
      where: { userId_type: { userId, type: "APNS" } },
      select: { nextRetryAt: true, lastFailureReason: true, enabled: true },
    });
  }

  const attempts = (userId: string, eventType: string) =>
    getPrismaClient().pushAttempt.findMany({
      where: { userId, eventType, channel: "APNS" },
      select: { result: true, reason: true },
    });

  /** The ledger row is written without being awaited. */
  async function attemptsOnceWritten(userId: string, eventType: string) {
    for (let i = 0; i < 80; i++) {
      const rows = await attempts(userId, eventType);
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  /** Both events are for the APNs channel, whatever their defaults say. */
  async function enableOnApns(userId: string, eventTypes: string[]) {
    const prisma = getPrismaClient();
    const channel = await prisma.notificationChannel.findUniqueOrThrow({
      where: { userId_type: { userId, type: "APNS" } },
      select: { id: true },
    });
    await prisma.notificationPreference.createMany({
      data: eventTypes.map((eventType) => ({
        channelId: channel.id,
        eventType,
        enabled: true,
      })),
    });
  }

  it("sends the next alert after a reminder the phone plans itself", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const token = tokenFor(3);
    await bindDevice(instanceId, token, session);
    await enableOnApns(user.id, ["MOOD_REMINDER", "SECURITY_ALERT"]);
    fake.apns.length = 0;

    // The app plans its mood reminder itself: the relay carries none. On a
    // server without its own APNs key this used to answer "APNs not
    // configured", which rests the channel for an hour.
    const mood = await dispatch(user.id, "MOOD_REMINDER");
    expect(mood.dispatched).toBe(false);
    expect(fake.apns).toHaveLength(0);
    expect(await attemptsOnceWritten(user.id, "MOOD_REMINDER")).toEqual([
      { result: "skipped", reason: "apns_event_not_carried" },
    ]);
    expect((await apnsChannel(user.id)).nextRetryAt).toBeNull();

    // The same for the follow-up of a dose still open, on a phone that
    // reminds itself: on by default, so this is the one that bit.
    await remind(user.id, true);
    expect(fake.apns).toHaveLength(0);
    expect(await attemptsOnceWritten(user.id, "MEDICATION_REMINDER")).toEqual([
      { result: "skipped", reason: "apns_event_not_carried" },
    ]);
    expect((await apnsChannel(user.id)).nextRetryAt).toBeNull();

    // So the alert that is for the relay goes out right after it.
    const alert = await dispatch(user.id, "SECURITY_ALERT", {
      securityKind: "new_device",
    });
    expect(alert.dispatched).toBe(true);
    expect(
      fake.apns.filter((a) => a.pushClass === "alert" && a.token === token),
    ).toHaveLength(1);
  });

  it("rests only while no device has a route, and goes on when one binds", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const token = tokenFor(4);
    const { body } = deviceBody(instanceId, token);
    const bound = await registerDevice(session, body);
    expect(bound.data.push.relayState).toBe("bound");
    await enableOnApns(user.id, ["SECURITY_ALERT"]);
    fake.apns.length = 0;
    const prisma = getPrismaClient();
    // The relay forgot the binding: the device has to bind again.
    await prisma.device.update({
      where: { id: bound.data.id },
      data: { relayState: "rebind_needed", relayBoundAt: null },
    });

    const lost = await dispatch(user.id, "SECURITY_ALERT", {
      securityKind: "new_device",
    });
    expect(lost.dispatched).toBe(false);
    expect(await attemptsOnceWritten(user.id, "SECURITY_ALERT")).toEqual([
      { result: "skipped", reason: "apns_device_unrouted" },
    ]);
    const resting = await apnsChannel(user.id);
    expect(resting.lastFailureReason).toBe("apns_device_unrouted");
    expect(resting.nextRetryAt).not.toBeNull();
    expect(resting.enabled).toBe(true);

    // The app comes back and binds again, with the key it holds: the rest
    // ends with it, not an hour later.
    const again1 = await registerDevice(session, body);
    expect(again1.data.push.relayState).toBe("bound");
    expect((await apnsChannel(user.id)).nextRetryAt).toBeNull();
    fake.apns.length = 0;
    const again = await dispatch(user.id, "SECURITY_ALERT", {
      securityKind: "passkey_added",
    });
    expect(again.dispatched).toBe(true);
    expect(
      fake.apns.filter((a) => a.pushClass === "alert" && a.token === token),
    ).toHaveLength(1);
  });
});

describe("the APNs test push", () => {
  const TITLE = "HealthLog test notification";

  async function sendTest(session: Awaited<ReturnType<typeof makeSession>>) {
    const { POST } = await import("@/app/api/notifications/apns/test/route");
    return callRoute<{ ok: boolean }>(POST, {
      method: "POST",
      route: "/api/notifications/apns/test",
      auth: session,
    });
  }

  it("reaches a relay-bound device sealed over the relay", async () => {
    const { instanceId } = await enableRelay();
    const session = await makeSession(await makeUser());
    const token = tokenFor(1);
    await bindDevice(instanceId, token, session);
    fake.apns.length = 0;
    const res = await sendTest(session);
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    const alerts = fake.apns.filter(
      (a) => a.pushClass === "alert" && a.token === token,
    );
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0])).not.toContain(TITLE);
    expect(apnsSendMock).not.toHaveBeenCalled();
  });

  it("never carries its text in the clear to a device with a push key", async () => {
    await withOwnApnsKey();
    const { instanceId } = await enableRelay();
    const session = await makeSession(await makeUser());
    const token = tokenFor(2);
    await bindDevice(instanceId, token, session);
    fake.apns.length = 0;
    apnsSendMock.mockClear();
    const res = await sendTest(session);
    expect(res.status).toBe(200);
    // Whichever way the sealed push went, nothing that left this server
    // for the device carries the test text in the clear.
    const sent =
      apnsSendMock.mock.calls.length +
      fake.apns.filter((a) => a.token === token).length;
    expect(sent).toBeGreaterThan(0);
    for (const [note] of apnsSendMock.mock.calls) {
      expect(JSON.stringify(note)).not.toContain(TITLE);
    }
  });
});
