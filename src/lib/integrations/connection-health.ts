/**
 * One health state per connection, resolved on the server.
 *
 * Every integration used to express its condition in its own vocabulary: the
 * ledger `state` (`error_transient`, `error_reauth`, `parked`), the liveness
 * `syncHealth.verdict`, Withings' `planUnavailable` and `hasActivityScope`,
 * Oura's `scopeReconnect`, Google Health's `needsReauth`, a token expiry, a
 * backfill flag. Each card combined those itself, so the same fact could read
 * as a red error on one card and as a footnote on the next.
 *
 * This module folds all of it into four states a person can act on:
 *
 *   ok               data is arriving (or the first sync is still due).
 *   limited          it works, but some data types are unavailable because of
 *                    the provider plan or a missing permission; `unavailable`
 *                    names them.
 *   degraded         temporary provider trouble or unexpected silence; the
 *                    server keeps retrying. `since` dates it.
 *   action_required  the person has to do something; `action` names the one
 *                    thing.
 *
 * Plus a short reason code, the last successful sync, the newest data the
 * source delivered, and a redacted diagnostics object that is safe to paste
 * into a bug report: endpoint (leg) names, outcomes, instants and short error
 * codes. Never a message, a token, a value or a user id.
 *
 * Pure: no Prisma, no I/O, type imports only, so the resolver is unit-testable
 * and the types are importable from client code. The loader that gathers the
 * inputs lives in `./connection-health-load`.
 */
import type { IntegrationKey } from "./status";
import type { SyncHealth } from "./sync-verdict";

/** Every connection the health read covers: the polled providers + Apple Health. */
export type ConnectionKey = IntegrationKey | "apple-health";

export const CONNECTION_KEYS: readonly ConnectionKey[] = [
  "withings",
  "whoop",
  "fitbit",
  "google-health",
  "polar",
  "oura",
  "strava",
  "nightscout",
  "dawarich",
  "garmin",
  "apple-health",
];

export const CONNECTION_HEALTH_STATES = [
  "ok",
  "limited",
  "degraded",
  "action_required",
] as const;
export type ConnectionHealthState = (typeof CONNECTION_HEALTH_STATES)[number];

/**
 * Why the state is what it is. One code per state branch, so a client can pick
 * its sentence from the code alone.
 */
export const CONNECTION_HEALTH_REASONS = [
  // ok
  "data_arriving",
  "first_sync_pending",
  // limited
  "plan_limited",
  "permission_limited",
  // degraded
  "provider_errors",
  "sync_stalled",
  "no_new_data",
  "unexpected_silence",
  // action_required
  "reauth_required",
  "paused_after_errors",
] as const;
export type ConnectionHealthReason = (typeof CONNECTION_HEALTH_REASONS)[number];

/** The one thing a person can do about an `action_required` (or `limited`) connection. */
export const CONNECTION_HEALTH_ACTIONS = ["reconnect", "resume"] as const;
export type ConnectionHealthAction = (typeof CONNECTION_HEALTH_ACTIONS)[number];

export interface UnavailableItem {
  /** A provider data type key (`spo2`, `vo2Max`, `activity`, …). */
  item: string;
  /** Withheld by the provider's plan, or not covered by the granted permission. */
  cause: "plan" | "permission";
}

/** Outcome of one recorded sync attempt. */
export const RECENT_CALL_STATUSES = [
  "ok",
  "transient",
  "persistent",
  "reauth_required",
] as const;
export type RecentCallStatus = (typeof RECENT_CALL_STATUSES)[number];

export interface RecentCall {
  /** The sync leg name the code recorded (`sleep`, `measures`, `sync`), or for Apple Health `batch:<TYPE>`. */
  endpoint: string;
  status: RecentCallStatus;
  at: string;
  /** A short error code (`401`, `invalid_grant`, `scope_missing`) or null. */
  errorCode: string | null;
}

/** How many attempts the ring keeps and the diagnostics publish. */
export const RECENT_CALLS_LIMIT = 10;

