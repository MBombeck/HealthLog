/**
 * A server with its own APNs key and a relay registration starts its Live
 * Activities over the relay.
 *
 * Such a server sends a bound device's alerts and syncs over its own key
 * (`routeFor` reads `direct`), and the Live Activity pass used to ask for the
 * `relay` route, so no Activity ever started there. The pass reads the
 * relay's own reach now: exactly one start over the relay, with or without
 * the key, none while the operator's switch is off, and none over the key.
 */
import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

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
    public payload: unknown;
  }
  return { default: { Provider, Notification }, Provider, Notification };
});

import { getPrismaClient, truncateAllTables } from "./setup";
import { makeMedication } from "../kit/factories";
import { bindDevice, enableRelay, registerDevice } from "./push-relay-kit";
import { tokenTagHex } from "@/lib/push-relay/encoding";
import {
  laConsentText,
  laStartText,
  signText,
} from "@/lib/push-relay/statements";
import { runLiveActivityRelayPass } from "@/lib/push-relay/live-activity";

const TOKEN = "a1".repeat(32);
const START_TOKEN = "5a".repeat(32);
const APNS_ENV_KEYS = [
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_BUNDLE_ID",
  "APNS_KEY",
  "APNS_KEY_FILE",
  "APNS_PRODUCTION",
] as const;
const now = () => Math.floor(Date.now() / 1000);

let fake: FakeRelay;

async function resetApns(): Promise<void> {
  const apns = await import("@/lib/notifications/senders/apns");
  apns.resetApnsForTesting();
}

async function withoutOwnApnsKey(): Promise<void> {
  for (const k of APNS_ENV_KEYS) vi.stubEnv(k, "");
  await resetApns();
}

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
  vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "on");
  await withoutOwnApnsKey();
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
  apnsSendMock.mockImplementation(async (_note: unknown, token: string) => ({
    sent: [{ device: token }],
    failed: [],
  }));
});

/** A time zone in which the real clock reads about noon. */
function noonZone(): string {
  const offset = 12 - new Date().getUTCHours();
  if (offset === 0) return "UTC";
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

function hhmm(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/**
 * A relay-bound device with its Live Activity consent and push-to-start
 * token, and a daily dose of an opted-in medication half an hour ahead.
 */
async function boundDeviceWithDueDose() {
  const { instanceId } = await enableRelay();
  const bound = await bindDevice(instanceId, TOKEN);
  const seed = bound.binding.seed;
  const base = {
    host: RELAY_HOST,
    instanceId,
    tokenTag: tokenTagHex(TOKEN) as string,
  };
  const iat = now();
  const startStatement = {
    instanceId,
    tokenTag: base.tokenTag,
    laTokenTag: tokenTagHex(START_TOKEN) as string,
    iat,
  };
  const registered = await registerDevice(bound.session, {
    token: `device-${TOKEN.slice(0, 6)}`,
    bundleId: "dev.healthlog.app",
    apnsToken: TOKEN,
    apnsEnvironment: "production",
    liveActivityConsent: {
      textVersion: "2026-11-21",
      iat,
      signature: signText(
        seed,
        laConsentText({ ...base, textVersion: "2026-11-21", iat }),
      ).toString("base64url"),
    },
    liveActivityStart: {
      token: START_TOKEN,
      statement: startStatement,
      signature: signText(
        seed,
        laStartText({ ...base, startTokenTag: startStatement.laTokenTag, iat }),
      ).toString("base64url"),
    },
  });
  expect(registered.status).toBe(201);
  expect(registered.data.push.liveActivityConsent).toBe(true);

  const userId = bound.session.userId;
  const tz = noonZone();
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { timezone: tz },
  });
  const slot = new Date(Date.now() + 30 * 60_000);
  slot.setUTCSeconds(0, 0);
  const time = hhmm(slot, tz);
  const medication = await makeMedication(
    { id: userId },
    {
      createdAt: new Date(slot.getTime() - 2 * 24 * 3600_000),
      liveActivityEnabled: true,
    },
    [{ windowStart: time, windowEnd: time, timesOfDay: [time] }],
  );
  await getPrismaClient().medicationIntakeEvent.create({
    data: { userId, medicationId: medication.id, scheduledFor: slot },
  });
  fake.apns.length = 0;
  apnsSendMock.mockClear();
}

const relayStarts = () =>
  fake.apns.filter(
    (a) =>
      a.pushClass === "liveactivity" &&
      (a.payload.aps as Record<string, unknown>).event === "start",
  );

/** Live Activity pushes sent with this server's own key. */
const ownKeyActivityPushes = () =>
  apnsSendMock.mock.calls.filter(([note]) =>
    String((note as { topic?: string }).topic ?? "").endsWith(
      ".push-type.liveactivity",
    ),
  );

describe("a Live Activity start", () => {
  it("goes over the relay once on a server with its own APNs key", async () => {
    await withOwnApnsKey();
    await boundDeviceWithDueDose();
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(relayStarts()).toHaveLength(1);
    expect(relayStarts()[0]!.token).toBe(START_TOKEN);
    expect(ownKeyActivityPushes()).toHaveLength(0);
  });

  it("goes over the relay once on a server without one", async () => {
    await boundDeviceWithDueDose();
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(relayStarts()).toHaveLength(1);
    expect(ownKeyActivityPushes()).toHaveLength(0);
  });

  it("goes nowhere while the operator's switch is off", async () => {
    await withOwnApnsKey();
    await boundDeviceWithDueDose();
    vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "");
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(relayStarts()).toHaveLength(0);
    expect(ownKeyActivityPushes()).toHaveLength(0);
  });
});
