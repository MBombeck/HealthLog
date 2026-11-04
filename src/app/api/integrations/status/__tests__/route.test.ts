import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/integrations/connection-health-load", () => ({
  loadConnectionHealth: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    withingsConnection: { findUnique: vi.fn(async () => null) },
    whoopConnection: { findUnique: vi.fn(async () => null) },
    fitbitConnection: { findUnique: vi.fn(async () => null) },
    googleHealthConnection: { findUnique: vi.fn(async () => null) },
    moodEntry: { count: vi.fn(async () => 0) },
    measurement: { findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    workout: { groupBy: vi.fn(async () => []) },
  },
}));

// v1.42 — the per-source type walk that replaced the measurement groupBy.
vi.mock("@/lib/measurements/live-types", () => ({
  listLiveMeasurementTypes: vi.fn(async () => []),
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
  failingSince: null,
};
vi.mock("@/lib/integrations/status", () => ({
  getIntegrationStatus: vi.fn(async (_u: string, integration: string) => ({
    integration,
    ...(perIntegrationLedger[integration] ?? ledger),
  })),
  getPersistentFailureThreshold: () => 5,
}));
const perIntegrationLedger: Record<string, Record<string, unknown>> = {};

vi.mock("@/lib/withings/client", () => ({ hasActivityScope: () => false }));

const polarAvailable = vi.fn(async () => true);
const ouraAvailable = vi.fn(async () => false);
vi.mock("@/lib/polar/credentials", () => ({
  getPolarClientCredentials: () => polarAvailable(),
}));
vi.mock("@/lib/oura/credentials", async () => ({
  readOuraScopeDenied: (
    await vi.importActual<typeof import("@/lib/oura/credentials")>(
      "@/lib/oura/credentials",
    )
  ).readOuraScopeDenied,
  getOuraClientCredentials: () => ouraAvailable(),
}));

import { GET } from "../route";
import { isFitbitRetired } from "@/lib/fitbit/retirement";
import { prisma } from "@/lib/db";
import { listLiveMeasurementTypes } from "@/lib/measurements/live-types";
import { ATTEMPT_STALE_AFTER_MS } from "@/lib/integrations/sync-verdict";

const userFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const whoopFind = prisma.whoopConnection.findUnique as ReturnType<typeof vi.fn>;

type Entry = {
  integration: string;
  state?: string;
  connected?: boolean;
  configured?: boolean;
  available?: boolean;
  hasOwnCredentials?: boolean;
  hasToken?: boolean;
  allowPrivateHost?: boolean;
  syncHealth?: { verdict: string; since: string | null };
  metricFreshness?: Array<{ type: string; lastSeenAt: string; stale: boolean }>;
};

async function fetchEnvelope(): Promise<{
  integrations: Entry[];
  metricFreshnessDegraded: boolean;
}> {
  return (await (GET as unknown as () => Promise<{ data: unknown }>)())
    .data as {
    integrations: Entry[];
    metricFreshnessDegraded: boolean;
  };
}

async function fetchEntries(): Promise<Entry[]> {
  return (await fetchEnvelope()).integrations;
}

describe("/api/integrations/status — Polar/Oura fold (04-M2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(perIntegrationLedger)) {
      delete perIntegrationLedger[key];
    }
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

/**
 * The envelope is the unit of coverage for liveness. Every entry carries the
 * verdict, whether or not a card renders it — a card-level verdict misses a
 * card-less provider by construction, which is exactly how a month-dead sync
 * stayed invisible.
 */
describe("/api/integrations/status — sync-health verdict on every entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(perIntegrationLedger)) {
      delete perIntegrationLedger[key];
    }
    polarAvailable.mockResolvedValue(true);
    ouraAvailable.mockResolvedValue(true);
  });

  it("carries a syncHealth verdict on every entry", async () => {
    userFind.mockResolvedValue({});
    const entries = await fetchEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.syncHealth, entry.integration).toBeDefined();
      expect(typeof entry.syncHealth!.verdict).toBe("string");
      expect(Array.isArray(entry.metricFreshness)).toBe(true);
    }
  });

  it("reports a configured, month-silent provider as stalled", async () => {
    // The class the verdict exists for: the ledger state has been frozen
    // since the last write, so only the age of `lastAttemptAt` can say the
    // sync has stopped attempting.
    const lastAttemptAt = new Date(
      Date.now() - 28 * 24 * 60 * 60 * 1000,
    ).toISOString();
    perIntegrationLedger.nightscout = {
      state: "error_transient",
      lastSuccessAt: new Date(
        Date.now() - 55 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      lastAttemptAt,
      lastError: null,
    };
    userFind.mockResolvedValue({ nightscoutUrlEncrypted: "enc" });

    const nightscout = (await fetchEntries()).find(
      (entry) => entry.integration === "nightscout",
    )!;
    expect(nightscout.configured).toBe(true);
    expect(nightscout.syncHealth).toEqual({
      verdict: "stalled",
      since: lastAttemptAt,
    });
  });

  it("keeps an integration that attempted within the window off the stalled arm", async () => {
    perIntegrationLedger.nightscout = {
      state: "error_transient",
      lastSuccessAt: null,
      lastAttemptAt: new Date(
        Date.now() - (ATTEMPT_STALE_AFTER_MS - 60_000),
      ).toISOString(),
      lastError: null,
    };
    userFind.mockResolvedValue({ nightscoutUrlEncrypted: "enc" });

    const nightscout = (await fetchEntries()).find(
      (entry) => entry.integration === "nightscout",
    )!;
    expect(nightscout.syncHealth!.verdict).toBe("failing");
  });

  it("includes a nightscout entry with the fields the card's form reads", async () => {
    userFind.mockResolvedValue({
      nightscoutUrlEncrypted: "enc",
      nightscoutTokenEncrypted: "enc",
      nightscoutAllowPrivateHost: true,
    });

    const nightscout = (await fetchEntries()).find(
      (entry) => entry.integration === "nightscout",
    );
    expect(nightscout).toBeDefined();
    expect(nightscout!.connected).toBe(true);
    expect(nightscout!.configured).toBe(true);
    expect(nightscout!.hasToken).toBe(true);
    expect(nightscout!.allowPrivateHost).toBe(true);
    expect(nightscout!.syncHealth).toBeDefined();
  });
});

