/**
 * The silent wakes and the security alert, end to end through the fake
 * relay of `push-relay-fake.ts` and a fake device that opens the envelopes:
 *
 * - DATA_CHANGED: the first change goes out at once, changes inside five
 *   minutes merge into one trailing wake, at most three an hour per account,
 *   the origin device is left out, a provider sync's shared tail raises it,
 *   and a device's hourly wake budget is honoured.
 * - HEALTHKIT_CATCH_UP: only for an upload six hours behind on a device in
 *   use, at most three a day and four hours apart.
 * - SECURITY_ALERT: sealed, time-sensitive, with the change it reports.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
import { makeSession, makeUser, type SessionFixture } from "../kit/factories";
import { bindDevice, enableRelay } from "./push-relay-kit";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import { openEnvelope } from "@/lib/push-relay/__tests__/envelope-open";
import {
  flushDueDataChanges,
  batchDataChanges,
  noteDataChanged,
  withDataChangeOrigin,
} from "@/lib/push-relay/data-changed";
import { runHealthKitCatchUp } from "@/lib/push-relay/healthkit-catch-up";
import { sendSecurityAlert } from "@/lib/auth/security-alert";
import { afterProviderWrite } from "@/lib/integrations/sync-kit/after-write";

let fake: FakeRelay;
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
});

async function senderKey(session: SessionFixture): Promise<string> {
  const { GET } = await import("@/app/api/auth/me/route");
  const me = await callRoute<{
    push: { relay: { senderKeys: Array<{ publicKey: string }> } };
  }>(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth: session,
    contract: {
      skip: "the account payload's features block predates this check",
    },
  });
  return me.data.push.relay.senderKeys[0]!.publicKey;
}

interface Bound {
  token: string;
  deviceToken: string;
  deviceId: string;
  pushKey: { privateKey: Buffer };
}

async function setUp(tokens: string[]) {
  const { instanceId } = await enableRelay();
  const session = await makeSession(await makeUser());
  const devices: Bound[] = [];
  for (const token of tokens) {
    const bound = await bindDevice(instanceId, token, session);
    devices.push({
      token,
      deviceToken: `device-${token.slice(0, 6)}`,
      deviceId: bound.deviceId,
      pushKey: bound.pushKey,
    });
  }
  return { session, devices, sender: await senderKey(session) };
}

/** Every push the fake APNs got for `device`, opened. */
function opened(
  device: Bound,
  sender: string,
  pushClass: "alert" | "silent" = "silent",
) {
  return fake.apns
    .filter((a) => a.token === device.token && a.pushClass === pushClass)
    .map((a) =>
      openEnvelope({
        recipientKeys: [device.pushKey.privateKey],
        trustedSenders: [fromBase64Url(sender, 32) as Buffer],
        apnsToken: Buffer.from(device.token, "hex"),
        envelope: fromBase64Url(a.payload.e as string) as Buffer,
        expectedClass: pushClass,
        now: Math.floor(Date.now() / 1000),
      }),
    );
}

function wakes(device: Bound, sender: string, type: string) {
  return opened(device, sender).filter((p) => p.t === type);
}

