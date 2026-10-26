/**
 * Gather what `resolveConnectionHealth` needs, for one account, in one place.
 *
 * Every surface that publishes a connection's health (the consolidated
 * integrations envelope, the per-provider status routes, the Apple Health
 * config read, the watchdog) calls this loader, so the four states cannot
 * drift into one opinion per route. It reads:
 *
 *   - the sync ledger rows (state, streak, failing legs, recent calls),
 *   - which connections exist and the provider-side extras that bear on
 *     health (Withings plan + activity scope, Oura scope gaps, Google Health
 *     `needsReauth`),
 *   - the watchdog's silence flags,
 *   - the newest data per connected source (one index probe each).
 *
 * Read-only. A connection that does not exist resolves to null.
 */
import { BACKFILL_LEDGER_PREFIX } from "./healthkit-type-sync";
import { prisma } from "@/lib/db";
import type { MeasurementSource } from "@/generated/prisma/client";
import type { IntegrationKey } from "./status";
import {
  INTEGRATION_CADENCE,
  PUSH_CADENCE,
  resolveSyncVerdict,
  type SyncHealth,
} from "./sync-verdict";
import {
  CONNECTION_KEYS,
  RECENT_CALLS_LIMIT,
  readRecentCalls,
  resolveConnectionHealth,
  type ConnectionHealth,
  type ConnectionKey,
  type RecentCall,
} from "./connection-health";
import { SOURCE_PROFILES } from "./watchdog-classify";
import {
  INTEGRATION_MEASUREMENT_SOURCE,
  INTEGRATION_WORKOUT_SOURCE,
} from "./metric-freshness";
import { parseWithingsApiPlanState } from "@/lib/withings/api-plan";
import { withingsPlanUnavailableFeatures } from "@/lib/withings/plan-features";
import { hasActivityScope } from "@/lib/withings/oauth";
import { readOuraScopeDenied } from "@/lib/oura/credentials";
import { ouraScopeReconnectList } from "@/lib/oura/scope";
import { localDayWindow } from "@/lib/tz/local-day";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { isFitbitRetired } from "@/lib/fitbit/retirement";

export type ConnectionHealthMap = Record<
  ConnectionKey,
  ConnectionHealth | null
>;

/** Everything the loader read for one connection, beside the resolved health. */
export interface ConnectionFacts {
  key: ConnectionKey;
  connected: boolean;
  syncHealth: SyncHealth;
  lastDataAt: Date | null;
  /** The sync ledger holds an unresolved operator page for this streak. */
  ledgerAlerted: boolean;
  /** Health resolved WITHOUT the watchdog's silence flag (the watchdog's own input). */
  healthWithoutSilence: ConnectionHealth | null;
  /** Health as published (silence flag folded in). */
  health: ConnectionHealth | null;
  silentSince: Date | null;
}

interface LedgerRow {
  integration: string;
  state: string;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  failingSinceAt: Date | null;
  failingLegs: unknown;
  recentCalls: unknown;
  alertedAt: Date | null;
}

/** Newest measurement of one source: one probe on `(userId, source, measuredAt DESC)`. */
async function newestMeasurementAt(
  userId: string,
  source: MeasurementSource,
): Promise<Date | null> {
  const row = await prisma.measurement.findFirst({
    where: { userId, source, deletedAt: null },
    orderBy: { measuredAt: "desc" },
    select: { measuredAt: true },
  });
  return row?.measuredAt ?? null;
}

