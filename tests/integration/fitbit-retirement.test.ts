/**
 * After Google turned the Fitbit Web API off, a Fitbit connection that has
 * gone quiet is the provider's shutdown, not a broken pipe. Against real
 * Postgres: the health read publishes no state for it (so no card or banner
 * asks for a reconnect), the watchdog pages nobody, and the connection row
 * and every imported reading stay.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { recordSyncSuccess } from "@/lib/integrations/status";
import { isFitbitRetired } from "@/lib/fitbit/retirement";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-03T12:00:00.000Z");
const USER = "user-fitbit-retired";
const ADMIN = "user-fitbit-retired-admin";
const prisma = () => getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma());
  await prisma().user.create({
    data: {
      id: ADMIN,
      username: "fr-admin",
      email: "admin@example.test",
      role: "ADMIN",
    },
  });
  await prisma().user.create({
    data: { id: USER, username: "fr-subject", email: "subject@example.test" },
  });
  await prisma().fitbitConnection.create({
    data: {
      userId: USER,
      fitbitUserId: "fb-1",
      accessToken: "not-a-real-token",
      refreshToken: "not-a-real-token",
      tokenExpiresAt: new Date(NOW.getTime() - DAY),
      lastSyncedAt: new Date(NOW.getTime() - 5 * DAY),
    },
  });
  // A fortnight of daily steps that stopped with the turndown.
  await prisma().measurement.createMany({
    data: Array.from({ length: 14 }, (_, i) => ({
      userId: USER,
      type: "ACTIVITY_STEPS" as const,
      value: 8000,
      unit: "count",
      source: "FITBIT" as const,
      measuredAt: new Date(NOW.getTime() - (i + 5) * DAY),
      externalId: `stats:day-${i}`,
    })),
  });
  vi.mocked(dispatchNotification).mockClear();
  // The watchdog has run on this instance before, so it pages on a fresh
  // incident instead of recording what stands.
  await prisma().integrationWatch.create({
    data: { userId: ADMIN, integration: "withings" },
  });
});

describe("Fitbit after the Web API turndown", () => {
  it("still reads as a connection with a health state before the day", async () => {
    await recordSyncSuccess(USER, "fitbit");
    const health = await loadConnectionHealth(USER, ["fitbit"]);
    expect(health.fitbit).not.toBeNull();
  });

  it("publishes no health, pages nobody, and keeps the row and the data", async () => {
    await recordSyncSuccess(USER, "fitbit");
    vi.mocked(isFitbitRetired).mockReturnValue(true);
    try {
      const health = await loadConnectionHealth(USER, ["fitbit"]);
      expect(health.fitbit).toBeNull();

      await runIntegrationWatchdog({ mode: "hourly", now: NOW });
      await runIntegrationWatchdog({ mode: "daily", now: NOW });
      expect(dispatchNotification).not.toHaveBeenCalled();
      const watch = await prisma().integrationWatch.findUnique({
        where: { userId_integration: { userId: USER, integration: "fitbit" } },
      });
      expect(watch?.alertedAt ?? null).toBeNull();
    } finally {
      vi.mocked(isFitbitRetired).mockReturnValue(false);
    }

    expect(
      await prisma().fitbitConnection.count({ where: { userId: USER } }),
    ).toBe(1);
    expect(
      await prisma().measurement.count({
        where: { userId: USER, source: "FITBIT" },
      }),
    ).toBe(14);
  });
});
