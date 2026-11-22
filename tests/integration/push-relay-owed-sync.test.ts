/**
 * A relay per-item refusal is never a success.
 *
 * The relay answers `200` for a batch and refuses items inside it. An undo on
 * the web logged its intake sync flush as `ok` with nothing deferred while the
 * relay had refused the one silent item for the device's budget
 * (`device_quota`, six silent pushes per rolling hour): the outbox held the
 * push for a retry, the flush read "handed on" as sent, and the sync was never
 * owed. The minute pass then found nothing to send, and the device never
 * reconciled.
 *
 * Now: a silent push the relay refuses for a budget is owed, not retried, and
 * the relay's hold (its `retryAfter`, else the ledger's next free slot) keeps
 * every silent push to the device back until the window frees; the next minute
 * pass then sends one fresh sync. The flush and the ledger say `deferred`
 * (recorded as `skipped`), never `ok`, unless every device accepted.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-relay-owed-sync-ingest-32-bytes-minimum-1234";

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
import { makeSession, makeUser } from "../kit/factories";
import { deviceBody, enableRelay, registerDevice } from "./push-relay-kit";

const TOKEN = "4a".repeat(32);
const OTHER_TOKEN = "5b".repeat(32);
const SYNC = "MEDICATION_INTAKE_SYNC";
const MINUTE = 60_000;

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

async function relayDevice(token = TOKEN) {
  const { instanceId } = await enableRelay();
  const user = await makeUser();
  const session = await makeSession(user);
  const registered = await registerDevice(
    session,
    deviceBody(instanceId, token).body,
  );
  return { user, deviceId: registered.data.id as string };
}

async function flushSync(userId: string) {
  const { queueMedicationIntakeSync } =
    await import("@/lib/notifications/medication-intake-sync");
  queueMedicationIntakeSync({ userId, originDeviceToken: null });
  await eventually(
    async () =>
      (await getPrismaClient().pushAttempt.count({
        where: { userId, eventType: SYNC },
      })) === 1,
  );
}

function syncAttempts(userId: string) {
  return getPrismaClient().pushAttempt.findMany({
    where: { userId, eventType: SYNC },
    select: { result: true, reason: true },
    orderBy: { createdAt: "asc" },
  });
}

async function owedAt(deviceId: string) {
  return (
    await getPrismaClient().pushDataChange.findUnique({ where: { deviceId } })
  )?.intakeSyncOwedAt;
}

const quota = (retryAfter?: number) => ({
  status: 429,
  error: "device_quota",
  scope: "device",
  ...(retryAfter !== undefined ? { retryAfter } : {}),
});

describe("a sync the relay refuses for the device's budget", () => {
  it("is owed, not ok, and goes with the next minute pass once the window frees", async () => {
    const { user, deviceId } = await relayDevice();
    const prisma = getPrismaClient();
    fake.itemAnswer = (item) => (item.class === "silent" ? quota(600) : null);
    const before = Date.now();
    await flushSync(user.id);

    expect(await syncAttempts(user.id)).toEqual([
      { result: "skipped", reason: "relay_owed:device_quota" },
    ]);
    const since = await owedAt(deviceId);
    expect(since).not.toBeNull();
    // Not retried by the outbox: dropped, with the relay's hold.
    const rows = await prisma.pushRelayDelivery.findMany({
      where: { deviceId, eventType: SYNC },
      select: { status: true, reason: true, nextAttemptAt: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "dropped",
      reason: "device_quota",
    });
    const hold = rows[0]!.nextAttemptAt!;
    expect(hold.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(hold.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
    // A refused push spent none of this server's mirror of the budget.
    expect(await prisma.pushWake.count({ where: { deviceId } })).toBe(0);

    // The device's diagnostics show the owed sync and when it goes.
    const { token } = await prisma.device.findUniqueOrThrow({
      where: { id: deviceId },
      select: { token: true },
    });
    const { devicePushDiagnostics } =
      await import("@/lib/push-relay/diagnostics");
    const diag = await devicePushDiagnostics(user.id, token);
    expect(diag?.budget).toMatchObject({
      owedSyncs: 1,
      owedSince: since!.toISOString(),
      nextFreeAt: hold.toISOString(),
    });
    expect(diag?.lastDelivery.silentSync).toMatchObject({
      outcome: "dropped",
      reason: "device_quota",
    });

    // The relay's window is still closed: the minute pass does not even try.
    fake.itemAnswer = null;
    const { flushDueDataChanges } =
      await import("@/lib/push-relay/data-changed");
    const sentBefore = fake.wire.length;
    expect(
      (await flushDueDataChanges(new Date(Date.now() + MINUTE))).owedSynced,
    ).toBe(0);
    expect(fake.wire.length).toBe(sentBefore);
    expect(await owedAt(deviceId)).toEqual(since);

    // The first minute pass after the window frees sends it, once.
    const later = new Date(hold.getTime() + MINUTE);
    expect((await flushDueDataChanges(later)).owedSynced).toBe(1);
    expect(
      fake.apns.filter((a) => a.pushClass === "silent" && a.token === TOKEN),
    ).toHaveLength(1);
    expect(await owedAt(deviceId)).toBeNull();
    expect((await flushDueDataChanges(later)).owedSynced).toBe(0);
    expect((await syncAttempts(user.id)).at(-1)).toEqual({
      result: "ok",
      reason: "intake_sync_owed_sent",
    });
  });

  it("without a retry hint holds until this server's ledger frees a slot", async () => {
    const { user, deviceId } = await relayDevice();
    const prisma = getPrismaClient();
    // The relay counts three (its limit halves after a restart); this server
    // knows of three, the oldest 50 minutes ago.
    const now = Date.now();
    await prisma.pushWake.createMany({
      data: [50, 30, 10].map((ago) => ({
        deviceId,
        kind: SYNC,
        createdAt: new Date(now - ago * MINUTE),
      })),
    });
    fake.itemAnswer = (item) => (item.class === "silent" ? quota() : null);
    await flushSync(user.id);

    const row = await prisma.pushRelayDelivery.findFirstOrThrow({
      where: { deviceId, eventType: SYNC },
      select: { status: true, nextAttemptAt: true },
    });
    expect(row.status).toBe("dropped");
    const expected = now - 50 * MINUTE + 60 * MINUTE;
    expect(Math.abs(row.nextAttemptAt!.getTime() - expected)).toBeLessThan(
      2000,
    );
    expect(await owedAt(deviceId)).not.toBeNull();
  });

  it("is deferred beside a device that took it, never ok", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    await registerDevice(session, deviceBody(instanceId, TOKEN).body);
    await registerDevice(session, deviceBody(instanceId, OTHER_TOKEN).body);
    // The 21:12 flush: one item accepted, one refused for the budget.
    let silent = 0;
    fake.itemAnswer = (item) =>
      item.class === "silent" && silent++ === 0 ? quota(300) : null;
    await flushSync(user.id);

    expect(await syncAttempts(user.id)).toEqual([
      { result: "skipped", reason: "relay_owed:device_quota" },
    ]);
    const owed = await getPrismaClient().pushDataChange.findMany({
      where: { intakeSyncOwedAt: { not: null } },
    });
    expect(owed).toHaveLength(1);
    expect(fake.apns.filter((a) => a.pushClass === "silent")).toHaveLength(1);
  });
});

describe("every relay answer to a silent sync", () => {
  it.each([
    [null, "accepted", false, "ok", null],
    [quota(300), "dropped", true, "skipped", "relay_owed:device_quota"],
    [
      {
        status: 429,
        error: "instance_rate",
        scope: "instance",
        retryAfter: 40,
      },
      "dropped",
      true,
      "skipped",
      "relay_owed:instance_rate",
    ],
    [
      { status: 503, error: "apns_unavailable", retryAfter: 30 },
      "pending",
      false,
      "skipped",
      "relay_waiting",
    ],
    [
      { status: 404, error: "binding_unknown" },
      "failed",
      false,
      "error",
      "relay_item_failed:binding_unknown",
    ],
    [
      { status: 422, error: "invalid_item" },
      "failed",
      false,
      "error",
      "relay_item_failed:invalid_item",
    ],
    [
      { status: 200, result: "soft_invalid" },
      "failed",
      false,
      "error",
      "relay_item_failed:soft_invalid",
    ],
  ] as const)(
    "%o: delivery %s, owed %s, ledger %s %s",
    async (answer, status, owed, result, reason) => {
      const { user, deviceId } = await relayDevice();
      fake.itemAnswer = (item) =>
        item.class === "silent" && answer ? { ...answer } : null;
      await flushSync(user.id);
      const row = await getPrismaClient().pushRelayDelivery.findFirstOrThrow({
        where: { deviceId, eventType: SYNC },
        select: { status: true },
      });
      expect(row.status).toBe(status);
      expect((await owedAt(deviceId)) != null).toBe(owed);
      expect(await syncAttempts(user.id)).toEqual([{ result, reason }]);
    },
  );
});

describe("a DATA_CHANGED wake and the owed sync", () => {
  it("puts its domains back when the relay refuses it for the budget", async () => {
    const { user, deviceId } = await relayDevice();
    const prisma = getPrismaClient();
    fake.itemAnswer = (item) => (item.class === "silent" ? quota(600) : null);
    const { flushDueDataChanges, noteDataChanged } =
      await import("@/lib/push-relay/data-changed");
    await noteDataChanged(user.id, ["sleep"]);
    const row = await prisma.pushDataChange.findUniqueOrThrow({
      where: { deviceId },
    });
    expect(row.domains).toEqual(["sleep"]);
    // Refused, so the five-minute window did not start.
    expect(row.sentAt).toEqual([]);
    expect(await prisma.pushWake.count({ where: { deviceId } })).toBe(0);

    fake.itemAnswer = null;
    const hold = (
      await prisma.pushRelayDelivery.findFirstOrThrow({
        where: { deviceId, eventType: "DATA_CHANGED" },
        select: { nextAttemptAt: true },
      })
    ).nextAttemptAt!;
    expect((await flushDueDataChanges(new Date())).flushed).toBe(0);
    expect(
      (await flushDueDataChanges(new Date(hold.getTime() + MINUTE))).flushed,
    ).toBe(1);
    expect(
      (await prisma.pushDataChange.findUniqueOrThrow({ where: { deviceId } }))
        .domains,
    ).toEqual([]);
  });

  it("waits behind an owed sync, which the minute pass sends first", async () => {
    const { user, deviceId } = await relayDevice();
    const prisma = getPrismaClient();
    const { oweIntakeSync } = await import("@/lib/push-relay/owed-silent");
    await oweIntakeSync([deviceId], new Date());
    const { flushDueDataChanges, noteDataChanged } =
      await import("@/lib/push-relay/data-changed");
    // A change between two passes does not take the slot ahead of the sync.
    await noteDataChanged(user.id, ["measurements"]);
    expect(fake.wire).toHaveLength(0);
    const facts = await flushDueDataChanges(new Date());
    expect(facts).toMatchObject({ owedSynced: 1, flushed: 1 });
    const kinds = await prisma.pushRelayDelivery.findMany({
      where: { deviceId },
      orderBy: { createdAt: "asc" },
      select: { eventType: true, status: true },
    });
    expect(kinds).toEqual([
      { eventType: SYNC, status: "accepted" },
      { eventType: "DATA_CHANGED", status: "accepted" },
    ]);
  });
});
