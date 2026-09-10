-- Delivery outcome of the last error report this host tried to send.
-- "A DSN is set and it parses" and "reports are arriving" are different
-- facts, and only the second one is worth a green badge: a wrong public key,
-- a wrong project id and an unreachable host all parse.
ALTER TABLE "app_settings"
    ADD COLUMN "glitchtip_last_ok_at" TIMESTAMP(3),
    ADD COLUMN "glitchtip_last_failure_at" TIMESTAMP(3),
    ADD COLUMN "glitchtip_last_failure_reason" TEXT;
