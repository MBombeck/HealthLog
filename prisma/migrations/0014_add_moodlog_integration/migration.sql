-- CreateTable
CREATE TABLE "mood_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "mood" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "tags" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MOODLOG',
    "mood_logged_at" TIMESTAMP(3) NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mood_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mood_entries_user_id_date_idx" ON "mood_entries"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "mood_entries_user_id_date_mood_logged_at_key" ON "mood_entries"("user_id", "date", "mood_logged_at");

-- AddForeignKey
ALTER TABLE "mood_entries" ADD CONSTRAINT "mood_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: Add moodLog fields to users
ALTER TABLE "users" ADD COLUMN "mood_log_url_encrypted" TEXT;
ALTER TABLE "users" ADD COLUMN "mood_log_api_key_encrypted" TEXT;
ALTER TABLE "users" ADD COLUMN "mood_log_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "mood_log_last_synced_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "mood_log_webhook_secret" TEXT;

-- AlterTable: Add moodLogGlobal to app_settings
ALTER TABLE "app_settings" ADD COLUMN "mood_log_global" BOOLEAN NOT NULL DEFAULT true;
