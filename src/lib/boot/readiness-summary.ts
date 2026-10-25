/**
 * First-boot readiness summary.
 *
 * The bundled image promises "single `docker compose up`", but the reality is
 * three hand-generated secrets plus a handful of optional subsystems — and the
 * crypto loader is fail-closed, so a missing/short `ENCRYPTION_KEY` throws a
 * stack trace on first use rather than a sentence an operator can act on. This
 * module inspects the environment ONCE at boot and prints a compact,
 * human-readable readiness block: a clear line per core secret (with the exact
 * `openssl` fix on a bad one) before anything throws, plus a one-glance status
 * of the optional channels.
 *
 * It NEVER logs a secret value — only presence + shape validity. It never
 * throws: the fail-closed loaders remain the real gate; this is a friendlier
 * signpost in front of them.
 */

import {
  LEGACY_ANY_HOST_WARNING,
  legacyAnyHostConfigured,
} from "@/lib/ai/local-host-allowlist";
import {
  backupDirectoryStatus,
  databaseBackupEnabled,
  resolveBackupDir,
  resolveBackupSchedule,
  resolveDailyKeep,
  type BackupDirectoryStatus,
} from "@/lib/database-backup/dump-core.mjs";

export interface ReadinessLine {
  /** Short label, e.g. "ENCRYPTION_KEY". */
  label: string;
  /** ok = green, warn = optional-not-configured, error = missing/invalid core. */
  status: "ok" | "warn" | "error";
  /** One-line human detail (no secret material). */
  detail: string;
}

export interface ReadinessReport {
  lines: ReadinessLine[];
  /** True when at least one core secret is missing or malformed. */
  hasBlocker: boolean;
}

type Env = Record<string, string | undefined>;

/** A 64-char hex string (= 32 bytes) or a base64 string that decodes to 32 bytes. */
function isValid32ByteKey(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return true;
  if (/^[A-Za-z0-9+/=]+$/.test(v)) {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  }
  return false;
}

function allSet(env: Env, keys: string[]): boolean {
  return keys.every((k) => (env[k] ?? "").trim().length > 0);
}

function anySet(env: Env, keys: string[]): boolean {
  return keys.some((k) => (env[k] ?? "").trim().length > 0);
}

/**
 * The nightly database dump's line. The dump is what rebuilds a lost server,
 * so a host where it cannot be kept anywhere is said out loud at every boot,
 * and so is one where it only goes off-host.
 */
export function databaseBackupReadiness(
  env: Env,
  directoryStatus: (dir: string) => BackupDirectoryStatus,
): ReadinessLine[] {
  const label = "Database dump";
  if (!databaseBackupEnabled(env)) {
    return [
      {
        label,
        status: "warn",
        detail:
          "DB_BACKUP_ENABLED=false: no nightly database dump is taken; back the database up another way",
      },
    ];
  }
  const lines: ReadinessLine[] = [];
  const schedule = resolveBackupSchedule(env);
  if (!schedule.valid) {
    lines.push({
      label: "DB_BACKUP_SCHEDULE",
      status: "warn",
      detail: `not a five-field cron; using ${schedule.cron}`,
    });
  }
  const dir = resolveBackupDir(env);
  const offhost = allSet(env, [
    "BACKUP_S3_ENDPOINT",
    "BACKUP_S3_BUCKET",
    "BACKUP_S3_ACCESS_KEY",
    "BACKUP_S3_SECRET_KEY",
    "BACKUP_ENCRYPTION_KEY",
  ]);
  const status = directoryStatus(dir);
  if (status.persistent) {
    lines.push({
      label,
      status: "ok",
      detail: `nightly (${schedule.cron}) into ${dir}, keeping ${resolveDailyKeep(env)}${offhost ? ", copied off-host" : ""}`,
    });
    return lines;
  }
  // Writable but thrown away with the container (the image's own directory
  // without the volume) or at a restart (a tmpfs): no dump is kept there,
  // because one that is would be counted as kept and then lost.
  const where = !status.writable
    ? `${dir} is not writable`
    : status.reason === "memory"
      ? `${dir} is in memory (tmpfs), so a dump there is lost at the next restart`
      : `${dir} is inside the container, not on a mounted volume, so a dump there is lost at the next update`;
  const fix =
    "Mount the backups volume (see docker-compose.yml) or set DB_BACKUP_DIR to a mounted directory";
  lines.push({
    label,
    status: "warn",
    detail: offhost
      ? `${where}: the nightly dump goes off-host only, none is kept on this server and none is taken before a migration. ${fix}`
      : `${where} and no off-host bucket is configured: no database dump is kept anywhere. ${fix}`,
  });
  return lines;
}

/**
 * Inspect the environment and build the readiness report. Pure apart from
 * `directoryStatus`, the probe of the dump directory, which tests replace.
 */
