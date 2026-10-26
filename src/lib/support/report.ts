/**
 * The operator's support report: a redacted plain-text summary of what this
 * instance looks like, for pasting into a bug report.
 *
 * Three stages, kept apart so each can be tested on its own:
 *
 *   1. `collectSupportReportFacts()` reads the database, the queue and this
 *      process. Accounts leave it as numbers ("Account 1..n", oldest first);
 *      no account id, username or email is part of the facts.
 *   2. `renderSupportReport()` turns the facts into text. Pure.
 *   3. `redactSupportText()` runs every redaction step over that text, with
 *      the instance's own emails, usernames, names and ids as known values.
 *
 * What it never contains: an email address, an account id, a value anyone
 * recorded, a token, the host name of a foreign service. Configuration is yes
 * or no, never the setting itself. Errors appear as an action name and an
 * error class, never as their message.
 *
 * The report is English on purpose: it is read by whoever answers the issue.
 */

import { prisma } from "@/lib/db";
import { failureCondition } from "@/lib/jobs/failure-condition";
import {
  containerMemoryLimitMb,
  heapLimitMb,
  isBelowMemoryFloor,
  isHeapLimitLow,
  lowHeapLimitAdvice,
  megabytes,
  memoryFloorAdvice,
} from "@/lib/support/heap-limit";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { isOidcConfigured, isOidcOnly } from "@/lib/auth/oidc";
import { getLoggingConfig } from "@/lib/logging/config";
import {
  readLogBuffer,
  PROBLEMS_BUFFER_MAX,
} from "@/lib/logging/in-memory-buffer";
import type { WideEvent } from "@/lib/logging/types";
import { offhostBackupConfigured } from "@/lib/jobs/offhost-backup";
import { OFFHOST_BACKUP_QUEUE } from "@/lib/jobs/offhost-backup-queue";
import { DATA_BACKUP_QUEUE } from "@/lib/jobs/data-backup-policy";
import { RESTORE_DRILL_QUEUE } from "@/lib/jobs/restore-drill-queue";
import {
  JOB_FAILURE_WINDOW_HOURS,
  readFailingQueues,
  readLastQueueRun,
  type LastQueueRun,
} from "@/lib/jobs/job-failures";
import { getWorkerStatus } from "@/lib/jobs/worker-status";
import { getProcessType, shouldRunWorker } from "@/lib/process-type";
import { offlineGeoReady } from "@/lib/geo";
import { configuredNotificationPrivateOrigins } from "@/lib/notifications/egress-policy";
import { isEmailConfigured } from "@/lib/notifications/senders/email-config";
import { loadConnectionHealth } from "@/lib/integrations/connection-health-load";
import { CONNECTION_KEYS } from "@/lib/integrations/connection-health";
import {
  redactSupportText,
  supportLine,
  type SupportRedactionContext,
} from "./redact";
import packageJson from "../../../package.json";

/** Accounts whose connections the report reads; the rest are counted only. */
export const SUPPORT_REPORT_ACCOUNT_CAP = 200;
/** How far back the notification tallies reach. */
export const SUPPORT_REPORT_NOTIFICATION_DAYS = 7;
/** How many error actions the report lists. */
export const SUPPORT_REPORT_TOP_ERRORS = 20;

// ─── Facts ───────────────────────────────────────────────────────────────

export interface QueueRunFact {
  at: string;
  state: LastQueueRun["state"];
  errorClass: string | null;
}

