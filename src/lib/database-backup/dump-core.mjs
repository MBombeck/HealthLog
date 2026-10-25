/**
 * The whole-database dump: naming, writing, checking, keeping and reading it
 * back. One module for three callers that cannot share TypeScript:
 *
 *   - the nightly job in the app (`src/lib/database-backup/run.ts`), bundled;
 *   - the pre-migration dump the entrypoint takes (`scripts/db-dump.mjs`);
 *   - the restore (`scripts/db-restore.mjs`), which runs in the image with
 *     plain `node` on a server that has nothing but the dump and the keys.
 *
 * It is plain ESM with no imports beyond Node and `pg`, for the same reason
 * `src/lib/auth/argon2-params.mjs` is: the production image strips `tsx`, and
 * a restore that needs a source checkout is not a restore. Every rule that
 * decides whether a dump is good, which files may be deleted and whether the
 * keys fit lives here once, so the writer and the reader cannot drift.
 *
 * What a dump is: `pg_dump --format=custom` of the whole database (every
 * schema, pg-boss included), named `healthlog-<UTC timestamp>-<kind>.dump`,
 * with `healthlog-<UTC timestamp>-<kind>.manifest.json` beside it. A dump is
 * good only when both exist under their final names: the archive is written
 * as `.partial`, read back with `pg_restore --list`, the manifest is written
 * and renamed first, and the archive is renamed last. A run that dies at any
 * point leaves nothing that looks good.
 *
 * The row counts in the manifest come from the same snapshot `pg_dump` reads
 * (`pg_export_snapshot()` + `--snapshot`), so a dump taken while the app is
 * writing still restores to exactly the counts it claims.
 */
import { spawn } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/** Where dumps are written when `DB_BACKUP_DIR` is unset. */
export const DEFAULT_BACKUP_DIR = "/var/lib/healthlog/backups";

/** Daily dumps kept when `DB_BACKUP_KEEP` is unset. */
export const DEFAULT_DAILY_KEEP = 7;

/** Pre-migration dumps kept: the one before this update and the one before. */
export const PRE_MIGRATION_KEEP = 2;

/** The cron the nightly dump runs on when `DB_BACKUP_SCHEDULE` is unset. */
export const DEFAULT_BACKUP_SCHEDULE = "30 1 * * *";

/** The kinds of dump this module writes. */
export const DUMP_KINDS = /** @type {const} */ (["daily", "pre-migration"]);

/** The manifest's own format marker. */
export const MANIFEST_FORMAT = "healthlog-database-dump";
export const MANIFEST_FORMAT_VERSION = 1;

/** The bucket prefix off-host database dumps live under. */
export const OFFHOST_DATABASE_PREFIX = "database/";

/**
 * A leftover `.partial` or an orphaned manifest younger than this may belong
 * to a run that is still going (another container, the entrypoint), so it is
 * left alone.
 */
const STALE_LEFTOVER_MS = 12 * 60 * 60 * 1000;

const NAME_PATTERN =
  /^healthlog-(\d{8}T\d{6}Z)-(daily|pre-migration)\.(dump|manifest\.json)(\.partial|\.enc)?$/;

/**
 * @typedef {"daily" | "pre-migration"} DumpKind
 * @typedef {{
 *   base: string;
 *   kind: DumpKind;
 *   timestamp: Date;
 *   role: "dump" | "manifest";
 *   variant: "final" | "partial" | "encrypted";
 * }} ParsedDumpName
 */

/** `20261025T013000Z` for an instant, in UTC. */
export function formatDumpTimestamp(date) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

/**
 * The shared stem of a dump and its manifest.
 *
 * @param {DumpKind} kind
 * @param {Date} date
 */
export function dumpBaseName(kind, date) {
  return `healthlog-${formatDumpTimestamp(date)}-${kind}`;
}

/** @param {string} base */
export function dumpFileName(base) {
  return `${base}.dump`;
}

/** @param {string} base */
export function manifestFileName(base) {
  return `${base}.manifest.json`;
}

/**
 * Parse a file name this module writes. Anything else answers null, which is
 * what keeps retention away from files it did not write.
 *
 * @param {string} name
 * @returns {ParsedDumpName | null}
 */
export function parseDumpFileName(name) {
  const m = NAME_PATTERN.exec(name);
  if (!m) return null;
  const [, stamp, kind, role, suffix] = m;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime())) return null;
  return {
    base: `healthlog-${stamp}-${kind}`,
    kind: /** @type {DumpKind} */ (kind),
    timestamp,
    role: role === "dump" ? "dump" : "manifest",
    variant:
      suffix === ".partial"
        ? "partial"
        : suffix === ".enc"
          ? "encrypted"
          : "final",
  };
}

// ── Configuration ──────────────────────────────────────────────────────────

/** @typedef {Record<string, string | undefined>} Env */

/** @param {string | undefined} raw */
function isOff(raw) {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "false" || v === "0" || v === "no" || v === "off";
}

/** `DB_BACKUP_ENABLED`, on unless it says off. @param {Env} env */
export function databaseBackupEnabled(env = process.env) {
  return !isOff(env.DB_BACKUP_ENABLED);
}

/** `DB_BACKUP_BEFORE_MIGRATE`, on unless it says off. @param {Env} env */
export function preMigrationDumpEnabled(env = process.env) {
  return !isOff(env.DB_BACKUP_BEFORE_MIGRATE);
}

/** `DB_BACKUP_DIR`, or the image's default. @param {Env} env */
export function resolveBackupDir(env = process.env) {
  return (env.DB_BACKUP_DIR ?? "").trim() || DEFAULT_BACKUP_DIR;
}

/**
 * `DB_BACKUP_KEEP`: how many daily dumps stay on disk. At least one, so the
 * newest good dump is never deleted; a value that is not a whole number
 * keeps the default.
 *
 * @param {Env} env
 */
