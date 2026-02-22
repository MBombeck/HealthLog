-- CreateTable
CREATE TABLE "telegram_scheduled_deletions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "delete_after" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_scheduled_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "telegram_scheduled_deletions_delete_after_idx" ON "telegram_scheduled_deletions"("delete_after");
