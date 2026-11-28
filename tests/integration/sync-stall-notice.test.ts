/**
 * The stall notice (`SYNC_STALLED`) against real Postgres, end to end: the
 * batch ingest stamps the device named by `X-Device-Id`, the stall pass
 * learns its rhythm from the hours it delivered in, tells a quiet iPhone or a
 * flagged integration once, never at night and at most once a day, and the
 * next delivery clears the stall and re-arms the notice.
 *
 * The dispatcher is mocked: what is asserted is which notices the pass asks
 * for, not their delivery.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/cache/invalidate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/cache/invalidate")>();
  return { ...actual, invalidateUserData: vi.fn() };
});

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue({
    dispatched: true,
    channelsAttempted: 1,
    channelsSucceeded: 1,
  }),
}));

import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { runIntegrationWatchdog } from "@/lib/integrations/watchdog";
import { recordSyncSuccess } from "@/lib/integrations/status";
import { runSyncStallPass } from "@/lib/sync-stall/notice";
import { loadQuietSources } from "@/lib/sync-stall/quiet-load";
import type { DailyAsk } from "@/lib/daily/asks";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** 11:00 in Berlin. */
const T0 = new Date("2026-11-20T10:00:00.000Z");
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const TOKEN = "device-token-aaaaaaaa";
const OTHER_TOKEN = "device-token-bbbbbbbb";

const prisma = () => getPrismaClient();

interface StallCall {
  eventType: string;
  userId: string;
  message: string;
  metadata: { source: string; url: string };
}

function stallCalls(): StallCall[] {
  return vi
    .mocked(dispatchNotification)
    .mock.calls.map((c) => c[0] as unknown as StallCall)
    .filter((p) => p.eventType === "SYNC_STALLED");
}

async function signIn(): Promise<string> {
  const owner = await prisma().user.create({
    data: {
      username: "stall-owner",
      email: "stall-owner@example.test",
      timezone: "Europe/Berlin",
      locale: "en",
    },
  });
  const session = await prisma().session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 365 * DAY) },
  });
  cookieJar.set("healthlog_session", session.id);
  return owner.id;
}

async function addDevice(userId: string, token: string): Promise<string> {
  const device = await prisma().device.create({
    data: { userId, platform: "ios", token, bundleId: "app", model: "iPhone" },
  });
  return device.id;
}

/** Two weeks of deliveries every two hours, the last one at `lastAt`. */
async function seedHistory(deviceId: string, lastAt: Date): Promise<void> {
  const hours: Date[] = [];
  for (
    let t = lastAt.getTime();
    t > lastAt.getTime() - 14 * DAY;
    t -= 2 * HOUR
  ) {
    hours.push(new Date(Math.floor(t / HOUR) * HOUR));
  }
  await prisma().deviceHealthIngestHour.createMany({
    data: hours.map((hour) => ({ deviceId, hour })),
  });
  await prisma().device.update({
    where: { id: deviceId },
    data: { healthIngestAt: lastAt },
  });
}

async function postBatch(
  entries: unknown[],
  opts: { deviceToken?: string; syncTrigger?: string } = {},
) {
  const { POST } = await import("@/app/api/measurements/batch/route");
  return POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.deviceToken ? { "x-device-id": opts.deviceToken } : {}),
      },
      body: JSON.stringify({
        entries,
        ...(opts.syncTrigger ? { syncTrigger: opts.syncTrigger } : {}),
      }),
    }),
  );
}

function restingHeartRate(when: Date, id: string) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierRestingHeartRate",
    value: 58,
    unit: "count/min",
    startDate: when.toISOString(),
    endDate: when.toISOString(),
    externalId: `sample:rhr:${id}`,
  };
}

function activeEnergy(when: Date, id: string) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierActiveEnergyBurned",
    value: 120,
    unit: "kcal",
    startDate: when.toISOString(),
    endDate: when.toISOString(),
    externalId: `sample:energy:${id}`,
  };
}

