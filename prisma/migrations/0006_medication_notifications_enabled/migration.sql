-- AlterTable: per-medication notification toggle
ALTER TABLE "medications"
ADD COLUMN IF NOT EXISTS "notifications_enabled" BOOLEAN NOT NULL DEFAULT true;

