import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    withingsConnection: { findUnique: vi.fn(async () => null) },
    whoopConnection: { findUnique: vi.fn(async () => null) },
    fitbitConnection: { findUnique: vi.fn(async () => null) },
    googleHealthConnection: { findUnique: vi.fn(async () => null) },
    moodEntry: { count: vi.fn(async () => 0) },
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
}));

const ledger: Record<string, unknown> = {
  state: "connected",
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastError: null,
};
vi.mock("@/lib/integrations/status", () => ({
  getIntegrationStatus: vi.fn(async (_u: string, integration: string) => ({
    integration,
    ...ledger,
  })),
  getPersistentFailureThreshold: () => 5,
}));

vi.mock("@/lib/withings/client", () => ({ hasActivityScope: () => false }));
vi.mock("@/lib/moodlog-secret", () => ({ readMoodLogSecret: () => null }));

const polarAvailable = vi.fn(async () => true);
const ouraAvailable = vi.fn(async () => false);
vi.mock("@/lib/polar/credentials", () => ({
  getPolarClientCredentials: () => polarAvailable(),
}));
vi.mock("@/lib/oura/credentials", () => ({
  getOuraClientCredentials: () => ouraAvailable(),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";

const userFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const whoopFind = prisma.whoopConnection.findUnique as ReturnType<typeof vi.fn>;

type Entry = {
  integration: string;
  connected?: boolean;
  configured?: boolean;
  available?: boolean;
  hasOwnCredentials?: boolean;
};

async function fetchEntries(): Promise<Entry[]> {
  const res = (await (GET as unknown as () => Promise<{ data: unknown }>)())
    .data as { integrations: Entry[] };
  return res.integrations;
}

describe("/api/integrations/status — Polar/Oura fold (04-M2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    polarAvailable.mockResolvedValue(true);
    ouraAvailable.mockResolvedValue(false);
  });

  it("includes polar + oura entries on the consolidated envelope", async () => {
    userFind.mockResolvedValue({
      polarAccessTokenEncrypted: "tok",
      polarClientIdEncrypted: "id",
      polarClientSecretEncrypted: "sec",
      ouraAccessTokenEncrypted: null,
      ouraClientIdEncrypted: null,
      ouraClientSecretEncrypted: null,
    });

    const entries = await fetchEntries();
    const keys = entries.map((e) => e.integration);
    expect(keys).toEqual(expect.arrayContaining(["polar", "oura"]));

    const polar = entries.find((e) => e.integration === "polar")!;
    expect(polar.connected).toBe(true);
    expect(polar.configured).toBe(true);
    expect(polar.available).toBe(true);
    expect(polar.hasOwnCredentials).toBe(true);

    const oura = entries.find((e) => e.integration === "oura")!;
    expect(oura.connected).toBe(false);
    expect(oura.available).toBe(false);
    expect(oura.hasOwnCredentials).toBe(false);
  });

  it("reports polar disconnected when no access token is stored", async () => {
    userFind.mockResolvedValue({
      polarAccessTokenEncrypted: null,
      polarClientIdEncrypted: null,
      polarClientSecretEncrypted: null,
    });
    const entries = await fetchEntries();
    const polar = entries.find((e) => e.integration === "polar")!;
    expect(polar.connected).toBe(false);
    expect(polar.configured).toBe(false);
  });
});

describe("/api/integrations/status — WHOOP identity ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFind.mockResolvedValue({
      whoopClientIdEncrypted: "id",
      whoopClientSecretEncrypted: "secret",
    });
  });

  it("reports an identity-cleared duplicate row as disconnected", async () => {
    whoopFind.mockResolvedValue({
      whoopUserId: null,
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      lastSyncedAt: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      backfillCompletedAt: null,
    });

    const entries = await fetchEntries();
    const whoop = entries.find((entry) => entry.integration === "whoop");

    expect(whoop?.connected).toBe(false);
    expect(whoop?.configured).toBe(true);
  });
});
