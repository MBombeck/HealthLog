-- Turn Web Push back on for every account that has a browser subscription
-- but whose WEB_PUSH channel was switched off by a delivery failure.
--
-- Until this release a send with no subscription left (push turned off on the
-- last device, or the Home Screen app removed) counted as a failure, and five
-- of them, or one 410, switched the channel off. Subscribing again stored the
-- new browser but left the channel off, so the settings card read "enabled",
-- a test push arrived, and no reminder was ever sent. Subscribing now turns
-- the channel back on; this does the same for the accounts already caught.
--
-- Only an automatic switch-off is touched: the dispatcher always writes a
-- `disabled_reason`, a channel switched off by hand has none. The fields
-- reset are the ones a re-enable resets (`reEnableChannel`). A channel
-- without any subscription stays off. Running this again finds nothing left
-- to change.
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    UPDATE "notification_channels" AS c
       SET "enabled" = true,
           "disabled_reason" = NULL,
           "consecutive_failures" = 0,
           "next_retry_at" = NULL,
           "last_failure_reason" = NULL,
           "updated_at" = CURRENT_TIMESTAMP
     WHERE c."type" = 'WEB_PUSH'
       AND c."enabled" = false
       AND c."disabled_reason" IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM "push_subscriptions" AS s
          WHERE s."user_id" = c."user_id"
       );
END
$migration$;
