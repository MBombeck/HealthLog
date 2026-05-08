/**
 * Integration test bootstrap — boots a Postgres testcontainer, runs the
 * project's Prisma migrations against it, and exposes a singleton Prisma
 * client. Each test file should:
 *
 *   import { startTestDb, stopTestDb, getPrismaClient, truncateAllTables }
 *     from "./setup";
 *
 *   beforeAll(async () => { await startTestDb(); });
 *   afterAll(async () => { await stopTestDb(); });
 *   beforeEach(async () => { await truncateAllTables(getPrismaClient()); });
 *
 * The container is reused across tests inside the same vitest worker
 * (singleFork is enabled in vitest.integration.config.mts) — booting once
 * keeps the suite well under the 60s test timeout.
 */
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

import { PrismaClient } from "@/generated/prisma/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");

let container: StartedPostgreSqlContainer | null = null;
let prisma: PrismaClient | null = null;
let originalDatabaseUrl: string | undefined;

/**
 * Start a fresh Postgres container, point Prisma at it, and apply all
 * migrations. Idempotent within a vitest worker — repeated calls return
 * the already-running container.
 */
export async function startTestDb(): Promise<void> {
  if (container && prisma) return;

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("healthlog_test")
    .withUsername("healthlog")
    .withPassword("healthlog")
    .start();

  // Prisma 7 + adapter-pg can read the URL from process.env.DATABASE_URL
  // when prisma migrate deploy is invoked from a child process. The
  // ?schema=public&pgbouncer=false hints keep behaviour explicit and
  // avoid surprises when running against pgbouncer in production.
  const url = container.getConnectionUri() + "?schema=public&pgbouncer=false";
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;

  // Apply migrations in a child process so Prisma's CLI machinery picks
  // up the freshly-set DATABASE_URL and uses the project's prisma.config.ts.
  execSync("pnpm db:migrate:deploy", {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });

  const adapter = new PrismaPg({ connectionString: url });
  prisma = new PrismaClient({ adapter });
  await prisma.$connect();
}

/**
 * Stop the Postgres container and disconnect the singleton Prisma client.
 * Restores the original DATABASE_URL so a follow-up suite in the same
 * process doesn't accidentally reuse the dead container's URL.
 */
export async function stopTestDb(): Promise<void> {
  try {
    if (prisma) {
      await prisma.$disconnect();
    }
  } finally {
    prisma = null;
  }

  try {
    if (container) {
      await container.stop({ remove: true });
    }
  } finally {
    container = null;
  }

  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  originalDatabaseUrl = undefined;
}

/**
 * Singleton Prisma client connected to the running testcontainer. Throws
 * if `startTestDb()` has not been awaited.
 */
export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    throw new Error(
      "Prisma client is not initialised — call startTestDb() in beforeAll() first.",
    );
  }
  return prisma;
}

/**
 * Truncate every user-facing table in dependency-safe order using
 * `TRUNCATE … RESTART IDENTITY CASCADE`. Call from beforeEach() to make
 * tests independent. The list mirrors `prisma/schema.prisma` (25 models)
 * minus prisma-internal tables (_prisma_migrations).
 */
export async function truncateAllTables(client: PrismaClient): Promise<void> {
  // CASCADE means we only need to enumerate the tables; FK chains are
  // handled by Postgres. Listed alphabetically for diff stability.
  const tables = [
    "api_tokens",
    "app_settings",
    "audit_logs",
    "auth_challenges",
    "data_backups",
    "devices",
    "feedback",
    "idempotency_keys",
    "measurements",
    "medication_intake_events",
    "medication_schedules",
    "medications",
    "mood_entries",
    "notification_channels",
    "notification_preferences",
    "passkeys",
    "push_subscriptions",
    "rate_limits",
    "reminder_phase_configs",
    "sessions",
    "telegram_reminder_messages",
    "telegram_scheduled_deletions",
    "user_achievements",
    "users",
    "withings_connections",
  ];

  const quoted = tables.map((t) => `"${t}"`).join(", ");
  await client.$executeRawUnsafe(
    `TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`,
  );
}