describe("/api/integrations/status — a provider that has delivered nothing for weeks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(perIntegrationLedger)) {
      delete perIntegrationLedger[key];
    }
    userFind.mockResolvedValue({});
    whoopFind.mockResolvedValue(null);
    polarAvailable.mockResolvedValue(true);
    ouraAvailable.mockResolvedValue(false);
  });

  it("reports it as failing and dates the verdict from the streak, not the retry", async () => {
    const failingSince = new Date(
      Date.now() - 17 * 24 * 60 * 60 * 1000,
    ).toISOString();
    perIntegrationLedger.nightscout = {
      state: "error_transient",
      // The hourly cron is still running and a sibling leg can still stamp a
      // success, so neither of these tells the user anything.
      lastSuccessAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      lastAttemptAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      failingSince,
      lastError: "Nightscout sync HTTP 502",
    };
    userFind.mockResolvedValue({ nightscoutUrlEncrypted: "enc" });

    const nightscout = (await fetchEntries()).find(
      (entry) => entry.integration === "nightscout",
    )!;
    expect(nightscout.syncHealth).toEqual({
      verdict: "failing",
      since: failingSince,
    });
  });
});

/**
 * The freshness read is fail-soft, and it used to be fail-silent with it.
 *
 * `getSourceMetricFreshness` is one query for all eight providers, wrapped in a
 * `.catch(() => ({}))` so a groupBy hiccup never 500s the whole settings
 * surface. The fallback makes every entry's `metricFreshness` an empty array —
 * which is byte-identical to what a user with nothing recorded sees. So the
 * honesty signal built to say "this metric has gone quiet" answered "nothing
 * has gone quiet" when it had in fact failed to look.
 *
 * `metricFreshnessDegraded` separates the two. It stays a flag rather than a
 * nullable array per entry because the query fails for all eight providers at
 * once or for none of them.
 */
