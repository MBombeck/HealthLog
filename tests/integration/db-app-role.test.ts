/**
 * The app's restricted database role, against a real Postgres.
 *
 * `scripts/db-app-role.mjs` runs at boot as the owner and hands the app a URL
 * for `healthlog_app`. Proven here: the role does what the app does (Prisma
 * reads and writes, pg-boss installing its schema and creating a queue
 * partition, the measurement maintenance's VACUUM and concurrent rebuild),
 * and is refused what it must not do (DDL in the app's schema, roles,
 * schemas, server files and programs, the migration history). A second run is
 * a no-op that keeps the same password, the index the role may not drop is
 * dropped by the next run as the owner, and an owner that may not create
 * roles leaves the app on the owner with a notice.
 *
 * On Postgres 16 (the nightly `INTEGRATION_PG_IMAGE` run) the script stays
 * on the owner by design; the file proves that instead.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import {
  MAINTENANCE_SESSION_OPTIONS,
  RETIRED_MEASUREMENT_INDEXES,
  runMeasurementMaintenance,
} from "@/lib/jobs/measurement-maintenance";
import {
  APP_ROLE,
  appRolePassword,
  ensureAppRole,
} from "../../scripts/db-app-role.mjs";

const HMAC_KEY = "a".repeat(64);
const PROBE_OWNER = "app_role_probe_owner";
const USER_ID = "user-app-role-probe";
const RETIRED = RETIRED_MEASUREMENT_INDEXES[0];

function ownerUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set for the integration run");
  return url;
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

let owner: Client;
let serverVersion = 0;

beforeAll(async () => {
  owner = await connect(ownerUrl());
  const { rows } = await owner.query<{ v: number }>(
    `SELECT current_setting('server_version_num')::int AS v`,
  );
  serverVersion = rows[0].v;
  // Each file starts from a worker database without the queue schema.
  await owner.query(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
});

afterAll(async () => {
  // The role is cluster-wide: hand back what it owns here and drop it, so no
  // other file or run sees it.
  for (const role of [APP_ROLE, PROBE_OWNER]) {
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

describe("DB_APP_ROLE=off", () => {
  it("stays on the owner without touching the database", async () => {
    const { url, said } = await boot({
      DATABASE_URL: ownerUrl(),
      API_TOKEN_HMAC_KEY: HMAC_KEY,
      DB_APP_ROLE: "off",
    });
    expect(url).toBeNull();
    expect(said).toContain("DB_APP_ROLE=off");
    const { rows } = await owner.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
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
    expect(said).not.toContain(appRolePassword(HMAC_KEY));
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
    expect(first.said).toContain(`the app connects as ${APP_ROLE}`);
    expect(first.said).not.toContain(appRolePassword(HMAC_KEY));
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

  it("keeps the owner's host, database and parameters", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    const owned = new URL(ownerUrl());
    const handed = new URL(appUrl);
    expect(handed.username).toBe(APP_ROLE);
    expect(handed.password).toBe(appRolePassword(HMAC_KEY));
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

  it("runs pg-boss: install, a queue partition, a job", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    const boss = new PgBoss({
      connectionString: withoutSchema(appUrl),
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    boss.on("error", () => {});
    await boss.start();
    try {
      await boss.createQueue("app-role-probe", { policy: "standard" });
      const id = await boss.send("app-role-probe", { n: 1 });
      const [job] = await boss.fetch("app-role-probe");
      expect(job?.id).toBe(id);
      await boss.complete("app-role-probe", job.id);
    } finally {
      await boss.stop({ graceful: false });
    }
    const { rows } = await owner.query<{ foreign: string }>(
      `SELECT count(*)::text AS foreign FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p')
            AND pg_get_userbyid(c.relowner) <> $1`,
      [APP_ROLE],
    );
    expect(rows[0].foreign).toBe("0");
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

  it("is refused schema changes, roles, schemas, server files and the migration history", async (ctx) => {
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
      becomeOwner: await sqlState(
        app,
        `SET ROLE ${new URL(ownerUrl()).username}`,
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
    });
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

  it("is idempotent: a second boot keeps the password and drops what the role could not", async (ctx) => {
    if (serverVersion < 170000) ctx.skip();
    // A table a later migration adds: the next boot grants it.
    await owner.query(`CREATE TABLE public.app_role_probe_new (x int)`);
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
