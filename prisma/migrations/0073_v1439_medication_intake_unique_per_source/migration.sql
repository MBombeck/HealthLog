-- v1.4.39 W-SERVER-FIX-2 — unique constraint on
-- (user_id, medication_id, scheduled_for, source) for
-- medication_intake_events so the projection-then-backfill code path
-- can't mint duplicate REMINDER rows under a concurrent two-route
-- hit.
--
-- Background. Two read routes now project active schedules through
-- `expandTodayIntakes` and idempotently `createMany`-backfill any
-- missing rows:
--
--   GET /api/medications/intake?scope=today
--   GET /api/dashboard/summary
--
-- The iOS Dashboard mounts both at roughly the same wall-clock when
-- the compliance ring + Erfassen sheet hydrate together. Pre-fix the
-- table carried only an INDEX on `(user_id, medication_id,
-- scheduled_for)`, NOT a UNIQUE constraint, so both routes could pass
-- their existence probes simultaneously and `createMany` the same
-- `(medicationId, scheduledFor, REMINDER)` row twice — corrupting the
-- compliance bucket counts on the next read.
--
-- `source` is part of the key so the reminder worker's REMINDER row
-- doesn't collide with manual user inserts (WEB / TELEGRAM / IMPORT)
-- on the same slot. Distinct intake sources at the same scheduled
-- instant are a legitimate shape — e.g. a Telegram-bot logged take +
-- a Web-UI correction on the same dose.
--
-- The query-side `(user_id, medication_id, scheduled_for)` index
-- stays in place — most reads filter on those three columns without
-- caring about `source`, so the legacy index keeps its read-path
-- value even after the unique constraint creates its own
-- (user_id, medication_id, scheduled_for, source) covering index.
--
-- Production data check. The reminder worker is the only writer that
-- ever produces REMINDER-source rows pre-this-fix; it queries pending
-- rows by `(medicationId, scheduledFor)` before each insert so a
-- self-double-mint is structurally impossible. The new projection
-- code paths (intake route + dashboard route) are the only new
-- sources of potential duplicates, and both ship with the
-- `skipDuplicates: true` flag alongside this constraint. If
-- `migrate deploy` reports a unique-constraint violation, a follow-up
-- one-shot data-cleanup pass would dedup the offending rows by
-- (user_id, medication_id, scheduled_for, source) keeping the
-- lowest-id row; that cleanup is intentionally NOT bundled here so
-- the migration stays additive + reviewable.
--
-- Additive only. IF NOT EXISTS / EXCEPTION-on-duplicate guards
-- mirror the patterns in 0067 / 0071.

DO $$ BEGIN
    ALTER TABLE "medication_intake_events"
        ADD CONSTRAINT "medication_intake_events_user_id_medication_id_scheduled_for_source_key"
        UNIQUE ("user_id", "medication_id", "scheduled_for", "source");
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN duplicate_table THEN NULL;
END $$;