describe("/api/integrations/status — the freshness read failed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(perIntegrationLedger)) {
      delete perIntegrationLedger[key];
    }
    userFind.mockResolvedValue({});
    whoopFind.mockResolvedValue(null);
    polarAvailable.mockResolvedValue(true);
    ouraAvailable.mockResolvedValue(false);
  });

  it("reports the degradation instead of passing an empty list off as an answer", async () => {
    vi.mocked(listLiveMeasurementTypes).mockRejectedValue(
      new Error("statement timeout"),
    );

    const envelope = await fetchEnvelope();

    expect(envelope.metricFreshnessDegraded).toBe(true);
    // Still fail-soft: the rest of the envelope survives, all eight entries
    // present, because a freshness hiccup is never worth the settings surface.
    expect(envelope.integrations).toHaveLength(10);
    for (const entry of envelope.integrations) {
      expect(entry.metricFreshness).toEqual([]);
    }
  });

  it("reports no degradation when the read simply found nothing", async () => {
    vi.mocked(listLiveMeasurementTypes).mockResolvedValue([]);
    (prisma.workout.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const envelope = await fetchEnvelope();

    // The same empty lists as above, and this is the case they honestly mean.
    expect(envelope.metricFreshnessDegraded).toBe(false);
    for (const entry of envelope.integrations) {
      expect(entry.metricFreshness).toEqual([]);
    }
  });
});

/**
 * v1.38.19 — the never-connected provider on the wire.
 *
 * The ledger's synthetic "no row" snapshot reads `unknown`, and the envelope
 * publishes it verbatim. A client that reads `state` must see a value that
 * cannot be mistaken for a live connection, while `syncHealth.verdict` keeps
 * saying `disconnected` for the same entry.
 */
describe("/api/integrations/status — a provider with no ledger row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(perIntegrationLedger)) {
      delete perIntegrationLedger[key];
    }
    polarAvailable.mockResolvedValue(true);
    ouraAvailable.mockResolvedValue(false);
  });

  it("publishes state unknown beside connected false and a disconnected verdict", async () => {
    perIntegrationLedger.whoop = {
      state: "unknown",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      failingSince: null,
    };
    userFind.mockResolvedValue({});
    whoopFind.mockResolvedValue(null);

    const whoop = (await fetchEntries()).find(
      (e) => e.integration === "whoop",
    )!;
    expect(whoop.state).toBe("unknown");
    expect(whoop.connected).toBe(false);
    expect(whoop.syncHealth?.verdict).toBe("disconnected");
  });
});

describe("/api/integrations/status — what a provider withholds by contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the readings the Withings plan withholds and the Oura collections the grant lacks", async () => {
    (
      prisma.withingsConnection.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      lastSyncedAt: null,
      createdAt: new Date(),
      scope: "user.metrics,user.activity",
      apiPlanState: {
        version: 1,
        measures: {
          unavailable: [155, 54],
          checkedAt: new Date().toISOString(),
        },
        ecg: { unavailable: ["heart"], checkedAt: new Date().toISOString() },
      },
    });
    userFind.mockResolvedValue({
      ouraAccessTokenEncrypted: "tok",
      ouraScopeDenied: ["resilience", "spo2", "not_a_collection"],
    });

    const entries = (await fetchEntries()) as Array<
      Entry & { planUnavailable?: string[]; scopeReconnect?: string[] }
    >;
    const withings = entries.find((e) => e.integration === "withings")!;
    const oura = entries.find((e) => e.integration === "oura")!;

    expect(withings.planUnavailable).toEqual(["spo2", "vascularAge", "ecg"]);
    expect(oura.scopeReconnect).toEqual(["spo2", "resilience"]);
  });

  it("publishes empty lists when nothing is withheld", async () => {
    userFind.mockResolvedValue({ ouraAccessTokenEncrypted: "tok" });

    const entries = (await fetchEntries()) as Array<
      Entry & { planUnavailable?: string[]; scopeReconnect?: string[] }
    >;
    expect(
      entries.find((e) => e.integration === "withings")!.planUnavailable,
    ).toEqual([]);
    expect(
      entries.find((e) => e.integration === "oura")!.scopeReconnect,
    ).toEqual([]);
  });
});

