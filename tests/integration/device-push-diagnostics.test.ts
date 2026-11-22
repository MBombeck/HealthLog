/**
 * `GET /api/devices/me/push-diagnostics`: the calling device's push state,
 * against the real database, through the real API kit and the fake relay.
 *
 * What the app's diagnostics screen relies on:
 *   - it sees its own device only, named by `X-Device-Id`; another account's
 *     device, an unknown one and a missing header all answer the same 404;
 *   - the budget numbers are the ones the send itself counts, after real
 *     sends, and an intake sync the budget held back shows as owed with the
 *     time it can go;
 *   - the APNs token appears only masked, and a narrow token is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-device-push-diagnostics-32-bytes-min-12345";

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

import { GET } from "@/app/api/devices/me/push-diagnostics/route";
import type { DevicePushDiagnostics } from "@/lib/push-relay/diagnostics";
import { sendWake } from "@/lib/push-relay/wakes";
import { loadPushContext } from "@/lib/push-relay/route-device";
import { callRoute, type RouteAuth } from "../kit/call-route";
import {
  makeSession,
  makeToken,
  makeUser,
  uniqueSuffix,
} from "../kit/factories";
import { bindDevice, enableRelay } from "./push-relay-kit";
import { countStatements } from "./query-counter";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const MIN = 60_000;
const TOKEN = "5c".repeat(32);
const DEVICE_ID_HEADER = `device-${TOKEN.slice(0, 6)}`;

let fake: FakeRelay;

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await truncateAllTables(prisma);
  fake = new FakeRelay();
  relay.current = fake;
});

function read(auth: RouteAuth, deviceIdHeader?: string) {
  return callRoute<DevicePushDiagnostics>(GET, {
    method: "GET",
    route: "/api/devices/me/push-diagnostics",
    auth,
    headers: deviceIdHeader ? { "x-device-id": deviceIdHeader } : undefined,
  });
}

async function boundDevice() {
  const { instanceId } = await enableRelay();
  const bound = await bindDevice(instanceId, TOKEN);
  const device = await prisma.device.findUniqueOrThrow({
    where: { id: bound.deviceId },
    select: {
      id: true,
      apnsToken: true,
      apnsEnvironment: true,
      pushKeyPublic: true,
      relayState: true,
      relayConsentAt: true,
    },
  });
  return { ...bound, device };
}

describe("GET /api/devices/me/push-diagnostics", () => {
  it("answers 401 without a credential", async () => {
    expect((await read({ kind: "anonymous" }, DEVICE_ID_HEADER)).status).toBe(
      401,
    );
  });

  it("describes the caller's relay device, with the token masked", async () => {
    const { session, deviceId } = await boundDevice();
    const res = await read(session, DEVICE_ID_HEADER);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const d = res.data;
    expect(d.deviceId).toBe(deviceId);
    expect(d.transport).toBe("relay");
    expect(d.sealed).toBe(true);
    expect(d.binding).toMatchObject({ state: "bound", consent: true });
    expect(d.relay.state).toBe("ok");
    expect(d.apnsToken).toEqual({
      prefix: TOKEN.slice(0, 8),
      suffix: TOKEN.slice(-8),
    });
    expect(d.apnsEnvironment).toBe("production");
    expect(d.budget).toEqual({
      windowMinutes: 60,
      limit: 6,
      wakeLimit: 4,
      usedInWindow: 0,
      wakesUsedInWindow: 0,
      owedSyncs: 0,
      owedSince: null,
      nextFreeAt: null,
    });
    expect(d.lastDelivery).toEqual({
      alert: null,
      silentSync: null,
      wake: null,
      liveActivity: null,
    });
    expect(d.receipt).toBeNull();
    expect(Math.abs(Date.parse(d.serverTime) - Date.now())).toBeLessThan(
      60_000,
    );
    // The token in clear appears nowhere in the answer.
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it("answers the same 404 for another account's device, an unknown one and none", async () => {
    await boundDevice();
    const stranger = await makeSession(await makeUser());
    const foreign = await read(stranger, DEVICE_ID_HEADER);
    const unknown = await read(stranger, `device-${uniqueSuffix()}`);
    const missing = await read(stranger);
    for (const res of [foreign, unknown, missing]) {
      expect(res.status).toBe(404);
      expect(res.error).toBe("Device not found");
    }
  });

  it("accepts a wildcard token and refuses a narrow one", async () => {
    const { session } = await boundDevice();
    const user = { id: session.userId };
    const wildcard = await makeToken(user);
    expect((await read(wildcard, DEVICE_ID_HEADER)).status).toBe(200);

    const narrow = await makeToken(user, {
      permissions: ["medication:ingest"],
    });
    const refused = await read(narrow, DEVICE_ID_HEADER);
    expect(refused.status).toBe(403);
    await expect
      .poll(
        async () => {
          const row = await prisma.auditLog.findFirst({
            where: { action: "auth.bearer.failure", userId: session.userId },
            orderBy: { createdAt: "desc" },
          });
          return row?.details
            ? (JSON.parse(row.details) as { reason?: string }).reason
            : undefined;
        },
        { timeout: 5_000, interval: 100 },
      )
      .toBe("undeclared_scope");
  });

  it("counts the sends the budget counts, and shows the last wake", async () => {
    const { session, device } = await boundDevice();
    const ctx = await loadPushContext();
    const start = new Date();
    for (let i = 0; i < 4; i++) {
      const sent = await sendWake(
        "HEALTHKIT_CATCH_UP",
        [device],
        { requestedAt: start.toISOString() },
        { ctx, now: new Date(start.getTime() + i * MIN) },
      );
      expect(sent.sent).toEqual([device.id]);
    }
    await eventually(async () => {
      const rows = await prisma.pushRelayDelivery.findMany({
        where: { deviceId: device.id },
      });
      return rows.length === 4 && rows.every((r) => r.status === "accepted");
    });

    const d = (await read(session, DEVICE_ID_HEADER)).data;
    expect(d.budget).toMatchObject({
      usedInWindow: 4,
      wakesUsedInWindow: 4,
      owedSyncs: 0,
      nextFreeAt: null,
    });
    expect(d.lastDelivery.wake).toMatchObject({
      eventType: "HEALTHKIT_CATCH_UP",
      outcome: "accepted",
      reason: null,
    });
    expect(d.lastDelivery.silentSync).toBeNull();

    // The wake limit is spent (and over the relay two slots stay for the
    // sync): the send refuses the fifth, as the numbers above say.
    const fifth = await sendWake(
      "DATA_CHANGED",
      [device],
      { domains: ["sleep"] },
      { ctx, now: new Date(start.getTime() + 5 * MIN) },
    );
    expect(fifth.overBudget).toEqual([device.id]);
    const after = (await read(session, DEVICE_ID_HEADER)).data;
    expect(after.budget.usedInWindow).toBe(4);
    expect(after.budget.nextFreeAt).toBeNull();
  });

  it("shows an owed intake sync and when it can go", async () => {
    const { session, deviceId } = await boundDevice();
    const spentAt = new Date(Date.now() - 30 * MIN);
    await prisma.pushWake.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        deviceId,
        kind: i < 2 ? "DATA_CHANGED" : "MEDICATION_INTAKE_SYNC",
        createdAt: spentAt,
      })),
    });
    const { queueMedicationIntakeSync } =
      await import("@/lib/notifications/medication-intake-sync");
    queueMedicationIntakeSync({
      userId: session.userId,
      originDeviceToken: null,
    });
    await eventually(
      async () =>
        (
          await prisma.pushDataChange.findUnique({
            where: { deviceId },
          })
        )?.intakeSyncOwedAt != null,
    );

    const d = (await read(session, DEVICE_ID_HEADER)).data;
    expect(d.budget.usedInWindow).toBe(6);
    expect(d.budget.wakesUsedInWindow).toBe(2);
    expect(d.budget.owedSyncs).toBe(1);
    expect(d.budget.owedSince).not.toBeNull();
    expect(d.budget.nextFreeAt).toBe(
      new Date(spentAt.getTime() + 60 * MIN).toISOString(),
    );
  });

  it("shows the last receipt the device reported", async () => {
    const { session, deviceId } = await boundDevice();
    const reportedAt = new Date();
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        envelopeOpenedAlertId: "01JDAAAAAAAAAAAAAAAAAAAAAA",
        envelopeReportedAt: reportedAt,
      },
    });
    const d = (await read(session, DEVICE_ID_HEADER)).data;
    expect(d.receipt).toEqual({
      reportedAt: reportedAt.toISOString(),
      openedAlert: "01JDAAAAAAAAAAAAAAAAAAAAAA",
      openedSilent: null,
    });
  });

  it("reads the account's attempts for the alert only while this is its one APNs device", async () => {
    // No relay, no APNs key: the device has no route, and its deliveries
    // come from the server-side ledgers.
    const user = await makeUser();
    const session = await makeSession(user);
    const phone = await prisma.device.create({
      data: {
        userId: user.id,
        platform: "ios",
        token: "device-solo",
        bundleId: "dev.healthlog.app",
        apnsToken: "7d".repeat(32),
        apnsEnvironment: "sandbox",
      },
    });
    const at = new Date(Date.now() - 5 * MIN);
    await prisma.pushAttempt.createMany({
      data: {
        userId: user.id,
        recordUserId: user.id,
        recipientUserId: user.id,
        channel: "APNS",
        eventType: "MEDICATION_REMINDER",
        result: "error",
        reason: "BadDeviceToken",
        createdAt: at,
      },
    });
    await prisma.pushWake.create({
      data: { deviceId: phone.id, kind: "MEDICATION_INTAKE_SYNC" },
    });

    const solo = (await read(session, "device-solo")).data;
    expect(solo.transport).toBe("none");
    expect(solo.budget.limit).toBeNull();
    expect(solo.lastDelivery.alert).toEqual({
      at: at.toISOString(),
      eventType: "MEDICATION_REMINDER",
      outcome: "failed",
      reason: "BadDeviceToken",
    });
    expect(solo.lastDelivery.silentSync).toMatchObject({
      eventType: "MEDICATION_INTAKE_SYNC",
      outcome: "sent",
    });

    // A second APNs device: the attempt could be either one's.
    await prisma.device.create({
      data: {
        userId: user.id,
        platform: "ios",
        token: "device-second",
        bundleId: "dev.healthlog.app",
        apnsToken: "8e".repeat(32),
        apnsEnvironment: "sandbox",
      },
    });
    const shared = (await read(session, "device-solo")).data;
    expect(shared.lastDelivery.alert).toBeNull();
    expect(shared.lastDelivery.silentSync).not.toBeNull();
  });

  it("allows ten reads a minute per account", async () => {
    const { session } = await boundDevice();
    for (let i = 0; i < 10; i++) {
      expect((await read(session, DEVICE_ID_HEADER)).status).toBe(200);
    }
    const limited = await read(session, DEVICE_ID_HEADER);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("stays within its statement budget", async () => {
    const { session } = await boundDevice();
    await read(session, DEVICE_ID_HEADER);
    const measured = await countStatements(() =>
      read(session, DEVICE_ID_HEADER),
    );
    expect(measured.result.status).toBe(200);
    // The session and its user, the rate-limit upsert, the device and its
    // owed row, the relay registration, one outbox read per kind and the
    // budget window: a fixed number, whatever the ledgers hold.
    expect(measured.count, measured.statements.join("\n")).toBeLessThanOrEqual(
      BUDGET,
    );
  });
});

/** Statements one read sends on this fixture; see the test above. */
const BUDGET = 11;