export interface SupportReportFacts {
  generatedAt: string;
  build: {
    version: string;
    buildSha: string | null;
    builtAt: string | null;
    node: string;
    processType: string;
    heapLimitMb: number;
    /** The container's memory limit; `null` when there is none or it cannot be read. */
    containerMemoryLimitMb: number | null;
    uptimeSeconds: number;
  };
  database: {
    version: string | null;
    timezone: string | null;
    sizeBytes: number | null;
    lastMigration: string | null;
    lastMigrationAt: string | null;
    unfinishedMigrations: number | null;
  };
  /** Label and a yes / no / count answer. Never the setting itself. */
  config: Array<[string, string]>;
  jobs: {
    workerInThisProcess: boolean;
    workerRunning: boolean;
    workerLastHeartbeat: string | null;
    newestFinishedJobAt: string | null;
    /** `null` when the queue tables could not be read. */
    failing: Array<{
      queue: string;
      failures: number;
      lastFailedAt: string;
      errorClass: string;
    }> | null;
  };
  accounts: { total: number; read: number };
  connections: Array<{
    provider: string;
    state: string;
    reason: string;
    accounts: number[];
  }>;
  incidents: Array<{
    provider: string;
    reason: string;
    openedAt: string | null;
    announced: boolean;
    account: number | null;
  }>;
  ai: {
    defaultLevel: string | null;
    maxLevel: string | null;
    /** Level (or `instance default`) to number of accounts. */
    levels: Array<[string, number]>;
    providers: Array<{
      provider: string;
      ok: number;
      failing: number;
      authFailed: number;
      paused: number;
      lastFailureAt: string | null;
      lastStatus: number | null;
    }>;
  };
  notifications: Array<{
    channel: string;
    ok: number;
    error: number;
    skipped: number;
    topReasons: Array<[string, number]>;
  }>;
  backups: {
    newestLocalAt: string | null;
    localCopies: number;
    lastLocalRun: QueueRunFact | null;
    offhostConfigured: boolean;
    offhostNewestAt: string | null;
    offhostOldestAt: string | null;
    offhostAccounts: number;
    offhostNeverStored: number;
    lastOffhostRun: QueueRunFact | null;
    lastRestoreDrill: QueueRunFact | null;
  };
  errors: {
    ringSize: number;
    ringMax: number;
    top: Array<{
      action: string;
      level: string;
      count: number;
      lastSeen: string;
      errorClass: string;
    }>;
  };
}

// ─── Error classes ───────────────────────────────────────────────────────

/**
 * A short class for a failure text: never the message. Timeouts and lost
 * heartbeats by name, otherwise the thrown class (`TypeError`), a Prisma code
 * (`P2002`), a system code (`ECONNREFUSED`) or an HTTP status, whichever the
 * text names; plain `Error` when it names none.
 */
export function errorClassOf(text: string | null | undefined): string {
  if (!text) return "unknown";
  const trimmed = text.trim();
  if (/^(job timed out|handler execution exceeded)/i.test(trimmed)) {
    return "timeout";
  }
  if (/^job heartbeat timeout/i.test(trimmed)) return "heartbeat_timeout";
  const parts: string[] = [];
  const named = /^([A-Z][A-Za-z0-9]{1,60}(?:Error|Exception))\b/.exec(trimmed);
  if (named) parts.push(named[1]);
  // The database condition (`statement_timeout`, `lock_timeout`, ...): a
  // Prisma error carries it only as a SQLSTATE inside the message, and
  // without it a statement timeout read as the bare class "Error" (#1239).
  const condition = failureCondition(trimmed);
  if (condition) return [...parts, condition].join(" ");
  const code =
    /\b(P\d{4})\b/.exec(trimmed) ??
    /\b(E[A-Z][A-Z_]{2,30})\b/.exec(trimmed) ??
    /\b(?:HTTP|status)\s*:?\s*([1-5]\d{2})\b/i.exec(trimmed);
  if (code) parts.push(code[1]);
  return parts.length > 0 ? parts.join(" ") : "Error";
}

/** The class of a wide event's failure: thrown class and code, else its level. */
export function eventErrorClass(event: WideEvent): string {
  if (event.error) {
    const type = supportLine(event.error.type, 60) || "Error";
    const code =
      event.error.code !== undefined && event.error.code !== null
        ? supportLine(String(event.error.code), 40)
        : "";
    return code ? `${type} ${code}` : type;
  }
  const status = event.http?.status;
  return typeof status === "number" && status >= 400 ? `HTTP ${status}` : "-";
}

/** The name an event is grouped under: its action, else its kind and status. */
function eventActionName(event: WideEvent): string {
  const name = supportLine(event.action?.name, 80);
  if (name) return name;
  if (event.kind === "background") {
    return supportLine(event.background?.task_name, 80) || "background";
  }
  const status = event.http?.status;
  return `http ${event.http?.method ?? ""} ${status ?? ""}`
    .replace(/\s+/g, " ")
    .trim();
}

