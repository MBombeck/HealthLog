-- AlterTable: add medication reminder thresholds to app_settings
ALTER TABLE "app_settings"
ADD COLUMN IF NOT EXISTS "reminder_late_minutes" INTEGER NOT NULL DEFAULT 120;

ALTER TABLE "app_settings"
ADD COLUMN IF NOT EXISTS "reminder_missed_minutes" INTEGER NOT NULL DEFAULT 240;