export function resolveDailyKeep(env = process.env) {
  const raw = (env.DB_BACKUP_KEEP ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_DAILY_KEEP;
  return Math.min(Math.max(Number.parseInt(raw, 10), 1), 366);
}

const CRON_FIELD = /^[0-9*,/-]+$/;

/**
 * `DB_BACKUP_SCHEDULE` when it is a five-field cron of digits, `*`, `,`, `/`
 * and `-`, otherwise the default. `valid` says which, so the boot summary can
 * name a schedule it ignored.
 *
 * @param {Env} env
 * @returns {{ cron: string; valid: boolean; configured: boolean }}
 */
export function resolveBackupSchedule(env = process.env) {
  const raw = (env.DB_BACKUP_SCHEDULE ?? "").trim();
  if (!raw) {
    return { cron: DEFAULT_BACKUP_SCHEDULE, valid: true, configured: false };
  }
  const fields = raw.split(/\s+/);
  const valid = fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
  return {
    cron: valid ? fields.join(" ") : DEFAULT_BACKUP_SCHEDULE,
    valid,
    configured: true,
  };
}

/**
 * Whether `dir` exists (or can be created) and this process may write in it.
 * Never throws.
 *
 * @param {string} dir
 */
export function isWritableDirectory(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Whether a dump kept there survives ─────────────────────────────────────

/**
 * File systems that live in memory: a dump on one is gone at the next restart.
 */
const EPHEMERAL_FS_TYPES = new Set(["tmpfs", "ramfs"]);

/**
 * cgroup paths that name a container runtime (cgroup v1; under v2 a container
 * sees `0::/`, and the marker files or the root mount answer instead).
 */
const CONTAINER_CGROUP = /\/(docker|kubepods|containerd|libpod|podman)[/-]/;

/**
 * @typedef {{ mountPoint: string; fsType: string }} MountEntry
 */

/** Undo the octal escapes the kernel writes for space, tab, newline, `\`. */
function unescapeMountPath(raw) {
  return raw.replace(/\\([0-7]{3})/g, (_, oct) =>
    String.fromCharCode(Number.parseInt(oct, 8)),
  );
}

/**
 * The mount points and file system types in `/proc/self/mountinfo` text.
 * Lines that do not have the documented shape are skipped.
 *
 * @param {string} text
 * @returns {MountEntry[]}
 */
export function parseMountInfo(text) {
  /** @type {MountEntry[]} */
  const mounts = [];
  for (const line of text.split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(" ");
    const right = line.slice(sep + 3).split(" ");
    if (left.length < 6 || !right[0]) continue;
    mounts.push({ mountPoint: unescapeMountPath(left[4]), fsType: right[0] });
  }
  return mounts;
}

/**
 * The mount `path` lives on: the longest mount point that is `path` or one of
 * its parents. A later entry for the same point wins, as it covers the earlier
 * one. Null when nothing matches (no `/` in the list).
 *
 * @param {string} path an absolute path, symlinks resolved
 * @param {MountEntry[]} mounts
 * @returns {MountEntry | null}
 */
export function mountContaining(path, mounts) {
  /** @type {MountEntry | null} */
  let best = null;
  for (const mount of mounts) {
    const point = mount.mountPoint;
    const covers =
      point === "/" ||
      path === point ||
      path.startsWith(point.endsWith("/") ? point : `${point}/`);
    if (covers && (best === null || point.length >= best.mountPoint.length)) {
      best = mount;
    }
  }
  return best;
}

/**
 * @typedef {{
 *   writable: (dir: string) => boolean;
 *   realpath: (path: string) => string;
 *   readText: (path: string) => string | null;
 *   exists: (path: string) => boolean;
 *   device: (path: string) => number | null;
 *   env: Env;
 * }} DirectoryProbe
 */

/** @type {DirectoryProbe} */
const SYSTEM_PROBE = {
  writable: isWritableDirectory,
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists: (path) => existsSync(path),
  device: (path) => {
    try {
      return statSync(path).dev;
    } catch {
      return null;
    }
  },
  env: process.env,
};

/**
 * Whether this process runs in a container whose root file system is thrown
 * away when the container is replaced: Docker (`/.dockerenv`), Podman
 * (`/run/.containerenv`), Kubernetes, a container cgroup, or a root file
 * system that is an overlay. A host, a VM or a system container with a disk
 * of its own answers false.
 *
 * @param {DirectoryProbe} probe
 * @param {MountEntry[] | null} mounts
 */
export function runsInContainer(probe, mounts) {
  if (probe.exists("/.dockerenv") || probe.exists("/run/.containerenv")) {
    return true;
  }
  if ((probe.env.KUBERNETES_SERVICE_HOST ?? "").trim()) return true;
  if (CONTAINER_CGROUP.test(probe.readText("/proc/self/cgroup") ?? "")) {
    return true;
  }
  const root = mounts ? mountContaining("/", mounts) : null;
  return root?.mountPoint === "/" && root.fsType === "overlay";
}

/**
 * @typedef {{
 *   writable: boolean;
 *   persistent: boolean;
 *   reason: "volume" | "host" | "container_layer" | "memory" | "not_writable";
 * }} BackupDirectoryStatus
 */

/**
 * Whether a dump written to `dir` is still there after the container is
 * replaced, which is what "kept on this server" promises.
 *
 *   volume          — in a container, on a mount of its own (the `backups`
 *                     volume, a bind mount): it survives.
 *   host            — not in a container: a writable directory is a disk.
 *   container_layer — in a container, on its root file system: an update
 *                     replaces the container and the dump with it. The image
 *                     creates the default directory, so without the volume it
 *                     is writable and looks fine; this is the case to catch.
 *   memory          — on a tmpfs: gone at the next restart.
 *   not_writable    — nothing can be written there at all.
 *
 * Never throws. `probe` is the file system; tests hand in their own.
 *
 * @param {string} dir
 * @param {DirectoryProbe} [probe]
 * @returns {BackupDirectoryStatus}
 */
export function backupDirectoryStatus(dir, probe = SYSTEM_PROBE) {
  if (!probe.writable(dir)) {
    return { writable: false, persistent: false, reason: "not_writable" };
  }
  const text = probe.readText("/proc/self/mountinfo");
  const mounts = text === null ? null : parseMountInfo(text);
  if (!runsInContainer(probe, mounts)) {
    return { writable: true, persistent: true, reason: "host" };
  }
  const real = probe.realpath(dir);
  const mount = mounts ? mountContaining(real, mounts) : null;
  if (mount) {
    if (EPHEMERAL_FS_TYPES.has(mount.fsType)) {
      return { writable: true, persistent: false, reason: "memory" };
    }
    return mount.mountPoint === "/"
      ? { writable: true, persistent: false, reason: "container_layer" }
      : { writable: true, persistent: true, reason: "volume" };
  }
  // No mount table to read: a directory on the root's own device is in the
  // container's layer.
  const own = probe.device(real);
  const root = probe.device("/");
  return own !== null && own === root
    ? { writable: true, persistent: false, reason: "container_layer" }
    : { writable: true, persistent: true, reason: "volume" };
}

// ── Keys ───────────────────────────────────────────────────────────────────

/**
 * Decode a 32-byte key the way the app does (`decodeKey` in
 * `src/lib/crypto.ts`): 64 hex characters, or base64 of 32 bytes. Shorter hex
 * is padded with its own SHA-256 there, outside production only; it is
 * decoded the same way here so a development instance's fingerprints match
 * what its admin page shows. Null when the value is not a key at all.
 *
 * @param {string | undefined} raw
 * @returns {Buffer | null}
 */
export function decodeKeyMaterial(raw) {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/=]+$/.test(value)) {
    const buf = Buffer.from(value, "base64");
    if (buf.length === 32) return buf;
  }
  if (/^[0-9a-fA-F]+$/.test(value) && value.length >= 32) {
    const padded =
      value + createHash("sha256").update(value, "utf8").digest("hex");
    return Buffer.from(padded.slice(0, 64), "hex");
  }
  return null;
}

