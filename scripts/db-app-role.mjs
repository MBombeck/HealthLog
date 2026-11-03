#!/usr/bin/env node
/**
 * The database role the running app connects as.
 *
 * The migrations, the dump before them and the restore connect as the owner
 * `DATABASE_URL` names. The long-running web and worker processes do not need
 * the owner: they read and write rows, run the queue, and maintain one table.
 * After the migrations, `docker-entrypoint.sh` runs this script as the owner.
 * It ensures a login role for this database, `healthlog_app_<database>_<hash>`
 * ({@link appRoleName}), that can do exactly that, and hands the entrypoint a
 * `DATABASE_URL` for it; the entrypoint then starts the app with that URL in
 * place of the owner's, so the owner's credentials never reach the app's
 * environment.
 *
 * One role per database. Roles are cluster-wide, so two HealthLog databases on
 * one server (production and staging on a shared Postgres) sharing one role
 * name would each set their own password on every start, locking the other
 * out, and the role would hold grants on both, letting either instance read
 * the other's database. The name carries the database's name and a hash of
 * it; the marker comment names the database too. A role that holds an explicit
 * CONNECT grant on another database is refused.
 *
 * What the role can do:
 *   - SELECT, INSERT, UPDATE, DELETE on every table of the app's schema, and
 *     USAGE, SELECT, UPDATE on its sequences. `_prisma_migrations` is SELECT
 *     only: the app reads the migration history, it never writes it.
 *   - MAINTAIN on `measurements` (Postgres 17+): the maintenance job's
 *     `VACUUM (ANALYZE)` and `REINDEX INDEX CONCURRENTLY`.
 *   - Rows of the queue schema `pgboss`, which stays the owner's. See
 *     "The queue schema" below.
 *
 * What it cannot do: create, alter or drop anything in either schema; create
 * triggers, rules or functions; create schemas, databases or roles; act as a
 * superuser, so no `COPY ... FROM PROGRAM`, no `pg_read_file`, no untrusted
 * languages; write the migration history. `CREATE` on the app's schema is
 * revoked from PUBLIC as well (the default since Postgres 15; a database first
 * created on an older major still grants it), where the owner may do so.
 *
 * The queue schema. pg-boss changes its schema in three places: its install,
 * its migrations (and the index builds they queue in `pgboss.bam`), and
 * queues created with `partition: true`. HealthLog creates no partitioned
 * queue, and with `persistQueueStats` off pg-boss creates no stats
 * partitions, so a running app only reads and writes rows. This script
 * installs and migrates the schema as the owner before the app starts
 * ({@link prepareQueueSchema}), with pg-boss's own plans and its index builds
 * run inline, and the worker starts pg-boss with `migrate: false` when it
 * does not own the schema (`reminder-worker.ts`). The role gets rows only,
 * and not all of them: `pgboss.bam` holds SQL that pg-boss runs as whoever
 * runs its migrations, so the role may only read it, and of
 * `pgboss.version` it may update the timestamps but not the version. Owning
 * nothing in the schema, the role cannot plant a trigger, a rule or a
 * function body that a later owner session (a rollback to an older release,
 * `DB_APP_ROLE=off`, a container that fell back to the owner) would run with
 * the owner's rights.
 *
 * A pre-release build handed the schema to a cluster-wide `healthlog_app`
 * role. Every start therefore also takes back, as the owner, anything in the
 * schema a HealthLog-managed role owns, drops every trigger and rule there
 * (pg-boss defines none), and when it took something back compares each
 * function with pg-boss's own definition, built in a scratch schema, and
 * restores the ones that differ ({@link hardenQueueSchema}). It runs on every
 * path, `DB_APP_ROLE=off` and the fallback included. The legacy role loses
 * its grants in this database.
 *
 * pg-boss rebuilds bloated indexes only on tables its connection owns; under
 * the role it reports them instead. The start rebuilds them as the owner
 * ({@link rebuildBloatedQueueIndexes}), each under a short lock wait.
 *
 * Every boot re-applies the grants, inside one transaction under an advisory
 * lock, so a table a new migration created is covered before the app starts,
 * a web and a worker container booting together do not race, and a restored
 * database (whose objects `pg_restore --no-owner` hands to the owner) is put
 * right. Grants only touch what lacks them, so a boot after the first writes
 * almost nothing to the catalog.
 *
 * The password is derived, not stored: HMAC-SHA256 of a label naming the
 * database under API_TOKEN_HMAC_KEY. Every container of one instance carries
 * that key, so a separate worker container derives the same password without
 * a new variable. It is set as a SCRAM verifier computed here, so the
 * plaintext never travels to the server, where a statement log could keep it.
 * The role is marked with a comment; a role of the same name without the
 * mark is not HealthLog's, and is left alone.
 *
 * Fail open, loudly. When the owner cannot do this (a managed or external
 * database whose user may not create roles, Postgres before 17, a pg_hba.conf
 * that does not let the new role in, a lock that did not come in time), the
 * script says why in one notice and the app runs as the owner, as it did
 * before. `DB_APP_ROLE=off` skips the role for an operator who manages roles
 * themselves, including one whose `DATABASE_URL` already names a restricted role.
 *
 * Why Postgres 17: the maintenance job vacuums and rebuilds the indexes of
 * `measurements`, and before the MAINTAIN privilege only the table's owner
 * could. Rather than leave that job broken on 16, an older server keeps
 * today's behaviour.
 *
 * Index drops stay with the owner: `DROP INDEX` belongs to the table's owner
 * and MAINTAIN does not include it. When the role is in place this script
 * also drops, as the owner, the indexes the maintenance job used to drop
 * (retired indexes, and the invalid copies an interrupted concurrent rebuild
 * leaves), each under a short lock wait, so a held lock delays the boot by
 * seconds and the drop waits for the next boot.
 *
 * Interface: the URL for the role goes to file descriptor 3 and nowhere else;
 * every message goes to stderr, and no message carries a password or a URL.
 * The entrypoint reads it with `url="$(node scripts/db-app-role.mjs 3>&1 1>&2)"`.
 * Without descriptor 3 (a manual run) the role is still ensured and the URL is
 * not printed. Exit 0 in every case the app should start; nothing written to
 * descriptor 3 means: stay on the owner.
 *
 * Plain ESM with no imports beyond Node, `pg`, `pg-boss` and the shared dump
 * module, so it runs from the runtime image like the other entrypoint scripts.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  getConstructionPlans,
  getIndexBloatPlans,
  getMigrationPlans,
} from "pg-boss";

import { connect } from "../src/lib/database-backup/dump-core.mjs";
import {
  CONCURRENT_COPY,
  RETIRED_MEASUREMENT_INDEXES,
} from "../src/lib/jobs/retired-measurement-indexes.mjs";

/** Every role this script creates starts with this. */
export const APP_ROLE_PREFIX = "healthlog_app_";

