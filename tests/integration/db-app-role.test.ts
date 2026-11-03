/**
 * The app's restricted database role, against a real Postgres.
 *
 * `scripts/db-app-role.mjs` runs at boot as the owner and hands the app a URL
 * for this database's own role (`healthlog_app_<database>_<hash>`). Proven
 * here:
 *
 *   - The role does what the app does: Prisma reads and writes, the queue
 *     lifecycle the worker runs (start with `migrate: false`, create a new
 *     queue, send, fetch, complete, schedule, delete a queue, a supervise
 *     pass), the measurement maintenance's VACUUM and concurrent rebuild.
 *   - It is refused what it must not do: DDL in either schema, triggers,
 *     functions, roles, schemas, server files and programs, the migration
 *     history, and the two queue tables whose contents pg-boss executes or
 *     migrates by.
 *   - It owns nothing in the queue schema, which the boot installs as the
 *     owner, and the boot takes back, from a pre-release state, a schema a
 *     HealthLog role owned, with a planted trigger and a replaced function.
 *   - Two databases on one server get two roles that do not lock each other
 *     out and cannot read each other's data; a role that holds CONNECT on
 *     another database is refused.
 *   - A second run is a no-op that keeps the password; an owner that may not
 *     create roles, and DB_APP_ROLE=off, leave the app on the owner.
 *
 * On Postgres 16 (the nightly `INTEGRATION_PG_IMAGE` run) the script stays
 * on the owner by design; the file proves that instead.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { createWorkerBoss } from "@/lib/jobs/boss-instance";
import {
  MAINTENANCE_SESSION_OPTIONS,
  RETIRED_MEASUREMENT_INDEXES,
  runMeasurementMaintenance,
} from "@/lib/jobs/measurement-maintenance";
import {
  LEGACY_APP_ROLE,
  MANAGED_MARK,
  appRoleName,
  appRolePassword,
  ensureAppRole,
  restoreQueueFunctions,
} from "../../scripts/db-app-role.mjs";
import { TEMPLATE_DATABASE } from "./worker-database";

const HMAC_KEY = "a".repeat(64);
const OTHER_HMAC_KEY = "b".repeat(64);
const PROBE_OWNER = "app_role_probe_owner";
const USER_ID = "user-app-role-probe";
const RETIRED = RETIRED_MEASUREMENT_INDEXES[0];
const OTHER_DB = `app_role_probe_other_${process.pid}`;

function ownerUrl(database?: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set for the integration run");
  if (!database) return url;
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

function withoutSchema(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("schema");
  u.searchParams.delete("pgbouncer");
  return u.toString();
}

async function connect(url: string, options?: string): Promise<Client> {
  const client = new Client({ connectionString: withoutSchema(url), options });
  await client.connect();
  return client;
}

/** Run the boot step and keep what it says on stderr. */
async function boot(
  env: Record<string, string | undefined>,
): Promise<{ url: string | null; said: string }> {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  try {
    const url = await ensureAppRole(env as NodeJS.ProcessEnv);
    return { url, said: lines.join("") };
  } finally {
    spy.mockRestore();
  }
}