describe("/api/integrations/status — the unified connection health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(perIntegrationLedger)) {
      delete perIntegrationLedger[key];
    }
  });

  it("puts each provider's resolved health on its own entry, null where not connected", async () => {
    const { loadConnectionHealth } =
      await import("@/lib/integrations/connection-health-load");
    const ouraHealth = { state: "limited", reason: "permission_limited" };
    vi.mocked(loadConnectionHealth).mockResolvedValueOnce({
      withings: null,
      whoop: null,
      fitbit: null,
      "google-health": null,
      polar: null,
      oura: ouraHealth,
      strava: null,
      nightscout: null,
      dawarich: null,
      garmin: null,
      "apple-health": null,
    } as never);
    userFind.mockResolvedValue({ ouraAccessTokenEncrypted: "tok" });

    const entries = (await fetchEntries()) as Array<
      Entry & { health?: unknown }
    >;
    expect(entries.find((e) => e.integration === "oura")?.health).toEqual(
      ouraHealth,
    );
    for (const entry of entries.filter((e) => e.integration !== "oura")) {
      expect(entry.health).toBeNull();
    }
  });
});

describe("/api/integrations/status — one round of reads", () => {
  it("asks for the connection health and the freshness without waiting on the provider rows", async () => {
    userFind.mockResolvedValue({});
    // Hold the user row back: under the old shape nothing else was asked
    // until it (and the rest of the first round) had answered.
    let release: (row: unknown) => void = () => {};
    userFind.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const { loadConnectionHealth } =
      await import("@/lib/integrations/connection-health-load");

    const pending = fetchEnvelope();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadConnectionHealth).toHaveBeenCalledTimes(1);
    expect(listLiveMeasurementTypes).toHaveBeenCalled();
    release({});
    const envelope = await pending;
    expect(envelope.integrations.length).toBeGreaterThan(0);
  });
});

describe("/api/integrations/status — the Fitbit card after the turndown", () => {
  const fitbitFind = prisma.fitbitConnection.findUnique as ReturnType<
    typeof vi.fn
  >;
  const fitbitDataFind = prisma.measurement.findFirst as ReturnType<
    typeof vi.fn
  >;
  const offered = async () =>
    (
      (await fetchEntries()).find((e) => e.integration === "fitbit") as {
        retirement?: { ended: boolean; offered: boolean };
      }
    ).retirement;

  beforeEach(() => {
    vi.clearAllMocks();
    userFind.mockResolvedValue({});
    fitbitFind.mockResolvedValue(null);
    fitbitDataFind.mockResolvedValue(null);
    // The suites run before the turndown by default (`vitest.setup.ts`).
    vi.mocked(isFitbitRetired).mockReturnValue(true);
  });
  afterEach(() => {
    vi.mocked(isFitbitRetired).mockReturnValue(false);
  });

  it("is not offered to an account that never had Fitbit", async () => {
    expect(await offered()).toMatchObject({ ended: true, offered: false });
    expect(fitbitDataFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "u1", source: "FITBIT" }),
      }),
    );
  });

  it("stays, with its notice, for an account holding Fitbit data", async () => {
    fitbitDataFind.mockResolvedValue({ id: "m1" });
    expect(await offered()).toMatchObject({ ended: true, offered: true });
  });

  it("stays for an account still holding its Fitbit connection", async () => {
    fitbitFind.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      tokenExpiresAt: new Date("2026-11-01T00:00:00.000Z"),
      lastSyncedAt: null,
      backfillCompletedAt: null,
    });
    expect(await offered()).toMatchObject({ ended: true, offered: true });
    expect(fitbitDataFind).not.toHaveBeenCalled();
  });

  it("is offered to everyone before the turndown", async () => {
    vi.mocked(isFitbitRetired).mockReturnValue(false);
    expect(await offered()).toMatchObject({ ended: false, offered: true });
    expect(fitbitDataFind).not.toHaveBeenCalled();
  });
});