/** The cluster-wide role a pre-release build created, retired here. */
export const LEGACY_APP_ROLE = "healthlog_app";

/** The start of every comment this script puts on a role. */
export const MANAGED_MARK = "Managed by HealthLog";

/** The schema pg-boss keeps its queue in (its default; HealthLog sets none). */
export const QUEUE_SCHEMA = "pgboss";

/** The queue schema version this image's pg-boss installs and expects. */
export const QUEUE_SCHEMA_VERSION = Number(
  createRequire(import.meta.url)("pg-boss/package.json").pgboss.schema,
);

/**
 * Queue tables the role may only read: `bam` holds SQL that pg-boss's
 * migration runner executes, `version` decides which migrations run (its
 * timestamp columns stay writable, below).
 */
export const QUEUE_READ_ONLY_TABLES = Object.freeze(["bam", "version"]);

/** Tables the role may maintain (VACUUM, ANALYZE, REINDEX). */
export const MAINTAINED_TABLES = Object.freeze(["measurements"]);

/** Tables the role may only read. */
export const READ_ONLY_TABLES = Object.freeze(["_prisma_migrations"]);

/** The label the password is derived under. A new label is a new password. */
const PASSWORD_LABEL = "healthlog database app role v2";

/** The first major with the MAINTAIN privilege. */
export const MIN_SERVER_VERSION_NUM = 170000;

/** How long the setup waits for a lock before staying on the owner. */
const SETUP_LOCK_TIMEOUT = "15s";

/** How long a boot-time index drop or rebuild waits for its lock. */
export const BOOT_DROP_LOCK_TIMEOUT = "5s";

/** The advisory lock every start of every database takes for its setup. */
const SETUP_LOCK =
  "SELECT pg_advisory_xact_lock(hashtext('healthlog.db-app-role'))";

/** An identifier this script splices into SQL: lower-case catalog names only. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function say(message) {
  process.stderr.write(`HealthLog: ${message}\n`);
}

/** Double-quote an identifier after checking its shape. */
function ident(name) {
  if (!IDENTIFIER.test(name)) {
    throw new Error("refusing to splice an identifier of unexpected shape");
  }
  return `"${name}"`;
}

