#!/usr/bin/env node
/**
 * The database role the running app connects as.
 *
 * The migrations, the dump before them and the restore connect as the owner
 * `DATABASE_URL` names. The long-running web and worker processes do not need
 * the owner: they read and write rows, run the queue, and maintain one table.
 * After the migrations, `docker-entrypoint.sh` runs this script as the owner.
 * It ensures a login role, `healthlog_app`, that can do exactly that, and
 * hands the entrypoint a `DATABASE_URL` for it; the entrypoint then starts the
 * app with that URL in place of the owner's, so the owner's credentials never
 * reach the app's environment.
 *
 * What the role can do:
 *   - SELECT, INSERT, UPDATE, DELETE on every table of the app's schema, and
 *     USAGE, SELECT, UPDATE on its sequences. `_prisma_migrations` is SELECT
 *     only: the app reads the migration history, it never writes it.
 *   - MAINTAIN on `measurements` (Postgres 17+): the maintenance job's
 *     `VACUUM (ANALYZE)` and `REINDEX INDEX CONCURRENTLY`.
 *   - Own the `pgboss` schema and everything in it. pg-boss creates and
 *     migrates its own tables, functions and per-queue partitions at runtime,
 *     so it needs DDL there; it is the queue's private schema and nothing of
 *     the app's data lives in it.
 *
 * What it cannot do: create, alter or drop anything in the app's schema;
 * create schemas, databases or roles; act as a superuser, so no
 * `COPY ... FROM PROGRAM`, no `pg_read_file`, no untrusted languages; write
 * the migration history. `CREATE` on the app's schema is revoked from PUBLIC
 * as well (the default since Postgres 15; a database first created on an
 * older major still grants it), where the owner may do so.
 *
 * Every boot re-applies it, inside one transaction under an advisory lock, so
 * a table a new migration created is covered before the app starts, a web and
 * a worker container booting together do not race, and a restored database
 * (whose objects `pg_restore --no-owner` hands to the owner) is put right.
 * Grants only touch what lacks them, so a boot after the first writes
 * almost nothing to the catalog.
 *
 * The password is derived, not stored: HMAC-SHA256 of a fixed label under
 * API_TOKEN_HMAC_KEY. Every container of one instance carries that key, so a
 * separate worker container derives the same password without a new
 * variable. It is set as a SCRAM verifier computed here, so the plaintext
 * never travels to the server, where a statement log could keep it. The role
 * is marked with a comment; a role of the same name without the mark is not
 * HealthLog's, and is left alone.
 *
 * Fail open, loudly. When the owner cannot do this (a managed or external
 * database whose user may not create roles, Postgres before 17, a pg_hba.conf
 * that does not let the new role in, a lock that did not come in time), the
 * script says why in one notice and the app runs as the owner, as it did
 * before. `DB_APP_ROLE=off` skips it for an operator who manages roles
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
 * Plain ESM with no imports beyond Node, `pg` and the shared dump module, so
 * it runs from the runtime image like the other entrypoint scripts.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { connect } from "../src/lib/database-backup/dump-core.mjs";
import {
  CONCURRENT_COPY,
  RETIRED_MEASUREMENT_INDEXES,
} from "../src/lib/jobs/retired-measurement-indexes.mjs";

/** The role's name. Cluster-wide, like every Postgres role. */
export const APP_ROLE = "healthlog_app";

/** The mark on a role this script created. */
export const ROLE_COMMENT =
  "Managed by HealthLog: the app's least-privilege login (scripts/db-app-role.mjs). Recreated and re-granted on every start.";

/** The schema pg-boss keeps its queue in (its default; HealthLog sets none). */
export const QUEUE_SCHEMA = "pgboss";

/** Tables the role may maintain (VACUUM, ANALYZE, REINDEX). */
export const MAINTAINED_TABLES = Object.freeze(["measurements"]);

/** Tables the role may only read. */
export const READ_ONLY_TABLES = Object.freeze(["_prisma_migrations"]);

/** The label the password is derived under. A new label is a new password. */
const PASSWORD_LABEL = "healthlog database app role v1";

/** The first major with the MAINTAIN privilege. */
export const MIN_SERVER_VERSION_NUM = 170000;

/** How long the setup waits for a lock before staying on the owner. */
const SETUP_LOCK_TIMEOUT = "15s";

/** How long a boot-time index drop waits for its lock. */
export const BOOT_DROP_LOCK_TIMEOUT = "5s";

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