/**
 * The public fingerprint of a key: the first twelve hex characters of
 * SHA-256 over its bytes. The same rule as `fingerprintKeyBytes` in
 * `src/lib/crypto.ts` (what the admin's key-backup step shows) and as the key
 * id an off-host object records, so one number names one key everywhere.
 *
 * @param {Buffer} bytes
 */
export function fingerprintBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * @typedef {{
 *   encryption: {
 *     activeKeyId: string | null;
 *     keys: Array<{ id: string; fingerprint: string }>;
 *   };
 *   backupEncryptionKey: string | null;
 *   backupEncryptionPreviousKeys: string[];
 *   apiTokenHmacKey: string | null;
 * }} KeyFingerprints
 */

/**
 * Fingerprints of every key a restored database needs, read from an
 * environment. Never the key material. A malformed value is left out, which
 * the comparison then reports as missing.
 *
 * `ENCRYPTION_KEY` joins the map as `v1` unless the map names `v1` itself,
 * exactly as the app's key loader does.
 *
 * @param {Env} env
 * @returns {KeyFingerprints}
 */
export function keyFingerprints(env = process.env) {
  /** @type {Map<string, string>} */
  const keys = new Map();
  let activeKeyId = null;
  const rawMap = (env.ENCRYPTION_KEYS ?? "").trim();
  if (rawMap) {
    try {
      const parsed = JSON.parse(rawMap);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, value] of Object.entries(parsed)) {
          const bytes =
            typeof value === "string" ? decodeKeyMaterial(value) : null;
          if (bytes) keys.set(id, fingerprintBytes(bytes));
        }
      }
    } catch {
      // Malformed JSON: no keys from the map. The entrypoint refuses to boot
      // on it anyway; here it only means nothing matches.
    }
    activeKeyId = (env.ENCRYPTION_ACTIVE_KEY_ID ?? "").trim() || null;
    if (!activeKeyId && keys.size === 1) activeKeyId = [...keys.keys()][0];
  }
  const legacy = decodeKeyMaterial(env.ENCRYPTION_KEY);
  if (legacy && !keys.has("v1")) keys.set("v1", fingerprintBytes(legacy));
  if (!activeKeyId && legacy) activeKeyId = "v1";

  const backup = decodeKeyMaterial(env.BACKUP_ENCRYPTION_KEY);
  const previous = (env.BACKUP_ENCRYPTION_PREVIOUS_KEYS ?? "")
    .split(",")
    .map((raw) => decodeKeyMaterial(raw))
    .filter((b) => b !== null)
    .map((b) => fingerprintBytes(/** @type {Buffer} */ (b)));
  const hmac = (env.API_TOKEN_HMAC_KEY ?? "").trim();

  return {
    encryption: {
      activeKeyId,
      keys: [...keys.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, fingerprint]) => ({ id, fingerprint })),
    },
    backupEncryptionKey: backup ? fingerprintBytes(backup) : null,
    backupEncryptionPreviousKeys: previous,
    // Used as a string by the app (`createHmac("sha256", key)`), so its
    // fingerprint is over the string's bytes.
    apiTokenHmacKey: hmac ? fingerprintBytes(Buffer.from(hmac, "utf8")) : null,
  };
}

/**
 * @typedef {{
 *   key: string;
 *   state: "missing" | "different";
 *   severity: "refuse" | "warn";
 *   detail: string;
 * }} KeyFinding
 */

/**
 * Compare the keys a dump was written with against the keys an environment
 * holds. The active encryption key is the one that refuses: without it the
 * app's start-up key check fails and nothing encrypted reads. Every other
 * difference is a warning that says what stops working.
 *
 * @param {KeyFingerprints} expected the manifest's
 * @param {KeyFingerprints} actual the environment's
 * @returns {{ findings: KeyFinding[]; refuse: boolean }}
 */
