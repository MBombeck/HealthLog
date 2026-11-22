-- A lock token per settings document, not per row.
--
-- Eight `/api/...` surfaces guard a read-modify-write of one JSON column on
-- `users` (dashboard layout, insights layout, medications layout, mood-tag
-- layout, modules, notification preferences, Coach preferences, score
-- selection), and two guard the about-me document on `user_health_profiles`.
-- Until now every one of them used the row's `updated_at` as its token. That
-- moves on ANY write to the row: a registry choice, a profile save, a sync
-- cursor, the emergency profile. Each such write made every other surface's
-- token stale, and where the GET served its token from the five-minute server
-- cache the next saves answered 409 until the cache expired.
--
-- Each document now has its own revision column, and the database moves it:
-- a BEFORE UPDATE trigger stamps the current UTC instant, cut to the
-- millisecond the wire token carries, into the revision of every document
-- whose value changed in the statement. A trigger, not application
-- code, because the documents have writers that are not their own route (the
-- onboarding seed, the chart-overlay toggle, record settings, a restore, the
-- data wipe, the reminder suggestions), and a token one of them forgets to
-- move is a lock that passes a stale save. Precedent: 0302 (`record_epoch`).
--
-- `IS DISTINCT FROM` keeps a write of the same value from moving the token, so
-- a no-op save conflicts with nobody. `UPDATE OF` keeps every write that names
-- none of the document columns off the trigger entirely. The trigger owns the
-- revision whenever a document changes; application code never names the
-- revision columns outside `src/lib/optimistic-lock.ts`
-- (`src/__tests__/document-revision-guard.test.ts`).
--
-- The wire token keeps its shape (an ISO instant on `updatedAt`, echoed as
-- `baseUpdatedAt`), so no client changes. A client holding a token read before
-- this migration gets one 409 and re-reads.
--
-- Adding a NOT NULL column with a stable default is metadata-only on
-- PostgreSQL 11 and later. Reversibility: drop the triggers, the functions and
-- the nine columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "dashboard_widgets_revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "insights_layout_revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "medication_list_layout_revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "mood_tag_layout_revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "module_preferences_revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "notification_prefs_revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "coach_prefs_revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "health_score_config_revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

    ALTER TABLE "user_health_profiles"
        ADD COLUMN IF NOT EXISTS "about_me_revised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
END
$migration$;

CREATE OR REPLACE FUNCTION "users_bump_document_revisions"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."dashboard_widgets_json" IS DISTINCT FROM OLD."dashboard_widgets_json" THEN
        NEW."dashboard_widgets_revised_at" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    IF NEW."insights_layout_json" IS DISTINCT FROM OLD."insights_layout_json" THEN
        NEW."insights_layout_revised_at" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    IF NEW."medication_list_layout_json" IS DISTINCT FROM OLD."medication_list_layout_json" THEN
        NEW."medication_list_layout_revised_at" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    IF NEW."mood_tag_layout_json" IS DISTINCT FROM OLD."mood_tag_layout_json" THEN
        NEW."mood_tag_layout_revised_at" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    IF NEW."module_preferences_json" IS DISTINCT FROM OLD."module_preferences_json" THEN
        NEW."module_preferences_revised_at" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    IF NEW."notification_prefs" IS DISTINCT FROM OLD."notification_prefs" THEN
        NEW."notification_prefs_revised_at" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    IF NEW."coach_prefs_json" IS DISTINCT FROM OLD."coach_prefs_json"
        OR NEW."insights_exclude_metrics" IS DISTINCT FROM OLD."insights_exclude_metrics" THEN
        NEW."coach_prefs_revised_at" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    IF NEW."health_score_config_json" IS DISTINCT FROM OLD."health_score_config_json" THEN
        NEW."health_score_config_revised_at" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "users_document_revision_bump" ON "users";
CREATE TRIGGER "users_document_revision_bump"
    BEFORE UPDATE OF
        "dashboard_widgets_json",
        "insights_layout_json",
        "medication_list_layout_json",
        "mood_tag_layout_json",
        "module_preferences_json",
        "notification_prefs",
        "coach_prefs_json",
        "insights_exclude_metrics",
        "health_score_config_json"
    ON "users"
    FOR EACH ROW
    EXECUTE FUNCTION "users_bump_document_revisions"();

CREATE OR REPLACE FUNCTION "user_health_profiles_bump_about_me_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."about_me_encrypted" IS DISTINCT FROM OLD."about_me_encrypted"
        OR NEW."conditions_encrypted" IS DISTINCT FROM OLD."conditions_encrypted"
        OR NEW."allergies_encrypted" IS DISTINCT FROM OLD."allergies_encrypted"
        OR NEW."coach_focus_encrypted" IS DISTINCT FROM OLD."coach_focus_encrypted"
        OR NEW."ai_included_sections" IS DISTINCT FROM OLD."ai_included_sections" THEN
        NEW."about_me_revised_at" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "user_health_profiles_about_me_revision_bump" ON "user_health_profiles";
CREATE TRIGGER "user_health_profiles_about_me_revision_bump"
    BEFORE UPDATE OF
        "about_me_encrypted",
        "conditions_encrypted",
        "allergies_encrypted",
        "coach_focus_encrypted",
        "ai_included_sections"
    ON "user_health_profiles"
    FOR EACH ROW
    EXECUTE FUNCTION "user_health_profiles_bump_about_me_revision"();