/** The most frequent warn/error actions in the problems ring. */
export function summariseProblemEvents(
  events: readonly WideEvent[],
  limit: number = SUPPORT_REPORT_TOP_ERRORS,
): SupportReportFacts["errors"]["top"] {
  const groups = new Map<
    string,
    {
      action: string;
      level: string;
      count: number;
      lastSeen: string;
      errorClass: string;
    }
  >();
  for (const event of events) {
    const action = eventActionName(event);
    const key = `${event.level}\u0000${action}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        action,
        level: event.level,
        count: 1,
        lastSeen: event.timestamp,
        errorClass: eventErrorClass(event),
      });
      continue;
    }
    existing.count += 1;
    if (event.timestamp > existing.lastSeen) {
      existing.lastSeen = event.timestamp;
      existing.errorClass = eventErrorClass(event);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit);
}

// ─── Collect ─────────────────────────────────────────────────────────────

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function runFact(run: LastQueueRun | null): QueueRunFact | null {
  if (!run) return null;
  return {
    at: run.at,
    state: run.state,
    errorClass: run.error ? errorClassOf(run.error) : null,
  };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function envSet(name: string): boolean {
  return (process.env[name] ?? "").trim().length > 0;
}

async function readDatabaseFacts(): Promise<SupportReportFacts["database"]> {
  const out: SupportReportFacts["database"] = {
    version: null,
    timezone: null,
    sizeBytes: null,
    lastMigration: null,
    lastMigrationAt: null,
    unfinishedMigrations: null,
  };
  try {
    const [row] = await prisma.$queryRaw<
      Array<{ version: string; timezone: string; size: bigint }>
    >`
      SELECT current_setting('server_version') AS version,
             current_setting('TimeZone') AS timezone,
             pg_database_size(current_database()) AS size
    `;
    if (row) {
      out.version = row.version;
      out.timezone = row.timezone;
      out.sizeBytes = Number(row.size);
    }
  } catch {
    /* reported as unknown */
  }
  try {
    const [last] = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null }>
    >`
      SELECT migration_name, finished_at
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at DESC, migration_name DESC
      LIMIT 1
    `;
    const [unfinished] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM _prisma_migrations
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
    `;
    out.lastMigration = last?.migration_name ?? null;
    out.lastMigrationAt = iso(last?.finished_at);
    out.unfinishedMigrations = unfinished?.count ?? null;
  } catch {
    /* no migrations table: reported as unknown */
  }
  return out;
}

async function readNewestFinishedJobAt(): Promise<string | null> {
  try {
    const [row] = await prisma.$queryRaw<Array<{ at: Date | null }>>`
      SELECT max(completed_on) AS at FROM pgboss.job WHERE state = 'completed'
    `;
    return iso(row?.at);
  } catch {
    return null;
  }
}