export interface ConnectionDiagnostics {
  /** The ledger state string as stored, for whoever reads a bug report. */
  ledgerState: string | null;
  /** Sync legs currently recorded as failing. */
  failingLegs: string[];
  /** Start of the current failure streak, if any. */
  failingSince: string | null;
  lastAttemptAt: string | null;
  /** The liveness verdict the state was derived from. */
  verdict: SyncHealth["verdict"];
  /** Newest first, at most `RECENT_CALLS_LIMIT`. */
  recentCalls: RecentCall[];
}

export interface ConnectionHealth {
  state: ConnectionHealthState;
  reason: ConnectionHealthReason;
  /** When the current non-ok condition started; null for `ok` and `limited`. */
  since: string | null;
  /** The one action that resolves it; null when none is needed or possible. */
  action: ConnectionHealthAction | null;
  /** Data types this connection cannot deliver; empty when nothing is withheld. */
  unavailable: UnavailableItem[];
  lastSuccessAt: string | null;
  /**
   * The newest data this source delivered. For polled providers, when the
   * newest reading or workout was taken; for Apple Health, when a sync last
   * brought a new sample. Null when nothing has arrived.
   */
  lastDataAt: string | null;
  diagnostics: ConnectionDiagnostics;
}

export interface ConnectionHealthInput {
  /** The liveness verdict from `resolveSyncVerdict`. */
  syncHealth: SyncHealth;
  /** Not connected: there is no health to resolve. */
  connected: boolean;
  ledgerState: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  failingSince: string | null;
  failingLegs: readonly string[];
  recentCalls: readonly RecentCall[];
  lastDataAt: string | null;
  /** Provider-side reauth signal outside the ledger (Google Health `needsReauth`). */
  needsReauth?: boolean;
  /** Types withheld by the provider plan (Withings). */
  planUnavailable?: readonly string[];
  /** Types the granted permission does not cover (Oura scopes, Withings activity scope). */
  permissionUnavailable?: readonly string[];
  /**
   * The watchdog's unexpected-silence flag: the newest-data instant at the
   * moment it flagged, or null when not flagged.
   */
  silentSince?: string | null;
  /**
   * How long the source may go without data before the silence flag counts.
   * A flag is ignored once `lastDataAt` is newer than this window, so a source
   * that delivered after the last watchdog pass reads healthy at once.
   */
  silenceWindowMs?: number;
  now?: number;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Fold the inputs into one state. First match wins, from the state that asks
 * the most of the person down to the one that asks nothing:
 *
 *   1. action_required — the grant is gone, or the connection paused itself.
 *   2. degraded        — failing, stalled, stale, or unexpectedly silent.
 *   3. limited         — working, with named types withheld.
 *   4. ok.
 *
 * Returns null for a connection that does not exist: there is nothing to say
 * about its health, and a state would suggest otherwise.
 */
export function resolveConnectionHealth(
  input: ConnectionHealthInput,
): ConnectionHealth | null {
  if (!input.connected || input.syncHealth.verdict === "disconnected") {
    return null;
  }
  const now = input.now ?? Date.now();
  const { verdict, since: verdictSince } = input.syncHealth;

  const unavailable: UnavailableItem[] = [
    ...dedupe(input.planUnavailable).map((item): UnavailableItem => ({
      item,
      cause: "plan",
    })),
    ...dedupe(input.permissionUnavailable).map((item): UnavailableItem => ({
      item,
      cause: "permission",
    })),
  ];

  const diagnostics: ConnectionDiagnostics = {
    ledgerState: input.ledgerState,
    failingLegs: [...input.failingLegs],
    failingSince: input.failingSince,
    lastAttemptAt: input.lastAttemptAt,
    verdict,
    recentCalls: input.recentCalls.slice(0, RECENT_CALLS_LIMIT),
  };

  const base = {
    unavailable,
    lastSuccessAt: input.lastSuccessAt,
    lastDataAt: input.lastDataAt,
    diagnostics,
  };

  // 1. The person has to act.
  if (verdict === "reauth_required" || input.needsReauth) {
    return {
      ...base,
      state: "action_required",
      reason: "reauth_required",
      since: verdictSince ?? input.failingSince,
      action: "reconnect",
    };
  }
  if (verdict === "parked") {
    return {
      ...base,
      state: "action_required",
      reason: "paused_after_errors",
      since: verdictSince ?? input.failingSince,
      action: "resume",
    };
  }

  // 2. Temporary trouble; the server keeps trying.
  if (verdict === "failing") {
    return {
      ...base,
      state: "degraded",
      reason: "provider_errors",
      since: verdictSince,
      action: null,
    };
  }
  if (verdict === "stalled") {
    return {
      ...base,
      state: "degraded",
      reason: "sync_stalled",
      since: verdictSince,
      action: null,
    };
  }
  if (verdict === "stale") {
    return {
      ...base,
      state: "degraded",
      reason: "no_new_data",
      since: verdictSince,
      action: null,
    };
  }
  if (isSilenceStillTrue(input, now)) {
    return {
      ...base,
      state: "degraded",
      reason: "unexpected_silence",
      since: input.silentSince ?? null,
      action: null,
    };
  }

  // 3. Working, with something withheld. A permission gap is fixable by one
  //    reconnect; a plan gap is not fixable here at all.
  const permissionGap = unavailable.some((u) => u.cause === "permission");
  if (unavailable.length > 0) {
    return {
      ...base,
      state: "limited",
      reason: permissionGap ? "permission_limited" : "plan_limited",
      since: null,
      action: permissionGap ? "reconnect" : null,
    };
  }

  // 4. Fine.
  return {
    ...base,
    state: "ok",
    reason:
      verdict === "pending_first_sync" ? "first_sync_pending" : "data_arriving",
    since: null,
    action: null,
  };
}

/**
 * The watchdog flag stands only while no data newer than the silence window
 * has arrived. The watchdog clears it on its next pass; this keeps the read
 * honest in the hour between.
 */
function isSilenceStillTrue(
  input: ConnectionHealthInput,
  now: number,
): boolean {
  if (!input.silentSince) return false;
  const window = input.silenceWindowMs;
  const lastData = toMs(input.lastDataAt);
  if (window != null && lastData != null && now - lastData <= window) {
    return false;
  }
  return true;
}

function dedupe(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values)];
}

