-- CreateTable
CREATE TABLE "data_backups" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'WEEKLY_AUTO',
    "data" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_backups_user_id_idx" ON "data_backups"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_backups_user_id_type_key" ON "data_backups"("user_id", "type");

-- AddForeignKey
ALTER TABLE "data_backups" ADD CONSTRAINT "data_backups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