async function deviceRow(id: string) {
  return prisma().device.findUniqueOrThrow({
    where: { id },
    select: {
      healthIngestAt: true,
      healthQuietSince: true,
      healthQuietNotifiedAt: true,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(prisma());
  cookieJar.clear();
  headerJar.clear();
  vi.mocked(dispatchNotification).mockClear();
  vi.useRealTimers();
});

describe("an iPhone whose Apple Health upload stalled", () => {
  it("is told once, cleared by the next delivery, and told afresh after the next stall", async () => {
    const userId = await signIn();
    const deviceId = await addDevice(userId, TOKEN);
    const lastAt = at(T0, -30 * HOUR);
    await seedHistory(deviceId, lastAt);

    const first = await runSyncStallPass(T0, prisma());
    expect(first.devicesFlagged).toBe(1);
    expect(first.sent).toBe(1);
    expect(stallCalls()).toHaveLength(1);
    expect(stallCalls()[0]).toMatchObject({
      userId,
      message:
        "Apple Health has sent nothing since yesterday. Opening HealthLog once is enough.",
      metadata: {
        source: "apple-health",
        url: "/settings/integrations#apple-health",
      },
    });
    expect(await deviceRow(deviceId)).toMatchObject({
      healthQuietSince: lastAt,
      healthQuietNotifiedAt: T0,
    });

    // The card reads the same flag.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(T0, HOUR));
    const { GET } = await import("@/app/api/integrations/healthkit/route");
    const card = (await (await GET()).json()) as {
      data: { quietDevices: Array<{ model: string; quietSince: string }> };
    };
    expect(card.data.quietDevices).toEqual([
      { model: "iPhone", quietSince: lastAt.toISOString() },
    ]);

    // An hour later, and the day after: still quiet, never told again.
    await runSyncStallPass(at(T0, HOUR), prisma());
    await runSyncStallPass(at(T0, 25 * HOUR), prisma());
    expect(stallCalls()).toHaveLength(1);

    // The app is opened; its foreground upload clears the stall.
    const delivered = at(T0, 26 * HOUR);
    vi.setSystemTime(delivered);
    const res = await postBatch([restingHeartRate(delivered, "resume")], {
      deviceToken: TOKEN,
    });
    expect(res.status).toBe(200);
    expect(await deviceRow(deviceId)).toEqual({
      healthIngestAt: delivered,
      healthQuietSince: null,
      healthQuietNotifiedAt: null,
    });
    expect(
      await prisma().deviceHealthIngestHour.count({
        where: {
          deviceId,
          hour: new Date(Math.floor(delivered.getTime() / HOUR) * HOUR),
        },
      }),
    ).toBe(1);

    // Quiet again for a day and a half: a new stall, told afresh.
    const later = at(delivered, 30 * HOUR); // 2026-11-22 19:00 Berlin
    const again = await runSyncStallPass(later, prisma());
    expect(again.devicesFlagged).toBe(1);
    expect(stallCalls()).toHaveLength(2);
  });

  it("stamps only accepted background types from the device that sent them", async () => {
    const userId = await signIn();
    const deviceId = await addDevice(userId, TOKEN);
    const now = new Date("2026-11-20T09:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    // Energy syncs only in the foreground: no evidence either way.
    expect(
      (await postBatch([activeEnergy(now, "e1")], { deviceToken: TOKEN }))
        .status,
    ).toBe(200);
    // A backfill is a catch-up, not a sync.
    await postBatch([restingHeartRate(now, "b1")], {
      deviceToken: TOKEN,
      syncTrigger: "backfill",
    });
    // No header, or a token that is no device of this account.
    await postBatch([restingHeartRate(now, "n1")]);
    await postBatch([restingHeartRate(now, "u1")], {
      deviceToken: "device-token-unknown",
    });
    expect((await deviceRow(deviceId)).healthIngestAt).toBeNull();
    expect(await prisma().deviceHealthIngestHour.count()).toBe(0);

    // A heart rate from the device: stamped, and its hour recorded.
    await postBatch([restingHeartRate(now, "ok")], { deviceToken: TOKEN });
    expect((await deviceRow(deviceId)).healthIngestAt).toEqual(now);
    expect(await prisma().deviceHealthIngestHour.count()).toBe(1);
  });

  it("waits for the morning when the stall begins at night", async () => {
    const userId = await signIn();
    const deviceId = await addDevice(userId, TOKEN);
    const night = new Date("2026-11-20T22:30:00.000Z"); // 23:30 Berlin
    await seedHistory(deviceId, at(night, -30 * HOUR));

    const flagged = await runSyncStallPass(night, prisma());
    expect(flagged.devicesFlagged).toBe(1);
    expect(stallCalls()).toHaveLength(0);
    await runSyncStallPass(new Date("2026-11-21T07:00:00.000Z"), prisma()); // 08:00
    expect(stallCalls()).toHaveLength(0);

    await runSyncStallPass(new Date("2026-11-21T08:00:00.000Z"), prisma()); // 09:00
    expect(stallCalls()).toHaveLength(1);
  });

  it("says nothing while another iPhone of the account still delivers", async () => {
    const userId = await signIn();
    const quiet = await addDevice(userId, TOKEN);
    const busy = await addDevice(userId, OTHER_TOKEN);
    await seedHistory(quiet, at(T0, -30 * HOUR));
    await seedHistory(busy, at(T0, -HOUR));

    const facts = await runSyncStallPass(T0, prisma());
    expect(facts.devicesFlagged).toBe(1);
    expect(facts.settled).toBe(1);
    expect(stallCalls()).toHaveLength(0);
    expect((await deviceRow(quiet)).healthQuietNotifiedAt).toEqual(T0);
  });

  it("leaves a phone used now and then alone", async () => {
    const userId = await signIn();
    const deviceId = await addDevice(userId, TOKEN);
    const lastAt = at(T0, -3 * DAY);
    await prisma().deviceHealthIngestHour.createMany({
      data: [3, 6, 9, 12].map((d) => ({
        deviceId,
        hour: new Date(Math.floor((lastAt.getTime() - d * DAY) / HOUR) * HOUR),
      })),
    });
    await prisma().device.update({
      where: { id: deviceId },
      data: { healthIngestAt: lastAt },
    });
    const facts = await runSyncStallPass(T0, prisma());
    expect(facts.devicesFlagged).toBe(0);
    expect(stallCalls()).toHaveLength(0);
  });
});

describe("an integration the watchdog flagged", () => {
  it("is told once, one notice a day across sources, and re-armed when data arrives", async () => {
    const userId = await signIn();
    await prisma().user.update({
      where: { id: userId },
      data: { ouraAccessTokenEncrypted: "x" },
    });
    // The watchdog has run here before (its first pass pages nothing).
    await prisma().integrationWatch.create({
      data: { userId, integration: "withings" },
    });
    // Oura delivered every three hours for two weeks, then stopped 60 h ago.
    const ouraLast = at(T0, -60 * HOUR);
    const readings = [];
    for (
      let t = ouraLast.getTime();
      t > ouraLast.getTime() - 14 * DAY;
      t -= 3 * HOUR
    ) {
      readings.push({
        userId,
        type: "RESTING_HEART_RATE" as const,
        value: 60,
        unit: "bpm",
        source: "OURA" as const,
        measuredAt: new Date(t),
      });
    }
    await prisma().measurement.createMany({ data: readings });
    // And the iPhone stalled too, more recently.
    const deviceId = await addDevice(userId, TOKEN);
    await seedHistory(deviceId, at(T0, -30 * HOUR));

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await recordSyncSuccess(userId, "oura");
    const watch = await runIntegrationWatchdog({ mode: "hourly", now: T0 });
    expect(watch.silencesFlagged).toBe(1);

    // The longest quiet first; the iPhone waits for tomorrow.
    await runSyncStallPass(T0, prisma());
    // The Today rail reads the same rule: both sources, before either is told.
    expect(await loadQuietSources(userId, T0)).toEqual([
      { source: "oura", since: ouraLast },
      { source: "apple-health", since: at(T0, -30 * HOUR) },
    ]);
    // And so does the start page's ask card: one row per quiet source, its
    // days counted on the owner's local calendar.
    const { GET: digest } = await import("@/app/api/daily/digest/route");
    const res = await digest(
      new NextRequest("http://localhost/api/daily/digest"),
    );
    expect(res.status).toBe(200);
    const asks = ((await res.json()) as { data: { asks: DailyAsk[] } }).data
      .asks;
    expect(
      asks
        .filter((a) => a.kind === "source_stalled")
        .map((a) => [a.itemKey, a.title, a.body, a.actions[0].href]),
    ).toEqual([
      [
        "source_stalled:oura",
        "Oura",
        "3 days quiet",
        "/settings/integrations#oura",
      ],
      [
        "source_stalled:apple-health",
        "Apple Health",
        "1 day quiet",
        "/settings/integrations#apple-health",
      ],
    ]);
    expect(stallCalls().map((c) => c.metadata.source)).toEqual(["oura"]);
    expect(stallCalls()[0]!.message).toMatch(/^Oura has sent nothing since/);
    await runSyncStallPass(at(T0, HOUR), prisma());
    expect(stallCalls()).toHaveLength(1);

    // The next morning: the iPhone's turn, and Oura is not told again.
    const tomorrow = at(T0, 23 * HOUR); // 10:00 Berlin
    vi.setSystemTime(tomorrow);
    await runIntegrationWatchdog({ mode: "hourly", now: tomorrow });
    await runSyncStallPass(tomorrow, prisma());
    expect(stallCalls().map((c) => c.metadata.source)).toEqual([
      "oura",
      "apple-health",
    ]);

    // Oura delivers again: the watchdog clears the flag and the notice stamp.
    await prisma().measurement.create({
      data: {
        userId,
        type: "RESTING_HEART_RATE",
        value: 61,
        unit: "bpm",
        source: "OURA",
        measuredAt: at(tomorrow, -HOUR),
      },
    });
    await runIntegrationWatchdog({ mode: "hourly", now: tomorrow });
    const row = await prisma().integrationWatch.findUniqueOrThrow({
      where: { userId_integration: { userId, integration: "oura" } },
      select: { silentSince: true, ownerNotifiedAt: true },
    });
    expect(row).toEqual({ silentSince: null, ownerNotifiedAt: null });
    // And the rail lets it go with the flag.
    expect(
      (await loadQuietSources(userId, tomorrow)).map((q) => q.source),
    ).toEqual(["apple-health"]);
  });

  it("hands its claims back when every channel failed, and settles when none wanted it", async () => {
    const userId = await signIn();
    const deviceId = await addDevice(userId, TOKEN);
    await seedHistory(deviceId, at(T0, -30 * HOUR));

    vi.mocked(dispatchNotification).mockResolvedValueOnce({
      dispatched: false,
      channelsAttempted: 2,
      channelsSucceeded: 0,
    });
    const failed = await runSyncStallPass(T0, prisma());
    expect(failed.failed).toBe(1);
    expect((await deviceRow(deviceId)).healthQuietNotifiedAt).toBeNull();

    // The next hour tries again; this time no channel wants the event.
    vi.mocked(dispatchNotification).mockResolvedValueOnce({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    });
    const unwanted = await runSyncStallPass(at(T0, HOUR), prisma());
    expect(unwanted.settled).toBe(1);
    expect((await deviceRow(deviceId)).healthQuietNotifiedAt).toEqual(
      at(T0, HOUR),
    );
    await runSyncStallPass(at(T0, 2 * HOUR), prisma());
    expect(stallCalls()).toHaveLength(2);
  });
});