// ── Recent-call ring ─────────────────────────────────────────────────

/** Leg names and error codes are identifiers; anything else is dropped. */
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,48}$/;

/** A leg name safe to publish, or `sync` when the caller passed none or something unexpected. */
export function safeEndpointName(value: string | null | undefined): string {
  return value && SAFE_TOKEN.test(value) ? value : "sync";
}

/**
 * An error code safe to publish, or null. Codes are short identifiers the sync
 * code passes (`401`, `invalid_grant`, `scope_missing`); a value that does not
 * look like one (a sentence, a URL, something carrying a token) is dropped
 * rather than trimmed, because a trimmed secret is still a secret.
 */
export function safeErrorCode(value: string | null | undefined): string | null {
  return value && SAFE_TOKEN.test(value) ? value : null;
}

/**
 * Read the stored JSON ring into typed entries, newest first. Anything that is
 * not a well-formed entry is skipped; every string is re-checked against the
 * same closed shapes the writer applies, so a hand-edited row cannot publish
 * free text through the diagnostics.
 */
export function readRecentCalls(value: unknown): RecentCall[] {
  if (!Array.isArray(value)) return [];
  const out: RecentCall[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const status = entry.status;
    const at = entry.at;
    if (
      typeof status !== "string" ||
      !(RECENT_CALL_STATUSES as readonly string[]).includes(status) ||
      typeof at !== "string" ||
      !Number.isFinite(Date.parse(at))
    ) {
      continue;
    }
    out.push({
      endpoint: safeEndpointName(
        typeof entry.endpoint === "string" ? entry.endpoint : null,
      ),
      status: status as RecentCallStatus,
      at: new Date(at).toISOString(),
      errorCode: safeErrorCode(
        typeof entry.errorCode === "string" ? entry.errorCode : null,
      ),
    });
    if (out.length >= RECENT_CALLS_LIMIT) break;
  }
  return out;
}
