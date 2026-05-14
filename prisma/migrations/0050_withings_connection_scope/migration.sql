-- v1.4.25 W5d — Withings OAuth scope tracking.
--
-- Adds a nullable `scope` column to `withings_connections` so the
-- ingest path + the Settings UI can tell which OAuth permissions a
-- given connection holds. Legacy v1.4.24 connections sit on
-- `user.metrics` only; v1.4.25 starts requesting
-- `user.metrics,user.activity` for new connections so the activity /
-- sleep endpoints unlock.
--
-- The Settings → Integrations card surfaces a reconnect banner for
-- legacy connections (`scope IS NULL` OR scope NOT LIKE
-- '%user.activity%') so the user can re-auth and gain step / active
-- energy / distance ingest.
--
-- Forward-only, additive. NULL is the documented "legacy connection"
-- sentinel; existing rows stay NULL and continue to read every
-- `user.metrics`-gated endpoint exactly as before.

ALTER TABLE "withings_connections"
  ADD COLUMN IF NOT EXISTS "scope" TEXT;