/** Read everything the report shows. Accounts leave here as numbers only. */
export async function collectSupportReportFacts(
  now: Date = new Date(),
): Promise<{ facts: SupportReportFacts; context: SupportRedactionContext }> {
  const users = await prisma.user.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      username: true,
      email: true,
      fullName: true,
      aiUsageLevel: true,
    },
  });
  const accountOf = new Map<string, number>();
  users.forEach((u, i) => accountOf.set(u.id, i + 1));
  const knownValues: string[] = [];
  for (const u of users) {
    knownValues.push(u.id, u.username);
    if (u.email) knownValues.push(u.email);
    if (u.fullName) knownValues.push(u.fullName);
  }

  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      glitchtipEnabled: true,
      glitchtipDsn: true,
      webPushVapidPublicKey: true,
      webPushVapidPrivateKeyEncrypted: true,
      adminAiKeyEncrypted: true,
      adminCodexConnectionStatus: true,
      aiUsageDefaultLevel: true,
      aiUsageMaxLevel: true,
    },
  });

  const providerTypes = await prisma.user.groupBy({
    by: ["aiProvider"],
    _count: { _all: true },
  });

  const config: Array<[string, string]> = [
    ["Secure cookie flag", yesNo(shouldEmitSecureCookie())],
    ["OIDC sign-in", yesNo(isOidcConfigured())],
    ["OIDC only", yesNo(isOidcOnly())],
    ["Loki", yesNo(Boolean(getLoggingConfig().lokiEndpoint))],
    [
      "GlitchTip",
      yesNo(Boolean(appSettings?.glitchtipEnabled && appSettings.glitchtipDsn)),
    ],
    ["Off-host backup", yesNo(offhostBackupConfigured())],
    [
      "APNs",
      yesNo(
        envSet("APNS_KEY_ID") &&
          envSet("APNS_TEAM_ID") &&
          envSet("APNS_BUNDLE_ID") &&
          (envSet("APNS_KEY_B64") ||
            envSet("APNS_KEY") ||
            envSet("APNS_KEY_FILE")),
      ),
    ],
    [
      "Web Push (VAPID)",
      yesNo(
        Boolean(
          appSettings?.webPushVapidPublicKey &&
          appSettings.webPushVapidPrivateKeyEncrypted,
        ) ||
          (envSet("VAPID_PUBLIC_KEY") && envSet("VAPID_PRIVATE_KEY")),
      ),
    ],
    ["SMTP", yesNo(isEmailConfigured())],
    ["GeoLite2 databases", yesNo(offlineGeoReady())],
    [
      "NOTIFICATION_PRIVATE_ORIGINS entries",
      String(configuredNotificationPrivateOrigins().size),
    ],
    ["Operator AI key", yesNo(Boolean(appSettings?.adminAiKeyEncrypted))],
    [
      "Central Codex connected",
      yesNo(appSettings?.adminCodexConnectionStatus === "connected"),
    ],
    [
      "AI provider types chosen by accounts",
      providerTypes
        .filter((row) => row.aiProvider)
        .map((row) => `${supportLine(row.aiProvider, 30)} ${row._count._all}`)
        .sort()
        .join(", ") || "none",
    ],
    ["Demo mode", yesNo(process.env.DEMO_MODE === "true")],
  ];

  const workerStatus = getWorkerStatus();
  const [database, failing, newestFinishedJobAt] = await Promise.all([
    readDatabaseFacts(),
    readFailingQueues(JOB_FAILURE_WINDOW_HOURS),
    readNewestFinishedJobAt(),
  ]);

  // Connections: one health read per account, capped.
  const readUsers = users.slice(0, SUPPORT_REPORT_ACCOUNT_CAP);
  const connectionGroups = new Map<
    string,
    { provider: string; state: string; reason: string; accounts: number[] }
  >();
  for (const user of readUsers) {
    let health;
    try {
      health = await loadConnectionHealth(user.id);
    } catch {
      continue;
    }
    for (const key of CONNECTION_KEYS) {
      const h = health[key];
      if (!h) continue;
      const groupKey = `${key}|${h.state}|${h.reason}`;
      const group = connectionGroups.get(groupKey) ?? {
        provider: key,
        state: h.state,
        reason: h.reason,
        accounts: [],
      };
      group.accounts.push(accountOf.get(user.id) ?? 0);
      connectionGroups.set(groupKey, group);
    }
  }

  const incidentRows = await prisma.integrationWatch.findMany({
    where: { incidentReason: { not: null } },
    select: {
      userId: true,
      integration: true,
      incidentReason: true,
      incidentOpenedAt: true,
      alertedAt: true,
    },
    orderBy: { incidentOpenedAt: "desc" },
    take: 100,
  });

  const providerRows = await prisma.providerHealth.findMany({
    select: {
      providerType: true,
      lastResult: true,
      lastStatus: true,
      lastFailureAt: true,
      nextRetryAt: true,
    },
  });
  const providers = new Map<
    string,
    SupportReportFacts["ai"]["providers"][number]
  >();
  for (const row of providerRows) {
    const p = providers.get(row.providerType) ?? {
      provider: row.providerType,
      ok: 0,
      failing: 0,
      authFailed: 0,
      paused: 0,
      lastFailureAt: null,
      lastStatus: null,
    };
    if (row.lastResult === "ok") p.ok += 1;
    else if (row.lastResult === "auth_failed") p.authFailed += 1;
    else p.failing += 1;
    if (row.nextRetryAt && row.nextRetryAt.getTime() > now.getTime()) {
      p.paused += 1;
    }
    const failedAt = iso(row.lastFailureAt);
    if (failedAt && (!p.lastFailureAt || failedAt > p.lastFailureAt)) {
      p.lastFailureAt = failedAt;
      p.lastStatus = row.lastStatus;
    }
    providers.set(row.providerType, p);
  }

  const levelCounts = new Map<string, number>();
  for (const u of users) {
    const level = u.aiUsageLevel ?? "instance default";
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
  }

  const since = new Date(
    now.getTime() - SUPPORT_REPORT_NOTIFICATION_DAYS * 24 * 60 * 60 * 1000,
  );
  const [attemptCounts, reasonCounts] = await Promise.all([
    prisma.pushAttempt.groupBy({
      by: ["channel", "result"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.pushAttempt.groupBy({
      by: ["channel", "reason"],
      where: { createdAt: { gte: since }, result: { not: "ok" } },
      _count: { _all: true },
    }),
  ]);
  const channels = new Map<
    string,
    SupportReportFacts["notifications"][number]
  >();
  const channelOf = (channel: string) => {
    const c = channels.get(channel) ?? {
      channel,
      ok: 0,
      error: 0,
      skipped: 0,
      topReasons: [],
    };
    channels.set(channel, c);
    return c;
  };
  for (const row of attemptCounts) {
    const c = channelOf(row.channel);
    if (row.result === "ok") c.ok += row._count._all;
    else if (row.result === "error") c.error += row._count._all;
    else c.skipped += row._count._all;
  }
  for (const row of reasonCounts) {
    channelOf(row.channel).topReasons.push([
      supportLine(row.reason ?? "unspecified", 60),
      row._count._all,
    ]);
  }
  for (const c of channels.values()) {
    c.topReasons = c.topReasons.sort((a, b) => b[1] - a[1]).slice(0, 3);
  }

  const [
    localAggregate,
    localCopies,
    offhostRows,
    lastLocalRun,
    lastOffhostRun,
    lastDrill,
  ] = await Promise.all([
    prisma.dataBackup.aggregate({ _max: { createdAt: true } }),
    prisma.dataBackup.count(),
    prisma.offhostBackupState.findMany({ select: { lastSuccessAt: true } }),
    readLastQueueRun(DATA_BACKUP_QUEUE),
    readLastQueueRun(OFFHOST_BACKUP_QUEUE),
    readLastQueueRun(RESTORE_DRILL_QUEUE),
  ]);
  const offhostDates = offhostRows
    .map((r) => r.lastSuccessAt)
    .filter((d): d is Date => d !== null)
    .map((d) => d.toISOString())
    .sort();

  const problemEvents = readLogBuffer({ ring: "problems" });

  const facts: SupportReportFacts = {
    generatedAt: now.toISOString(),
    build: {
      version:
        process.env.NEXT_PUBLIC_APP_VERSION?.trim() || packageJson.version,
      buildSha: process.env.NEXT_PUBLIC_APP_BUILD_SHA?.trim() || null,
      builtAt: process.env.NEXT_PUBLIC_APP_BUILT_AT?.trim() || null,
      node: process.version,
      processType: getProcessType(),
      heapLimitMb: heapLimitMb(),
      containerMemoryLimitMb: containerMemoryLimitMb(),
      uptimeSeconds: Math.round(process.uptime()),
    },
    database,
    config,
    jobs: {
      workerInThisProcess: shouldRunWorker(),
      workerRunning: workerStatus.running,
      workerLastHeartbeat: workerStatus.lastHeartbeat,
      newestFinishedJobAt,
      failing:
        failing === null
          ? null
          : failing.map((q) => ({
              queue: q.queue,
              failures: q.failures,
              lastFailedAt: q.lastFailedAt,
              errorClass: errorClassOf(q.lastError),
            })),
    },
    accounts: { total: users.length, read: readUsers.length },
    connections: [...connectionGroups.values()].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.state.localeCompare(b.state) ||
        a.reason.localeCompare(b.reason),
    ),
    incidents: incidentRows.map((row) => ({
      provider: row.integration,
      reason: row.incidentReason ?? "",
      openedAt: iso(row.incidentOpenedAt),
      announced: row.alertedAt !== null,
      account: accountOf.get(row.userId) ?? null,
    })),
    ai: {
      defaultLevel: appSettings?.aiUsageDefaultLevel ?? null,
      maxLevel: appSettings?.aiUsageMaxLevel ?? null,
      levels: [...levelCounts.entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      ),
      providers: [...providers.values()].sort((a, b) =>
        a.provider.localeCompare(b.provider),
      ),
    },
    notifications: [...channels.values()].sort((a, b) =>
      a.channel.localeCompare(b.channel),
    ),
    backups: {
      newestLocalAt: iso(localAggregate._max.createdAt),
      localCopies,
      lastLocalRun: runFact(lastLocalRun),
      offhostConfigured: offhostBackupConfigured(),
      offhostNewestAt: offhostDates.at(-1) ?? null,
      offhostOldestAt: offhostDates[0] ?? null,
      offhostAccounts: offhostRows.length,
      offhostNeverStored: offhostRows.length - offhostDates.length,
      lastOffhostRun: runFact(lastOffhostRun),
      lastRestoreDrill: runFact(lastDrill),
    },
    errors: {
      ringSize: problemEvents.length,
      ringMax: PROBLEMS_BUFFER_MAX,
      top: summariseProblemEvents(problemEvents),
    },
  };

  return { facts, context: { knownValues } };
}

// ─── Render ──────────────────────────────────────────────────────────────

function or(value: string | number | null | undefined, fallback = "unknown") {
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

function sizeLine(bytes: number | null): string {
  return bytes === null ? "unknown" : `${megabytes(bytes)} MB`;
}

function runLine(run: QueueRunFact | null): string {
  if (!run) return "no run on record";
  return run.errorClass
    ? `${run.state} at ${run.at} (${run.errorClass})`
    : `${run.state} at ${run.at}`;
}

function accountList(accounts: readonly number[]): string {
  const sorted = [...accounts].sort((a, b) => a - b);
  const shown = sorted.slice(0, 10).map((n) => `Account ${n}`);
  const more = sorted.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/** The report as plain text, before redaction. */
export function renderSupportReport(facts: SupportReportFacts): string {
  const lines: string[] = [];
  const section = (title: string) => {
    if (lines.length > 0) lines.push("");
    lines.push(`## ${title}`);
  };
  const row = (label: string, value: string | number | null) =>
    lines.push(`- ${label}: ${or(value)}`);

  lines.push("# HealthLog support report");
  lines.push(`Generated: ${facts.generatedAt}`);

  section("Build");
  row("Version", facts.build.version);
  row("Build SHA", facts.build.buildSha);
  row("Built at", facts.build.builtAt);
  row("Node", facts.build.node);
  row("Process type", facts.build.processType);
  row(
    "Container memory limit",
    facts.build.containerMemoryLimitMb === null
      ? "none or unreadable"
      : `${facts.build.containerMemoryLimitMb} MB`,
  );
  if (isBelowMemoryFloor(facts.build.containerMemoryLimitMb)) {
    row(
      "Memory note",
      `Below the supported floor. ${memoryFloorAdvice(facts.build.containerMemoryLimitMb as number)}`,
    );
  }
  row("Heap limit", `${facts.build.heapLimitMb} MB`);
  if (isHeapLimitLow(facts.build.heapLimitMb)) {
    row("Heap limit note", lowHeapLimitAdvice(facts.build.heapLimitMb));
  }
  row(
    "Uptime",
    `${Math.floor(facts.build.uptimeSeconds / 3600)} h ${Math.floor((facts.build.uptimeSeconds % 3600) / 60)} min`,
  );

  section("Database");
  row("PostgreSQL", facts.database.version);
  row("Server time zone", facts.database.timezone);
  row("Size", sizeLine(facts.database.sizeBytes));
  row(
    "Last migration",
    facts.database.lastMigration
      ? `${facts.database.lastMigration} (${or(facts.database.lastMigrationAt)})`
      : null,
  );
  row("Unfinished migrations", facts.database.unfinishedMigrations);

  section("Configuration");
  for (const [label, value] of facts.config) row(label, value);

  section("Jobs");
  row("Worker in this process", yesNo(facts.jobs.workerInThisProcess));
  if (facts.jobs.workerInThisProcess) {
    row("Worker running", yesNo(facts.jobs.workerRunning));
    row("Worker last heartbeat", facts.jobs.workerLastHeartbeat);
  }
  row("Newest finished job", facts.jobs.newestFinishedJobAt);
  if (facts.jobs.failing === null) {
    row(
      `Failed jobs (${JOB_FAILURE_WINDOW_HOURS} h)`,
      "queue tables not readable",
    );
  } else if (facts.jobs.failing.length === 0) {
    row(`Failed jobs (${JOB_FAILURE_WINDOW_HOURS} h)`, "none");
  } else {
    lines.push(`- Failed jobs (${JOB_FAILURE_WINDOW_HOURS} h):`);
    for (const q of facts.jobs.failing) {
      lines.push(
        `  - ${supportLine(q.queue, 60)}: ${q.failures} failed, last ${q.lastFailedAt} (${q.errorClass})`,
      );
    }
  }

  section("Connections");
  row(
    "Accounts",
    facts.accounts.read < facts.accounts.total
      ? `${facts.accounts.total} (connections read for the oldest ${facts.accounts.read})`
      : facts.accounts.total,
  );
  if (facts.connections.length === 0) {
    row("Connected sources", "none");
  } else {
    for (const c of facts.connections) {
      const who = c.state === "ok" ? "" : ` (${accountList(c.accounts)})`;
      lines.push(
        `- ${c.provider}: ${c.state} / ${c.reason}: ${c.accounts.length}${who}`,
      );
    }
  }
  if (facts.incidents.length === 0) {
    row("Open watchdog incidents", "none");
  } else {
    lines.push("- Open watchdog incidents:");
    for (const i of facts.incidents) {
      lines.push(
        `  - ${supportLine(i.provider, 40)}: ${supportLine(i.reason, 40)} since ${or(i.openedAt)}, ${i.announced ? "announced" : "not announced"}${i.account ? `, Account ${i.account}` : ""}`,
      );
    }
  }

  section("AI");
  row("Usage level default", facts.ai.defaultLevel);
  row("Usage level ceiling", facts.ai.maxLevel);
  row(
    "Accounts by usage level",
    facts.ai.levels.map(([level, n]) => `${level} ${n}`).join(", ") || "none",
  );
  if (facts.ai.providers.length === 0) {
    row("Provider ledger", "empty");
  } else {
    lines.push("- Provider ledger (accounts):");
    for (const p of facts.ai.providers) {
      const last = p.lastFailureAt
        ? `, last failure ${p.lastFailureAt}${p.lastStatus ? ` (HTTP ${p.lastStatus})` : ""}`
        : "";
      lines.push(
        `  - ${supportLine(p.provider, 30)}: ok ${p.ok}, failing ${p.failing}, credential refused ${p.authFailed}, paused ${p.paused}${last}`,
      );
    }
  }

  section(`Notifications (${SUPPORT_REPORT_NOTIFICATION_DAYS} days)`);
  if (facts.notifications.length === 0) {
    row("Delivery attempts", "none");
  } else {
    for (const c of facts.notifications) {
      const reasons =
        c.topReasons.length > 0
          ? `; ${c.topReasons.map(([r, n]) => `${r} ${n}`).join(", ")}`
          : "";
      lines.push(
        `- ${supportLine(c.channel, 20)}: ok ${c.ok}, failed ${c.error}, skipped ${c.skipped}${reasons}`,
      );
    }
  }

  section("Backups");
  row("Newest in-database copy", facts.backups.newestLocalAt ?? "none");
  row("In-database copies", facts.backups.localCopies);
  row("Last weekly run", runLine(facts.backups.lastLocalRun));
  row("Off-host configured", yesNo(facts.backups.offhostConfigured));
  if (facts.backups.offhostAccounts > 0) {
    row("Off-host newest", facts.backups.offhostNewestAt ?? "none");
    row(
      "Off-host oldest account copy",
      facts.backups.offhostOldestAt ?? "none",
    );
    row(
      "Off-host accounts never stored",
      `${facts.backups.offhostNeverStored} of ${facts.backups.offhostAccounts}`,
    );
  }
  row("Last off-host run", runLine(facts.backups.lastOffhostRun));
  row("Last restore drill", runLine(facts.backups.lastRestoreDrill));

  section("Recent warnings and errors (this process)");
  row(
    "Problems ring",
    `${facts.errors.ringSize} of ${facts.errors.ringMax} entries`,
  );
  if (facts.errors.top.length === 0) {
    row("Top actions", "none");
  } else {
    for (const e of facts.errors.top) {
      lines.push(
        `- ${e.level} ${e.action}: ${e.count}x, last ${e.lastSeen}, ${e.errorClass}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Facts to finished, redacted text. */
export function buildSupportReportText(
  facts: SupportReportFacts,
  context: SupportRedactionContext,
): string {
  return redactSupportText(renderSupportReport(facts), context);
}