/** Double-quote any identifier, doubling its quotes (database names). */
function quoteAny(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * The role's name for a database: the prefix, the database's name cut to
 * letters, digits and underscores (at most 32), and eight hex digits of its
 * SHA-256, so two databases whose names clean up alike still differ. At most
 * 55 characters, under Postgres's 63.
 */
export function appRoleName(database) {
  const clean = String(database)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  const hash = createHash("sha256").update(String(database)).digest("hex");
  return `${APP_ROLE_PREFIX}${clean ? `${clean}_` : ""}${hash.slice(0, 8)}`;
}

/** The mark on the role this script created for `database`. */
export function roleComment(database) {
  return `${MANAGED_MARK} for database ${JSON.stringify(String(database))}: the app's least-privilege login (scripts/db-app-role.mjs). Re-granted on every start.`;
}

/** The role's password for a database: 64 hex characters, the same in every container. */
export function appRolePassword(hmacKey, database) {
  if (!hmacKey) throw new Error("API_TOKEN_HMAC_KEY is not set");
  return createHmac("sha256", hmacKey)
    .update(`${PASSWORD_LABEL}:${database}`)
    .digest("hex");
}

/**
 * A SCRAM-SHA-256 verifier in the form `pg_authid.rolpassword` stores
 * (RFC 5802/7677; the password is ASCII hex, so SASLprep leaves it as is).
 * Postgres takes a string of this shape as already hashed.
 */
export function scramVerifier(
  password,
  salt = randomBytes(16),
  iterations = 4096,
) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** The owner's URL with the role's name and password: same host, database and parameters. */
export function appRoleUrl(ownerUrl, role, password) {
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** The user a URL names, for the notices. Never the password. */
function userOf(databaseUrl) {
  try {
    return decodeURIComponent(new URL(databaseUrl).username) || "(default)";
  } catch {
    return "(unparsable)";
  }
}

function errorText(err) {
  const code = err?.code;
  const message = err instanceof Error ? err.message : String(err);
  return typeof code === "string" ? `${code} ${message}` : message;
}

/**
 * Whether the connected user can set the role up, and why not when it
 * cannot. Read-only.
 *
 * @param {{ query: Function }} client
 * @returns {Promise<{ ok: true, superuser: boolean, role: string, database: string } | { ok: false, reason: string, detail: string }>}
 */
export async function checkPreconditions(client) {
  const { rows } = await client.query(
    `SELECT current_setting('server_version_num')::int AS version,
            r.rolsuper AS superuser,
            r.rolcreaterole AS createrole,
            current_user AS me,
            current_database() AS database
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const me = rows[0];
  const name = appRoleName(me.database);
  if (me.me === name) {
    return {
      ok: false,
      reason: "already_app_role",
      detail: `DATABASE_URL already names ${name}`,
    };
  }
  if (me.version < MIN_SERVER_VERSION_NUM) {
    return {
      ok: false,
      reason: "server_too_old",
      detail: `Postgres ${Math.floor(me.version / 10000)} has no MAINTAIN privilege (17 or newer does)`,
    };
  }
  if (!me.superuser && !me.createrole) {
    return {
      ok: false,
      reason: "cannot_create_roles",
      detail: `the database user ${me.me} may not create roles (a managed or external database, or a user without CREATEROLE)`,
    };
  }
  const existing = await client.query(
    `SELECT shobj_description(r.oid, 'pg_authid') AS comment,
            pg_has_role(r.oid, current_user, 'MEMBER') AS member_of_owner,
            r.rolsuper OR r.rolreplication OR r.rolbypassrls AS elevated,
            ARRAY(
              SELECT d.datname::text FROM pg_database d, aclexplode(d.datacl) a
               WHERE d.datname <> current_database()
                 AND a.grantee = r.oid AND a.privilege_type = 'CONNECT'
               ORDER BY d.datname
            ) AS other_databases
       FROM pg_roles r WHERE r.rolname = $1`,
    [name],
  );
  const role = existing.rows[0];
  if (role && role.comment !== roleComment(me.database)) {
    return {
      ok: false,
      reason: "foreign_role",
      detail: `a role named ${name} exists that HealthLog did not create for this database`,
    };
  }
  if (role?.member_of_owner) {
    return {
      ok: false,
      reason: "role_inherits_owner",
      detail: `${name} is a member of ${me.me}, so it would hold the owner's rights`,
    };
  }
  if (role?.elevated && !me.superuser) {
    return {
      ok: false,
      reason: "role_elevated",
      detail: `${name} has SUPERUSER, REPLICATION or BYPASSRLS, and only a superuser can take it away`,
    };
  }
  if (role?.other_databases?.length > 0) {
    return {
      ok: false,
      reason: "role_reaches_other_database",
      detail: `${name} holds CONNECT on another database (${role.other_databases.join(", ")}); revoke it there first`,
    };
  }
  return {
    ok: true,
    superuser: me.superuser,
    role: name,
    database: me.database,
  };
}

/**
 * The queue schema's state, read-only: whether pg-boss is installed and at
 * which version.
 *
 * @param {{ query: Function }} client
 */
async function queueSchemaVersion(client) {
  const { rows } = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS installed`,
    [`${QUEUE_SCHEMA}.version`],
  );
  if (!rows[0].installed) return null;
  const { rows: version } = await client.query(
    `SELECT max(version)::int AS version FROM ${ident(QUEUE_SCHEMA)}.version`,
  );
  return version[0]?.version ?? null;
}

/**
 * Make the queue schema the owner's alone, on every start and every path.
 *
 * Takes back, in one transaction, every object in the schema a
 * HealthLog-managed role owns (the pre-release build handed the schema to
 * one), retires the legacy cluster-wide role's grants here, and drops every
 * trigger and rule in the schema (pg-boss defines none; anything there was
 * planted). When it took something back, the functions are compared with
 * pg-boss's own afterwards ({@link restoreQueueFunctions}).
 *
 * @param {{ query: Function }} client connected as the owner
 * @returns {Promise<{ reclaimed: number, dropped: string[] }>}
 */
export async function hardenQueueSchema(client) {
  const { rows: present } = await client.query(
    `SELECT to_regnamespace($1) IS NOT NULL AS present`,
    [QUEUE_SCHEMA],
  );
  const { rows: legacy } = await client.query(
    `SELECT 1 FROM pg_roles r
      WHERE r.rolname = $1 AND shobj_description(r.oid, 'pg_authid') LIKE $2`,
    [LEGACY_APP_ROLE, `${MANAGED_MARK}%`],
  );
  if (!present[0].present && legacy.length === 0) {
    return { reclaimed: 0, dropped: [] };
  }
  const queue = ident(QUEUE_SCHEMA);
  let reclaimed = 0;
  const dropped = [];
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${SETUP_LOCK_TIMEOUT}'`);
    await client.query(SETUP_LOCK);
    if (present[0].present) {
      // Owned by a role HealthLog manages: any of them, this database's or
      // another's, or the legacy one.
      const managed = `SELECT oid FROM pg_roles
                        WHERE shobj_description(oid, 'pg_authid') LIKE '${MANAGED_MARK}%'`;
      const { rows: schemaOwned } = await client.query(
        `SELECT 1 FROM pg_namespace WHERE nspname = $1 AND nspowner IN (${managed})`,
        [QUEUE_SCHEMA],
      );
      if (schemaOwned.length > 0) {
        await client.query(`ALTER SCHEMA ${queue} OWNER TO CURRENT_USER`);
        reclaimed += 1;
      }
      const { rows: relations } = await client.query(
        `SELECT c.oid::regclass::text AS name, c.relkind AS kind
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
            AND c.relowner IN (${managed})
            AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
            AND NOT (c.relkind = 'S' AND EXISTS (
                  SELECT 1 FROM pg_depend d
                   WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                     AND d.deptype IN ('a', 'i')))`,
        [QUEUE_SCHEMA],
      );
      const kinds = {
        S: "SEQUENCE",
        v: "VIEW",
        m: "MATERIALIZED VIEW",
        f: "FOREIGN TABLE",
      };
      for (const { name, kind } of relations) {
        // `regclass::text` is the catalog's own quoting of the name.
        await client.query(
          `ALTER ${kinds[kind] ?? "TABLE"} ${name} OWNER TO CURRENT_USER`,
        );
        reclaimed += 1;
      }
      const { rows: routines } = await client.query(
        `SELECT p.oid::regprocedure::text AS signature
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proowner IN (${managed})`,
        [QUEUE_SCHEMA],
      );
      for (const { signature } of routines) {
        await client.query(`ALTER ROUTINE ${signature} OWNER TO CURRENT_USER`);
        reclaimed += 1;
      }
      const { rows: types } = await client.query(
        `SELECT t.oid::regtype::text AS name, t.typtype AS kind
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           LEFT JOIN pg_class c ON c.oid = t.typrelid
          WHERE n.nspname = $1 AND t.typowner IN (${managed}) AND t.typelem = 0
            AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND c.relkind = 'c'))`,
        [QUEUE_SCHEMA],
      );
      for (const { name, kind } of types) {
        await client.query(
          `ALTER ${kind === "d" ? "DOMAIN" : "TYPE"} ${name} OWNER TO CURRENT_USER`,
        );
        reclaimed += 1;
      }

      const { rows: triggers } = await client.query(
        `SELECT t.tgname AS name, t.tgrelid::regclass::text AS on_table
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND NOT t.tgisinternal`,
        [QUEUE_SCHEMA],
      );
      for (const { name, on_table: onTable } of triggers) {
        await client.query(`DROP TRIGGER ${quoteAny(name)} ON ${onTable}`);
        dropped.push(`trigger ${name}`);
      }
      const { rows: rules } = await client.query(
        `SELECT r.rulename AS name, r.ev_class::regclass::text AS on_table
           FROM pg_rewrite r
           JOIN pg_class c ON c.oid = r.ev_class
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND r.rulename <> '_RETURN'`,
        [QUEUE_SCHEMA],
      );
      for (const { name, on_table: onTable } of rules) {
        await client.query(`DROP RULE ${quoteAny(name)} ON ${onTable}`);
        dropped.push(`rule ${name}`);
      }
    }
    if (legacy.length > 0) {
      // Its grants in this database; the role itself goes once no database
      // holds any (DROP ROLE fails while another one does).
      // REASSIGN first: DROP OWNED drops what the role still owns, and
      // nothing it owns here may go with it.
      await client.query(
        `REASSIGN OWNED BY ${ident(LEGACY_APP_ROLE)} TO CURRENT_USER`,
      );
      await client.query(`DROP OWNED BY ${ident(LEGACY_APP_ROLE)}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
  if (legacy.length > 0) {
    await client
      .query(`DROP ROLE ${ident(LEGACY_APP_ROLE)}`)
      .catch(() => undefined);
  }
  return { reclaimed, dropped };
}

/** The functions of a schema by signature (without the schema), each as `CREATE OR REPLACE` text. */
async function functionDefinitions(client, schema) {
  const { rows } = await client.query(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
            p.oid::regprocedure::text AS qualified,
            pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1`,
    [schema],
  );
  return new Map(rows.map((r) => [r.signature, r]));
}

/**
 * After a take-back: compare every function in the queue schema with the
 * one pg-boss itself installs, built in a scratch schema, and restore any
 * that differs; drop a function pg-boss does not define. Run as the owner.
 *
 * @param {{ query: Function }} client connected as the owner, outside a transaction
 * @returns {Promise<string[]>} the functions restored or dropped
 */
export async function restoreQueueFunctions(client) {
  const scratch = "healthlog_pgboss_reference";
  const changed = [];
  await client.query(`DROP SCHEMA IF EXISTS ${ident(scratch)} CASCADE`);
  try {
    await client.query(getConstructionPlans(scratch));
    const reference = await functionDefinitions(client, scratch);
    const installed = await functionDefinitions(client, QUEUE_SCHEMA);
    // The scratch name appears qualified and as a literal (catalog
    // lookups); it is unique, so every occurrence is the schema's name.
    const asQueue = (text) => text.split(scratch).join(QUEUE_SCHEMA);
    await client.query("BEGIN");
    try {
      await client.query(SETUP_LOCK);
      for (const [signature, ref] of reference) {
        const want = asQueue(ref.definition);
        if (installed.get(signature)?.definition === want) continue;
        await client.query(want);
        changed.push(signature);
      }
      for (const [signature, own] of installed) {
        if (reference.has(signature)) continue;
        await client.query(`DROP ROUTINE ${own.qualified}`);
        changed.push(`${signature} (dropped)`);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${ident(scratch)} CASCADE`);
  }
  return changed;
}

/**
 * Install or migrate the queue schema as the owner, with pg-boss's own plans,
 * so the app (as the role, `migrate: false`) finds it current. A migration's
 * concurrent index builds, which pg-boss would leave to its runner, are run
 * here one after another.
 *
 * @param {{ query: Function }} client connected as the owner, outside a transaction
 * @returns {Promise<"current" | "installed" | "migrated" | "newer">}
 */
export async function prepareQueueSchema(client) {
  const version = await queueSchemaVersion(client);
  if (version === null) {
    await client.query(getConstructionPlans(QUEUE_SCHEMA));
    return "installed";
  }
  if (version === QUEUE_SCHEMA_VERSION) return "current";
  if (version > QUEUE_SCHEMA_VERSION) return "newer";
  const [transactional, ...concurrent] = getMigrationPlans(
    QUEUE_SCHEMA,
    version,
  ).split(/\n(?=-- inlined from )/);
  await client.query(transactional);
  for (const statement of concurrent) {
    await client.query(statement.trim().replace(/;$/, ""));
  }
  return "migrated";
}

/**
 * Rebuild, as the owner, the queue indexes pg-boss's own check calls bloated
 * (under the role it may only report them). One at a time, each waiting at
 * most {@link BOOT_DROP_LOCK_TIMEOUT} for its lock; a rebuild that fails drops
 * its half-built copy and leaves the index for the next start.
 *
 * @param {{ query: Function }} client connected as the owner, outside a transaction
 * @returns {Promise<{ rebuilt: string[], left: string[] }>}
 */
export async function rebuildBloatedQueueIndexes(client) {
  const rebuilt = [];
  const left = [];
  if ((await queueSchemaVersion(client)) === null) return { rebuilt, left };
  const { rows } = await client.query(getIndexBloatPlans(QUEUE_SCHEMA));
  if (rows.length === 0) return { rebuilt, left };
  const { rows: setting } = await client.query(
    `SELECT current_setting('lock_timeout') AS value`,
  );
  try {
    await client.query(`SET lock_timeout = '${BOOT_DROP_LOCK_TIMEOUT}'`);
    for (const { name } of rows) {
      const index = `${ident(QUEUE_SCHEMA)}.${ident(name)}`;
      try {
        await client.query(`REINDEX INDEX CONCURRENTLY ${index}`);
        rebuilt.push(name);
      } catch (err) {
        left.push(name);
        await client
          .query(
            `DROP INDEX CONCURRENTLY IF EXISTS ${ident(QUEUE_SCHEMA)}.${ident(`${name}_ccnew`)}`,
          )
          .catch(() => undefined);
        say(
          `notice: queue index ${name} was not rebuilt (${errorText(err)}); the next start tries again`,
        );
      }
    }
  } finally {
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [
      setting[0]?.value ?? "0",
    ]);
  }
  return { rebuilt, left };
}

/**
 * Create or update the role and apply every grant, in one transaction.
 * Call it on a client connected as the owner, after the migrations and
 * {@link prepareQueueSchema}.
 *
 * @param {{ query: Function }} client
 * @param {{ role: string, database: string, password: string, schema?: string, superuser: boolean }} options
 */
export async function applyAppRole(client, options) {
  const schema = options.schema ?? "public";
  const name = options.role;
  const role = ident(name);
  const app = ident(schema);
  const queue = ident(QUEUE_SCHEMA);
  // The verifier is a base64/`$`/`:` string; it never contains a quote.
  const verifier = scramVerifier(options.password);
  if (verifier.includes("'")) throw new Error("unexpected verifier shape");

  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${SETUP_LOCK_TIMEOUT}'`);
    await client.query(SETUP_LOCK);

    const { rows: present } = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      [name],
    );
    // The attributes a superuser alone may set are named only by one; a
    // role a CREATEROLE user creates never has them (checked beforehand).
    const elevatedOff = options.superuser
      ? " NOSUPERUSER NOREPLICATION NOBYPASSRLS"
      : "";
    const attributes = `LOGIN NOCREATEDB NOCREATEROLE NOINHERIT${elevatedOff}`;
    if (present.length === 0) {
      await client.query(
        `CREATE ROLE ${role} ${attributes} PASSWORD '${verifier}'`,
      );
    } else {
      await client.query(
        `ALTER ROLE ${role} ${attributes} PASSWORD '${verifier}'`,
      );
    }
    await client.query(
      `COMMENT ON ROLE ${role} IS '${roleComment(options.database).replace(/'/g, "''")}'`,
    );

    // A non-superuser owner may change a role's password and comment only
    // with ADMIN on it, which creating it gave. It needs no membership: the
    // role owns nothing.

    await client.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${quoteAny(options.database)} TO ${role}`,
    );

    // The app's schema: rows, never structure.
    await client.query(`GRANT USAGE ON SCHEMA ${app} TO ${role}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${app} FROM ${role}`);
    const { rows: schemaOwner } = await client.query(
      `SELECT pg_has_role(current_user, nspowner, 'USAGE') AS owns
         FROM pg_namespace WHERE nspname = $1`,
      [schema],
    );
    if (options.superuser || schemaOwner[0]?.owns) {
      await client.query(`REVOKE CREATE ON SCHEMA ${app} FROM PUBLIC`);
    } else {
      say(
        `notice: the schema ${schema} is not the database user's to change; PUBLIC may still create objects in it`,
      );
    }
    await grantRows(client, { schema, role: name, readOnly: READ_ONLY_TABLES });

    // Objects the owner creates later in this schema (the migrations of the
    // next update) are granted at creation as well. The per-boot pass above
    // is what the app relies on; this covers the time between the two.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${app} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${app} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`,
    );

    for (const table of MAINTAINED_TABLES) {
      const { rows } = await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`${app}.${ident(table)}`],
      );
      if (rows[0].present) {
        await client.query(
          `GRANT MAINTAIN ON ${app}.${ident(table)} TO ${role}`,
        );
      }
    }

    // The queue schema: rows only, and only read on the tables whose
    // contents decide what pg-boss's migration runner executes. No default
    // privileges here: a table a later pg-boss adds is granted by the next
    // start's pass, after this script migrated it, so a new table of that
    // kind is not writable before anyone has looked at it.
    await client.query(`GRANT USAGE ON SCHEMA ${queue} TO ${role}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${queue} FROM ${role}`);
    await grantRows(client, {
      schema: QUEUE_SCHEMA,
      role: name,
      readOnly: QUEUE_READ_ONLY_TABLES,
    });
    // pg-boss stamps its maintenance times on `version`; the version itself
    // stays the owner's to write.
    const { rows: stamps } = await client.query(
      `SELECT a.attname AS name FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname <> 'version'
          AND NOT has_column_privilege($2, a.attrelid, a.attnum, 'UPDATE')`,
      [`${QUEUE_SCHEMA}.version`, name],
    );
    if (stamps.length > 0) {
      await client.query(
        `GRANT UPDATE (${stamps.map((c) => ident(c.name)).join(", ")}) ON ${queue}.${ident("version")} TO ${role}`,
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/**
 * Grant rows on every table of a schema that lacks them, and read only on
 * `readOnly` (any write it holds there is taken away); sequences alike.
 */
async function grantRows(client, { schema, role: name, readOnly }) {
  const role = ident(name);
  const where = ident(schema);
  const { rows: tables } = await client.query(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND c.relname <> ALL($3::text[])
        AND NOT (has_table_privilege($2, c.oid, 'SELECT')
             AND has_table_privilege($2, c.oid, 'INSERT')
             AND has_table_privilege($2, c.oid, 'UPDATE')
             AND has_table_privilege($2, c.oid, 'DELETE'))`,
    [schema, name, readOnly],
  );
  for (const { name: table } of tables) {
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${where}.${ident(table)} TO ${role}`,
    );
  }
  for (const table of readOnly) {
    const { rows } = await client.query(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`${where}.${ident(table)}`],
    );
    if (!rows[0].present) continue;
    await client.query(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON ${where}.${ident(table)} FROM ${role}`,
    );
    await client.query(`GRANT SELECT ON ${where}.${ident(table)} TO ${role}`);
  }
  const { rows: sequences } = await client.query(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'S'
        AND NOT (has_sequence_privilege($2, c.oid, 'USAGE')
             AND has_sequence_privilege($2, c.oid, 'SELECT')
             AND has_sequence_privilege($2, c.oid, 'UPDATE'))`,
    [schema, name],
  );
  for (const { name: sequence } of sequences) {
    await client.query(
      `GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${where}.${ident(sequence)} TO ${role}`,
    );
  }
}

/**
 * Drop, as the owner, the indexes on `measurements` the maintenance job can
 * no longer drop as the role: the retired ones and the invalid copies of a
 * concurrent rebuild. Each waits at most {@link BOOT_DROP_LOCK_TIMEOUT}; one
 * that does not get its lock is left for the next boot.
 *
 * @param {{ query: Function }} client a connection outside any transaction
 * @returns {Promise<{ dropped: string[], left: string[] }>}
 */
export async function dropOwnerOnlyIndexes(client) {
  const dropped = [];
  const left = [];
  const { rows: table } = await client.query(
    `SELECT to_regclass('measurements') IS NOT NULL AS present`,
  );
  if (!table[0].present) return { dropped, left };
  const { rows } = await client.query(
    `SELECT c.relname AS name, i.indisvalid AS valid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'measurements'::regclass`,
  );
  const targets = rows
    .filter(
      (r) =>
        RETIRED_MEASUREMENT_INDEXES.includes(r.name) ||
        (!r.valid && CONCURRENT_COPY.test(r.name)),
    )
    .map((r) => r.name);
  if (targets.length === 0) return { dropped, left };
  const { rows: setting } = await client.query(
    `SELECT current_setting('lock_timeout') AS value`,
  );
  try {
    await client.query(`SET lock_timeout = '${BOOT_DROP_LOCK_TIMEOUT}'`);
    for (const name of targets) {
      try {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${ident(name)}`);
        dropped.push(name);
      } catch (err) {
        left.push(name);
        say(
          `notice: index ${name} on measurements was not dropped (${errorText(err)}); the next start tries again`,
        );
      }
    }
  } finally {
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [
      setting[0]?.value ?? "0",
    ]);
  }
  return { dropped, left };
}

/** Log in as the role once, so a pg_hba.conf that refuses it shows here. */
async function proveLogin(url, role) {
  const client = await connect(url);
  try {
    const { rows } = await client.query(`SELECT current_user AS me`);
    if (rows[0].me !== role) {
      throw new Error(`logged in as ${rows[0].me}, not ${role}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Write the URL to descriptor 3 when the caller opened it. */
function handOver(url) {
  try {
    writeSync(3, url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The queue schema back to the owner alone, on any path. A failure is a
 * notice, never a stop: on the role path the setup then falls back.
 *
 * @returns {Promise<boolean>} whether the schema is in the owner's hands
 */
async function secureQueue(client) {
  try {
    const { reclaimed, dropped } = await hardenQueueSchema(client);
    if (dropped.length > 0) {
      say(
        `warning: dropped ${dropped.join(", ")} in the queue schema; pg-boss defines none`,
      );
    }
    if (reclaimed > 0) {
      say(
        `took back ${reclaimed} object(s) in the queue schema from a HealthLog role`,
      );
      const changed = await restoreQueueFunctions(client);
      if (changed.length > 0) {
        say(
          `warning: restored queue function(s) ${changed.join(", ")} to pg-boss's own definition`,
        );
      }
    }
    return true;
  } catch (err) {
    say(`notice: the queue schema check failed (${errorText(err)})`);
    return false;
  }
}

/**
 * The boot step. Returns the role's URL when the app should use it, or null
 * to stay on the owner.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string | null>}
 */
export async function ensureAppRole(env = process.env) {
  const ownerUrl = env.DATABASE_URL;
  const mode = (env.DB_APP_ROLE ?? "").trim().toLowerCase();
  const off = mode === "off" || mode === "false";
  if (mode && !off && mode !== "auto" && mode !== "on") {
    say(
      `notice: DB_APP_ROLE="${mode}" is not auto or off; treating it as auto`,
    );
  }
  if (!ownerUrl) return null;

  const user = userOf(ownerUrl);
  const fallBack = (detail) => {
    say(
      `notice: the app connects as ${user}, the user DATABASE_URL names, not as a restricted role: ${detail}. ` +
        "This is how every earlier release ran. " +
        `If ${user} is a restricted role you manage yourself, DB_APP_ROLE=off silences this; otherwise see docs/self-hosting/database-role.md.`,
    );
    return null;
  };

  let client;
  try {
    client = await connect(ownerUrl);
  } catch (err) {
    if (off) return null;
    return fallBack(`could not connect to set it up (${errorText(err)})`);
  }
  try {
    // Every path, before anything runs as the owner against the queue.
    const secured = await secureQueue(client);
    if (off) {
      say(
        `DB_APP_ROLE=off: the app connects as ${user}, the user DATABASE_URL names`,
      );
      return null;
    }
    const pre = await checkPreconditions(client);
    if (!pre.ok) {
      if (pre.reason === "already_app_role") {
        say(`${pre.detail}; nothing to set up`);
        return null;
      }
      return fallBack(pre.detail);
    }
    if (!secured) return fallBack("the queue schema could not be checked");
    const password = appRolePassword(env.API_TOKEN_HMAC_KEY, pre.database);
    const schema = new URL(ownerUrl).searchParams.get("schema") || "public";
    try {
      const queue = await prepareQueueSchema(client);
      if (queue === "newer") {
        return fallBack(
          "the queue schema is newer than this image's pg-boss (a rollback?), and only the owner may run on it",
        );
      }
      if (queue !== "current") say(`queue schema ${queue} as the owner`);
      await applyAppRole(client, {
        role: pre.role,
        database: pre.database,
        password,
        schema,
        superuser: pre.superuser,
      });
    } catch (err) {
      return fallBack(`setting it up failed (${errorText(err)})`);
    }
    const url = appRoleUrl(ownerUrl, pre.role, password);
    try {
      await proveLogin(url, pre.role);
    } catch (err) {
      return fallBack(
        `${pre.role} cannot log in (${errorText(err)}); a pg_hba.conf that lists users by name needs a line for it`,
      );
    }
    const { dropped } = await dropOwnerOnlyIndexes(client);
    if (dropped.length > 0) {
      say(`dropped index ${dropped.join(", ")} on measurements`);
    }
    const { rebuilt } = await rebuildBloatedQueueIndexes(client).catch(
      (err) => {
        say(`notice: the queue index check failed (${errorText(err)})`);
        return { rebuilt: [] };
      },
    );
    if (rebuilt.length > 0) {
      say(`rebuilt queue index ${rebuilt.join(", ")}`);
    }
    say(
      `the app connects as ${pre.role}: rows and the queue, no schema changes (DB_APP_ROLE=off turns this off)`,
    );
    return url;
  } catch (err) {
    if (off) return null;
    return fallBack(`the check failed (${errorText(err)})`);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function main(env = process.env) {
  const url = await ensureAppRole(env);
  if (url && !handOver(url)) {
    say(
      "the role is ready; the URL goes to file descriptor 3, which this run did not open",
    );
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      say(`notice: the database role step failed (${errorText(err)})`);
      process.exit(0);
    },
  );
}
