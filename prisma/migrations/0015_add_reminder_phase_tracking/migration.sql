-- CreateEnum
CREATE TYPE "reminder_phase" AS ENUM ('GREEN', 'YELLOW', 'ORANGE', 'RED');

-- CreateEnum
CREATE TYPE "phase_mode" AS ENUM ('MINUTES', 'PERCENT');

-- CreateTable
CREATE TABLE "reminder_phase_configs" (
    "id" TEXT NOT NULL,
    "medication_id" TEXT NOT NULL,
    "green_value" INTEGER NOT NULL DEFAULT 60,
    "green_mode" "phase_mode" NOT NULL DEFAULT 'MINUTES',
    "yellow_value" INTEGER NOT NULL DEFAULT 30,
    "yellow_mode" "phase_mode" NOT NULL DEFAULT 'MINUTES',
    "orange_value" INTEGER NOT NULL DEFAULT 0,
    "orange_mode" "phase_mode" NOT NULL DEFAULT 'MINUTES',
    "red_value" INTEGER NOT NULL DEFAULT 240,
    "red_mode" "phase_mode" NOT NULL DEFAULT 'MINUTES',

    CONSTRAINT "reminder_phase_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_reminder_messages" (
    "id" TEXT NOT NULL,
    "medication_id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "phase" "reminder_phase" NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date" TEXT NOT NULL,

    CONSTRAINT "telegram_reminder_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reminder_phase_configs_medication_id_key" ON "reminder_phase_configs"("medication_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_reminder_messages_medication_id_schedule_id_date_phase_key" ON "telegram_reminder_messages"("medication_id", "schedule_id", "date", "phase");

-- CreateIndex
CREATE INDEX "telegram_reminder_messages_medication_id_date_idx" ON "telegram_reminder_messages"("medication_id", "date");

-- AddForeignKey
ALTER TABLE "reminder_phase_configs" ADD CONSTRAINT "reminder_phase_configs_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_reminder_messages" ADD CONSTRAINT "telegram_reminder_messages_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_reminder_messages" ADD CONSTRAINT "telegram_reminder_messages_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "medication_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