export function compareKeyFingerprints(expected, actual) {
  /** @type {KeyFinding[]} */
  const findings = [];
  const have = new Map(
    actual.encryption.keys.map((k) => [k.id, k.fingerprint]),
  );
  const active = expected.encryption.activeKeyId;
  for (const { id, fingerprint } of expected.encryption.keys) {
    const mine = have.get(id);
    if (mine === fingerprint) continue;
    const isActive = id === active;
    findings.push({
      key: `ENCRYPTION_KEYS[${id}]`,
      state: mine === undefined ? "missing" : "different",
      severity: isActive ? "refuse" : "warn",
      detail: isActive
        ? `the dump's active encryption key ${id} (fingerprint ${fingerprint}) is ${mine === undefined ? "not configured" : `configured with a different value (fingerprint ${mine})`}; nothing encrypted in this database can be read without it`
        : `encryption key ${id} (fingerprint ${fingerprint}) is ${mine === undefined ? "not configured" : `different here (fingerprint ${mine})`}; rows still sealed under it will not open`,
    });
  }
  if (
    expected.backupEncryptionKey &&
    expected.backupEncryptionKey !== actual.backupEncryptionKey
  ) {
    findings.push({
      key: "BACKUP_ENCRYPTION_KEY",
      state: actual.backupEncryptionKey ? "different" : "missing",
      severity: "warn",
      detail: `the off-host backup key (fingerprint ${expected.backupEncryptionKey}) is ${actual.backupEncryptionKey ? `different here (fingerprint ${actual.backupEncryptionKey})` : "not configured"}; off-host copies written before the restore will not open`,
    });
  }
  if (
    expected.apiTokenHmacKey &&
    expected.apiTokenHmacKey !== actual.apiTokenHmacKey
  ) {
    findings.push({
      key: "API_TOKEN_HMAC_KEY",
      state: actual.apiTokenHmacKey ? "different" : "missing",
      severity: "warn",
      detail: `API_TOKEN_HMAC_KEY (fingerprint ${expected.apiTokenHmacKey}) is ${actual.apiTokenHmacKey ? `different here (fingerprint ${actual.apiTokenHmacKey})` : "not configured"}; every session, app token and share link will stop working, no data is lost`,
    });
  }
  return {
    findings,
    refuse: findings.some((f) => f.severity === "refuse"),
  };
}

// ── Connection ─────────────────────────────────────────────────────────────

/**
 * Query parameters libpq understands, by the environment variable that
 * carries each to `pg_dump` / `pg_restore`. `DATABASE_URL` also carries
 * Prisma's own (`schema`, `connection_limit`, `pool_timeout`), which libpq
 * rejects, so the URL is never handed over as it is.
 */
const LIBPQ_PARAMS = {
  host: "PGHOST",
  sslmode: "PGSSLMODE",
  sslcert: "PGSSLCERT",
  sslkey: "PGSSLKEY",
  sslrootcert: "PGSSLROOTCERT",
  connect_timeout: "PGCONNECT_TIMEOUT",
  application_name: "PGAPPNAME",
};

/**
 * @typedef {{
 *   pgEnv: Record<string, string>;
 *   clientConfig: Record<string, unknown>;
 *   schema: string;
 * }} Connection
 */

/**
 * The connection `DATABASE_URL` describes, as libpq environment variables
 * (the password travels there, never in a process argument) and as a `pg`
 * client config.
 *
 * @param {string} databaseUrl
 * @returns {Connection}
 */
export function connectionFromUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const host = decodeURIComponent(url.hostname).replace(/^\[|\]$/g, "");
  /** @type {Record<string, string>} */
  const pgEnv = {
    PGHOST: host,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
  for (const [param, value] of url.searchParams) {
    const name = /** @type {Record<string, string>} */ (LIBPQ_PARAMS)[param];
    if (name) pgEnv[name] = value;
  }
  const clean = new URL(databaseUrl);
  for (const param of [...clean.searchParams.keys()]) {
    if (!(param in LIBPQ_PARAMS)) clean.searchParams.delete(param);
  }
  return {
    pgEnv,
    clientConfig: {
      connectionString: clean.toString(),
      connectionTimeoutMillis: 10_000,
    },
    schema: url.searchParams.get("schema") || "public",
  };
}

/**
 * A connected `pg` client for `DATABASE_URL`.
 *
 * @param {string} databaseUrl
 */
export async function connect(databaseUrl) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(connectionFromUrl(databaseUrl).clientConfig);
  await client.connect();
  // The server may carry a default statement timeout (the app sets one per
  // session through `options`); counting a large table must not hit it.
  await client.query("SET statement_timeout = 0");
  return client;
}

// ── Facts about a database ─────────────────────────────────────────────────

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Queryable
 */