/** The role's password: 64 hex characters, the same in every container. */
export function appRolePassword(hmacKey) {
  if (!hmacKey) throw new Error("API_TOKEN_HMAC_KEY is not set");
  return createHmac("sha256", hmacKey).update(PASSWORD_LABEL).digest("hex");
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
export function appRoleUrl(ownerUrl, password) {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
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
 * @returns {Promise<{ ok: true, superuser: boolean } | { ok: false, reason: string, detail: string }>}
 */
export async function checkPreconditions(client) {
  const { rows } = await client.query(
    `SELECT current_setting('server_version_num')::int AS version,
            r.rolsuper AS superuser,
            r.rolcreaterole AS createrole,
            current_user AS me
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const me = rows[0];
  if (me.me === APP_ROLE) {
    return {
      ok: false,
      reason: "already_app_role",
      detail: `DATABASE_URL already names ${APP_ROLE}`,
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
            r.rolsuper OR r.rolreplication OR r.rolbypassrls AS elevated
       FROM pg_roles r WHERE r.rolname = $1`,
    [APP_ROLE],
  );
  const role = existing.rows[0];
  if (role && role.comment !== ROLE_COMMENT) {
    return {
      ok: false,
      reason: "foreign_role",
      detail: `a role named ${APP_ROLE} exists that HealthLog did not create`,
    };
  }
  if (role?.member_of_owner) {
    return {
      ok: false,
      reason: "role_inherits_owner",
      detail: `${APP_ROLE} is a member of ${me.me}, so it would hold the owner's rights`,
    };
  }
  if (role?.elevated && !me.superuser) {
    return {
      ok: false,
      reason: "role_elevated",
      detail: `${APP_ROLE} has SUPERUSER, REPLICATION or BYPASSRLS, and only a superuser can take it away`,
    };
  }
  return { ok: true, superuser: me.superuser };
}

/**
 * Create or update the role and apply every grant, in one transaction.
 * Call it on a client connected as the owner, after the migrations.
 *
 * @param {{ query: Function }} client
 * @param {{ password: string, schema?: string, superuser: boolean }} options
 */
export async function applyAppRole(client, options) {
  const schema = options.schema ?? "public";
  const role = ident(APP_ROLE);
  const app = ident(schema);
  const queue = ident(QUEUE_SCHEMA);
  // The verifier is a base64/`$`/`:` string; it never contains a quote.
  const verifier = scramVerifier(options.password);
  if (verifier.includes("'")) throw new Error("unexpected verifier shape");

  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${SETUP_LOCK_TIMEOUT}'`);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('healthlog.db-app-role'))`,
    );

    const { rows: present } = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
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
      `COMMENT ON ROLE ${role} IS '${ROLE_COMMENT.replace(/'/g, "''")}'`,
    );

    // A non-superuser owner hands objects to the role only when it may act
    // as it (Postgres 16+), and must keep reading what the role owns: the
    // dump before a migration reads the queue schema too. The membership
    // runs owner -> role, never the other way.
    if (!options.superuser) {
      await client.query(
        `GRANT ${role} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`,
      );
    }

    const { rows: db } = await client.query(
      `SELECT current_database() AS name`,
    );
    await client.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE "${String(db[0].name).replace(/"/g, '""')}" TO ${role}`,
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
      [schema, APP_ROLE, READ_ONLY_TABLES],
    );
    for (const { name } of tables) {
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${app}.${ident(name)} TO ${role}`,
      );
    }
    for (const name of READ_ONLY_TABLES) {
      const { rows } = await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`${app}.${ident(name)}`],
      );
      if (!rows[0].present) continue;
      await client.query(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${app}.${ident(name)} FROM ${role}`,
      );
      await client.query(`GRANT SELECT ON ${app}.${ident(name)} TO ${role}`);
    }

    const { rows: sequences } = await client.query(
      `SELECT c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'S'
          AND NOT (has_sequence_privilege($2, c.oid, 'USAGE')
               AND has_sequence_privilege($2, c.oid, 'SELECT')
               AND has_sequence_privilege($2, c.oid, 'UPDATE'))`,
      [schema, APP_ROLE],
    );
    for (const { name } of sequences) {
      await client.query(
        `GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${app}.${ident(name)} TO ${role}`,
      );
    }

    // Objects the owner creates later in this schema (the migrations of the
    // next update) are granted at creation as well. The per-boot pass above
    // is what the app relies on; this covers the time between the two.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${app} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${app} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`,
    );

    for (const name of MAINTAINED_TABLES) {
      const { rows } = await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`${app}.${ident(name)}`],
      );
      if (rows[0].present) {
        await client.query(
          `GRANT MAINTAIN ON ${app}.${ident(name)} TO ${role}`,
        );
      }
    }

    // The queue's schema belongs to the role: pg-boss creates its tables,
    // functions and partitions there at runtime. On the first boot after an
    // update, and after a restore, everything in it still belongs to the
    // owner and is handed over once.
    await client.query(
      `CREATE SCHEMA IF NOT EXISTS ${queue} AUTHORIZATION ${role}`,
    );
    await client.query(`ALTER SCHEMA ${queue} OWNER TO ${role}`);
    await transferQueueObjects(client, role);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** Hand every object in the queue schema the role does not own to it. */
