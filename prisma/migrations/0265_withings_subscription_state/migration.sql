ALTER TABLE "withings_connections"
  ADD COLUMN "webhook_subscription_state" JSONB,
  ADD COLUMN "webhook_subscription_retry_at" TIMESTAMP(3);

-- Existing connections have no durable outcome yet. Mark them due so the
-- hourly repair reconciles each category; status 294 is idempotent success.
UPDATE "withings_connections"
SET "webhook_subscription_retry_at" = CURRENT_TIMESTAMP;

CREATE INDEX "withings_connections_webhook_subscription_retry_at_idx"
  ON "withings_connections"("webhook_subscription_retry_at");