async function newestWorkoutAt(
  userId: string,
  source: MeasurementSource,
): Promise<Date | null> {
  const row = await prisma.workout.findFirst({
    where: { userId, source },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  return row?.startedAt ?? null;
}

/**
 * Dawarich stores days, not readings: its newest data is the start of the
 * newest stored day, in the account's zone.
 */
async function newestDawarichDayAt(userId: string): Promise<Date | null> {
  const row = await prisma.dawarichDay.findFirst({
    where: { userId },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (!row) return null;
  return localDayWindow(row.date, await resolveUserTimezone(userId)).dayStart;
}

function newestOf(...values: Array<Date | null | undefined>): Date | null {
  let max: Date | null = null;
  for (const v of values) {
    if (v && (max === null || v.getTime() > max.getTime())) max = v;
  }
  return max;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function readLegs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is string =>
      typeof v === "string" && /^[A-Za-z0-9_.:-]{1,48}$/.test(v),
  );
}

/**
 * Load the facts and resolved health for every connection key of one account.
 * `keys` narrows the work for a single-provider route.
 */
export async function loadConnectionFacts(
  userId: string,
  keys: readonly ConnectionKey[] = CONNECTION_KEYS,
  now: Date = new Date(),
): Promise<Map<ConnectionKey, ConnectionFacts>> {
  const wanted = new Set(keys);
  const [
    ledgerRows,
    watchRows,
    dbUser,
    withingsConn,
    whoopConn,
    fitbitConn,
    googleHealthConn,
    healthKitArrivals,
  ] = await Promise.all([
    prisma.integrationStatus.findMany({
      where: { userId },
      select: {
        integration: true,
        state: true,
        lastSuccessAt: true,
        lastAttemptAt: true,
        failingSinceAt: true,
        failingLegs: true,
        recentCalls: true,
        alertedAt: true,
      },
    }),
    prisma.integrationWatch.findMany({
      where: { userId },
      select: { integration: true, silentSince: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        polarAccessTokenEncrypted: true,
        ouraAccessTokenEncrypted: true,
        ouraScopeDenied: true,
        stravaAccessTokenEncrypted: true,
        nightscoutUrlEncrypted: true,
        dawarichUrlEncrypted: true,
        healthKitLastSyncedAt: true,
      },
    }),
    wanted.has("withings")
      ? prisma.withingsConnection.findUnique({
          where: { userId },
          select: { lastSyncedAt: true, scope: true, apiPlanState: true },
        })
      : null,
    wanted.has("whoop")
      ? prisma.whoopConnection.findUnique({
          where: { userId },
          select: { lastSyncedAt: true, whoopUserId: true },
        })
      : null,
    wanted.has("fitbit")
      ? prisma.fitbitConnection.findUnique({
          where: { userId },
          select: { lastSyncedAt: true },
        })
      : null,
    wanted.has("google-health")
      ? prisma.googleHealthConnection.findUnique({
          where: { userId },
          select: { lastSyncedAt: true, needsReauth: true },
        })
      : null,
    wanted.has("apple-health")
      ? prisma.healthKitTypeSync.findMany({
          // A backfill's own ledger row is a catch-up, not a live arrival,
          // and must not make the connection look alive (ios #77).
          where: {
            userId,
            NOT: { type: { startsWith: BACKFILL_LEDGER_PREFIX } },
          },
          select: { type: true, lastReceivedAt: true, lastNewSampleAt: true },
          orderBy: { lastReceivedAt: "desc" },
        })
      : [],
  ]);

  const ledger = new Map<string, LedgerRow>(
    ledgerRows.map((row) => [row.integration, row]),
  );
  const silence = new Map<string, Date | null>(
    watchRows.map((row) => [row.integration, row.silentSince]),
  );

  const connected: Record<ConnectionKey, boolean> = {
    withings: !!withingsConn,
    whoop: !!whoopConn?.whoopUserId,
    // Once Google has turned the Fitbit Web API off the row stays (it carries
    // the imported history) but nothing will sync through it: no health to
    // judge and nothing for the watchdog to call silent.
    fitbit: !!fitbitConn && !isFitbitRetired(now),
    "google-health": !!googleHealthConn,
    polar: !!dbUser?.polarAccessTokenEncrypted,
    oura: !!dbUser?.ouraAccessTokenEncrypted,
    strava: !!dbUser?.stravaAccessTokenEncrypted,
    nightscout: !!dbUser?.nightscoutUrlEncrypted,
    dawarich: !!dbUser?.dawarichUrlEncrypted,
    // Apple Health has nothing to connect; it is "connected" once the phone
    // has delivered anything (a live batch, or rows from the export import).
    "apple-health": false,
  };
  const legacyLastSyncedAt: Partial<Record<ConnectionKey, Date | null>> = {
    withings: withingsConn?.lastSyncedAt ?? null,
    whoop: whoopConn?.whoopUserId ? (whoopConn.lastSyncedAt ?? null) : null,
    fitbit: fitbitConn?.lastSyncedAt ?? null,
    "google-health": googleHealthConn?.lastSyncedAt ?? null,
  };

  // Newest data per wanted, connected source. Apple Health is probed even
  // before it counts as connected, because delivered data is what connects it.
  const lastData = new Map<ConnectionKey, Date | null>();
  await Promise.all(
    [...wanted].map(async (key) => {
      if (key === "apple-health") {
        const measured = await newestMeasurementAt(userId, "APPLE_HEALTH");
        lastData.set(key, measured);
        return;
      }
      if (!connected[key]) return;
      if (key === "dawarich") {
        lastData.set(key, await newestDawarichDayAt(userId));
        return;
      }
      const mSource = INTEGRATION_MEASUREMENT_SOURCE[key as IntegrationKey];
      const wSource = INTEGRATION_WORKOUT_SOURCE[key as IntegrationKey];
      const [m, w] = await Promise.all([
        mSource ? newestMeasurementAt(userId, mSource) : null,
        wSource ? newestWorkoutAt(userId, wSource) : null,
      ]);
      lastData.set(key, newestOf(m, w));
    }),
  );

  const out = new Map<ConnectionKey, ConnectionFacts>();
  const nowMs = now.getTime();

  for (const key of keys) {
    if (key === "apple-health") {
      out.set(
        key,
        appleHealthFacts({
          lastSyncedAt: dbUser?.healthKitLastSyncedAt ?? null,
          arrivals: healthKitArrivals,
          newestMeasuredAt: lastData.get("apple-health") ?? null,
          silentSince: silence.get(key) ?? null,
          now,
        }),
      );
      continue;
    }

    const row = ledger.get(key);
    const isConnected = connected[key];
    const syncHealth = resolveSyncVerdict({
      connected: isConnected,
      configured: isConnected,
      state: row?.state ?? "unknown",
      lastSuccessAt: row?.lastSuccessAt ?? null,
      lastAttemptAt: row?.lastAttemptAt ?? null,
      failingSinceAt: row?.failingSinceAt ?? null,
      legacyLastSyncedAt: legacyLastSyncedAt[key] ?? null,
      cadence: INTEGRATION_CADENCE[key],
      now: nowMs,
    });

    let planUnavailable: string[] = [];
    let permissionUnavailable: string[] = [];
    if (key === "withings" && withingsConn) {
      planUnavailable = withingsPlanUnavailableFeatures(
        parseWithingsApiPlanState(withingsConn.apiPlanState),
      );
      // A connection whose grant predates the activity scope cannot read
      // activity or sleep; one reconnect asks for it. A null scope is the
      // same legacy case `hasActivityScope` already treats as missing.
      if (!hasActivityScope(withingsConn.scope ?? null)) {
        permissionUnavailable = ["activity", "sleep"];
      }
    }
    if (key === "oura" && isConnected) {
      permissionUnavailable = ouraScopeReconnectList(
        readOuraScopeDenied(dbUser?.ouraScopeDenied),
      );
    }

    const lastDataAt = lastData.get(key) ?? null;
    const silentSince = silence.get(key) ?? null;
    const common = {
      syncHealth,
      connected: isConnected,
      ledgerState: row?.state ?? null,
      lastSuccessAt: iso(row?.lastSuccessAt ?? legacyLastSyncedAt[key] ?? null),
      lastAttemptAt: iso(row?.lastAttemptAt),
      failingSince: iso(row?.failingSinceAt),
      failingLegs: readLegs(row?.failingLegs),
      recentCalls: readRecentCalls(row?.recentCalls),
      lastDataAt: iso(lastDataAt),
      needsReauth: key === "google-health" && !!googleHealthConn?.needsReauth,
      planUnavailable,
      permissionUnavailable,
      silenceWindowMs: SOURCE_PROFILES[key].silenceWindowMs,
      now: nowMs,
    };
    out.set(key, {
      key,
      connected: isConnected,
      syncHealth,
      lastDataAt,
      ledgerAlerted: row?.alertedAt != null,
      healthWithoutSilence: resolveConnectionHealth({
        ...common,
        silentSince: null,
      }),
      health: resolveConnectionHealth({
        ...common,
        silentSince: iso(silentSince),
      }),
      silentSince,
    });
  }
  return out;
}

function appleHealthFacts(input: {
  lastSyncedAt: Date | null;
  arrivals: Array<{
    type: string;
    lastReceivedAt: Date;
    lastNewSampleAt: Date | null;
  }>;
  newestMeasuredAt: Date | null;
  silentSince: Date | null;
  now: Date;
}): ConnectionFacts {
  const newestReceived = newestOf(
    ...input.arrivals.map((a) => a.lastReceivedAt),
  );
  const newestNewSample = newestOf(
    ...input.arrivals.map((a) => a.lastNewSampleAt),
  );
  // "Last import with data": a sync that brought a new sample. Rows from the
  // export import carry no arrival record, so their newest sample stands in.
  const lastDataAt = newestNewSample ?? input.newestMeasuredAt;
  const connected =
    input.lastSyncedAt !== null ||
    newestReceived !== null ||
    input.newestMeasuredAt !== null;
  // Same rule the config read uses (`newestAppleHealthDataAt`): anything that
  // arrived counts as liveness for the push cadence.
  const syncHealth = resolveSyncVerdict({
    configured: connected,
    connected,
    lastDataAt: newestOf(
      input.lastSyncedAt,
      newestReceived,
      input.newestMeasuredAt,
    ),
    legacyLastSyncedAt: input.lastSyncedAt,
    cadence: PUSH_CADENCE,
    now: input.now,
  });
  const recentCalls: RecentCall[] = input.arrivals
    .slice(0, RECENT_CALLS_LIMIT)
    .map((a) => ({
      endpoint: `batch:${a.type}`,
      status: "ok",
      at: a.lastReceivedAt.toISOString(),
      errorCode: null,
    }));
  const common = {
    syncHealth,
    connected,
    ledgerState: null,
    lastSuccessAt: iso(input.lastSyncedAt ?? newestReceived),
    lastAttemptAt: iso(newestReceived),
    failingSince: null,
    failingLegs: [],
    recentCalls,
    lastDataAt: iso(lastDataAt),
    silenceWindowMs: SOURCE_PROFILES["apple-health"].silenceWindowMs,
    now: input.now.getTime(),
  };
  return {
    key: "apple-health",
    connected,
    syncHealth,
    lastDataAt,
    ledgerAlerted: false,
    healthWithoutSilence: resolveConnectionHealth({
      ...common,
      silentSince: null,
    }),
    health: resolveConnectionHealth({
      ...common,
      silentSince: iso(input.silentSince),
    }),
    silentSince: input.silentSince,
  };
}

/** The published health per connection key, for routes. */
export async function loadConnectionHealth(
  userId: string,
  keys: readonly ConnectionKey[] = CONNECTION_KEYS,
): Promise<ConnectionHealthMap> {
  const facts = await loadConnectionFacts(userId, keys);
  const out = {} as ConnectionHealthMap;
  for (const key of CONNECTION_KEYS) out[key] = facts.get(key)?.health ?? null;
  return out;
}

/** One connection's published health, for a single-provider route. */
export async function loadOneConnectionHealth(
  userId: string,
  key: ConnectionKey,
): Promise<ConnectionHealth | null> {
  const facts = await loadConnectionFacts(userId, [key]);
  return facts.get(key)?.health ?? null;
}
