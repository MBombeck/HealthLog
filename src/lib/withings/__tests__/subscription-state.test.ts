import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as IntegrationStatusModule from "@/lib/integrations/status";
import type * as MeasurementRollupsModule from "@/lib/rollups/measurement-rollups";

const eventMock = vi.hoisted(() => ({
  addMeta: vi.fn(),
  addWarning: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    withingsConnection: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((value: string) => value),
  encrypt: vi.fn((value: string) => value),
}));

vi.mock("../client", () => ({
  fetchMeasurements: vi.fn(),
  refreshAccessToken: vi.fn(),
  subscribeWebhook: vi.fn(),
}));

vi.mock("../credentials", () => ({
  getUserWithingsCredentials: vi.fn(async () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
  })),
}));

vi.mock("@/lib/integrations/status", async () => {
  const actual = await vi.importActual<typeof IntegrationStatusModule>(
    "@/lib/integrations/status",
  );
  return {
    ...actual,
    isReauthRequired: vi.fn().mockResolvedValue(false),
    recordSyncFailure: vi.fn().mockResolvedValue(undefined),
    recordSyncSuccess: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<typeof MeasurementRollupsModule>(
    "@/lib/rollups/measurement-rollups",
  );
  return {
    ...actual,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => eventMock),
  annotate: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { subscribeWebhook } from "../client";
import { WithingsApiError } from "../response-classifier";
import {
  WITHINGS_NOTIFY_APPLIS,
  WITHINGS_SUBSCRIPTION_BASE_RETRY_MS,
  parseWithingsWebhookSubscriptionState,
  retryDueWithingsWebhookSubscriptions,
  setupWebhook,
} from "../sync";

const NOW = new Date("2026-07-21T10:00:00.000Z");

function connection(subscriptionState: unknown = null) {
  return {
    id: "connection-1",
    userId: "user-1",
    withingsUserId: "withings-user-1",
    accessToken: "encrypted-access-token",
    refreshToken: "encrypted-refresh-token",
    tokenExpiresAt: new Date("2099-07-21T12:00:00.000Z"),
    webhookSubscriptionState: subscriptionState,
  };
}

function persistedState() {
  const calls = vi.mocked(prisma.withingsConnection.update).mock.calls;
  const data = calls.at(-1)?.[0].data as {
    webhookSubscriptionState: unknown;
    webhookSubscriptionRetryAt: Date | null;
  };
  return data;
}

function stateWithTransientCategory(nextRetryAt: string) {
  return {
    version: 1,
    outcomes: Object.fromEntries(
      WITHINGS_NOTIFY_APPLIS.map((appli) => [
        String(appli),
        appli === 2
          ? {
              status: "transient",
              attemptCount: 1,
              lastAttemptAt: NOW.toISOString(),
              nextRetryAt,
              withingsStatus: 2554,
            }
          : {
              status: "success",
              attemptCount: 1,
              lastAttemptAt: NOW.toISOString(),
              nextRetryAt: null,
              withingsStatus: null,
            },
      ]),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation(async (run) =>
    run(prisma as never),
  );
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
    connection() as never,
  );
  vi.mocked(prisma.withingsConnection.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.withingsConnection.update).mockResolvedValue({} as never);
  vi.mocked(subscribeWebhook).mockResolvedValue(undefined);
});

describe("Withings webhook subscription durability", () => {
  it("persists every category outcome when one subscription fails transiently", async () => {
    vi.mocked(subscribeWebhook).mockImplementation(
      async (_token, _url, appli) => {
        if (appli === 2) {
          throw new WithingsApiError({
            verb: "subscribe",
            classification: "transient",
            withingsStatus: 2554,
            reason: "withings_2554",
            upstreamError: "credential=must-not-be-logged",
          });
        }
      },
    );

    await setupWebhook("user-1", NOW);

    expect(subscribeWebhook).toHaveBeenCalledTimes(
      WITHINGS_NOTIFY_APPLIS.length,
    );
    expect(prisma.withingsConnection.update).toHaveBeenCalledTimes(
      WITHINGS_NOTIFY_APPLIS.length,
    );

    const persisted = persistedState();
    const state = parseWithingsWebhookSubscriptionState(
      persisted.webhookSubscriptionState,
      NOW,
    );
    expect(state.outcomes["1"].status).toBe("success");
    expect(state.outcomes["2"]).toMatchObject({
      status: "transient",
      attemptCount: 1,
      withingsStatus: 2554,
    });
    expect(state.outcomes["4"].status).toBe("success");
    expect(state.outcomes["16"].status).toBe("success");
    expect(state.outcomes["44"].status).toBe("success");
    expect(persisted.webhookSubscriptionRetryAt?.toISOString()).toBe(
      new Date(
        NOW.getTime() + WITHINGS_SUBSCRIPTION_BASE_RETRY_MS,
      ).toISOString(),
    );
    expect(eventMock.addWarning).not.toHaveBeenCalledWith(
      expect.stringContaining("must-not-be-logged"),
    );
  });

  it.each([
    { classification: "persistent" as const, withingsStatus: 293 },
    { classification: "reauth_required" as const, withingsStatus: 401 },
  ])(
    "persists $classification failures without scheduling a hot-loop retry",
    async ({ classification, withingsStatus }) => {
      vi.mocked(subscribeWebhook).mockImplementation(
        async (_token, _url, appli) => {
          if (appli === 2) {
            throw new WithingsApiError({
              verb: "subscribe",
              classification,
              withingsStatus,
              reason: `withings_${withingsStatus}`,
            });
          }
        },
      );

      await setupWebhook("user-1", NOW);

      const persisted = persistedState();
      const state = parseWithingsWebhookSubscriptionState(
        persisted.webhookSubscriptionState,
        NOW,
      );
      expect(state.outcomes["2"]).toMatchObject({
        status: classification,
        withingsStatus,
      });
      expect(persisted.webhookSubscriptionRetryAt).toBeNull();
    },
  );

  it("validates untrusted JSON and replaces an invalid versioned payload with pending outcomes", () => {
    const parsed = parseWithingsWebhookSubscriptionState(
      {
        version: 1,
        outcomes: {
          "1": {
            status: "success",
            attemptCount: -4,
            lastAttemptAt: "not-a-date",
          },
        },
      },
      NOW,
    );

    for (const appli of WITHINGS_NOTIFY_APPLIS) {
      expect(parsed.outcomes[`${appli}`].status).toBe("pending");
    }
  });

  it("the hourly retry selects only due connections and retries only their due transient category", async () => {
    const dueAt = new Date(NOW.getTime() - 1).toISOString();
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValue([
      { userId: "user-1" },
    ] as never);
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
      connection(stateWithTransientCategory(dueAt)) as never,
    );

    await retryDueWithingsWebhookSubscriptions(NOW);

    expect(prisma.withingsConnection.findMany).toHaveBeenCalledWith({
      where: { webhookSubscriptionRetryAt: { lte: NOW } },
      select: { userId: true },
    });
    expect(subscribeWebhook).toHaveBeenCalledTimes(1);
    expect(subscribeWebhook).toHaveBeenCalledWith(
      "encrypted-access-token",
      expect.any(String),
      2,
    );

    const state = parseWithingsWebhookSubscriptionState(
      persistedState().webhookSubscriptionState,
      NOW,
    );
    expect(state.outcomes["1"].attemptCount).toBe(1);
    expect(state.outcomes["1"].status).toBe("success");
    expect(state.outcomes["2"].attemptCount).toBe(2);
    expect(state.outcomes["2"].status).toBe("success");
    expect(persistedState().webhookSubscriptionRetryAt).toBeNull();
  });

  it("does not retry successful or not-yet-due categories", async () => {
    const futureRetryAt = new Date(NOW.getTime() + 60_000).toISOString();
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValue([
      { userId: "user-1" },
    ] as never);
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(
      connection(stateWithTransientCategory(futureRetryAt)) as never,
    );

    await retryDueWithingsWebhookSubscriptions(NOW);

    expect(subscribeWebhook).not.toHaveBeenCalled();
    expect(prisma.withingsConnection.update).not.toHaveBeenCalled();
  });
});
