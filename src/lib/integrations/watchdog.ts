/**
 * The integration watchdog: notices a connection that has gone quiet or stayed
 * broken, flags it for the connection health read, and tells the operator once.
 *
 * Runs on two schedules (`src/lib/jobs/integration-watchdog.ts`):
 *
 *   hourly — cheap. One health load per account with a connection (the same
 *            loader the routes use), plus a 14-day history count only for a
 *            continuous source that is silent and not flagged yet.
 *   daily  — the same pass, and it re-reads the history behind every standing
 *            silence flag, so a source its owner simply stopped using drops out
 *            once its own history no longer says it delivers.
 *
 * Judgement lives in `./watchdog-classify` (pure, unit-tested); this module
 * gathers inputs and performs the side effects: one `IntegrationWatch` row per
 * watched connection, one operator alert per incident through the existing
 * admin path (`dispatchAdminSystemAlert`), one recovery note when it ends.
 *
 * Operator messages carry the provider, the account's email (as the ledger's
 * own alerts do), a reason and an instant. Never a token, a value or an error
 * message from the provider.
 */
import {
  ACTIVE_ACCOUNT,
  OWNED_BY_ACTIVE_ACCOUNT,
} from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import type { MeasurementSource } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import { dispatchAdminSystemAlert } from "./status";
import { CONNECTION_KEYS, type ConnectionKey } from "./connection-health";
import {
  loadConnectionFacts,
  type ConnectionFacts,
} from "./connection-health-load";
import { INTEGRATION_MEASUREMENT_SOURCE } from "./metric-freshness";
import {
  FIRST_RUN_ALERTED_AT,
  HISTORY_DAYS,
  SOURCE_PROFILES,
  classifySilence,
  currentIncident,
  decideWatchTransition,
  type IncidentReason,
  type WatchRow,
} from "./watchdog-classify";

export type WatchdogMode = "hourly" | "daily";

