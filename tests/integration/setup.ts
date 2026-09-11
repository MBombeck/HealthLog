/**
 * Per-test helpers for the integration suite. The Postgres testcontainer
 * is started once in global-setup.ts and bridged into each worker by
 * environment-setup.ts before application modules load.
 */
import { prisma } from "@/lib/db";
import { assertRecordContext } from "./mock-next-headers";
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

/** Lazily-captured global mood-tag catalogue (NULL user_id rows). */
let catalogueSnapshot: Awaited<
  ReturnType<PrismaClient["moodTag"]["findMany"]>
> | null = null;

/**
 * v1.17.0 — same treatment for the seeded mood-tag categories:
 * `mood_tag_categories.user_id` now FKs to `users` (custom groups), so the
 * users TRUNCATE cascades into the category table too. The categories must
 * restore BEFORE the tags (tags FK into categories).
 */
let categorySnapshot: Awaited<
  ReturnType<PrismaClient["moodTagCategory"]["findMany"]>
> | null = null;

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
    "host_metrics",
    "idempotency_keys",
    "integration_statuses",
    "measurement_rollups",
    "measurements",
    "medication_intake_events",
    "medication_intake_import_jobs",
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
    "step_up_elevations",
    "telegram_reminder_messages",
    "telegram_scheduled_deletions",
    "user_achievements",
    "users",
    "withings_connections",
    "withings_oauth_states",
    "workout_routes",
    "workouts",
  ];

  // v1.13.0 — the mood-tag catalogue (`mood_tags` rows with NULL user_id) is
  // global reference data seeded by migrations and is intentionally NOT in the
  // truncate list, so tests can rely on it. But `mood_tags.user_id` now FKs to
  // `users`, so `TRUNCATE users CASCADE` cascades into `mood_tags` and wipes
  // the catalogue too (TRUNCATE CASCADE truncates dependent tables wholesale,
  // regardless of the ON DELETE action). Snapshot the catalogue once (before
  // the first truncate clears it) and restore it after each truncate so the
  // migration-seeded catalogue persists across tests as it did before the FK.
  if (catalogueSnapshot === null) {
    catalogueSnapshot = await client.moodTag.findMany({
      where: { userId: null },
    });
  }
  if (categorySnapshot === null) {
    categorySnapshot = await client.moodTagCategory.findMany({
      where: { userId: null },
    });
  }

  const quoted = tables.map((t) => `"${t}"`).join(", ");
  // A truncate takes the strictest lock there is on every table at once, so it
  // loses to anything still holding a row lock. Thirty-nine places in the
  // server write without awaiting the result (a last-used stamp, a delivery
  // record, an audit row), and one of those can land after the test that
  // triggered it has returned. Postgres then reports a deadlock and kills the
  // truncate, which fails an unrelated file and passes on the next run.
  // Retrying is the honest answer: a deadlock means somebody else got there
  // first, and by the next attempt the stray write has finished. Only 40P01 is
  // retried, so a lock held for good still fails as it should.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.$executeRawUnsafe(
        `TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`,
      );
      break;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const deadlock =
        code === "40P01" || /deadlock detected/i.test(String(error));
      if (!deadlock || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }

  // Categories first — the tag rows FK into them.
  if (categorySnapshot.length > 0) {
    await client.moodTagCategory.createMany({
      data: categorySnapshot,
      skipDuplicates: true,
    });
  }
  if (catalogueSnapshot.length > 0) {
    await client.moodTag.createMany({
      data: catalogueSnapshot,
      skipDuplicates: true,
    });
  }
}

/**
 * v1.37.0 — point a session at a record the way a test needs it pointed, and
 * leave the request headers agreeing with the row.
 *
 * Every sharing fixture used to do this with a bare `session.update`. That is
 * still the write, but since the record-session fence a cookie request also has
 * to ASSERT the context it believes it is in: a session pointed at a record and
 * a request carrying no assertion is a bundle that predates the fence, and it is
 * refused with 403 before any resolver decides anything. A fixture that switched
 * and did not assert would therefore be testing the deploy-compatibility arm
 * rather than whatever it was written for.
 *
 * The assertion is read back off the row rather than computed, so it is
 * truthful by construction and cannot drift from the trigger's idea of the
 * epoch. Tests that WANT a stale or absent assertion set the headers themselves;
 * those live in `tests/integration/record-session-fence*.test.ts`.
 */
export async function switchSessionTo(
  sessionId: string,
  actingAsUserId: string | null,
): Promise<void> {
  const row = await prisma.session.update({
    where: { id: sessionId },
    data: { actingAsUserId },
  });
  assertRecordContext(row.recordEpoch, row.actingAsUserId);
}
