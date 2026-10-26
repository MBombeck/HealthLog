/**
 * A disconnect leaves provider-side state alone while another record still
 * holds the same provider account: Withings webhook subscriptions and the
 * Strava app authorisation belong to the account, not to the record.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, unsubscribeMock, deauthorizeMock } = vi.hoisted(() => ({
  prismaMock: {
    withingsConnection: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
  unsubscribeMock: vi.fn(async () => {}),
  deauthorizeMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));
vi.mock("@/lib/integrations/status", () => ({ markDisconnected: vi.fn() }));
vi.mock("@/lib/withings/client", () => ({
  unsubscribeWebhook: unsubscribeMock,
}));
vi.mock("@/lib/withings/sync", () => ({
  WITHINGS_NOTIFY_APPLIS: [1, 44],
  getWithingsWebhookCallbackUrl: () => "https://app.example/hook",
}));
vi.mock("@/lib/strava/oauth", () => ({
  stravaOAuth: { deauthorize: deauthorizeMock },
}));
vi.mock("@/lib/strava/credentials", () => ({
  STRAVA_DISCONNECTED: { stravaAccessTokenEncrypted: null },
  getStravaConnection: vi.fn(async () => ({ accessToken: "at" })),
}));

import { disconnectOAuth } from "../disconnect";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.withingsConnection.findUnique.mockResolvedValue({
    userId: "profile-1",
    withingsUserId: "wu-1",
    accessToken: "token",
  });
  prismaMock.user.findUnique.mockResolvedValue({ stravaAthleteId: "42" });
});

describe("disconnectOAuth with a shared provider account", () => {
  it("keeps the Withings subscriptions while another record holds the account", async () => {
    prismaMock.withingsConnection.findMany.mockResolvedValue([
      { userId: "guardian-1" },
    ]);
    await expect(disconnectOAuth("withings", "profile-1")).resolves.toBe(
      "disconnected",
    );
    expect(prismaMock.withingsConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { withingsUserId: "wu-1", userId: { not: "profile-1" } },
      }),
    );
    expect(unsubscribeMock).not.toHaveBeenCalled();
    expect(prismaMock.withingsConnection.delete).toHaveBeenCalled();
  });

  it("unsubscribes every category when no other record holds the account", async () => {
    prismaMock.withingsConnection.findMany.mockResolvedValue([]);
    await disconnectOAuth("withings", "profile-1");
    expect(unsubscribeMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the Strava authorisation while another record holds the athlete", async () => {
    prismaMock.user.findMany.mockResolvedValue([{ id: "guardian-1" }]);
    await disconnectOAuth("strava", "profile-1");
    expect(deauthorizeMock).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it("deauthorises Strava when the athlete is held nowhere else", async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    await disconnectOAuth("strava", "profile-1");
    expect(deauthorizeMock).toHaveBeenCalledWith("at");
  });
});
