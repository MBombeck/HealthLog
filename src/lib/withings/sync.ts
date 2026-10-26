/**
 * Withings sync service — handles fetching and storing measurements,
 * token refresh, and webhook subscription management.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType, Prisma } from "@/generated/prisma/client";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  fetchMeasurements,
  subscribeWebhook,
  WITHINGS_MEASTYPES,
  type WithingsMeasure,
} from "./client";
import {
  isPlanGatedError,
  isPlanReprobeDue,
  parseWithingsApiPlanState,
  persistWithingsPlanLeg,
  planCheckedAtFor,
  planSkipFor,
  requestWithinPlan,
  shouldPersistPlanLeg,
  WITHINGS_ADVANCED_MEASTYPES,
  WITHINGS_CORE_MEASTYPES,
  WITHINGS_PLAN_GATED_STATUS,
  type WithinPlanResult,
} from "./api-plan";
import { annotate, getEvent } from "@/lib/logging/context";
import { dropImplausibleMeasurements } from "@/lib/measurements/plausibility-gate";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  classifyError,
  WithingsApiError,
  type WithingsClassification,
} from "./response-classifier";
import { afterProviderWrite } from "@/lib/integrations/sync-kit/after-write";
import type { SyncWriteResult } from "@/lib/outcome/written-outcome";
import { obtainAccessToken } from "@/lib/integrations/oauth-kit/token";
import { withingsTokenDescriptor } from "./oauth-descriptor";

/**
 * Build the callback URL handed to Withings at `Notify.subscribe` time.
 *
 * v1.4.25 W17a moved the shared secret from `?secret=…` (query
 * parameter, captured by every reverse-proxy access log) to a path
 * segment (`/api/withings/webhook/<secret>`). Withings has no
 * mechanism for setting custom HTTP headers on outgoing notifications
 * and never signs the body, so the callback URL is the only
 * authenticity surface a subscriber controls — the path-segment form
 * is the largest practical shift away from the loggable query string.
 *
 * When `WITHINGS_WEBHOOK_SECRET` is unset (dev / new install before
 * provisioning) we fall back to the bare legacy URL so subscribe
 * doesn't 500 — the route handler will then reject every inbound
 * delivery with 401 anyway.
 */
