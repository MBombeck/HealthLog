/**
 * One row per integration, resolved on the server: what the Settings →
 * Integrations list shows and what a native client mirrors.
 *
 * The list has two groups, data sources and delivery channels, and every row
 * says the same three things: whether it is set up, one status word (active,
 * error, off) with a short reason code, and when it last worked. The words are
 * decided here, once, so the web and the app cannot word the same connection
 * two ways. A client renders `status` as it comes and picks its sentence from
 * `reason`; it never derives a status from other fields.
 *
 * Sources take their state from the shared connection health
 * (`./connection-health`): `ok` and `limited` are active, `degraded` and
 * `action_required` are an error, and the health reason travels unchanged.
 * Channels take theirs from the `NotificationChannel` reliability fields the
 * dispatcher keeps.
 *
 * Pure: the loader that gathers the inputs is `./overview-load`.
 */
import type {
  ConnectionHealth,
  ConnectionHealthReason,
  ConnectionKey,
} from "./connection-health";

/** Data sources, in the order the list shows them. */
export const OVERVIEW_SOURCE_KEYS = [
  "apple-health",
  "withings",
  "whoop",
  "google-health",
  "garmin",
  "oura",
  "polar",
  "strava",
  "nightscout",
  "dawarich",
  "health-connect-remote",
  "document-sources",
] as const satisfies readonly (ConnectionKey | "document-sources")[];
export type OverviewSourceKey = (typeof OVERVIEW_SOURCE_KEYS)[number];

/** Delivery channels, in the order the list shows them. */
export const OVERVIEW_CHANNEL_KEYS = [
  "telegram",
  "ntfy",
  "web-push",
  "webhook",
  "email",
  "apns",
] as const;
export type OverviewChannelKey = (typeof OVERVIEW_CHANNEL_KEYS)[number];

export type OverviewKey = OverviewSourceKey | OverviewChannelKey;

export const OVERVIEW_STATUSES = ["active", "error", "off"] as const;
export type OverviewStatus = (typeof OVERVIEW_STATUSES)[number];

/**
 * Why a row reads as it does. The connection-health reasons for sources, plus
 * the few states the health model has no word for.
 */
export const OVERVIEW_REASONS = [
  // A source with stored credentials (or a set-up folder) that is not connected.
  "not_connected",
  // A source switched off by the person (the Health Connect folder).
  "paused",
  // A channel switched off by the person.
  "switched_off",
  // A channel the dispatcher switched off after a hard refusal.
  "auto_disabled",
  // A channel waiting out a cooldown after a failed send.
  "sending_paused",
  // A channel whose most recent send failed.
  "delivery_failing",
] as const;
export type OverviewOwnReason = (typeof OVERVIEW_REASONS)[number];
export type OverviewReason = ConnectionHealthReason | OverviewOwnReason;

/** Why an offered integration needs one more step before it can connect. */
export const OVERVIEW_SETUP_NOTES = ["own_credentials"] as const;
export type OverviewSetupNote = (typeof OVERVIEW_SETUP_NOTES)[number];

export interface IntegrationOverviewItem {
  key: OverviewKey;
  group: "source" | "channel";
  /** Something is stored for it: a connection, credentials, a channel row. */
  setUp: boolean;
  /** Null exactly when `setUp` is false. */
  status: OverviewStatus | null;
  /** Null for an active row with nothing to say, and for a row not set up. */
  reason: OverviewReason | null;
  /** When it last worked: the last successful sync or send. */
  lastAt: string | null;
  /**
   * The server can offer it to this account (operator switches, module,
   * transport). A row not set up and not offered is not shown at all.
   */
  offered: boolean;
  /** Set when connecting first needs the person's own app credentials. */
  setupNote: OverviewSetupNote | null;
}

export interface IntegrationOverview {
  items: IntegrationOverviewItem[];
}

export interface SourceInput {
  key: OverviewSourceKey;
  /** A live connection exists. */
  connected: boolean;
  /** Something is stored short of a connection (credentials, a folder). */
  configured: boolean;
  /** Set up but switched off by the person. */
  paused?: boolean;
  /** The resolved connection health; null when there is none to give. */
  health: ConnectionHealth | null;
  /** When the source last worked, for one without a connection health. */
  lastAt?: string | null;
  offered: boolean;
  needsOwnCredentials?: boolean;
}

/** One data source's row. */
export function resolveSourceItem(input: SourceInput): IntegrationOverviewItem {
  const base = {
    key: input.key,
    group: "source" as const,
    offered: input.offered,
    setupNote:
      input.needsOwnCredentials && !input.connected
        ? ("own_credentials" as const)
        : null,
  };
  if (input.paused && (input.connected || input.configured)) {
    return {
      ...base,
      setUp: true,
      status: "off",
      reason: "paused",
      lastAt: lastWorked(input),
    };
  }
  if (!input.connected) {
    return input.configured
      ? {
          ...base,
          setUp: true,
          status: "off",
          reason: "not_connected",
          lastAt: null,
        }
      : { ...base, setUp: false, status: null, reason: null, lastAt: null };
  }
  const health = input.health;
  if (!health) {
    return {
      ...base,
      setUp: true,
      status: "active",
      reason: null,
      lastAt: input.lastAt ?? null,
    };
  }
  const failing =
    health.state === "degraded" || health.state === "action_required";
  return {
    ...base,
    setUp: true,
    status: failing ? "error" : "active",
    reason: health.reason,
    lastAt: lastWorked(input),
  };
}

function lastWorked(input: SourceInput): string | null {
  return (
    input.health?.lastSuccessAt ??
    input.health?.lastDataAt ??
    input.lastAt ??
    null
  );
}

export interface ChannelRowInput {
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  nextRetryAt: Date | null;
}

/** One delivery channel's row. `row` is its `NotificationChannel`, if any. */
export function resolveChannelItem(input: {
  key: OverviewChannelKey;
  row: ChannelRowInput | null;
  offered: boolean;
  now: Date;
}): IntegrationOverviewItem {
  const { key, row, offered, now } = input;
  const base = { key, group: "channel" as const, offered, setupNote: null };
  if (!row) {
    return { ...base, setUp: false, status: null, reason: null, lastAt: null };
  }
  const lastAt = row.lastSuccessAt?.toISOString() ?? null;
  if (!row.enabled) {
    return row.disabledReason
      ? {
          ...base,
          setUp: true,
          status: "error",
          reason: "auto_disabled",
          lastAt,
        }
      : { ...base, setUp: true, status: "off", reason: "switched_off", lastAt };
  }
  if (row.nextRetryAt && row.nextRetryAt.getTime() > now.getTime()) {
    return {
      ...base,
      setUp: true,
      status: "error",
      reason: "sending_paused",
      lastAt,
    };
  }
  const lastFailed =
    row.consecutiveFailures > 0 &&
    row.lastFailureAt !== null &&
    (row.lastSuccessAt === null ||
      row.lastFailureAt.getTime() > row.lastSuccessAt.getTime());
  if (lastFailed) {
    return {
      ...base,
      setUp: true,
      status: "error",
      reason: "delivery_failing",
      lastAt,
    };
  }
  return { ...base, setUp: true, status: "active", reason: null, lastAt };
}

/** The `NotificationChannel.type` behind each channel key. */
export const CHANNEL_KEY_TYPE: Record<OverviewChannelKey, string> = {
  telegram: "TELEGRAM",
  ntfy: "NTFY",
  "web-push": "WEB_PUSH",
  webhook: "WEBHOOK",
  email: "EMAIL",
  apns: "APNS",
};