async function transferQueueObjects(client, role) {
  const { rows: relations } = await client.query(
    `SELECT c.oid::regclass::text AS name, c.relkind AS kind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = $2)
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        -- A sequence a column owns follows its table.
        AND NOT (c.relkind = 'S' AND EXISTS (
              SELECT 1 FROM pg_depend d
               WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                 AND d.deptype IN ('a', 'i')))
      ORDER BY c.relkind = 'r' DESC, c.oid`,
    [QUEUE_SCHEMA, APP_ROLE],
  );
  for (const { name, kind } of relations) {
    const what =
      kind === "S"
        ? "SEQUENCE"
        : kind === "v"
          ? "VIEW"
          : kind === "m"
            ? "MATERIALIZED VIEW"
            : kind === "f"
              ? "FOREIGN TABLE"
              : "TABLE";
    // `regclass::text` is the catalog's own quoting of the name.
    await client.query(`ALTER ${what} ${name} OWNER TO ${role}`);
  }

  const { rows: routines } = await client.query(
    `SELECT p.oid::regprocedure::text AS signature
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
        AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = $2)`,
    [QUEUE_SCHEMA, APP_ROLE],
  );
  for (const { signature } of routines) {
    await client.query(`ALTER ROUTINE ${signature} OWNER TO ${role}`);
  }

  // Enums, domains and free-standing composite types; a table's row type
  // and an array type follow their owner object.
  const { rows: types } = await client.query(
    `SELECT t.oid::regtype::text AS name, t.typtype AS kind
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       LEFT JOIN pg_class c ON c.oid = t.typrelid
      WHERE n.nspname = $1
        AND t.typowner <> (SELECT oid FROM pg_roles WHERE rolname = $2)
        AND t.typelem = 0
        AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND c.relkind = 'c'))`,
    [QUEUE_SCHEMA, APP_ROLE],
  );
  for (const { name, kind } of types) {
    await client.query(
      `ALTER ${kind === "d" ? "DOMAIN" : "TYPE"} ${name} OWNER TO ${role}`,
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
async function proveLogin(url) {
  const client = await connect(url);
  try {
    const { rows } = await client.query(`SELECT current_user AS me`);
    if (rows[0].me !== APP_ROLE) {
      throw new Error(`logged in as ${rows[0].me}, not ${APP_ROLE}`);
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
 * The boot step. Returns the role's URL when the app should use it, or null
 * to stay on the owner.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string | null>}
 */
export async function ensureAppRole(env = process.env) {
  const ownerUrl = env.DATABASE_URL;
  const mode = (env.DB_APP_ROLE ?? "").trim().toLowerCase();
  if (mode === "off" || mode === "false") {
    say(
      `DB_APP_ROLE=off: the app connects as ${userOf(ownerUrl)}, the user DATABASE_URL names`,
    );
    return null;
  }
  if (mode && mode !== "auto" && mode !== "on") {
    say(
      `notice: DB_APP_ROLE="${mode}" is not auto or off; treating it as auto`,
    );
  }
  if (!ownerUrl) return null;

  const user = userOf(ownerUrl);
  const fallBack = (detail) => {
    say(
      `notice: the app connects as ${user}, the user DATABASE_URL names, not as the restricted role ${APP_ROLE}: ${detail}. ` +
        "This is how every earlier release ran. " +
        `If ${user} is a restricted role you manage yourself, DB_APP_ROLE=off silences this; otherwise see docs/self-hosting/database-role.md.`,
    );
    return null;
  };

  let client;
  try {
    client = await connect(ownerUrl);
  } catch (err) {
    return fallBack(`could not connect to set it up (${errorText(err)})`);
  }
  try {
    const pre = await checkPreconditions(client);
    if (!pre.ok) {
      if (pre.reason === "already_app_role") {
        say(`DATABASE_URL already names ${APP_ROLE}; nothing to set up`);
        return null;
      }
      return fallBack(pre.detail);
    }
    const password = appRolePassword(env.API_TOKEN_HMAC_KEY);
    const schema = new URL(ownerUrl).searchParams.get("schema") || "public";
    try {
      await applyAppRole(client, {
        password,
        schema,
        superuser: pre.superuser,
      });
    } catch (err) {
      return fallBack(`setting it up failed (${errorText(err)})`);
    }
    const url = appRoleUrl(ownerUrl, password);
    try {
      await proveLogin(url);
    } catch (err) {
      return fallBack(
        `${APP_ROLE} cannot log in (${errorText(err)}); a pg_hba.conf that lists users by name needs a line for it`,
      );
    }
    const { dropped } = await dropOwnerOnlyIndexes(client);
    if (dropped.length > 0) {
      say(`dropped index ${dropped.join(", ")} on measurements`);
    }
    say(
      `the app connects as ${APP_ROLE}: rows and the queue, no schema changes (DB_APP_ROLE=off turns this off)`,
    );
    return url;
  } catch (err) {
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
