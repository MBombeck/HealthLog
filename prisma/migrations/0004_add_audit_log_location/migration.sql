-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "location" TEXT;

-- DropTable (orphaned, not in schema)
DROP TABLE IF EXISTS "medication_categories";
