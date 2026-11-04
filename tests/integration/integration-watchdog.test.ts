/**
 * The integration watchdog and the connection health read against real
 * Postgres: the 14-day history count, the one-alert-per-incident ledger, the
 * recovery note, the on-demand exemption, the adoption of a page the sync
 * ledger already sent, and the recent-call ring the diagnostics read.
 *
 * The dispatcher is mocked: what is asserted is how many operator messages
 * the watchdog asks for, not their delivery.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue({
    dispatched: true,
    channelsAttempted: 1,
    channelsSucceeded: 1,
  }),
}));

import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { runIntegrationWatchdog } from "@/lib/integrations/watchdog";
import { loadConnectionHealth } from "@/lib/integrations/connection-health-load";
import {
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-15T12:00:00.000Z");
const USER = "user-watchdog-subject";
const ADMIN = "user-watchdog-admin";

const prisma = () => getPrismaClient();

async function seedDailyReadings(
  userId: string,
  source: "OURA" | "WITHINGS",
  days: number[],
  newestHoursAgo: number,
) {
  const rows = days.map((d) => ({
    userId,
    type: "RESTING_HEART_RATE" as const,
    value: 60,
    unit: "bpm",
    source,
    measuredAt: new Date(NOW.getTime() - d * DAY - 6 * HOUR),
  }));
  rows.push({
    userId,
    type: "RESTING_HEART_RATE" as const,
    value: 60,
    unit: "bpm",
    source,
    measuredAt: new Date(NOW.getTime() - newestHoursAgo * HOUR),
  });
  await prisma().measurement.createMany({ data: rows });
}

function dispatchedTitles(): string[] {
  return vi
    .mocked(dispatchNotification)
    .mock.calls.map((c) => String((c[0] as { title: string }).title));
}

beforeEach(async () => {
  await truncateAllTables(prisma());
  await prisma().user.create({
    data: {
      id: ADMIN,
      username: "wd-admin",
      email: "admin@example.test",
      role: "ADMIN",
    },
  });
  await prisma().user.create({
    data: {
      id: USER,
      username: "wd-subject",
      email: "subject@example.test",
      ouraAccessTokenEncrypted: "not-a-real-token",
    },
  });
  vi.mocked(dispatchNotification).mockClear();
  // The watchdog has run on this instance before: its first pass after a
  // deploy records what stands without paging (pinned on its own below).
  await prisma().integrationWatch.create({
    data: { userId: ADMIN, integration: "withings" },
  });
});

describe("integration watchdog", () => {
  it("flags a normally-daily wearable gone silent, alerts once, then sends one recovery note", async () => {
    // Thirteen consecutive days of data before the window, newest 54 h ago:
    // past Oura's 48 h window (it uploads only when its phone app is opened).
    await seedDailyReadings(
      USER,
      "OURA",
      Array.from({ length: 13 }, (_, i) => i + 3),
      54,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      await recordSyncSuccess(USER, "oura");

      const first = await runIntegrationWatchdog({ mode: "hourly", now: NOW });
      expect(first.silencesFlagged).toBe(1);
      expect(first.incidentsOpened).toBe(1);
      expect(dispatchedTitles()).toEqual([
        "Oura needs attention for subject@example.test",
      ]);

      const watch = await prisma().integrationWatch.findUniqueOrThrow({
        where: { userId_integration: { userId: USER, integration: "oura" } },
      });
      expect(watch.incidentReason).toBe("unexpected_silence");
      expect(watch.silentSince).not.toBeNull();
      expect(watch.alertedAt).not.toBeNull();

      const health = await loadConnectionHealth(USER, ["oura"]);
      expect(health.oura?.state).toBe("degraded");
      expect(health.oura?.reason).toBe("unexpected_silence");

      // Next hour, and the daily pass: still silent, nothing new is sent.
      const later = new Date(NOW.getTime() + HOUR);
      await runIntegrationWatchdog({ mode: "hourly", now: later });
      await runIntegrationWatchdog({ mode: "daily", now: later });
      expect(dispatchNotification).toHaveBeenCalledTimes(1);

      // Data arrives again: the incident closes with one recovery note.
      await prisma().measurement.create({
        data: {
          userId: USER,
          type: "RESTING_HEART_RATE",
          value: 61,
          unit: "bpm",
          source: "OURA",
          measuredAt: new Date(later.getTime() - 10 * 60 * 1000),
        },
      });
      const recovered = await runIntegrationWatchdog({
        mode: "hourly",
        now: new Date(later.getTime() + HOUR),
      });
      expect(recovered.incidentsClosed).toBe(1);
      expect(dispatchedTitles()).toEqual([
        "Oura needs attention for subject@example.test",
        "Oura recovered for subject@example.test",
      ]);
      const cleared = await prisma().integrationWatch.findUniqueOrThrow({
        where: { userId_integration: { userId: USER, integration: "oura" } },
      });
      expect(cleared.silentSince).toBeNull();
      expect(cleared.incidentReason).toBeNull();

      // Healthy and quiet: further passes send nothing.
      await runIntegrationWatchdog({
        mode: "hourly",
        now: new Date(later.getTime() + 2 * HOUR),
      });
      expect(dispatchNotification).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a wearable alone when its owner wears it only now and then", async () => {
    await seedDailyReadings(USER, "OURA", [3, 7, 11], 54);
    await recordSyncSuccess(USER, "oura");
    const summary = await runIntegrationWatchdog({ mode: "hourly", now: NOW });
    expect(summary.silencesFlagged).toBe(0);
    expect(dispatchNotification).not.toHaveBeenCalled();
    expect(
      await prisma().integrationWatch.count({ where: { userId: USER } }),
    ).toBe(0);
  });

  it("never alerts on silence for an on-demand source such as a scale", async () => {
    await prisma().user.update({
      where: { id: USER },
      data: { ouraAccessTokenEncrypted: null },
    });
    await prisma().withingsConnection.create({
      data: {
        userId: USER,
        withingsUserId: "w-1",
        accessToken: "x",
        refreshToken: "y",
        tokenExpiresAt: new Date(NOW.getTime() + DAY),
        scope: "user.metrics,user.activity",
      },
    });
    // Daily weigh-ins for two weeks, then nothing for three days.
    await seedDailyReadings(
      USER,
      "WITHINGS",
      Array.from({ length: 13 }, (_, i) => i + 4),
      72,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      await recordSyncSuccess(USER, "withings");
      const summary = await runIntegrationWatchdog({ mode: "daily", now: NOW });
      expect(summary.connectionsConsidered).toBe(1);
      expect(summary.silencesFlagged).toBe(0);
      expect(dispatchNotification).not.toHaveBeenCalled();
      const health = await loadConnectionHealth(USER, ["withings"]);
      expect(health.withings?.state).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts a failure streak the ledger already paged about and reports its end once", async () => {
    await seedDailyReadings(USER, "OURA", [2], 5);
    for (let i = 0; i < 3; i++) {
      await recordSyncFailure({
        userId: USER,
        integration: "oura",
        kind: "transient",
        message: "Oura error: 503 with a body that must never be published",
        errorCode: "503",
      });
    }
    // The ledger's own 3-strike page.
    expect(dispatchNotification).toHaveBeenCalledTimes(1);

    const now = new Date();
    const adopted = await runIntegrationWatchdog({ mode: "hourly", now });
    expect(adopted.incidentsOpened).toBe(1);
    expect(dispatchNotification).toHaveBeenCalledTimes(1);

    await recordSyncSuccess(USER, "oura");
    const closed = await runIntegrationWatchdog({ mode: "hourly", now });
    expect(closed.incidentsClosed).toBe(1);
    expect(dispatchNotification).toHaveBeenCalledTimes(2);
    expect(dispatchedTitles()[1]).toBe(
      "Oura recovered for subject@example.test",
    );
  });
});

describe("what pages and what does not", () => {
  it("never pages for an Apple Health account whose phone app stopped delivering weeks ago", async () => {
    // Daily data until forty days ago, then nothing: the push cadence reads
    // stale (`no_new_data`) for good. The owner stopped using the app; there
    // is nothing for an operator to do.
    await prisma().user.update({
      where: { id: USER },
      data: {
        ouraAccessTokenEncrypted: null,
        healthKitLastSyncedAt: new Date(NOW.getTime() - 40 * DAY),
      },
    });
    await prisma().measurement.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        userId: USER,
        type: "ACTIVITY_STEPS" as const,
        value: 5000,
        unit: "count",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(NOW.getTime() - (40 + i) * DAY),
      })),
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const health = await loadConnectionHealth(USER, ["apple-health"]);
      expect(health["apple-health"]?.state).toBe("degraded");
      expect(health["apple-health"]?.reason).toBe("no_new_data");
      // A week of hourly and daily passes.
      for (let day = 0; day < 7; day++) {
        const at = new Date(NOW.getTime() + day * DAY);
        const hourly = await runIntegrationWatchdog({
          mode: "hourly",
          now: at,
        });
        const daily = await runIntegrationWatchdog({ mode: "daily", now: at });
        expect(hourly.incidentsOpened + daily.incidentsOpened).toBe(0);
      }
      expect(dispatchNotification).not.toHaveBeenCalled();
      expect(
        await prisma().integrationWatch.count({
          where: { userId: USER, incidentReason: { not: null } },
        }),
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records what stands on its first pass after a deploy without paging, and pages normally after", async () => {
    await prisma().integrationWatch.deleteMany();
    // A wearable that has been silent since before the watchdog existed.
    await seedDailyReadings(
      USER,
      "OURA",
      Array.from({ length: 13 }, (_, i) => i + 3),
      54,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      await recordSyncSuccess(USER, "oura");
      const first = await runIntegrationWatchdog({ mode: "hourly", now: NOW });
      expect(first.firstRun).toBe(true);
      expect(first.incidentsOpened).toBe(1);
      expect(dispatchNotification).not.toHaveBeenCalled();
      const watch = await prisma().integrationWatch.findUniqueOrThrow({
        where: { userId_integration: { userId: USER, integration: "oura" } },
      });
      expect(watch.incidentReason).toBe("unexpected_silence");
      // Marked as announced, so no later pass pages it either.
      expect(watch.alertedAt).not.toBeNull();

      const later = new Date(NOW.getTime() + HOUR);
      const second = await runIntegrationWatchdog({
        mode: "hourly",
        now: later,
      });
      expect(second.firstRun).toBe(false);
      expect(dispatchNotification).not.toHaveBeenCalled();

      // It ends without a recovery note: nothing was ever sent about it.
      await prisma().measurement.create({
        data: {
          userId: USER,
          type: "RESTING_HEART_RATE",
          value: 61,
          unit: "bpm",
          source: "OURA",
          measuredAt: new Date(later.getTime() - 10 * 60 * 1000),
        },
      });
      const recovered = await runIntegrationWatchdog({
        mode: "hourly",
        now: new Date(later.getTime() + HOUR),
      });
      expect(recovered.incidentsClosed).toBe(1);
      expect(dispatchNotification).not.toHaveBeenCalled();

      // A new incident after the first pass pages as usual.
      for (let i = 0; i < 3; i++) {
        await recordSyncFailure({
          userId: USER,
          integration: "whoop",
          kind: "transient",
          message: "WHOOP error: 503",
          errorCode: "503",
        });
      }
      expect(dispatchNotification).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a row behind on a first pass that found nothing wrong, so the next pass is not a first one", async () => {
    await prisma().integrationWatch.deleteMany();
    await seedDailyReadings(USER, "OURA", [1, 2, 3], 2);
    await recordSyncSuccess(USER, "oura");
    const first = await runIntegrationWatchdog({ mode: "hourly", now: NOW });
    expect(first.firstRun).toBe(true);
    expect(await prisma().integrationWatch.count()).toBe(1);
    const second = await runIntegrationWatchdog({ mode: "hourly", now: NOW });
    expect(second.firstRun).toBe(false);
  });
});

describe("the ledger and the watchdog page once between them", () => {
  it("does not page a failure streak the watchdog already announced for the connection", async () => {
    await prisma().integrationWatch.create({
      data: {
        userId: USER,
        integration: "oura",
        silentSince: new Date(NOW.getTime() - 3 * DAY),
        incidentReason: "unexpected_silence",
        incidentOpenedAt: new Date(NOW.getTime() - DAY),
        alertedAt: new Date(NOW.getTime() - DAY),
      },
    });
    for (let i = 0; i < 3; i++) {
      await recordSyncFailure({
        userId: USER,
        integration: "oura",
        kind: "transient",
        message: "Oura error: 503",
        errorCode: "503",
      });
    }
    expect(dispatchNotification).not.toHaveBeenCalled();
    const ledger = await prisma().integrationStatus.findUniqueOrThrow({
      where: { userId_integration: { userId: USER, integration: "oura" } },
    });
    expect(ledger.alertedAt).not.toBeNull();
  });
});

describe("many accounts of one provider at once", () => {
  async function silentOuraAccounts(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `user-watchdog-many-${i}`;
      await prisma().user.create({
        data: {
          id,
          username: `wd-many-${i}`,
          email: `many-${i}@example.test`,
          ouraAccessTokenEncrypted: "not-a-real-token",
        },
      });
      await seedDailyReadings(
        id,
        "OURA",
        Array.from({ length: 13 }, (_, d) => d + 3),
        54,
      );
      await recordSyncSuccess(id, "oura");
      ids.push(id);
    }
    return ids;
  }

  it("sends one provider-wide message and one recovery instead of one per account", async () => {
    await prisma().user.update({
      where: { id: USER },
      data: { ouraAccessTokenEncrypted: null },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const ids = await silentOuraAccounts(5);
      const opened = await runIntegrationWatchdog({ mode: "hourly", now: NOW });
      expect(opened.incidentsOpened).toBe(5);
      expect(dispatchedTitles()).toEqual([
        "Oura: 5 connections need attention",
      ]);
      const message = String(
        (
          vi.mocked(dispatchNotification).mock.calls[0]![0] as {
            message: string;
          }
        ).message,
      );
      expect(message).toMatch(
        /^5 silent although they normally deliver every day since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./,
      );
      // Every incident counts as announced: none is paged again.
      expect(
        await prisma().integrationWatch.count({
          where: { integration: "oura", alertedAt: { not: null } },
        }),
      ).toBe(5);
      await runIntegrationWatchdog({
        mode: "hourly",
        now: new Date(NOW.getTime() + HOUR),
      });
      expect(dispatchNotification).toHaveBeenCalledTimes(1);

      // All of them deliver again: one recovery note.
      const later = new Date(NOW.getTime() + 2 * HOUR);
      for (const id of ids) {
        await prisma().measurement.create({
          data: {
            userId: id,
            type: "RESTING_HEART_RATE",
            value: 61,
            unit: "bpm",
            source: "OURA",
            measuredAt: new Date(later.getTime() - 10 * 60 * 1000),
          },
        });
      }
      const closed = await runIntegrationWatchdog({
        mode: "hourly",
        now: later,
      });
      expect(closed.incidentsClosed).toBe(5);
      expect(dispatchedTitles()).toEqual([
        "Oura: 5 connections need attention",
        "Oura recovered for 5 connections",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still sends one message per account up to the threshold", async () => {
    await prisma().user.update({
      where: { id: USER },
      data: { ouraAccessTokenEncrypted: null },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      await silentOuraAccounts(3);
      await runIntegrationWatchdog({ mode: "hourly", now: NOW });
      expect(dispatchedTitles().sort()).toEqual([
        "Oura needs attention for many-0@example.test",
        "Oura needs attention for many-1@example.test",
        "Oura needs attention for many-2@example.test",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recent-call ring", () => {
  it("keeps the newest ten attempts, newest first, without any message text", async () => {
    for (let i = 0; i < 7; i++) {
      await recordSyncFailure({
        userId: USER,
        integration: "oura",
        kind: "transient",
        message: `secret-bearing upstream body ${i}`,
        errorCode: i === 6 ? "token=abc def" : "503",
        leg: "sleep",
      });
    }
    for (let i = 0; i < 5; i++) {
      await recordSyncSuccess(USER, "oura", { leg: "sleep" });
    }
    const row = await prisma().integrationStatus.findUniqueOrThrow({
      where: { userId_integration: { userId: USER, integration: "oura" } },
    });
    const calls = row.recentCalls as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(10);
    expect(calls.slice(0, 5).every((c) => c.status === "ok")).toBe(true);
    expect(calls[5]).toMatchObject({
      endpoint: "sleep",
      status: "transient",
      errorCode: null,
    });
    expect(calls[6]).toMatchObject({ errorCode: "503" });
    expect(JSON.stringify(calls)).not.toContain("secret");

    const health = await loadConnectionHealth(USER, ["oura"]);
    expect(health.oura?.diagnostics.recentCalls).toHaveLength(10);
    expect(JSON.stringify(health.oura)).not.toContain(USER);
  });
});
