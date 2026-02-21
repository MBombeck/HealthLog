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

export async function ensureDbCompatibility() {
  if (!dbCompatibilityPromise) {
    dbCompatibilityPromise = Promise.all([
      ensureUserSchema(),
      ensureAppSettingsSchema(),
      ensureMedicationSchema(),
      ensureMedicationScheduleSchema(),
      ensureEnumCompatibility(),
    ])
      .then(() => undefined)
      .catch((error) => {
        dbCompatibilityPromise = null;
        throw error;
      });
  }

  await dbCompatibilityPromise;
}