/** Tables outside the system schemas, `schema.table`, sorted. @param {Queryable} client */
export async function listUserTables(client) {
  const { rows } = await client.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1`,
  );
  return rows.map((r) => /** @type {string} */ (r.name));
}

/**
 * Exact row counts of every user table, keyed `schema.table`.
 *
 * @param {Queryable} client
 * @returns {Promise<Record<string, number>>}
 */
export async function countRows(client) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const table of await listUserTables(client)) {
    const { rows } = await client.query(
      `SELECT count(*)::bigint AS n FROM ${table}`,
    );
    counts[table] = Number(rows[0].n);
  }
  return counts;
}

/**
 * The newest finished migration, or null on a database Prisma never touched.
 *
 * @param {Queryable} client
 * @param {string} schema
 */
export async function latestMigration(client, schema) {
  const table = await client.query(
    "SELECT to_regclass(format('%I._prisma_migrations', $1::text)) AS t",
    [schema],
  );
  if (!table.rows[0]?.t) return null;
  const { rows } = await client.query(
    `SELECT migration_name FROM ${table.rows[0].t}
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name DESC LIMIT 1`,
  );
  return rows[0]?.migration_name ?? null;
}

/** @param {Queryable} client */
export async function serverVersion(client) {
  const { rows } = await client.query(
    "SELECT current_setting('server_version') AS v, current_setting('server_version_num')::int AS n",
  );
  return { version: String(rows[0].v), versionNum: Number(rows[0].n) };
}

// ── Running the Postgres client tools ──────────────────────────────────────

/**
 * Run one Postgres client tool. Standard output goes to `stdout` when given
 * (a file stream) and is collected otherwise. Rejects with the tool's own
 * last lines on a non-zero exit, and kills it at `deadline` (epoch ms).
 *
 * A file the tool reads is named in `args`, never streamed to its standard
 * input: `pg_restore --list` reads an archive's table of contents and exits,
 * and a stream piped into it would stay open on the file. In the long-lived
 * worker that kept every checked dump allocated after retention deleted it.
 *
 * @param {string} tool
 * @param {string[]} args
 * @param {{
 *   env?: Record<string, string>;
 *   stdout?: NodeJS.WritableStream;
 *   deadline?: number;
 * }} [options]
 * @returns {Promise<string>}
 */
export function runTool(tool, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {Buffer[]} */
    const out = [];
    let err = "";
    let timedOut = false;
    const timer =
      options.deadline !== undefined
        ? setTimeout(
            () => {
              timedOut = true;
              child.kill("SIGTERM");
            },
            Math.max(0, options.deadline - Date.now()),
          )
        : null;
    if (options.stdout) {
      // A destination that fails (a full disk) must stop the tool: unpiped,
      // it would block on a full pipe until its deadline, or forever.
      options.stdout.on("error", (e) => {
        child.kill("SIGTERM");
        reject(e);
      });
      child.stdout.pipe(options.stdout);
    } else {
      child.stdout.on("data", (c) => out.push(c));
    }
    child.stderr.on("data", (c) => {
      err = (err + c.toString("utf8")).slice(-4000);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(
        /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT"
          ? new Error(
              `${tool} is not installed in this environment (the HealthLog image ships it; on another host install the PostgreSQL client tools)`,
            )
          : e,
      );
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${tool} ran past its time limit and was stopped`));
      } else if (code === 0) {
        resolve(Buffer.concat(out).toString("utf8"));
      } else {
        const tail = err.trim().split("\n").slice(-3).join(" | ");
        reject(
          new Error(
            `${tool} exited ${code ?? signal}${tail ? `: ${tail}` : ""}`,
          ),
        );
      }
    });
  });
}

/** `pg_dump (PostgreSQL) 18.6`, or null when it cannot be asked. */
export async function pgDumpVersion() {
  try {
    return (await runTool("pg_dump", ["--version"])).trim();
  } catch {
    return null;
  }
}

/**
 * Read an archive's table of contents back. A file `pg_restore` cannot list
 * is not a dump, whatever its name. Answers the number of entries.
 *
 * @param {string} path
 */
export async function verifyArchive(path) {
  const listing = await runTool("pg_restore", ["--list", path]);
  const entries = listing
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith(";")).length;
  if (entries === 0) throw new Error("the archive lists no entries");
  return entries;
}

/** SHA-256 and size of a file, streamed. @param {string} path */
export async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

// ── Writing a dump ─────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   format: string;
 *   formatVersion: number;
 *   kind: DumpKind;
 *   file: string;
 *   createdAt: string;
 *   appVersion: string | null;
 *   buildSha: string | null;
 *   latestMigration: string | null;
 *   postgres: { serverVersion: string; serverVersionNum: number; pgDump: string | null };
 *   dump: { bytes: number; sha256: string; entries: number };
 *   rowCounts: Record<string, number>;
 *   keys: KeyFingerprints;
 * }} DumpManifest
 */

/**
 * Build the manifest of one dump. Pure, so the shape is tested on its own.
 *
 * @param {{
 *   kind: DumpKind;
 *   file: string;
 *   createdAt: Date;
 *   appVersion?: string | null;
 *   buildSha?: string | null;
 *   latestMigration: string | null;
 *   server: { version: string; versionNum: number };
 *   pgDump: string | null;
 *   archive: { bytes: number; sha256: string; entries: number };
 *   rowCounts: Record<string, number>;
 *   env: Env;
 * }} input
 * @returns {DumpManifest}
 */
