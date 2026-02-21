-- AlterTable: track when medication was paused
ALTER TABLE "medications"
ADD COLUMN IF NOT EXISTS "paused_at" TIMESTAMP(3);