describe("DATA_CHANGED", () => {
  it("sends the first change at once and merges the rest of the window", async () => {
    const { session, devices, sender } = await setUp(["a1".repeat(32)]);
    const [device] = devices;
    const t0 = new Date();
    await noteDataChanged(session.userId, ["sleep"], { now: t0 });
    await noteDataChanged(session.userId, ["workouts"], {
      now: new Date(t0.getTime() + MIN),
    });
    await noteDataChanged(session.userId, ["measurements", "workouts"], {
      now: new Date(t0.getTime() + 2 * MIN),
    });
    let sent = wakes(device!, sender, "DATA_CHANGED");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.d).toMatchObject({ domains: ["sleep"] });

    // Still inside the window: nothing.
    await flushDueDataChanges(new Date(t0.getTime() + 4 * MIN));
    expect(wakes(device!, sender, "DATA_CHANGED")).toHaveLength(1);

    await flushDueDataChanges(new Date(t0.getTime() + 5 * MIN + 1000));
    sent = wakes(device!, sender, "DATA_CHANGED");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.d).toMatchObject({
      domains: ["measurements", "workouts"],
    });
    expect(sent[1]).not.toHaveProperty("n");

    // Nothing pending: the next pass sends nothing.
    await flushDueDataChanges(new Date(t0.getTime() + 20 * MIN));
    expect(wakes(device!, sender, "DATA_CHANGED")).toHaveLength(2);
  });

  it("sends at most three an hour per device and keeps the rest pending", async () => {
    const { session, devices, sender } = await setUp(["a2".repeat(32)]);
    const t0 = new Date();
    for (const offset of [0, 5, 10, 15]) {
      await noteDataChanged(session.userId, ["measurements"], {
        now: new Date(t0.getTime() + offset * MIN + offset * 1000),
      });
    }
    expect(wakes(devices[0]!, sender, "DATA_CHANGED")).toHaveLength(3);
    await flushDueDataChanges(new Date(t0.getTime() + 40 * MIN));
    expect(wakes(devices[0]!, sender, "DATA_CHANGED")).toHaveLength(3);
    const row = await getPrismaClient().pushDataChange.findUniqueOrThrow({
      where: { deviceId: devices[0]!.deviceId },
    });
    expect(row.domains).toEqual(["measurements"]);
    await flushDueDataChanges(new Date(t0.getTime() + HOUR + 1000));
    expect(wakes(devices[0]!, sender, "DATA_CHANGED")).toHaveLength(4);
  });

  it("leaves the origin device out of its own change only", async () => {
    const { session, devices, sender } = await setUp([
      "b1".repeat(32),
      "b2".repeat(32),
    ]);
    const [a, b] = devices as [Bound, Bound];
    const t0 = new Date();
    await withDataChangeOrigin(a.deviceToken, () =>
      noteDataChanged(session.userId, ["measurements"], { now: t0 }),
    );
    expect(wakes(a, sender, "DATA_CHANGED")).toHaveLength(0);
    expect(wakes(b, sender, "DATA_CHANGED")).toHaveLength(1);

    // A's own sleep change, then a scheduled sync's workouts: A hears only
    // the workouts, B both, merged after its window.
    await withDataChangeOrigin(a.deviceToken, () =>
      noteDataChanged(session.userId, ["sleep"], {
        now: new Date(t0.getTime() + MIN),
      }),
    );
    await noteDataChanged(session.userId, ["workouts"], {
      now: new Date(t0.getTime() + 2 * MIN),
    });
    await flushDueDataChanges(new Date(t0.getTime() + 6 * MIN));
    expect(wakes(a, sender, "DATA_CHANGED").map((w) => w.d)).toMatchObject([
      { domains: ["workouts"] },
    ]);
    expect(wakes(b, sender, "DATA_CHANGED").map((w) => w.d)).toMatchObject([
      { domains: ["measurements"] },
      { domains: ["sleep", "workouts"] },
    ]);
  });

  it("sends one wake for a batch of writes, merged, and still leaves the origin out", async () => {
    const { session, devices, sender } = await setUp([
      "b3".repeat(32),
      "b4".repeat(32),
    ]);
    const [a, b] = devices as [Bound, Bound];
    // Unbatched, the first note would go out alone as ["workouts"] and the
    // rest would wait out the five-minute window.
    await withDataChangeOrigin(a.deviceToken, () =>
      batchDataChanges(async () => {
        for (let i = 0; i < 20; i++) {
          void noteDataChanged(session.userId, [
            i % 2 === 0 ? "workouts" : "sleep",
          ]);
        }
      }),
    );
    await eventually(() => wakes(b, sender, "DATA_CHANGED").length === 1);
    expect(wakes(b, sender, "DATA_CHANGED")[0]!.d).toMatchObject({
      domains: ["sleep", "workouts"],
    });
    expect(wakes(a, sender, "DATA_CHANGED")).toHaveLength(0);
  });

  it("is raised by a provider sync's shared tail", async () => {
    const { session, devices, sender } = await setUp(["c1".repeat(32)]);
    await afterProviderWrite({
      userId: session.userId,
      provider: "withings",
      touched: [{ type: "SLEEP_DURATION", measuredAt: new Date() }],
    });
    await eventually(
      () => wakes(devices[0]!, sender, "DATA_CHANGED").length === 1,
    );
    expect(wakes(devices[0]!, sender, "DATA_CHANGED")[0]!.d).toMatchObject({
      domains: ["sleep"],
    });
  });

  it("wakes for a bridge's nutrition totals, not for the phone's own", async () => {
    const { session, devices, sender } = await setUp(["c3".repeat(32)]);
    const { writeNutrientDayTotals } =
      await import("@/lib/nutrients/day-total-write");
    const entry = {
      index: 0,
      day: "2026-11-20",
      nutrient: "thiamin" as const,
      amount: 1.5,
      unit: "mg",
      externalSourceVersion: null,
    };
    await writeNutrientDayTotals(session.userId, "APPLE_HEALTH", [entry]);
    await new Promise((r) => setTimeout(r, 300));
    expect(wakes(devices[0]!, sender, "DATA_CHANGED")).toHaveLength(0);
    await writeNutrientDayTotals(session.userId, "EXTERNAL", [entry]);
    await eventually(
      () => wakes(devices[0]!, sender, "DATA_CHANGED").length === 1,
    );
    expect(wakes(devices[0]!, sender, "DATA_CHANGED")[0]!.d).toMatchObject({
      domains: ["nutrition"],
    });
  });

  it("writes nothing for an account without a sealed device", async () => {
    const user = await makeUser();
    await noteDataChanged(user.id, ["measurements"]);
    expect(await getPrismaClient().pushDataChange.count()).toBe(0);
  });

  it("honours a device's hourly wake budget", async () => {
    const { session, devices } = await setUp(["c2".repeat(32)]);
    const now = new Date();
    await getPrismaClient().pushWake.createMany({
      data: Array.from({ length: 4 }, () => ({
        deviceId: devices[0]!.deviceId,
        kind: "HEALTHKIT_CATCH_UP",
        createdAt: new Date(now.getTime() - 10 * MIN),
      })),
    });
    await noteDataChanged(session.userId, ["measurements"], { now });
    expect(fake.apns.filter((a) => a.pushClass === "silent")).toHaveLength(0);
    // Kept for the next window, not lost.
    const row = await getPrismaClient().pushDataChange.findUniqueOrThrow({
      where: { deviceId: devices[0]!.deviceId },
    });
    expect(row.domains).toEqual(["measurements"]);
  });
});

