-- AlterTable: Add missing columns to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gender" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegram_bot_token" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegram_chat_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegram_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "withings_client_id_encrypted" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "withings_client_secret_encrypted" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMP(3);

-- AlterTable: Add missing dose column to medication_schedules
ALTER TABLE "medication_schedules" ADD COLUMN IF NOT EXISTS "dose" TEXT;

-- AlterEnum: Add IMPORT to intake_source
ALTER TYPE "intake_source" ADD VALUE IF NOT EXISTS 'IMPORT';