export function buildManifest(input) {
  return {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    kind: input.kind,
    file: input.file,
    createdAt: input.createdAt.toISOString(),
    appVersion: input.appVersion || null,
    buildSha: input.buildSha || null,
    latestMigration: input.latestMigration,
    postgres: {
      serverVersion: input.server.version,
      serverVersionNum: input.server.versionNum,
      pgDump: input.pgDump,
    },
    dump: { ...input.archive },
    rowCounts: Object.fromEntries(
      Object.entries(input.rowCounts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    keys: keyFingerprints(input.env),
  };
}

/**
 * Check a parsed manifest has the fields a restore reads.
 *
 * @param {unknown} value
 * @returns {DumpManifest}
 */
export function parseManifest(value) {
  const m = /** @type {Record<string, any>} */ (value);
  if (
    !m ||
    m.format !== MANIFEST_FORMAT ||
    m.formatVersion !== MANIFEST_FORMAT_VERSION ||
    typeof m.file !== "string" ||
    typeof m.dump?.sha256 !== "string" ||
    typeof m.dump?.bytes !== "number" ||
    typeof m.rowCounts !== "object" ||
    !m.keys?.encryption
  ) {
    throw new Error("not a HealthLog database dump manifest");
  }
  return /** @type {DumpManifest} */ (m);
}

/**
 * Take one dump into `dir`, with its manifest, and answer both paths.
 *
 * The archive and the row counts read one exported snapshot. The archive is
 * written as `.partial`, hashed and listed back; the manifest is written as
 * `.partial` and renamed; the archive is renamed last. On any failure every
 * file this call created is removed and the error is rethrown.
 *
 * @param {{
 *   databaseUrl: string;
 *   dir: string;
 *   kind: DumpKind;
 *   now?: Date;
 *   env?: Env;
 *   appVersion?: string | null;
 *   buildSha?: string | null;
 *   deadline?: number;
 * }} options
 * @returns {Promise<{ base: string; dumpPath: string; manifestPath: string; manifest: DumpManifest }>}
 */
export async function createDatabaseDump(options) {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const base = dumpBaseName(options.kind, now);
  const dumpPath = join(options.dir, dumpFileName(base));
  const manifestPath = join(options.dir, manifestFileName(base));
  const partialDump = `${dumpPath}.partial`;
  const partialManifest = `${manifestPath}.partial`;
  const connection = connectionFromUrl(options.databaseUrl);
  // Two runs in the same second would share a name. The second one must not
  // replace, or on failure remove, what the first one wrote.
  for (const taken of [dumpPath, manifestPath]) {
    if (await statOrNull(taken)) {
      throw new Error(`a dump named ${basename(taken)} already exists`);
    }
  }

  const client = await connect(options.databaseUrl);
  let finished = false;
  /** The files this call created, and only those, go on a failure. */
  const created = [];
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const { rows } = await client.query(
      "SELECT pg_export_snapshot() AS snapshot",
    );
    const snapshot = String(rows[0].snapshot);

    const out = createWriteStream(partialDump, { flags: "wx", mode: 0o600 });
    const opened = new Promise((resolve, reject) => {
      out.once("open", resolve);
      out.once("error", reject);
    });
    await opened;
    created.push(partialDump);
    const closed = new Promise((resolve, reject) => {
      out.once("close", resolve);
      out.once("error", reject);
    });
    // Awaited below on success; on a failure the run is already rejecting
    // and this must not surface a second time as unhandled.
    closed.catch(() => {});
    // `pg_dump` reads the snapshot in its own session while this one counts
    // the rows of the same snapshot; the queries on this client run one
    // after another (a `pg` client does not overlap them).
    const facts = async () => ({
      counts: await countRows(client),
      server: await serverVersion(client),
      migration: await latestMigration(client, connection.schema),
    });
    const [, { counts, server, migration }, pgDump] = await Promise.all([
      runTool(
        "pg_dump",
        [
          "--format=custom",
          "--no-password",
          `--snapshot=${snapshot}`,
          "--lock-wait-timeout=120000",
        ],
        { env: connection.pgEnv, stdout: out, deadline: options.deadline },
      ),
      facts(),
      pgDumpVersion(),
    ]);
    await closed;
    await client.query("COMMIT");

    const { sha256, bytes } = await hashFile(partialDump);
    const entries = await verifyArchive(partialDump);
    const manifest = buildManifest({
      kind: options.kind,
      file: dumpFileName(base),
      createdAt: now,
      appVersion: options.appVersion,
      buildSha: options.buildSha,
      latestMigration: migration,
      server,
      pgDump,
      archive: { bytes, sha256, entries },
      rowCounts: counts,
      env,
    });
    await writeFile(partialManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    created.push(partialManifest);
    await rename(partialManifest, manifestPath);
    created.push(manifestPath);
    await rename(partialDump, dumpPath);
    finished = true;
    return { base, dumpPath, manifestPath, manifest };
  } finally {
    await client.end().catch(() => {});
    if (!finished) {
      // Only what this call created: a `wx` open that failed created nothing.
      await Promise.all(created.map((p) => rm(p, { force: true })));
    }
  }
}

// ── What is on disk, and what may go ───────────────────────────────────────

/**
 * @typedef {{
 *   base: string;
 *   kind: DumpKind;
 *   timestamp: Date;
 *   dump: { path: string; bytes: number } | null;
 *   manifest: string | null;
 *   encryptedDump: string | null;
 *   encryptedManifest: string | null;
 *   leftovers: Array<{ path: string; mtimeMs: number }>;
 * }} DumpSet
 */

/**
 * Every dump this module wrote into `dir`, newest first, grouped by stem.
 * Files with any other name are not looked at.
 *
 * @param {string} dir
 * @returns {DumpSet[]}
 */
export function listDumpSets(dir) {
  /** @type {Map<string, DumpSet>} */
  const sets = new Map();
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const parsed = parseDumpFileName(name);
    if (!parsed) continue;
    const path = join(dir, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const set = sets.get(parsed.base) ?? {
      base: parsed.base,
      kind: parsed.kind,
      timestamp: parsed.timestamp,
      dump: null,
      manifest: null,
      encryptedDump: null,
      encryptedManifest: null,
      leftovers: [],
    };
    if (parsed.variant === "partial") {
      set.leftovers.push({ path, mtimeMs: info.mtimeMs });
    } else if (parsed.variant === "encrypted") {
      if (parsed.role === "dump") set.encryptedDump = path;
      else set.encryptedManifest = path;
    } else if (parsed.role === "dump") {
      set.dump = { path, bytes: info.size };
    } else {
      set.manifest = path;
    }
    sets.set(parsed.base, set);
  }
  return [...sets.values()].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
  );
}

/** A set is good when its archive and its manifest both carry final names. @param {DumpSet} set */
export function isGoodSet(set) {
  return set.dump !== null && set.manifest !== null;
}

/**
 * Which files retention removes. Pure.
 *
 * Per kind, the newest `keep` good dumps stay (at least one, so the newest
 * good dump is never removed) and every older good dump goes, archive and
 * manifest together.
 *
 * Pre-migration dumps are bounded by age as well: one older than the oldest
 * nightly dump kept goes, except the newest pre-migration dump, which is the
 * way back from the latest update. Kept by count alone, an install that
 * updates rarely held its last two pre-migration dumps, and every account
 * deleted since, with no limit, while the stated retention of deleted
 * accounts was the nightly one. With no nightly dump on disk, the bound is
 * as many days as nightly dumps are kept. A `.partial` or a manifest without its archive goes once
 * it is older than twelve hours, so a run still in progress keeps its files.
 * A final-named archive without a manifest is not something this module
 * leaves behind, so it is not touched. Encrypted copies (`.enc`) an operator
 * placed here to restore from are never touched either.
 *
 * @param {DumpSet[]} sets
 * @param {{ keep: Record<DumpKind, number>; now: number }} options
 * @returns {string[]}
 */
export function selectForDeletion(sets, options) {
  /** @type {string[]} */
  const remove = [];
  const goodOf = (/** @type {DumpKind} */ kind) =>
    sets
      .filter((s) => s.kind === kind && isGoodSet(s))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const dailyKeep = Math.max(1, options.keep.daily ?? 1);
  const keptDaily = goodOf("daily").slice(0, dailyKeep);
  const preMigrationFloor =
    keptDaily.length > 0
      ? keptDaily[keptDaily.length - 1].timestamp.getTime()
      : options.now - dailyKeep * 24 * 60 * 60 * 1000;
  for (const kind of DUMP_KINDS) {
    const keep = Math.max(1, options.keep[kind] ?? 1);
    goodOf(kind).forEach((set, index) => {
      const stays =
        index < keep &&
        (kind !== "pre-migration" ||
          index === 0 ||
          set.timestamp.getTime() >= preMigrationFloor);
      if (stays) return;
      remove.push(
        /** @type {{ path: string }} */ (set.dump).path,
        /** @type {string} */ (set.manifest),
      );
    });
  }
  for (const set of sets) {
    for (const leftover of set.leftovers) {
      if (options.now - leftover.mtimeMs > STALE_LEFTOVER_MS) {
        remove.push(leftover.path);
      }
    }
    if (set.manifest && !set.dump && set.leftovers.length === 0) {
      try {
        if (options.now - statSync(set.manifest).mtimeMs > STALE_LEFTOVER_MS) {
          remove.push(set.manifest);
        }
      } catch {
        // Gone already.
      }
    }
  }
  return remove;
}

/**
 * Apply retention to `dir`. Answers the paths removed.
 *
 * @param {string} dir
 * @param {{ dailyKeep?: number; now?: number }} [options]
 */
export async function applyRetention(dir, options = {}) {
  const doomed = selectForDeletion(listDumpSets(dir), {
    keep: {
      daily: options.dailyKeep ?? DEFAULT_DAILY_KEEP,
      "pre-migration": PRE_MIGRATION_KEEP,
    },
    now: options.now ?? Date.now(),
  });
  for (const path of doomed) await rm(path, { force: true });
  return doomed;
}

/** @param {string} path */
export async function readManifestFile(path) {
  return parseManifest(JSON.parse(await readFile(path, "utf8")));
}

// ── Off-host copies ────────────────────────────────────────────────────────

/**
 * The bucket key of an off-host database object. It is also the associated
 * data its encryption is bound to, so a copy cannot be passed off under
 * another name.
 *
 * @param {string} fileName e.g. `healthlog-…-daily.dump.enc`
 */
export function offhostObjectKey(fileName) {
  return `${OFFHOST_DATABASE_PREFIX}${fileName}`;
}

const ENVELOPE_MAGIC = "HLBK";
const ENVELOPE_KEYED = 0x04;
const AAD_PREFIX = "healthlog/offhost-backup/v4|";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Open an off-host object written in the version-4 envelope
 * (`src/lib/jobs/offhost-backup.ts`: `HLBK`, 0x04, key id, IV, gzip
 * ciphertext, tag, the object key as associated data) into `outPath`,
 * streaming, without holding the file.
 *
 * GCM's tag sits at the end, so the plaintext is written before the tag is
 * checked; it goes to `outPath` and is removed again unless the tag verifies.
 * Nothing reads `outPath` before this resolves.
 *
 * @param {{ inPath: string; outPath: string; objectKey: string; keys: Buffer[] }} options
 */
export async function decryptOffhostFile(options) {
  const size = statSync(options.inPath).size;
  const fd = openSync(options.inPath, "r");
  let header;
  let tag;
  try {
    const head = Buffer.alloc(Math.min(size, 6 + 255 + IV_LENGTH));
    readSync(fd, head, 0, head.length, 0);
    if (
      head.subarray(0, 4).toString("latin1") !== ENVELOPE_MAGIC ||
      head[4] !== ENVELOPE_KEYED
    ) {
      throw new Error(
        "not an off-host database copy (unknown envelope); expected a .dump.enc written by HealthLog",
      );
    }
    const idLen = head[5];
    const keyId = head.subarray(6, 6 + idLen).toString("latin1");
    const iv = head.subarray(6 + idLen, 6 + idLen + IV_LENGTH);
    header = { keyId, iv, length: 6 + idLen + IV_LENGTH };
    tag = Buffer.alloc(TAG_LENGTH);
    readSync(fd, tag, 0, TAG_LENGTH, size - TAG_LENGTH);
  } finally {
    closeSync(fd);
  }
  if (size < header.length + TAG_LENGTH) {
    throw new Error("the off-host copy is truncated");
  }
  const key = options.keys.find((k) => fingerprintBytes(k) === header.keyId);
  if (!key) {
    throw new Error(
      `the off-host copy was written under backup key ${header.keyId}, which is neither BACKUP_ENCRYPTION_KEY nor in BACKUP_ENCRYPTION_PREVIOUS_KEYS`,
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", key, header.iv);
  decipher.setAAD(Buffer.from(`${AAD_PREFIX}${options.objectKey}`, "utf8"));
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(options.inPath, {
        start: header.length,
        end: size - TAG_LENGTH - 1,
      }),
      decipher,
      createGunzip(),
      createWriteStream(options.outPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (err) {
    await rm(options.outPath, { force: true });
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      /auth|unable to authenticate/i.test(reason)
        ? "the off-host copy does not open with this key under this name (altered, renamed, or written with another key)"
        : `could not open the off-host copy: ${reason}`,
    );
  }
}

/**
 * The off-host keys an environment holds, current first.
 *
 * @param {Env} env
 * @returns {Buffer[]}
 */
export function offhostKeysFromEnv(env = process.env) {
  return [
    env.BACKUP_ENCRYPTION_KEY,
    ...(env.BACKUP_ENCRYPTION_PREVIOUS_KEYS ?? "").split(","),
  ]
    .map((raw) => decodeKeyMaterial(raw))
    .filter((k) => k !== null)
    .map((k) => /** @type {Buffer} */ (k));
}

/**
 * @typedef {{
 *   endpoint: string;
 *   bucket: string;
 *   accessKey: string;
 *   secretKey: string;
 *   region: string;
 * }} BucketConfig
 */

/**
 * The off-host bucket an environment names (`BACKUP_S3_*`), or null when one
 * of the four required variables is missing.
 *
 * @param {Env} env
 * @returns {BucketConfig | null}
 */
export function bucketConfigFromEnv(env = process.env) {
  const value = (/** @type {string} */ name) => (env[name] ?? "").trim();
  const config = {
    endpoint: value("BACKUP_S3_ENDPOINT"),
    bucket: value("BACKUP_S3_BUCKET"),
    accessKey: value("BACKUP_S3_ACCESS_KEY"),
    secretKey: value("BACKUP_S3_SECRET_KEY"),
    region: value("BACKUP_S3_REGION") || "auto",
  };
  return config.endpoint &&
    config.bucket &&
    config.accessKey &&
    config.secretKey
    ? config
    : null;
}

/**
 * The newest database dump in a bucket listing whose manifest is there too,
 * or the one `name` asks for. Pure. `name` may carry the `.enc` suffix or
 * not. Answers both object keys, or null.
 *
 * @param {string[]} keys every key under the `database/` prefix
 * @param {string | null} name
 * @returns {{ dumpKey: string; manifestKey: string } | null}
 */
export function pickBucketDump(keys, name = null) {
  const present = new Set(keys);
  const wanted = name
    ? name.replace(/\.enc$/, "").replace(/^database\//, "")
    : null;
  const candidates = keys
    .map((key) => ({
      key,
      parsed: parseDumpFileName(key.slice(OFFHOST_DATABASE_PREFIX.length)),
    }))
    .filter(
      ({ key, parsed }) =>
        key.startsWith(OFFHOST_DATABASE_PREFIX) &&
        parsed !== null &&
        parsed.role === "dump" &&
        parsed.variant === "encrypted" &&
        (wanted === null || `${parsed.base}.dump` === wanted),
    )
    .map(({ parsed }) => {
      const p = /** @type {ParsedDumpName} */ (parsed);
      return {
        timestamp: p.timestamp.getTime(),
        dumpKey: offhostObjectKey(`${p.base}.dump.enc`),
        manifestKey: offhostObjectKey(`${p.base}.manifest.json.enc`),
      };
    })
    .filter((c) => present.has(c.manifestKey))
    .sort((a, b) => b.timestamp - a.timestamp);
  return candidates[0]
    ? { dumpKey: candidates[0].dumpKey, manifestKey: candidates[0].manifestKey }
    : null;
}

/**
 * A minimal reader of the off-host bucket for the restore: list a prefix and
 * download an object to a file, streamed. Uses the AWS SDK the app ships
 * (path-style requests, as the app's own uploader does).
 *
 * @param {BucketConfig} config
 */
export async function openBucket(config) {
  const sdk = await import("@aws-sdk/client-s3");
  const client = new sdk.S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
  return {
    /** @param {string} prefix */
    async list(prefix) {
      /** @type {string[]} */
      const keys = [];
      /** @type {string | undefined} */
      let token;
      for (let page = 0; page < 200; page++) {
        const out = await client.send(
          new sdk.ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const c of out.Contents ?? []) if (c.Key) keys.push(c.Key);
        if (!out.IsTruncated || !out.NextContinuationToken) return keys;
        token = out.NextContinuationToken;
      }
      throw new Error(`the bucket listing under ${prefix} did not end`);
    },
    /**
     * @param {string} key
     * @param {string} outPath
     */
    async download(key, outPath) {
      const out = await client.send(
        new sdk.GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      if (!out.Body) throw new Error(`the bucket returned no body for ${key}`);
      await pipeline(
        /** @type {NodeJS.ReadableStream} */ (
          /** @type {unknown} */ (out.Body)
        ),
        createWriteStream(outPath, { flags: "wx", mode: 0o600 }),
      );
    },
  };
}

// ── Restore ────────────────────────────────────────────────────────────────

/**
 * Compare the counts a restore produced with the manifest's. Every table the
 * manifest names must be there with its count, and no table may be there that
 * the manifest does not name.
 *
 * @param {Record<string, number>} expected
 * @param {Record<string, number>} actual
 * @returns {string[]} one line per difference
 */
export function compareRowCounts(expected, actual) {
  /** @type {string[]} */
  const problems = [];
  for (const [table, count] of Object.entries(expected)) {
    if (!(table in actual)) {
      problems.push(`${table}: in the dump with ${count} rows, missing now`);
    } else if (actual[table] !== count) {
      problems.push(
        `${table}: ${count} rows in the dump, ${actual[table]} restored`,
      );
    }
  }
  for (const table of Object.keys(actual)) {
    if (!(table in expected)) {
      problems.push(`${table}: restored but not in the dump's manifest`);
    }
  }
  return problems;
}

/**
 * Drop every non-system schema and recreate an empty `public`, so a restore
 * that failed its check leaves the database as empty as it found it.
 *
 * @param {Queryable} client
 */
export async function emptyDatabase(client) {
  const { rows } = await client.query(
    `SELECT quote_ident(nspname) AS s FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
  );
  for (const { s } of rows) await client.query(`DROP SCHEMA ${s} CASCADE`);
  await client.query("CREATE SCHEMA IF NOT EXISTS public");
}

/** Stat helper that answers null for a missing file. @param {string} path */
export async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
