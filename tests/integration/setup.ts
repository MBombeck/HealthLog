/**
 * Per-test helpers for the integration suite. The Postgres testcontainer
 * is started ONCE in `global-setup.ts` and torn down at the end of the
 * run, so test files only need:
 *
 *   import { getPrismaClient, truncateAllTables } from "./setup";
 *
 *   beforeEach(async () => { await truncateAllTables(getPrismaClient()); });
 *
 * No beforeAll(startTestDb) / afterAll(stopTestDb) is needed — the
 * container is alive whenever the test file is loaded, and Vitest's
 * worker inherits `process.env.DATABASE_URL` from globalSetup so the
 * application's Prisma singleton (`src/lib/db.ts`) connects to the
 * testcontainer transparently.
 */
import { prisma } from "@/lib/db";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The application's Prisma singleton. Tests use this so any code
 * imported via `await import("@/lib/...")` shares the exact same client
 * instance — no risk of a divergent connection pool reading stale
 * truncation state.
 */
export function getPrismaClient(): PrismaClient {
  return prisma;
}

/**
 * Truncate every user-facing table in dependency-safe order using
 * `TRUNCATE … RESTART IDENTITY CASCADE`. Call from beforeEach() to make
 * tests independent. The list mirrors `prisma/schema.prisma` minus
 * prisma-internal tables (_prisma_migrations).
 */
export async function truncateAllTables(client: PrismaClient): Promise<void> {
  // CASCADE means we only need to enumerate the tables; FK chains are
  // handled by Postgres. Listed alphabetically for diff stability.
  const tables = [
    "api_tokens",
    "app_settings",
    "audit_logs",
    "auth_challenges",
    "coach_conversations",
    "coach_messages",
    "coach_usage",
    "data_backups",
    "devices",
    "feedback",
    "host_metrics",
    "idempotency_keys",
    "integration_statuses",
    "measurement_rollups",
    "measurements",
    "medication_intake_events",
    "medication_schedules",
    "medications",
    "mood_entries",
    "notification_channels",
    "notification_preferences",
    "passkeys",
    "personal_records",
    "push_subscriptions",
    "rate_limits",
    "refresh_tokens",
    "reminder_phase_configs",
    "sessions",
    "telegram_reminder_messages",
    "telegram_scheduled_deletions",
    "user_achievements",
    "users",
    "withings_connections",
    "withings_oauth_states",
    "workout_routes",
    "workouts",
  ];

  const quoted = tables.map((t) => `"${t}"`).join(", ");
  await client.$executeRawUnsafe(
    `TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`,
  );
}
