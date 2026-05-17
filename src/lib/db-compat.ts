/**
 * Schema-bootstrap path for fresh self-host containers.
 *
 * Production deploys run `prisma migrate deploy` from the entrypoint,
 * so the canonical migration history lives in `prisma/migrations/`.
 * That history is the source of truth — any new column or table must
 * land there first.
 *
 * This file is the belt-and-suspenders companion: it issues
 * idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements on
 * boot so a container that came up against a database which somehow
 * missed a migration (interrupted deploy, restored from an older
 * dump, etc.) self-heals before the app starts taking traffic.
 *
 * Treat every statement here as a mirror of an existing migration —
 * never invent schema in this file. If a column appears here without
 * a corresponding entry under `prisma/migrations/`, that is a bug.
 */
import { prisma } from "@/lib/db";

let dbCompatibilityPromise: Promise<void> | null = null;

async function ensureUserSchema() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'USER';
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "date_of_birth" TIMESTAMP(3);
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "gender" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "telegram_bot_token" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "telegram_chat_id" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "telegram_enabled" BOOLEAN NOT NULL DEFAULT false;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "withings_client_id_encrypted" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "withings_client_secret_encrypted" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "locale" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMP(3);
  `);
}

async function ensureAppSettingsSchema() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "app_settings" (
      "id" TEXT NOT NULL DEFAULT 'singleton',
      "registration_enabled" BOOLEAN NOT NULL DEFAULT true,
      CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
    );
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "app_settings" ("id", "registration_enabled")
    VALUES ('singleton', true)
    ON CONFLICT ("id") DO NOTHING;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "default_locale" TEXT NOT NULL DEFAULT 'de';
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "telegram_global" BOOLEAN NOT NULL DEFAULT true;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "ntfy_global" BOOLEAN NOT NULL DEFAULT true;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "web_push_global" BOOLEAN NOT NULL DEFAULT true;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "api_global" BOOLEAN NOT NULL DEFAULT true;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "web_push_vapid_public_key" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "web_push_vapid_private_key_encrypted" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "web_push_vapid_subject" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "umami_enabled" BOOLEAN NOT NULL DEFAULT false;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "umami_script_url" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "umami_website_id" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "glitchtip_enabled" BOOLEAN NOT NULL DEFAULT false;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "glitchtip_dsn" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "glitchtip_environment" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "github_issue_token_encrypted" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "app_settings"
    ADD COLUMN IF NOT EXISTS "github_issue_repo" TEXT;
  `);
}

async function ensureMedicationSchema() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "medications"
    ADD COLUMN IF NOT EXISTS "notifications_enabled" BOOLEAN NOT NULL DEFAULT true;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "medications"
    ADD COLUMN IF NOT EXISTS "paused_at" TIMESTAMP(3);
  `);
}

async function ensureMedicationScheduleSchema() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "medication_schedules"
    ADD COLUMN IF NOT EXISTS "dose" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "medication_schedules"
    ADD COLUMN IF NOT EXISTS "days_of_week" TEXT;
  `);
}

async function ensureEnumCompatibility() {
  await prisma.$executeRawUnsafe(`
    ALTER TYPE "intake_source" ADD VALUE IF NOT EXISTS 'IMPORT';
  `);
}

/**
 * v1.5.0 — fresh container bootstrap for the persistent measurement-
 * rollup table. Mirrors `prisma/migrations/0067_v1434_measurement_rollups`
 * so a container that came up against a database which skipped the
 * migration still self-heals before the app takes traffic.
 *
 * Idempotent: `CREATE TYPE` is guarded with a `pg_type` lookup
 * (Postgres rejects `CREATE TYPE IF NOT EXISTS`), `CREATE TABLE` /
 * `CREATE INDEX` carry `IF NOT EXISTS`. The FK is added via the
 * `pg_constraint` lookup so re-running the bootstrap on a populated
 * DB is a no-op.
 */
async function ensureMeasurementRollupsSchema() {
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_type
            WHERE typname = 'measurement_rollup_granularity'
        ) THEN
            CREATE TYPE "measurement_rollup_granularity"
                AS ENUM ('DAY', 'WEEK', 'MONTH', 'YEAR');
        END IF;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "measurement_rollups" (
      "user_id"      TEXT                              NOT NULL,
      "type"         "measurement_type"                NOT NULL,
      "granularity"  "measurement_rollup_granularity"  NOT NULL,
      "bucket_start" TIMESTAMPTZ(3)                    NOT NULL,
      "count"        INTEGER                           NOT NULL,
      "mean"         DOUBLE PRECISION                  NOT NULL,
      "min_value"    DOUBLE PRECISION                  NOT NULL,
      "max_value"    DOUBLE PRECISION                  NOT NULL,
      "sd"           DOUBLE PRECISION,
      "slope"        DOUBLE PRECISION,
      "r2"           DOUBLE PRECISION,
      "computed_at"  TIMESTAMPTZ(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "measurement_rollups_pkey"
        PRIMARY KEY ("user_id", "type", "granularity", "bucket_start")
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "measurement_rollups_user_type_granularity_bucket_desc_idx"
      ON "measurement_rollups" ("user_id", "type", "granularity", "bucket_start" DESC);
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'measurement_rollups_user_id_fkey'
        ) THEN
            ALTER TABLE "measurement_rollups"
              ADD CONSTRAINT "measurement_rollups_user_id_fkey"
              FOREIGN KEY ("user_id") REFERENCES "users"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
    END
    $$;
  `);
}

export async function ensureDbCompatibility() {
  if (!dbCompatibilityPromise) {
    dbCompatibilityPromise = Promise.all([
      ensureUserSchema(),
      ensureAppSettingsSchema(),
      ensureMedicationSchema(),
      ensureMedicationScheduleSchema(),
      ensureEnumCompatibility(),
      ensureMeasurementRollupsSchema(),
    ])
      .then(() => undefined)
      .catch((error) => {
        dbCompatibilityPromise = null;
        throw error;
      });
  }

  await dbCompatibilityPromise;
}
