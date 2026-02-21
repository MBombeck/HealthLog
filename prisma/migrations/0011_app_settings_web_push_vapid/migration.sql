-- AlterTable: add Web Push VAPID settings to app_settings
ALTER TABLE "app_settings"
ADD COLUMN IF NOT EXISTS "web_push_vapid_public_key" TEXT;

ALTER TABLE "app_settings"
ADD COLUMN IF NOT EXISTS "web_push_vapid_private_key_encrypted" TEXT;

ALTER TABLE "app_settings"
ADD COLUMN IF NOT EXISTS "web_push_vapid_subject" TEXT;