describe("HEALTHKIT_CATCH_UP", () => {
  async function staleUpload(userId: string, hoursAgo: number) {
    await getPrismaClient().healthKitTypeSync.create({
      data: {
        userId,
        type: "WEIGHT",
        lastReceivedAt: new Date(Date.now() - hoursAgo * HOUR),
      },
    });
  }

  it("asks a device in use when the upload is six hours behind, within its limits", async () => {
    const { session, devices, sender } = await setUp(["d1".repeat(32)]);
    await staleUpload(session.userId, 7);
    const t0 = new Date();
    const first = await runHealthKitCatchUp(t0);
    expect(first).toMatchObject({ candidates: 1, sent: 1 });
    const sent = wakes(devices[0]!, sender, "HEALTHKIT_CATCH_UP");
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.d as object)).toEqual(["requestedAt"]);

    // Too soon for a second one.
    expect(
      await runHealthKitCatchUp(new Date(t0.getTime() + HOUR)),
    ).toMatchObject({ sent: 0, limited: 1 });
    // Four hours apart, at most three a day.
    for (const hours of [4, 8, 12]) {
      await runHealthKitCatchUp(new Date(t0.getTime() + hours * HOUR));
    }
    expect(wakes(devices[0]!, sender, "HEALTHKIT_CATCH_UP")).toHaveLength(3);
  });

  it("leaves a current upload, a quiet device and an old upload alone", async () => {
    const { session, devices } = await setUp(["d2".repeat(32)]);
    await staleUpload(session.userId, 2);
    expect(await runHealthKitCatchUp()).toMatchObject({ candidates: 0 });

    await getPrismaClient().healthKitTypeSync.deleteMany({});
    await staleUpload(session.userId, 30 * 24);
    expect(await runHealthKitCatchUp()).toMatchObject({ candidates: 0 });

    await getPrismaClient().healthKitTypeSync.deleteMany({});
    await staleUpload(session.userId, 8);
    await getPrismaClient().device.update({
      where: { id: devices[0]!.deviceId },
      data: { lastSeen: new Date(Date.now() - 5 * 24 * HOUR) },
    });
    expect(await runHealthKitCatchUp()).toMatchObject({
      candidates: 1,
      sent: 0,
    });
    expect(fake.apns.filter((a) => a.pushClass === "silent")).toHaveLength(0);
  });
});

describe("SECURITY_ALERT over the relay", () => {
  it("arrives sealed and time-sensitive with the change it reports", async () => {
    const { session, devices, sender } = await setUp(["e1".repeat(32)]);
    await sendSecurityAlert(session.userId, "passkey_added");
    const alerts = opened(devices[0]!, sender, "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      t: "SECURITY_ALERT",
      d: { securityKind: "passkey_added" },
      ui: { level: "time-sensitive" },
    });
  });
});
