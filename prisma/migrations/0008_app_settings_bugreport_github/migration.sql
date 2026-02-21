-- AlterTable: add bug report GitHub configuration
ALTER TABLE "app_settings"
ADD COLUMN IF NOT EXISTS "github_issue_token_encrypted" TEXT,
ADD COLUMN IF NOT EXISTS "github_issue_repo" TEXT;