async function sqlState(db: Client, sql: string): Promise<string | null> {
  try {
    await db.query(sql);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

/** Objects in the queue schema not owned by `owner`. */
async function queueObjectsNotOwnedBy(
  db: Client,
  owner: string,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'pgboss' AND pg_get_userbyid(c.relowner) <> $1)
     + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'pgboss' AND pg_get_userbyid(p.proowner) <> $1)
     + (SELECT count(*) FROM pg_namespace WHERE nspname = 'pgboss'
         AND pg_get_userbyid(nspowner) <> $1))::text AS n`,
    [owner],
  );
  return Number(rows[0].n);
}

let owner: Client;
let ownerName = "";
let serverVersion = 0;
const roleA = () => appRoleName(databaseOf(ownerUrl()));
const roleB = appRoleName(OTHER_DB);

beforeAll(async () => {
  owner = await connect(ownerUrl());
  const { rows } = await owner.query<{ v: number; me: string }>(
    `SELECT current_setting('server_version_num')::int AS v, current_user AS me`,
  );
  serverVersion = rows[0].v;
  ownerName = rows[0].me;
  // Each file starts from a worker database without the queue schema.
  await owner.query(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
});

afterAll(async () => {
  await owner.query(`DROP DATABASE IF EXISTS "${OTHER_DB}" WITH (FORCE)`);
  // Roles are cluster-wide: hand back what they hold here and drop them, so
  // no other file or run sees them.
  for (const role of [roleA(), roleB, LEGACY_APP_ROLE, PROBE_OWNER]) {
    const { rows } = await owner.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      [role],
    );
    if (rows.length === 0) continue;
    await owner.query(`REASSIGN OWNED BY "${role}" TO CURRENT_USER`);
    await owner.query(`DROP OWNED BY "${role}"`);
    await owner.query(`DROP ROLE "${role}"`);
  }
  await owner.query(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
  await owner.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  await owner.end();
});

describe("the role's name", () => {
  it("is per database, under 63 characters, and stable", () => {
    expect(appRoleName("healthlog")).toMatch(
      /^healthlog_app_healthlog_[0-9a-f]{8}$/,
    );
    expect(appRoleName("healthlog")).toBe(appRoleName("healthlog"));
    expect(appRoleName("healthlog")).not.toBe(appRoleName("healthlog-staging"));
    // Names that clean up alike still differ by their hash.
    expect(appRoleName("a-b")).not.toBe(appRoleName("a_b"));
    expect(appRoleName("x".repeat(63)).length).toBeLessThanOrEqual(63);
    expect(appRolePassword(HMAC_KEY, "a")).not.toBe(
      appRolePassword(HMAC_KEY, "b"),
    );
  });
});

describe("DB_APP_ROLE=off", () => {
  it("stays on the owner and creates no role", async () => {
    const { url, said } = await boot({
      DATABASE_URL: ownerUrl(),
      API_TOKEN_HMAC_KEY: HMAC_KEY,
      DB_APP_ROLE: "off",
    });
    expect(url).toBeNull();
    expect(said).toContain("DB_APP_ROLE=off");
    const { rows } = await owner.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      [roleA()],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("an owner that may not create roles", () => {
  it("leaves the app on that user, with a notice and no secret in it", async () => {
    await owner.query(
      `CREATE ROLE ${PROBE_OWNER} LOGIN NOSUPERUSER NOCREATEROLE PASSWORD 'probe-owner-pw'`,
    );
    const url = new URL(ownerUrl());
    url.username = PROBE_OWNER;
    url.password = "probe-owner-pw";
    const { url: handed, said } = await boot({
      DATABASE_URL: url.toString(),
      API_TOKEN_HMAC_KEY: HMAC_KEY,
    });
    expect(handed).toBeNull();
    expect(said).toContain(`the app connects as ${PROBE_OWNER}`);
    if (serverVersion >= 170000) {
      expect(said).toContain("may not create roles");
    }
    expect(said).not.toContain("probe-owner-pw");
    expect(said).not.toContain(
      appRolePassword(HMAC_KEY, databaseOf(ownerUrl())),
    );
  });
});

describe("Postgres before 17", () => {
  it("stays on the owner: no MAINTAIN privilege", async (ctx) => {
    if (serverVersion >= 170000) ctx.skip();
    const { url, said } = await boot({
      DATABASE_URL: ownerUrl(),
      API_TOKEN_HMAC_KEY: HMAC_KEY,
    });
    expect(url).toBeNull();
    expect(said).toContain("no MAINTAIN privilege");
  });
});

describe("the restricted role (Postgres 17+)", () => {
  let appUrl: string;
  let app: Client;

  beforeAll(async () => {
    if (serverVersion < 170000) return;
    // A database first created before Postgres 15 still lets PUBLIC create
    // objects in `public`; the boot must take that away from the role too.
    await owner.query(`GRANT CREATE ON SCHEMA public TO PUBLIC`);
    // An index the role may not drop, as an instance that has not run 0416.
    await owner.query(
      `CREATE INDEX IF NOT EXISTS "${RETIRED}" ON "measurements" ("user_id", "type", "measured_at")`,
    );
    const first = await boot({
      DATABASE_URL: ownerUrl(),
      API_TOKEN_HMAC_KEY: HMAC_KEY,
    });
    expect(first.url, first.said).not.toBeNull();
    expect(first.said).toContain(`the app connects as ${roleA()}`);
    expect(first.said).toContain("queue schema installed as the owner");
    expect(first.said).not.toContain(
      appRolePassword(HMAC_KEY, databaseOf(ownerUrl())),
    );
    // The first run drops it as the owner; put it back for the role's turn.
    expect(first.said).toContain(`dropped index ${RETIRED}`);
    await owner.query(
      `CREATE INDEX IF NOT EXISTS "${RETIRED}" ON "measurements" ("user_id", "type", "measured_at")`,
    );
    appUrl = first.url!;
    app = await connect(appUrl);
  });

  afterAll(async () => {
    await app?.end();
  });

  it("keeps the owner's host, database and parameters", (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    const owned = new URL(ownerUrl());
    const handed = new URL(appUrl);
    expect(handed.username).toBe(roleA());
    expect(handed.password).toBe(
      appRolePassword(HMAC_KEY, databaseOf(ownerUrl())),
    );
    expect(handed.host).toBe(owned.host);
    expect(handed.pathname).toBe(owned.pathname);
    expect(handed.search).toBe(owned.search);
  });

  it("reads and writes rows through Prisma", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: withoutSchema(appUrl) }),
    });
    try {
      await db.user.create({
        data: {
          id: USER_ID,
          username: "app-role-probe",
          email: "app-role-probe@example.test",
          role: "USER",
        },
      });
      await db.measurement.create({
        data: {
          userId: USER_ID,
          type: "WEIGHT",
          value: 70,
          unit: "kg",
          measuredAt: new Date("2026-01-01T08:00:00Z"),
        },
      });
      await db.user.update({
        where: { id: USER_ID },
        data: { username: "app-role-probe-2" },
      });
      expect(await db.measurement.count({ where: { userId: USER_ID } })).toBe(
        1,
      );
      await db.measurement.deleteMany({ where: { userId: USER_ID } });
      const migrations = await db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM _prisma_migrations`;
      expect(Number(migrations[0].n)).toBeGreaterThan(100);
    } finally {
      await db.$disconnect();
    }
  });

  it("runs the worker's queue lifecycle owning nothing in the queue schema", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    expect(await queueObjectsNotOwnedBy(owner, ownerName)).toBe(0);
    const errors: unknown[] = [];
    // The options the worker passes when it does not own the schema.
    const boss = createWorkerBoss(withoutSchema(appUrl), {
      ownsQueueSchema: false,
    });
    boss.on("error", (err: unknown) => errors.push(err));
    await boss.start();
    try {
      // A queue no earlier boot created: a row, no table.
      const queue = `app-role-probe-${Date.now()}`;
      await boss.createQueue(queue, { policy: "standard" });
      await boss.createQueue(`${queue}-singleton`, { policy: "singleton" });
      const id = await boss.send(queue, { n: 1 });
      const [job] = await boss.fetch(queue);
      expect(job?.id).toBe(id);
      await boss.complete(queue, job.id);
      await boss.schedule(queue, "0 3 * * *", {}, { tz: "Europe/Berlin" });
      await boss.unschedule(queue);
      await boss.supervise();
      await boss.deleteQueue(`${queue}-singleton`);
    } finally {
      await boss.stop({ graceful: false });
    }
    expect(errors).toEqual([]);
    // Still nothing of the role's in the schema.
    expect(await queueObjectsNotOwnedBy(owner, ownerName)).toBe(0);
  });

  it("vacuums and rebuilds measurements, and leaves the drop to the owner", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    const db = await connect(appUrl, MAINTENANCE_SESSION_OPTIONS);
    try {
      const summary = await runMeasurementMaintenance(db, {
        vacuum: true,
        reindex: true,
      });
      expect(summary.outcome).toBe("completed");
      // A VACUUM without the privilege only warns and skips the table, so
      // the step reads ok either way; the grant is what makes it real.
      const { rows } = await db.query<{ maintain: boolean }>(
        `SELECT has_table_privilege(current_user, 'measurements', 'MAINTAIN') AS maintain`,
      );
      expect(rows[0].maintain).toBe(true);
      expect(summary.steps.find((s) => s.step === "vacuum")?.ok).toBe(true);
      const rebuilt = summary.steps.filter((s) => s.step === "reindex");
      expect(rebuilt.length).toBeGreaterThan(0);
      expect(rebuilt.every((s) => s.ok)).toBe(true);
      expect(summary.dropsLeftForBoot).toEqual([RETIRED]);
    } finally {
      await db.end();
    }
  });

  it("is refused schema changes, triggers, functions, roles, server files and the queue's executed tables", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    const refused = {
      dropTable: await sqlState(app, `DROP TABLE "users"`),
      alterTable: await sqlState(
        app,
        `ALTER TABLE "users" ADD COLUMN probe text`,
      ),
      createTable: await sqlState(app, `CREATE TABLE public.probe (x int)`),
      createFunction: await sqlState(
        app,
        `CREATE FUNCTION public.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
      ),
      createRole: await sqlState(app, `CREATE ROLE probe_escalation`),
      createSchema: await sqlState(app, `CREATE SCHEMA probe`),
      readFile: await sqlState(app, `SELECT pg_read_file('postgresql.conf')`),
      program: await sqlState(app, `COPY (SELECT 1) TO PROGRAM 'true'`),
      dropIndex: await sqlState(app, `DROP INDEX "${RETIRED}"`),
      writeMigrations: await sqlState(
        app,
        `DELETE FROM _prisma_migrations WHERE false`,
      ),
      becomeOwner: await sqlState(app, `SET ROLE "${ownerName}"`),
      queueTrigger: await sqlState(
        app,
        `CREATE TRIGGER probe BEFORE INSERT ON pgboss.job_common
           FOR EACH ROW EXECUTE FUNCTION pgboss.job_now()`,
      ),
      queueFunction: await sqlState(
        app,
        `CREATE FUNCTION pgboss.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
      ),
      replaceQueueFunction: await sqlState(
        app,
        `CREATE OR REPLACE FUNCTION pgboss.job_now() RETURNS timestamptz LANGUAGE sql AS 'SELECT now()'`,
      ),
      queueTable: await sqlState(app, `CREATE TABLE pgboss.probe (x int)`),
      alterQueueTable: await sqlState(
        app,
        `ALTER TABLE pgboss.queue ADD COLUMN probe text`,
      ),
      writeBam: await sqlState(
        app,
        `INSERT INTO pgboss.bam (name, version, status, command) VALUES ('probe', 1, 'pending', 'SELECT 1')`,
      ),
      writeQueueVersion: await sqlState(
        app,
        `UPDATE pgboss.version SET version = version`,
      ),
    };
    expect(refused).toEqual({
      dropTable: "42501",
      alterTable: "42501",
      createTable: "42501",
      createFunction: "42501",
      createRole: "42501",
      createSchema: "42501",
      readFile: "42501",
      program: "42501",
      dropIndex: "42501",
      writeMigrations: "42501",
      becomeOwner: "42501",
      queueTrigger: "42501",
      queueFunction: "42501",
      replaceQueueFunction: "42501",
      queueTable: "42501",
      alterQueueTable: "42501",
      writeBam: "42501",
      writeQueueVersion: "42501",
    });
    // pg-boss's own maintenance stamps stay writable.
    expect(
      await sqlState(app, `UPDATE pgboss.version SET cron_on = cron_on`),
    ).toBeNull();
    const { rows } = await app.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
    });
  });

  it("does not let the worker migrate the queue schema as the role", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    const { rows } = await owner.query<{ v: number }>(
      `SELECT max(version)::int AS v FROM pgboss.version`,
    );
    await owner.query(`UPDATE pgboss.version SET version = $1`, [
      rows[0].v - 1,
    ]);
    try {
      const boss = createWorkerBoss(withoutSchema(appUrl), {
        ownsQueueSchema: false,
      });
      boss.on("error", () => {});
      await expect(boss.start()).rejects.toThrow(/requires migrations/);
      await boss.stop({ graceful: false }).catch(() => {});
    } finally {
      await owner.query(`UPDATE pgboss.version SET version = $1`, [rows[0].v]);
    }
  });

  it("leaves pg-boss's own functions alone on an untouched schema", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    expect(await restoreQueueFunctions(owner)).toEqual([]);
  });

  it("gives a second database on the server its own role, without locking the first out", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    await owner.query(
      `SELECT pg_advisory_lock(hashtext('healthlog-integration-clone'))`,
    );
    try {
      await owner.query(
        `CREATE DATABASE "${OTHER_DB}" TEMPLATE "${TEMPLATE_DATABASE}"`,
      );
    } finally {
      await owner.query(
        `SELECT pg_advisory_unlock(hashtext('healthlog-integration-clone'))`,
      );
    }
    const other = await boot({
      DATABASE_URL: ownerUrl(OTHER_DB),
      API_TOKEN_HMAC_KEY: OTHER_HMAC_KEY,
    });
    expect(other.url, other.said).not.toBeNull();
    expect(new URL(other.url!).username).toBe(roleB);
    expect(roleB).not.toBe(roleA());

    // Both log in to their own database, the first after the second's boot.
    for (const [url, role] of [
      [appUrl, roleA()],
      [other.url!, roleB],
    ] as const) {
      const db = await connect(url);
      const { rows } = await db.query(`SELECT current_user AS me`);
      expect(rows[0].me).toBe(role);
      await db.query(`SELECT count(*) FROM users`);
      await db.end();
    }

    // Each is refused the other's data and queue.
    for (const [url, database] of [
      [appUrl, OTHER_DB],
      [other.url!, databaseOf(ownerUrl())],
    ] as const) {
      const u = new URL(url);
      u.pathname = `/${database}`;
      const db = await connect(u.toString());
      expect(await sqlState(db, `SELECT count(*) FROM users`)).toBe("42501");
      expect(await sqlState(db, `SELECT count(*) FROM pgboss.job`)).toBe(
        "42501",
      );
      expect(await sqlState(db, `CREATE TABLE public.probe (x int)`)).toBe(
        "42501",
      );
      await db.end();
    }

    // A role that holds CONNECT on another database is not used.
    await owner.query(
      `GRANT CONNECT ON DATABASE "${OTHER_DB}" TO "${roleA()}"`,
    );
    try {
      const refused = await boot({
        DATABASE_URL: ownerUrl(),
        API_TOKEN_HMAC_KEY: HMAC_KEY,
      });
      expect(refused.url).toBeNull();
      expect(refused.said).toContain(
        `holds CONNECT on another database (${OTHER_DB})`,
      );
    } finally {
      await owner.query(
        `REVOKE CONNECT ON DATABASE "${OTHER_DB}" FROM "${roleA()}"`,
      );
    }
  });

  it("takes the queue schema back from a pre-release role, with what it planted", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    const { rows: before } = await owner.query<{ src: string }>(
      `SELECT prosrc AS src FROM pg_proc WHERE oid = 'pgboss.job_now()'::regprocedure`,
    );
    // The state a pre-release build left: the schema and everything in it
    // owned by the cluster-wide role, which could then plant code.
    await owner.query(
      `CREATE ROLE "${LEGACY_APP_ROLE}" NOLOGIN;
       COMMENT ON ROLE "${LEGACY_APP_ROLE}" IS '${MANAGED_MARK}: the app''s least-privilege login (scripts/db-app-role.mjs). Recreated and re-granted on every start.';
       GRANT SELECT ON users TO "${LEGACY_APP_ROLE}";
       ALTER SCHEMA pgboss OWNER TO "${LEGACY_APP_ROLE}";
       ALTER TABLE pgboss.job_common OWNER TO "${LEGACY_APP_ROLE}";
       ALTER FUNCTION pgboss.job_now() OWNER TO "${LEGACY_APP_ROLE}";
       CREATE OR REPLACE FUNCTION pgboss.job_now() RETURNS timestamptz
         LANGUAGE sql AS 'SELECT now() - interval ''1 day''';
       CREATE FUNCTION pgboss.planted() RETURNS trigger LANGUAGE plpgsql
         AS 'BEGIN RETURN NEW; END';
       ALTER FUNCTION pgboss.planted() OWNER TO "${LEGACY_APP_ROLE}";
       CREATE TRIGGER planted BEFORE INSERT ON pgboss.job_common
         FOR EACH ROW EXECUTE FUNCTION pgboss.planted();
       CREATE RULE planted AS ON DELETE TO pgboss.queue DO INSTEAD NOTHING;`,
    );

    const next = await boot({
      DATABASE_URL: ownerUrl(),
      API_TOKEN_HMAC_KEY: HMAC_KEY,
    });
    expect(next.url, next.said).toBe(appUrl);
    expect(next.said).toContain("took back");
    expect(next.said).toContain("trigger planted");
    expect(next.said).toContain("rule planted");
    expect(await queueObjectsNotOwnedBy(owner, ownerName)).toBe(0);
    const { rows: after } = await owner.query<{ src: string }>(
      `SELECT prosrc AS src FROM pg_proc WHERE oid = 'pgboss.job_now()'::regprocedure`,
    );
    expect(after[0].src).toBe(before[0].src);
    const { rows: leftovers } = await owner.query(
      `SELECT to_regprocedure('pgboss.planted()') AS planted,
              (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'pgboss' AND NOT t.tgisinternal) AS triggers,
              (SELECT count(*)::int FROM pg_roles WHERE rolname = $1) AS legacy`,
      [LEGACY_APP_ROLE],
    );
    expect(leftovers[0]).toEqual({ planted: null, triggers: 0, legacy: 0 });
    // Taken back, not dropped: the queue's tables are all still there.
    const { rows: tables } = await owner.query(
      `SELECT to_regclass('pgboss.job_common') IS NOT NULL AS common,
              (SELECT count(*)::int FROM pgboss.queue) > 0 AS queues`,
    );
    expect(tables[0]).toEqual({ common: true, queues: true });
  });

  it("is idempotent: a later boot keeps the password and drops what the role could not", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    // A table a later migration adds: the next boot grants it.
    await owner.query(`CREATE TABLE public.app_role_probe_new (x int)`);
    // The boot before this one dropped it; put it back once more.
    await owner.query(
      `CREATE INDEX IF NOT EXISTS "${RETIRED}" ON "measurements" ("user_id", "type", "measured_at")`,
    );
    try {
      const second = await boot({
        DATABASE_URL: ownerUrl(),
        API_TOKEN_HMAC_KEY: HMAC_KEY,
      });
      expect(second.url).toBe(appUrl);
      expect(second.said).toContain(`dropped index ${RETIRED}`);
      // The connection opened before the second boot still works.
      await app.query(`INSERT INTO public.app_role_probe_new VALUES (1)`);
      const third = await boot({
        DATABASE_URL: ownerUrl(),
        API_TOKEN_HMAC_KEY: HMAC_KEY,
      });
      expect(third.url).toBe(appUrl);
      expect(third.said).not.toContain("dropped index");
      expect(third.said).not.toContain("took back");
      const { rows } = await owner.query(
        `SELECT to_regclass($1) IS NULL AS gone`,
        [RETIRED],
      );
      expect(rows[0].gone).toBe(true);
    } finally {
      await owner.query(`DROP TABLE public.app_role_probe_new`);
    }
  });
});