export interface WatchdogSummary {
  usersScanned: number;
  usersFailed: number;
  connectionsConsidered: number;
  silencesFlagged: number;
  incidentsOpened: number;
  incidentsClosed: number;
  notified: number;
  /**
   * The pass found no watch row at all: the first one after the watchdog was
   * deployed. Incidents standing at that moment are recorded as already
   * announced instead of paged, so a deploy does not page once for every
   * connection that has been broken or quiet for months.
   */
  firstRun: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const LABELS: Record<ConnectionKey, string> = {
  withings: "Withings",
  whoop: "WHOOP",
  fitbit: "Fitbit",
  "google-health": "Google Health",
  polar: "Polar",
  oura: "Oura",
  strava: "Strava",
  nightscout: "Nightscout",
  dawarich: "Dawarich",
  "apple-health": "Apple Health",
};

function measurementSourceFor(key: ConnectionKey): MeasurementSource | null {
  if (key === "apple-health") return "APPLE_HEALTH";
  return INTEGRATION_MEASUREMENT_SOURCE[key] ?? null;
}

/**
 * Distinct UTC days with data in the `HISTORY_DAYS` before the silence window.
 * The window ends where silence starts to count, so the history being read is
 * the one the silence is measured against.
 */
async function countDeliveredDays(
  userId: string,
  key: ConnectionKey,
  now: Date,
): Promise<number> {
  const source = measurementSourceFor(key);
  if (!source) return 0;
  const to = new Date(now.getTime() - SOURCE_PROFILES[key].silenceWindowMs);
  const from = new Date(to.getTime() - HISTORY_DAYS * DAY_MS);
  const rows = await prisma.$queryRaw<Array<{ days: number }>>`
    SELECT COUNT(DISTINCT date_trunc('day', m."measured_at"))::int AS "days"
      FROM "measurements" m
     WHERE m."user_id" = ${userId}
       AND m."source" = ${source}::"measurement_source"
       AND m."deleted_at" IS NULL
       AND m."measured_at" >= ${from}
       AND m."measured_at" < ${to}
  `;
  return Number(rows[0]?.days ?? 0);
}

/**
 * Every account that has a connection the watchdog covers, or a watch row that
 * still holds a flag or an incident (so a removed connection gets its incident
 * closed).
 */
async function listWatchedUserIds(): Promise<string[]> {
  const [withings, whoop, fitbit, google, userRows, healthKit, watches] =
    await Promise.all([
      // An account pending deletion is frozen: its connections are not
      // synced, so their silence is not an incident.
      prisma.withingsConnection.findMany({
        where: OWNED_BY_ACTIVE_ACCOUNT,
        select: { userId: true },
      }),
      prisma.whoopConnection.findMany({
        where: { whoopUserId: { not: null }, ...OWNED_BY_ACTIVE_ACCOUNT },
        select: { userId: true },
      }),
      prisma.fitbitConnection.findMany({
        where: OWNED_BY_ACTIVE_ACCOUNT,
        select: { userId: true },
      }),
      prisma.googleHealthConnection.findMany({
        where: OWNED_BY_ACTIVE_ACCOUNT,
        select: { userId: true },
      }),
      prisma.user.findMany({
        where: {
          ...ACTIVE_ACCOUNT,
          OR: [
            { polarAccessTokenEncrypted: { not: null } },
            { ouraAccessTokenEncrypted: { not: null } },
            { stravaAccessTokenEncrypted: { not: null } },
            { nightscoutUrlEncrypted: { not: null } },
            { dawarichUrlEncrypted: { not: null } },
            { healthKitLastSyncedAt: { not: null } },
          ],
        },
        select: { id: true },
      }),
      prisma.healthKitTypeSync.findMany({
        where: OWNED_BY_ACTIVE_ACCOUNT,
        distinct: ["userId"],
        select: { userId: true },
      }),
      prisma.integrationWatch.findMany({
        where: {
          OR: [
            { silentSince: { not: null } },
            { incidentReason: { not: null } },
          ],
          ...OWNED_BY_ACTIVE_ACCOUNT,
        },
        select: { userId: true },
      }),
    ]);
  const ids = new Set<string>();
  for (const r of [...withings, ...whoop, ...fitbit, ...google, ...healthKit]) {
    ids.add(r.userId);
  }
  for (const r of userRows) ids.add(r.id);
  for (const r of watches) ids.add(r.userId);
  return [...ids].sort();
}

function formatInstant(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const INCIDENT_COPY: Record<IncidentReason, (label: string) => string> = {
  unexpected_silence: (l) =>
    `${l} has delivered nothing although it normally delivers every day. The connection reports no error.`,
  reauth_required: (l) => `${l} needs to be reconnected by the account owner.`,
  paused_after_errors: (l) =>
    `${l} paused itself after a day of failing syncs. Resume or reconnect it in the integration settings.`,
  provider_errors: (l) =>
    `${l} syncs have been failing for more than a day. HealthLog keeps retrying.`,
  sync_stalled: (l) => `${l} sync has not run for more than a day.`,
  no_new_data: (l) => `${l} has delivered no new data for a while.`,
  // The remaining reasons belong to healthy states and never open an
  // incident; the copy exists so the table stays total.
  data_arriving: (l) => `${l} is delivering data.`,
  first_sync_pending: (l) => `${l} is waiting for its first sync.`,
  plan_limited: (l) => `${l} withholds some data types under its plan.`,
  permission_limited: (l) => `${l} lacks permission for some data types.`,
};

/**
 * Pure formatter for the two operator messages, exported for tests. Plain
 * text: the dispatcher sends it to Telegram without a parse mode, and the only
 * interpolations are a provider label, an email and server-built instants.
 */
export function formatWatchdogMessage(input: {
  kind: "incident" | "recovery";
  key: ConnectionKey;
  subjectLabel: string;
  reason: string;
  since: Date | null;
  closedBecause?: "healthy" | "disconnected" | "not_expected";
}): { title: string; message: string } {
  const label = LABELS[input.key];
  if (input.kind === "incident") {
    const copy =
      INCIDENT_COPY[input.reason as IncidentReason]?.(label) ??
      `${label} needs attention.`;
    const since = input.since ? ` Since ${formatInstant(input.since)}.` : "";
    return {
      title: `${label} needs attention for ${input.subjectLabel}`,
      message: `${copy}${since}`,
    };
  }
  const why =
    input.closedBecause === "disconnected"
      ? "The connection was removed."
      : input.closedBecause === "not_expected"
        ? "It has not delivered regularly for a while, so the watchdog no longer expects data from it."
        : "Data is arriving again.";
  return {
    title: `${label} recovered for ${input.subjectLabel}`,
    message: `${label} is fine again. ${why}`,
  };
}

/** Run one watchdog pass over every watched account. */
export async function runIntegrationWatchdog(opts: {
  mode: WatchdogMode;
  now?: Date;
}): Promise<WatchdogSummary> {
  const now = opts.now ?? new Date();
  const summary: WatchdogSummary = {
    usersScanned: 0,
    usersFailed: 0,
    connectionsConsidered: 0,
    silencesFlagged: 0,
    incidentsOpened: 0,
    incidentsClosed: 0,
    notified: 0,
    // account-deletion: whether any watch row exists yet; it reads no account.
    firstRun: (await prisma.integrationWatch.count()) === 0,
  };
  const userIds = await listWatchedUserIds();
  const outbox: WatchdogNote[] = [];
  for (const userId of userIds) {
    summary.usersScanned += 1;
    try {
      await watchUser(userId, opts.mode, now, summary, outbox);
    } catch (err) {
      // One account's failure must not stop the pass for everyone else.
      summary.usersFailed += 1;
      getEvent()?.addWarning(
        `integration watchdog failed for one account: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await flushWatchdogOutbox(outbox, now, summary);
  return summary;
}

/** One operator message the pass has decided to send. */
export interface WatchdogNote {
  kind: "incident" | "recovery";
  userId: string;
  key: ConnectionKey;
  subjectLabel: string;
  reason: string;
  since: Date | null;
  closedBecause?: "healthy" | "disconnected" | "not_expected";
}

/**
 * More than this many accounts of one provider opening (or closing) an
 * incident in the same pass is one provider-wide event, not that many
 * separate ones: a provider outage, an expired app credential, a changed API.
 * The operator gets one message for it instead of one per account.
 */
export const WATCHDOG_AGGREGATE_ABOVE = 3;

const AGGREGATE_REASON_COPY: Partial<Record<IncidentReason, string>> = {
  unexpected_silence: "silent although they normally deliver every day",
  reauth_required: "waiting to be reconnected by their owners",
  paused_after_errors: "paused after a day of failing syncs",
  provider_errors: "failing to sync for more than a day",
};

/** The most account emails one aggregated message names. */
const AGGREGATE_NAMED = 10;

/**
 * Pure formatter for the provider-wide messages, exported for tests. Same
 * rules as `formatWatchdogMessage`: plain text, a provider label, emails and
 * server-built instants only.
 */
export function formatWatchdogAggregate(
  kind: "incident" | "recovery",
  key: ConnectionKey,
  notes: WatchdogNote[],
): { title: string; message: string } {
  const label = LABELS[key];
  const n = notes.length;
  const named = notes.slice(0, AGGREGATE_NAMED).map((x) => x.subjectLabel);
  const more = n > AGGREGATE_NAMED ? ` and ${n - AGGREGATE_NAMED} more` : "";
  const accounts = `Accounts: ${named.join(", ")}${more}.`;
  if (kind === "recovery") {
    return {
      title: `${label} recovered for ${n} connections`,
      message: `${label} is fine again for ${n} connections. ${accounts}`,
    };
  }
  const byReason = new Map<string, WatchdogNote[]>();
  for (const note of notes) {
    const list = byReason.get(note.reason) ?? [];
    list.push(note);
    byReason.set(note.reason, list);
  }
  const lines = [...byReason].map(([reason, list]) => {
    const copy =
      AGGREGATE_REASON_COPY[reason as IncidentReason] ?? "needing attention";
    const earliest = list
      .map((x) => x.since)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const since = earliest ? ` since ${formatInstant(earliest)}` : "";
    return `${list.length} ${copy}${since}.`;
  });
  return {
    title: `${label}: ${n} connections need attention`,
    message: `${lines.join(" ")} ${accounts}`,
  };
}

/**
 * Send what the pass decided, per provider: one message per account, or one
 * for the provider when more than `WATCHDOG_AGGREGATE_ABOVE` accounts share
 * it. An incident counts as announced (its `alertedAt` stamped) once a channel
 * took the message, whichever form it went out in. A send that fails is a
 * warning; the incident stays unannounced and the next pass tries again.
 */
export async function flushWatchdogOutbox(
  outbox: WatchdogNote[],
  now: Date,
  summary: WatchdogSummary,
): Promise<void> {
  const groups = new Map<string, WatchdogNote[]>();
  for (const note of outbox) {
    const id = `${note.kind}:${note.key}`;
    const list = groups.get(id) ?? [];
    list.push(note);
    groups.set(id, list);
  }
  outbox.length = 0;

  const markAnnounced = async (notes: WatchdogNote[]) => {
    for (const note of notes) {
      await prisma.integrationWatch.updateMany({
        where: {
          userId: note.userId,
          integration: note.key,
          incidentReason: { not: null },
        },
        data: { alertedAt: now },
      });
    }
  };

  for (const notes of groups.values()) {
    const { kind, key } = notes[0]!;
    try {
      if (notes.length > WATCHDOG_AGGREGATE_ABOVE) {
        const text = formatWatchdogAggregate(kind, key, notes);
        const outcome = await dispatchAdminSystemAlert({
          // About many accounts: no one owner, so every admin's tap opens the
          // admin page.
          subjectUserId: "",
          title: text.title,
          message: text.message,
          metadata: {
            integration: key,
            watchdog: kind,
            connections: notes.length,
          },
        });
        if (outcome.channelsAttempted > 0) {
          summary.notified += 1;
          if (kind === "incident") await markAnnounced(notes);
        }
        continue;
      }
      for (const note of notes) {
        const text = formatWatchdogMessage(note);
        const outcome = await dispatchAdminSystemAlert({
          subjectUserId: note.userId,
          title: text.title,
          message: text.message,
          metadata: {
            integration: key,
            reason: note.reason,
            watchdog: kind,
          },
        });
        if (outcome.channelsAttempted > 0) {
          summary.notified += 1;
          if (kind === "incident") await markAnnounced([note]);
        }
      }
    } catch (err) {
      getEvent()?.addWarning(
        `integration watchdog could not send its ${kind} message for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Watch every connection of one account. Exported for tests. Its operator
 * messages go to `outbox` when one is passed (the pass sends them together at
 * its end), and are sent before it returns otherwise.
 */
export async function watchUser(
  userId: string,
  mode: WatchdogMode,
  now: Date,
  summary: WatchdogSummary,
  outbox?: WatchdogNote[],
): Promise<void> {
  if (!outbox) {
    const own: WatchdogNote[] = [];
    await watchUser(userId, mode, now, summary, own);
    await flushWatchdogOutbox(own, now, summary);
    return;
  }
  const [facts, rows, subject] = await Promise.all([
    loadConnectionFacts(userId, CONNECTION_KEYS, now),
    prisma.integrationWatch.findMany({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
  ]);
  const rowByKey = new Map(rows.map((r) => [r.integration, r]));
  const subjectLabel = subject?.email ?? "an account";

  for (const key of CONNECTION_KEYS) {
    const fact = facts.get(key);
    const row = rowByKey.get(key) ?? null;
    if (!fact) continue;
    if (!fact.connected && row === null) continue;
    summary.connectionsConsidered += 1;
    await watchConnection({
      userId,
      key,
      fact,
      row,
      mode,
      now,
      subjectLabel,
      summary,
      outbox,
    });
  }
}

async function watchConnection(input: {
  userId: string;
  key: ConnectionKey;
  fact: ConnectionFacts;
  row: (WatchRow & { id: string }) | null;
  mode: WatchdogMode;
  now: Date;
  subjectLabel: string;
  summary: WatchdogSummary;
  outbox: WatchdogNote[];
}): Promise<void> {
  const { userId, key, fact, row, mode, now, summary } = input;
  const profile = SOURCE_PROFILES[key];

  // ── Silence ────────────────────────────────────────────────────────
  let silentSince: Date | null = null;
  let closedBecause: "healthy" | "disconnected" | "not_expected" =
    fact.connected ? "healthy" : "disconnected";
  if (fact.connected) {
    const base = {
      profile,
      lastDataAt: fact.lastDataAt,
      currentSilentSince: row?.silentSince ?? null,
      now,
    };
    // The daily pass re-reads the history behind a standing flag.
    const recheck = mode === "daily" && row?.silentSince != null;
    let verdict = classifySilence({
      ...base,
      deliveredDays: recheck
        ? await countDeliveredDays(userId, key, now)
        : null,
    });
    if (verdict.kind === "needs_history") {
      verdict = classifySilence({
        ...base,
        deliveredDays: await countDeliveredDays(userId, key, now),
      });
    }
    if (verdict.kind === "flag") silentSince = verdict.silentSince;
    if (verdict.kind === "not_expected") closedBecause = "not_expected";
  }
  if (silentSince && !row?.silentSince) summary.silencesFlagged += 1;

  // ── Incident ───────────────────────────────────────────────────────
  const incident = currentIncident({
    health: fact.connected ? fact.healthWithoutSilence : null,
    silentSince,
    ledgerAlerted: fact.ledgerAlerted,
    now,
  });
  const transition = decideWatchTransition({
    row,
    incident,
    ledgerAlerted: fact.ledgerAlerted,
  });

  let incidentReason = row?.incidentReason ?? null;
  let incidentOpenedAt = row?.incidentOpenedAt ?? null;
  let alertedAt = row?.alertedAt ?? null;

  // Sent once the pass is over (`flushWatchdogOutbox`), so many accounts of
  // one provider failing at once come as one message.
  const announce = (reason: string, since: Date | null) => {
    input.outbox.push({
      kind: "incident",
      userId,
      key,
      subjectLabel: input.subjectLabel,
      reason,
      since,
    });
  };

  switch (transition.kind) {
    case "none":
      break;
    case "open":
      summary.incidentsOpened += 1;
      incidentReason = transition.reason;
      incidentOpenedAt = now;
      if (summary.firstRun) {
        // Standing since before the watchdog first looked: recorded as
        // announced, not paged (see `WatchdogSummary.firstRun`), and marked
        // so its end sends no recovery note either.
        alertedAt = FIRST_RUN_ALERTED_AT;
      } else {
        announce(transition.reason, transition.since);
      }
      break;
    case "adopt":
      // The ledger already paged about this streak; record it as announced so
      // the operator gets the recovery note and no second page.
      summary.incidentsOpened += 1;
      incidentReason = transition.reason;
      incidentOpenedAt = now;
      alertedAt = now;
      break;
    case "keep":
      incidentReason = transition.reason;
      if (alertedAt === null && fact.ledgerAlerted) {
        alertedAt = now;
      } else if (transition.announce && incident) {
        // Opened earlier while no admin channel accepted the alert.
        announce(transition.reason, incident.since);
      }
      break;
    case "close":
      summary.incidentsClosed += 1;
      if (transition.notify) {
        input.outbox.push({
          kind: "recovery",
          userId,
          key,
          subjectLabel: input.subjectLabel,
          reason: transition.previousReason,
          since: null,
          closedBecause,
        });
      }
      incidentReason = null;
      incidentOpenedAt = null;
      alertedAt = null;
      break;
  }

  // Nothing to remember and nothing remembered: no row. Except on the first
  // pass, which leaves a row for every connection it looked at, so the pass
  // after it is not taken for a first one too.
  if (
    row === null &&
    silentSince === null &&
    incidentReason === null &&
    !(summary.firstRun && fact.connected)
  ) {
    return;
  }

  await prisma.integrationWatch.upsert({
    where: { userId_integration: { userId, integration: key } },
    create: {
      userId,
      integration: key,
      silentSince,
      incidentReason,
      incidentOpenedAt,
      alertedAt,
      checkedAt: now,
    },
    update: {
      silentSince,
      incidentReason,
      incidentOpenedAt,
      alertedAt,
      checkedAt: now,
    },
  });
}
