-- AlterTable: Add role and date_of_birth to users
ALTER TABLE "users" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'USER';
ALTER TABLE "users" ADD COLUMN "date_of_birth" TIMESTAMP(3);

-- AlterTable: Remove BP target columns from users
ALTER TABLE "users" DROP COLUMN IF EXISTS "bp_sys_target_low";
ALTER TABLE "users" DROP COLUMN IF EXISTS "bp_sys_target_high";
ALTER TABLE "users" DROP COLUMN IF EXISTS "bp_dia_target_low";
ALTER TABLE "users" DROP COLUMN IF EXISTS "bp_dia_target_high";

-- CreateTable: app_settings (singleton)
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "registration_enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- Insert default settings row
INSERT INTO "app_settings" ("id", "registration_enabled") VALUES ('singleton', true)
ON CONFLICT ("id") DO NOTHING;

-- Set existing users as ADMIN (first user gets admin role)
UPDATE "users" SET "role" = 'ADMIN'
WHERE "id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC LIMIT 1);
