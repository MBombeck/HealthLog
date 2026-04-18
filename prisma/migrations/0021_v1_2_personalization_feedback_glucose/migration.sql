-- v1.2: Personalization + Blood Glucose + Built-in Feedback
--
-- This migration is purely additive.
-- - New enums: measurement_type.BLOOD_GLUCOSE, glucose_context, feedback_category, feedback_status.
-- - New columns on users: thresholds_json, dashboard_widgets_json, glucose_unit,
--   ai_provider, ai_model, ai_base_url, ai_anthropic_key_encrypted, ai_local_key_encrypted.
-- - New column on measurements: glucose_context (only set for BLOOD_GLUCOSE rows).
-- - New table: feedback.

-- ── Enums ────────────────────────────────────────────────────────────────

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BLOOD_GLUCOSE';

CREATE TYPE "glucose_context" AS ENUM ('FASTING', 'POSTPRANDIAL', 'RANDOM', 'BEDTIME');

CREATE TYPE "feedback_category" AS ENUM ('BUG', 'FEATURE_REQUEST', 'QUESTION', 'OTHER');

CREATE TYPE "feedback_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ARCHIVED');

-- ── users personalization columns ───────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN "thresholds_json" JSONB,
  ADD COLUMN "dashboard_widgets_json" JSONB,
  ADD COLUMN "glucose_unit" TEXT,
  ADD COLUMN "ai_provider" TEXT,
  ADD COLUMN "ai_model" TEXT,
  ADD COLUMN "ai_base_url" TEXT,
  ADD COLUMN "ai_anthropic_key_encrypted" TEXT,
  ADD COLUMN "ai_local_key_encrypted" TEXT;

-- ── measurements.glucose_context ────────────────────────────────────────

ALTER TABLE "measurements"
  ADD COLUMN "glucose_context" "glucose_context";

-- Enforce: glucose_context is only set for BLOOD_GLUCOSE rows.
ALTER TABLE "measurements"
  ADD CONSTRAINT "measurements_glucose_context_requires_type"
  CHECK (
    (type = 'BLOOD_GLUCOSE' AND glucose_context IS NOT NULL)
    OR
    (type <> 'BLOOD_GLUCOSE' AND glucose_context IS NULL)
  );

-- ── feedback table ──────────────────────────────────────────────────────

CREATE TABLE "feedback" (
  "id" TEXT NOT NULL,
  "user_id" TEXT,
  "email" TEXT,
  "category" "feedback_category" NOT NULL DEFAULT 'BUG',
  "subject" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "screenshot_base64" TEXT,
  "metadata" JSONB,
  "status" "feedback_status" NOT NULL DEFAULT 'OPEN',
  "admin_note" TEXT,
  "github_issue_url" TEXT,
  "notified_email" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "feedback_status_created_at_idx" ON "feedback" ("status", "created_at");
CREATE INDEX "feedback_user_id_idx" ON "feedback" ("user_id");

ALTER TABLE "feedback"
  ADD CONSTRAINT "feedback_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