export function collectReadiness(
  env: Env = process.env,
  directoryStatus: (
    dir: string,
  ) => BackupDirectoryStatus = backupDirectoryStatus,
): ReadinessReport {
  const lines: ReadinessLine[] = [];

  // --- Core secrets (boot blockers) ---------------------------------------
  // Encryption: the map form (ENCRYPTION_KEYS) supersedes the single key.
  const keysMap = (env.ENCRYPTION_KEYS ?? "").trim();
  let encryptionOk = false;
  if (keysMap) {
    try {
      const parsed = JSON.parse(keysMap) as Record<string, string>;
      const entries = Object.values(parsed ?? {});
      encryptionOk =
        entries.length > 0 && entries.every((v) => isValid32ByteKey(v));
    } catch {
      encryptionOk = false;
    }
    lines.push({
      label: "ENCRYPTION_KEYS",
      status: encryptionOk ? "ok" : "error",
      detail: encryptionOk
        ? "key-rotation map present and valid"
        : "ENCRYPTION_KEYS is not a JSON map of valid 32-byte keys",
    });
  } else {
    encryptionOk = isValid32ByteKey(env.ENCRYPTION_KEY);
    lines.push({
      label: "ENCRYPTION_KEY",
      status: encryptionOk ? "ok" : "error",
      detail: encryptionOk
        ? "present (64 hex chars)"
        : "missing or not 64 hex chars — generate with: openssl rand -hex 32",
    });
  }

  const hmacOk = isValid32ByteKey(env.API_TOKEN_HMAC_KEY);
  lines.push({
    label: "API_TOKEN_HMAC_KEY",
    status: hmacOk ? "ok" : "error",
    detail: hmacOk
      ? "present (64 hex chars)"
      : "missing or not 64 hex chars — generate with: openssl rand -hex 32",
  });

  const dbOk = (env.DATABASE_URL ?? "").trim().length > 0;
  lines.push({
    label: "DATABASE_URL",
    status: dbOk ? "ok" : "error",
    detail: dbOk
      ? "present"
      : "missing — the bundled compose derives it from POSTGRES_PASSWORD",
  });

  // --- Transport hint (a warning, never a blocker) ------------------------
  const secureOverride = (env.SESSION_COOKIE_SECURE ?? "").trim().toLowerCase();
  const secureFlagOn =
    secureOverride === "true" ||
    (secureOverride !== "false" && env.NODE_ENV === "production");
  lines.push({
    label: "SESSION_COOKIE_SECURE",
    status: "ok",
    detail: secureFlagOn
      ? "Secure cookie flag ON — serve HTTPS, or set SESSION_COOKIE_SECURE=false for a plain-HTTP LAN host"
      : "Secure cookie flag OFF — fine for plain-HTTP LAN; do NOT expose plain HTTP to the internet",
  });

  // --- Deprecated AI grant (a warning, never a blocker) -------------------
  // `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` used to open every private host on
  // the network to every user's AI base URL. Since v1.39.3 it only covers the
  // operator's own AI configurations and is on its way out; this line names
  // the replacement. The admin AI settings page lists the origins in use.
  if (legacyAnyHostConfigured(env)) {
    lines.push({
      label: "ALLOW_LOCAL_AI_PRIVATE_HOSTS",
      status: "warn",
      detail: LEGACY_ANY_HOST_WARNING,
    });
  }

  lines.push(...databaseBackupReadiness(env, directoryStatus));

  // --- Optional subsystems (informational) --------------------------------
  const optional: Array<[string, boolean]> = [
    ["SMTP (email)", allSet(env, ["SMTP_HOST", "SMTP_PORT", "SMTP_FROM"])],
    [
      "Off-host backup",
      allSet(env, [
        "BACKUP_S3_ENDPOINT",
        "BACKUP_S3_BUCKET",
        "BACKUP_S3_ACCESS_KEY",
        "BACKUP_S3_SECRET_KEY",
        "BACKUP_ENCRYPTION_KEY",
      ]),
    ],
    [
      "APNs (native iOS push)",
      allSet(env, ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID"]) &&
        anySet(env, ["APNS_KEY_B64", "APNS_KEY", "APNS_KEY_FILE"]),
    ],
    [
      "Web Push (VAPID env)",
      allSet(env, ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]),
    ],
  ];
  for (const [label, configured] of optional) {
    lines.push({
      label,
      status: configured ? "ok" : "warn",
      detail: configured ? "configured" : "not configured (optional)",
    });
  }

  const hasBlocker = lines.some((l) => l.status === "error");
  return { lines, hasBlocker };
}

const GLYPH: Record<ReadinessLine["status"], string> = {
  ok: "✓",
  warn: "·",
  error: "✗",
};

/** Render the report as a compact multi-line block. */
export function formatReadiness(report: ReadinessReport): string {
  const body = report.lines
    .map((l) => `  ${GLYPH[l.status]} ${l.label}: ${l.detail}`)
    .join("\n");
  const header = report.hasBlocker
    ? "HealthLog boot readiness — CORE SECRET MISSING/INVALID (see ✗ below):"
    : "HealthLog boot readiness:";
  return `${header}\n${body}`;
}

/**
 * Collect + print the readiness summary. Blockers go to stderr (they precede a
 * fail-closed throw), the healthy summary to stdout. Never throws.
 */
export function logReadinessSummary(
  env: Env = process.env,
  log: Pick<Console, "log" | "error"> = console,
): ReadinessReport {
  try {
    const report = collectReadiness(env);
    const text = formatReadiness(report);
    if (report.hasBlocker) {
      log.error(text);
    } else {
      log.log(text);
    }
    return report;
  } catch {
    // A readiness summary must never be the thing that breaks boot.
    return { lines: [], hasBlocker: false };
  }
}