export function getWithingsWebhookCallbackUrl(): string {
  const baseUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/withings/webhook`;
  const secret = process.env.WITHINGS_WEBHOOK_SECRET;
  if (!secret) return baseUrl;
  // Path-segment form. Withings preserves the full callback URL on
  // every notification, so once a subscription is created with this
  // URL every delivery carries the secret in the path rather than the
  // query string. Encode for safety even though we expect a strong
  // random secret.
  return `${baseUrl}/${encodeURIComponent(secret)}`;
}

export interface WithingsValidToken {
  accessToken: string;
  connection: { id: string; withingsUserId: string };
}

export interface GetValidWithingsTokenOptions {
  throwOnRefreshFailure?: boolean;
}

/**
 * Get a valid access token for a user, refreshing it through the shared OAuth
 * token lifecycle (`src/lib/integrations/oauth-kit/token.ts`) when it is
 * within five minutes of its expiry.
 */
export async function getValidToken(
  userId: string,
  options: GetValidWithingsTokenOptions = {},
): Promise<WithingsValidToken | null> {
  const connection = await prisma.withingsConnection.findUnique({
    where: { userId },
    select: { id: true, withingsUserId: true },
  });
  if (!connection) return null;

  try {
    const result = await obtainAccessToken(withingsTokenDescriptor, userId);
    if (result.kind === "token") {
      return { accessToken: result.accessToken, connection };
    }
    if (result.kind === "no_credentials") {
      getEvent()?.addWarning(
        `No credentials found for user ${userId} during token refresh`,
      );
      await recordSyncFailure({
        userId,
        integration: "withings",
        kind: "reauth_required",
        message: "Withings credentials missing — token refresh skipped",
        errorCode: "credentials_missing",
      });
    }
    return null;
  } catch (err) {
    getEvent()?.addWarning(`Token refresh failed for user ${userId}`);
    await recordWithingsSyncFailure(userId, err, WITHINGS_LEG_MEASURES);
    if (options.throwOnRefreshFailure) throw err;
    return null;
  }
}

/**
 * Incremental overlap window (ms). Withings backdates some readings (a scale
 * step syncs to the cloud minutes after the reading's timestamp), and
 * `lastSyncedAt` advances on every success — including a healthy 200-with-0
 * cycle (F-SYNC-1). A too-tight overlap let a reading that landed just before
 * the next cycle's `now()` slip through the gap. 10 minutes is comfortably wider
 * than the observed backdating skew while staying far short of a full re-scan;
 * the upserts are idempotent, so a wider overlap only re-touches a handful of
 * rows. (Still narrower than Google's 24h / Oura's 7-day because Withings is
 * webhook-primary — this overlap is the poll-catch-up safety net, not the main
 * path.)
 */
export const WITHINGS_INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000;

/**
 * Sync measurements from Withings for a given user.
 * Fetches data since last sync (or last 30 days if first sync).
 *
 * Returns what was written AND whether any part of the run did not land, so
 * the caller can tell a quiet week apart from a run that refused every row.
 *
 * Status-tracking contract:
 *   - On any failure (refresh failure, fetch failure, downstream
 *     measurement-upsert that fails ALL items) we call
 *     `recordSyncFailure` so the IntegrationStatus row + audit log
 *     reflect the burst, and so the persistent-failure threshold can
 *     trip an admin alert.
 *   - On full success we call `recordSyncSuccess` to clear the streak.
 *   - If the connection is parked at `error_reauth` we short-circuit
 *     immediately — the user has to reconnect first.
 */
export async function syncUserMeasurements(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<SyncWriteResult> {
  // Park: if the last burst said reauth_required, do nothing until
  // the OAuth callback flips state back to "connected". The run wrote
  // nothing AND did not complete, so it reports as a failure — a bare 0
  // read as "nothing new", which is how a parked connection could keep
  // answering with a green tick.
  if (await isReauthRequired(userId, "withings")) {
    getEvent()?.addWarning(
      `withings sync skipped for ${userId}: parked at error_reauth`,
    );
    return { imported: 0, failed: true };
  }

  const tokenInfo = await getValidToken(userId);
  // Note: getValidToken already calls recordSyncFailure on the refresh
  // path, so we don't double-record here.
  if (!tokenInfo) return { imported: 0, failed: true };

  const connection = await prisma.withingsConnection.findUnique({
    where: { userId },
  });
  // No connection row is not a failure — there is nothing to sync.
  if (!connection) return { imported: 0, failed: false };

  const startDate = opts.fullSync
    ? undefined
    : connection.lastSyncedAt
      ? new Date(
          connection.lastSyncedAt.getTime() - WITHINGS_INCREMENTAL_OVERLAP_MS,
        )
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days back

  // Withings API plans (2026-10-12): a request naming one meastype outside the
  // account's plan is refused whole with 277. Leave out what the plan refused
  // last time (unless the weekly re-probe is due), and let `requestWithinPlan`
  // narrow the request if the plan refuses something new. A refused run never
  // reaches the watermark stamp below, so the run after this fix reads the
  // whole gap since the last good sync.
  const now = new Date();
  const planState = parseWithingsApiPlanState(connection.apiPlanState);
  const reprobed = isPlanReprobeDue(planState.measures, now);
  const skip = planSkipFor(planState.measures, now);
  const requested = WITHINGS_MEASTYPES.filter((t) => !skip.includes(t));

  let plan: WithinPlanResult<number, WithingsMeasure>;
  try {
    plan = await requestWithinPlan({
      keys: requested,
      knownGated: WITHINGS_ADVANCED_MEASTYPES,
      fetch: (measTypes) =>
        fetchMeasurements(tokenInfo.accessToken, startDate, undefined, {
          measTypes,
        }),
    });
  } catch (err) {
    await recordWithingsSyncFailure(userId, err, WITHINGS_LEG_MEASURES);
    throw err;
  }
  if (
    shouldPersistPlanLeg({
      gated: plan.gated,
      reprobed,
      acceptedAny: plan.acceptedAny,
    })
  ) {
    try {
      await persistWithingsPlanLeg(userId, "measures", {
        unavailable: [...skip, ...plan.unavailable].sort((a, b) => a - b),
        checkedAt: planCheckedAtFor(planState.measures, reprobed, now),
      });
    } catch (err) {
      // Losing the memory only costs a refused round trip next run.
      getEvent()?.addWarning(`withings: plan state write failed: ${err}`);
    }
  }
  if (plan.gated) {
    annotate({
      action: {
        name: "withings.sync.plan_gated",
        details: {
          unavailable: plan.unavailable,
          unverified: plan.unverified,
          requests: plan.requests,
          acceptedAny: plan.acceptedAny,
        },
      },
    });
  }
  if (!plan.acceptedAny) {
    // Nothing was read: either plan memory left nothing to ask for, or every
    // request was refused. Every plan carries weight and blood pressure, so a
    // run where all of it was refused is a fault upstream, not a plan answer.
    // Nothing is remembered (above), the watermark stays where it is so the
    // next run reads the whole gap, and the run reports that it did not land.
    // It stays off the failure ledger like every other 277: a plan answer must
    // never climb the strike ladder or park the connection.
    getEvent()?.addWarning(
      requested.length === 0
        ? "withings: plan memory left no measure type to request"
        : "withings: every measure request was refused with 277",
    );
    annotate({
      action: {
        name: "withings.sync.plan_nothing_read",
        details: { requested: requested.length, requests: plan.requests },
      },
    });
    return { imported: 0, failed: true };
  }
  const fetched = plan.results;

  // The app's own plausibility band applies to a provider reading exactly as
  // it applies to a typed one. A remote that reports a pulse in the millions
  // is reporting a decode slip, not a heartbeat, and the row would poison
  // every mean and personal band derived from it. Refuse it here, before the
  // update branch below can overwrite a good stored value with it.
  const measures = dropImplausibleMeasurements("withings", fetched, (m) => ({
    type: m.type,
    value: m.value,
  }));

  let imported = 0;
  // v1.4.39.1 — track every (type, measuredAt) we touched so the
  // persistent rollup tier can be re-folded at the end of the sync.
  // Pre-fix, Withings-ingested BP / weight / pulse / body-fat rows
  // skipped the rollup write hook entirely: subsequent dashboard chart
  // fetches with `source=rollup` saw fewer DAY buckets than the live
  // measurements table, painting the "Noch nicht genug Daten" empty
  // state for the 30-day range on accounts whose recent data only came
  // through Withings. We collect first, fold once at the end so a 100-
  // row monthly catch-up costs at most ~N (type, day) recomputes rather
  // than N per-row hooks. Best-effort: a populator hiccup never fails
  // the user's sync. Only readings this run inserted or changed count as
  // touched: a re-read reading that is already stored dirties nothing.
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  const insertedArrivals: Array<{
    id: string;
    type: MeasurementType;
    measuredAt: Date;
  }> = [];

  // v1.28.39 — hold-watermark-on-hard-failure (mirrors google-health /
  // fitbit's `hardFailStorage` verdict). A per-row write that HARD-fails
  // (anything but a benign P2002 idempotent-write collision) must not let
  // `lastSyncedAt` advance past the unpersisted reading — the 10-min overlap
  // window would otherwise never re-cover it and the reading is stranded
  // forever. Track any hard failure so the watermark stamp + `recordSyncSuccess`
  // below are held and the failure is recorded for the next tick to retry.
  let anyRowFailed = false;
  let firstRowError: unknown = null;

  // The run reads a window (the whole history on a full sync) and most of it
  // is usually stored already. One read of the stored rows in that window
  // splits it three ways: unchanged (nothing to write, nothing to refold),
  // changed or tombstoned (an update), and new (one batched insert). The
  // per-row `findFirst` + `update` this replaced cost two round trips per
  // reading and marked every re-read day dirty, which is where a full sync's
  // forty seconds went.
  const latest = new Map<string, (typeof measures)[number]>();
  for (const m of measures) {
    latest.set(`${m.type}|${m.measuredAt.getTime()}`, m);
  }
  const incoming = [...latest.values()];
  const existingByKey = new Map<
    string,
    { id: string; value: number; deletedAt: Date | null }
  >();
  if (incoming.length > 0) {
    let first = incoming[0]!.measuredAt;
    let last = first;
    for (const m of incoming) {
      if (m.measuredAt < first) first = m.measuredAt;
      if (m.measuredAt > last) last = m.measuredAt;
    }
    const stored = await prisma.measurement.findMany({
      where: {
        userId,
        source: "WITHINGS",
        sleepStage: null,
        type: {
          in: [...new Set(incoming.map((m) => m.type as MeasurementType))],
        },
        measuredAt: { gte: first, lte: last },
      },
      select: {
        id: true,
        type: true,
        measuredAt: true,
        value: true,
        deletedAt: true,
      },
    });
    for (const row of stored) {
      existingByKey.set(`${row.type}|${row.measuredAt.getTime()}`, row);
    }
  }

  const toCreate: typeof incoming = [];
  for (const m of incoming) {
    const measType = m.type as MeasurementType;
    const existing = existingByKey.get(`${m.type}|${m.measuredAt.getTime()}`);
    if (!existing) {
      toCreate.push(m);
      continue;
    }
    if (existing.value === m.value && existing.deletedAt === null) {
      imported++;
      continue;
    }
    try {
      await prisma.measurement.update({
        where: { id: existing.id },
        // `deletedAt: null` is a no-op on a live row, a deliberate
        // RESURRECTION on a tombstoned one — Withings is the source of
        // truth for its own rows, so a re-fetched measure brings the row
        // back (mirrors Google / Fitbit).
        data: { value: m.value, deletedAt: null },
      });
      touched.push({ type: measType, measuredAt: m.measuredAt });
      imported++;
    } catch (err) {
      // A genuine write failure strands this reading. Flag the cycle so the
      // watermark is held and the next scheduled tick refetches the overlap
      // window and retries.
      anyRowFailed = true;
      if (firstRowError === null) firstRowError = err;
      getEvent()?.addWarning(`Failed to update measure: ${err}`);
    }
  }

  // New readings in one statement per chunk. `skipDuplicates` absorbs the
  // idempotent-write race the unique index serialises (a concurrent webhook
  // run inserting the same reading): that row is present and nothing is lost,
  // exactly the P2002 the per-row path caught and ignored.
  for (let i = 0; i < toCreate.length; i += 1_000) {
    const chunk = toCreate.slice(i, i + 1_000);
    try {
      const created = await prisma.measurement.createManyAndReturn({
        data: chunk.map((m) => ({
          userId,
          type: m.type as MeasurementType,
          value: m.value,
          unit: getUnitForType(m.type),
          measuredAt: m.measuredAt,
          source: "WITHINGS" as const,
        })),
        skipDuplicates: true,
        select: { id: true, type: true, measuredAt: true },
      });
      for (const row of created) {
        insertedArrivals.push(row);
        touched.push({ type: row.type, measuredAt: row.measuredAt });
      }
      imported += created.length;
      if (created.length < chunk.length) {
        getEvent()?.addWarning(
          `Withings measure insert skipped ${chunk.length - created.length} rows already present (idempotent race)`,
        );
      }
    } catch (err) {
      anyRowFailed = true;
      if (firstRowError === null) firstRowError = err;
      getEvent()?.addWarning(`Failed to insert measures: ${err}`);
    }
  }

  // The shared tail: arrivals, the rollup fold, the read caches back to the
  // earliest touched reading and the touched status cards. The dashboard
  // snapshot is evicted too: this server-side sync produces no client
  // mutation event, so its cached body would otherwise outlive the import.
  await afterProviderWrite({
    userId,
    provider: "withings",
    touched,
    arrivals: { rows: insertedArrivals, source: "withings" },
    evictDashboard: true,
  });

  // v1.28.39 — HOLD the watermark on any hard row failure. Implements the
  // documented status-tracking contract above ("downstream measurement-upsert
  // that fails ALL items → recordSyncFailure"), extended to a partial hard
  // failure: a single hard-failed row must not advance `lastSyncedAt` past the
  // reading it failed to persist, or the 10-min overlap window loses it. Record
  // the failure (classified transient by default → the connection stays live
  // and the next tick retries from the un-advanced watermark) and return
  // WITHOUT stamping the watermark or success. The rows that DID write kept
  // their rollup recompute above.
  if (anyRowFailed) {
    annotate({
      action: {
        name: "withings.sync.watermark_held",
        details: { imported },
      },
    });
    await recordWithingsSyncFailure(
      userId,
      firstRowError ?? new Error("Withings measure row write failed"),
      WITHINGS_LEG_MEASURES,
    );
    return { imported, failed: true };
  }

  // Types the probe budget could not resolve were not read this run. Moving
  // the watermark past them would drop their readings in this window for
  // good, so it stays put until a run reads (or proves refused) every type.
  // Re-reading the accepted types is idempotent.
  // The same holds for a core type left out on the strength of plan memory:
  // that memory may be wrong, and the re-probe must find the window intact.
  const skippedCore = skip.filter((t) => WITHINGS_CORE_MEASTYPES.includes(t));
  const holdWatermark = plan.unverified.length > 0 || skippedCore.length > 0;
  if (holdWatermark) {
    annotate({
      action: {
        name: "withings.sync.plan_watermark_held",
        details: { unverified: plan.unverified, skippedCore },
      },
    });
  } else {
    await prisma.withingsConnection.update({
      where: { userId },
      data: { lastSyncedAt: new Date() },
    });
  }

  // Record success — even when measures.length === 0, completing the
  // round-trip is the signal "the connection is healthy". A user who
  // doesn't weigh themselves for a week shouldn't see "error" on
  // their settings page.
  await recordSyncSuccess(userId, "withings", {
    leg: WITHINGS_LEG_MEASURES,
  });

  return { imported, failed: false };
}

/**
 * Map a Withings response classification onto the `FailureKind` carried
 * into `recordSyncFailure`. Pure function — no IO, no state.
 *
 *   `success`         → not a failure; callers must not invoke this.
 *   `transient`       → `transient` (retry next sync)
 *   `reauth_required` → `reauth_required` (park at `error_reauth`)
 *   `persistent`      → `persistent` (audited; next sync still runs)
 */
/**
 * v1.4.42 — shared failure-recording shape for the two Withings sync
 * catch-blocks. The typed `WithingsApiError` carries the classification
 * verdict directly; `classifyError`'s regex fallback handles plain
 * `Error` instances (e.g. a pg-boss job retry that lost the prototype
 * during the JSON round-trip).
 */
/**
 * The four Withings sync legs. Each runs on its own cron at its own minute and
 * writes the SAME `(user, withings)` ledger row, so a failure has to say which
 * leg it came from — otherwise the next sibling to succeed clears an error it
 * did not cause, which is what kept a broken leg invisible.
 */
export type WithingsSyncLeg = "measures" | "activity" | "sleep" | "ecg";

export const WITHINGS_LEG_MEASURES: WithingsSyncLeg = "measures";
export const WITHINGS_LEG_ACTIVITY: WithingsSyncLeg = "activity";
export const WITHINGS_LEG_SLEEP: WithingsSyncLeg = "sleep";
export const WITHINGS_LEG_ECG: WithingsSyncLeg = "ecg";

export async function recordWithingsSyncFailure(
  userId: string,
  err: unknown,
  leg: WithingsSyncLeg,
): Promise<void> {
  // A plan refusal (277) is a limit on the developer app, not a failure of the
  // connection. It never enters the ledger, so no path that forgets to handle
  // it can climb the strike ladder or park every leg over it.
  if (isPlanGatedError(err)) {
    annotate({
      meta: { withings_plan_gated_unhandled: { leg } },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: "withings",
    kind: classificationToFailureKind(classifyError(err)),
    message,
    leg,
    errorCode:
      err instanceof WithingsApiError
        ? err.withingsStatus?.toString()
        : extractWithingsStatus(message),
  });
}

export function classificationToFailureKind(
  classification: WithingsClassification,
): FailureKind {
  switch (classification) {
    case "reauth_required":
      return "reauth_required";
    case "persistent":
      return "persistent";
    case "transient":
      return "transient";
    case "success":
      // Defensive: a caller asking for the FailureKind of a success
      // is a contract bug. Default to `transient` so the audit log
      // still surfaces the bug rather than silently ignoring it.
      return "transient";
  }
}

/**
 * Withings status codes that indicate a permanent-revoke condition
 * (the refresh_token will not work again — the user has to redo OAuth).
 *
 * Documented values per
 * https://developer.withings.com/api-reference#tag/oauth2/operation/oauth2-getaccesstoken :
 *
 *   100 → "Authentication failed"
 *   101 → "Invalid token"
 *   102 → "User does not exist"
 *   200..299 → various OAuth/grant failures (treated as reauth-required
 *              by Withings' own libraries)
 *
 * The error message format from `refreshAccessToken()` is
 * "Withings refresh error: <status> - <error>".
 *
 * v1.4.42 — superseded for new code paths by
 * `classifyError`/`classifyWithingsResponse` in `response-classifier.ts`.
 * Kept for the W17b/c sync-activity + sync-sleep catch-blocks that
 * haven't yet been migrated; both paths now also benefit from the
 * typed-error throw upstream because `classifyError` falls back to the
 * same regex.
 */
export function isWithingsRefreshReauthFailure(message: string): boolean {
  const status = extractWithingsStatus(message);
  if (!status) return false;
  const n = Number.parseInt(status, 10);
  if (!Number.isFinite(n)) return false;
  if (n === 100 || n === 101 || n === 102) return true;
  // 277 is the API-plan refusal: a limit on the developer app, not a grant.
  if (n === WITHINGS_PLAN_GATED_STATUS) return false;
  if (n >= 200 && n <= 299) return true;
  return false;
}

export function extractWithingsStatus(message: string): string | undefined {
  // Captures the digit run after "Withings <verb> error:" — same shape
  // exchangeCode and refreshAccessToken use.
  const m = /Withings\s+\w+\s+error:\s*(\d+)/.exec(message);
  return m?.[1];
}

/**
 * Withings notify appli categories HealthLog ingests. Each category requires
 * an independent upstream subscription.
 */
export const WITHINGS_NOTIFY_APPLIS = [1, 2, 4, 16, 44] as const;

export type WithingsNotifyAppli = (typeof WITHINGS_NOTIFY_APPLIS)[number];
export type WithingsNotifyAppliKey = `${WithingsNotifyAppli}`;
export type WithingsWebhookSubscriptionStatus =
  "pending" | "success" | "transient" | "persistent" | "reauth_required";

export interface WithingsWebhookSubscriptionOutcome {
  status: WithingsWebhookSubscriptionStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  withingsStatus: number | null;
}

export interface WithingsWebhookSubscriptionStateV1 {
  version: 1;
  outcomes: Record<WithingsNotifyAppliKey, WithingsWebhookSubscriptionOutcome>;
}

export const WITHINGS_SUBSCRIPTION_BASE_RETRY_MS = 5 * 60 * 1000;
export const WITHINGS_SUBSCRIPTION_MAX_RETRY_MS = 24 * 60 * 60 * 1000;

const WITHINGS_SUBSCRIPTION_STATUSES: Record<
  WithingsWebhookSubscriptionStatus,
  true
> = {
  pending: true,
  success: true,
  transient: true,
  persistent: true,
  reauth_required: true,
};

function createPendingSubscriptionOutcome(
  now: Date,
): WithingsWebhookSubscriptionOutcome {
  return {
    status: "pending",
    attemptCount: 0,
    lastAttemptAt: null,
    nextRetryAt: now.toISOString(),
    withingsStatus: null,
  };
}

export function createPendingWithingsWebhookSubscriptionState(
  now: Date = new Date(),
): WithingsWebhookSubscriptionStateV1 {
  return {
    version: 1,
    outcomes: Object.fromEntries(
      WITHINGS_NOTIFY_APPLIS.map((appli) => [
        String(appli),
        createPendingSubscriptionOutcome(now),
      ]),
    ) as WithingsWebhookSubscriptionStateV1["outcomes"],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateStringOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}

function parseSubscriptionOutcome(
  value: unknown,
): WithingsWebhookSubscriptionOutcome | null {
  if (!isObject(value)) return null;
  if (
    typeof value.status !== "string" ||
    !WITHINGS_SUBSCRIPTION_STATUSES[
      value.status as WithingsWebhookSubscriptionStatus
    ] ||
    !Number.isSafeInteger(value.attemptCount) ||
    (value.attemptCount as number) < 0 ||
    !isDateStringOrNull(value.lastAttemptAt) ||
    !isDateStringOrNull(value.nextRetryAt) ||
    !(
      value.withingsStatus === null ||
      (typeof value.withingsStatus === "number" &&
        Number.isSafeInteger(value.withingsStatus))
    )
  ) {
    return null;
  }

  const status = value.status as WithingsWebhookSubscriptionStatus;
  if (
    (status === "transient" || status === "pending") &&
    value.nextRetryAt === null
  ) {
    return null;
  }
  if (
    status !== "transient" &&
    status !== "pending" &&
    value.nextRetryAt !== null
  ) {
    return null;
  }

  return {
    status,
    attemptCount: value.attemptCount as number,
    lastAttemptAt: value.lastAttemptAt,
    nextRetryAt: value.nextRetryAt,
    withingsStatus: value.withingsStatus as number | null,
  };
}

/**
 * Persisted JSON is an untrusted compatibility boundary. Unknown versions or
 * malformed outcomes reset to a fully pending v1 state rather than silently
 * treating a category as subscribed.
 */
export function parseWithingsWebhookSubscriptionState(
  value: unknown,
  now: Date = new Date(),
): WithingsWebhookSubscriptionStateV1 {
  const pending = createPendingWithingsWebhookSubscriptionState(now);
  if (!isObject(value) || value.version !== 1 || !isObject(value.outcomes)) {
    return pending;
  }

  const outcomes = { ...pending.outcomes };
  for (const appli of WITHINGS_NOTIFY_APPLIS) {
    const key = String(appli) as WithingsNotifyAppliKey;
    const raw = value.outcomes[key];
    if (raw === undefined) continue;
    const parsed = parseSubscriptionOutcome(raw);
    if (!parsed) return pending;
    outcomes[key] = parsed;
  }
  return { version: 1, outcomes };
}

function subscriptionBackoffMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  return Math.min(
    WITHINGS_SUBSCRIPTION_BASE_RETRY_MS * 2 ** exponent,
    WITHINGS_SUBSCRIPTION_MAX_RETRY_MS,
  );
}

function earliestSubscriptionRetryAt(
  state: WithingsWebhookSubscriptionStateV1,
): Date | null {
  let earliest: number | null = null;
  for (const outcome of Object.values(state.outcomes)) {
    if (
      (outcome.status !== "pending" && outcome.status !== "transient") ||
      outcome.nextRetryAt === null
    ) {
      continue;
    }
    const timestamp = Date.parse(outcome.nextRetryAt);
    if (earliest === null || timestamp < earliest) earliest = timestamp;
  }
  return earliest === null ? null : new Date(earliest);
}

async function persistWithingsWebhookSubscriptionState(
  connectionId: string,
  state: WithingsWebhookSubscriptionStateV1,
): Promise<void> {
  await prisma.withingsConnection.update({
    where: { id: connectionId },
    data: {
      webhookSubscriptionState: state as unknown as Prisma.InputJsonValue,
      webhookSubscriptionRetryAt: earliestSubscriptionRetryAt(state),
    },
  });
}

function subscriptionFailureOutcome(
  previous: WithingsWebhookSubscriptionOutcome,
  err: unknown,
  now: Date,
): WithingsWebhookSubscriptionOutcome {
  const classified = classifyError(err);
  const classification = classified === "success" ? "transient" : classified;
  const attemptCount = previous.attemptCount + 1;
  const withingsStatus =
    err instanceof WithingsApiError &&
    typeof err.withingsStatus === "number" &&
    Number.isSafeInteger(err.withingsStatus)
      ? err.withingsStatus
      : null;
  return {
    status: classification,
    attemptCount,
    lastAttemptAt: now.toISOString(),
    nextRetryAt:
      classification === "transient"
        ? new Date(
            now.getTime() + subscriptionBackoffMs(attemptCount),
          ).toISOString()
        : null,
    withingsStatus,
  };
}

async function reconcileWithingsWebhookSubscriptions(
  userId: string,
  now: Date,
): Promise<void> {
  const connection = await prisma.withingsConnection.findUnique({
    where: { userId },
    select: {
      id: true,
      webhookSubscriptionState: true,
    },
  });
  if (!connection) return;

  const state = parseWithingsWebhookSubscriptionState(
    connection.webhookSubscriptionState,
    now,
  );
  const dueApplis = WITHINGS_NOTIFY_APPLIS.filter((appli) => {
    const outcome = state.outcomes[String(appli) as WithingsNotifyAppliKey];
    return (
      (outcome.status === "pending" || outcome.status === "transient") &&
      outcome.nextRetryAt !== null &&
      Date.parse(outcome.nextRetryAt) <= now.getTime()
    );
  });
  if (dueApplis.length === 0) return;

  let tokenInfo: WithingsValidToken | null;
  try {
    tokenInfo = await getValidToken(userId, { throwOnRefreshFailure: true });
  } catch (err) {
    for (const appli of dueApplis) {
      const key = String(appli) as WithingsNotifyAppliKey;
      state.outcomes[key] = subscriptionFailureOutcome(
        state.outcomes[key],
        err,
        now,
      );
      await persistWithingsWebhookSubscriptionState(connection.id, state);
    }
    return;
  }

  if (!tokenInfo) {
    for (const appli of dueApplis) {
      const key = String(appli) as WithingsNotifyAppliKey;
      const previous = state.outcomes[key];
      state.outcomes[key] = {
        status: "reauth_required",
        attemptCount: previous.attemptCount + 1,
        lastAttemptAt: now.toISOString(),
        nextRetryAt: null,
        withingsStatus: null,
      };
      await persistWithingsWebhookSubscriptionState(connection.id, state);
    }
    return;
  }

  const callbackUrl = getWithingsWebhookCallbackUrl();
  for (const appli of dueApplis) {
    const key = String(appli) as WithingsNotifyAppliKey;
    const previous = state.outcomes[key];
    try {
      await subscribeWebhook(tokenInfo.accessToken, callbackUrl, appli);
      state.outcomes[key] = {
        status: "success",
        attemptCount: previous.attemptCount + 1,
        lastAttemptAt: now.toISOString(),
        nextRetryAt: null,
        withingsStatus: null,
      };
      getEvent()?.addMeta(`webhook_subscribed_${appli}`, userId);
    } catch (err) {
      state.outcomes[key] = subscriptionFailureOutcome(previous, err, now);
      const outcome = state.outcomes[key];
      getEvent()?.addWarning(
        `Webhook subscription failed (appli=${appli}, classification=${outcome.status}, status=${outcome.withingsStatus ?? "unknown"})`,
      );
    }
    await persistWithingsWebhookSubscriptionState(connection.id, state);
  }
}

/**
 * Initial setup and reconnect both reconcile the durable state. Successful
 * categories are retained; reconnect resets the JSON before calling this.
 */
export async function setupWebhook(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await reconcileWithingsWebhookSubscriptions(userId, now);
}

/**
 * Hourly repair discovers only rows whose indexed retry timestamp is due, then
 * narrows again to due pending/transient categories inside the validated JSON.
 */
export async function retryDueWithingsWebhookSubscriptions(
  now: Date = new Date(),
): Promise<number> {
  const connections = await prisma.withingsConnection.findMany({
    where: { webhookSubscriptionRetryAt: { lte: now } },
    select: { userId: true },
  });
  for (const connection of connections) {
    await reconcileWithingsWebhookSubscriptions(connection.userId, now);
  }
  return connections.length;
}
