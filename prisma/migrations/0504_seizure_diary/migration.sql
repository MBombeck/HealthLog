-- Seizure diary (#1368): the person's own seizure types, one row per recorded
-- seizure (or tally of brief ones), the rescue doses given for it, and the
-- record's cluster rule.
--
-- The classification column is the ILAE 2025 seizure type; the ILAE 2017 name
-- is a label the application shows beside it and is not stored. The ILAE class
-- is derived from the type, so it has no column either. Clusters, streaks and
-- duration flags are computed at read time; nothing derived is persisted.
--
-- Free text (the family's name for a type, the rescue plan, notes, aura and
-- witness text) is sealed at rest in BYTEA columns through the shared codec;
-- there is no plaintext twin. `logged_by_user_id` is deliberately not a foreign
-- key, for the reason `audit_logs.actor_user_id` gives. A rescue dose keeps a
-- SET NULL link to the medication and to the intake row written for it, so
-- deleting either keeps the diary entry readable.
--
-- Purely additive: new types and tables only, nothing existing changes shape,
-- nothing to backfill. One DO block, so the file is one statement that rolls
-- back whole and the foreign keys' lock wait on `users`, `medications` and
-- `medication_intake_events` is bounded. Reversibility: dropping the four
-- tables and the sixteen types restores the previous schema.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_ilae_type') THEN
        CREATE TYPE "seizure_ilae_type" AS ENUM ('FOCAL_PRESERVED', 'FOCAL_IMPAIRED', 'FOCAL_UNDETERMINED', 'FOCAL_TO_BILATERAL_TC', 'GENERALIZED_UNDETERMINED', 'GENERALIZED_TC', 'GEN_CLONIC', 'GEN_TONIC', 'GEN_MYOCLONIC', 'GEN_MYOCLONIC_ATONIC', 'GEN_ATONIC', 'GEN_NEGATIVE_MYOCLONIC', 'GEN_SPASMS', 'ABSENCE_TYPICAL', 'ABSENCE_ATYPICAL', 'ABSENCE_MYOCLONIC', 'EYELID_MYOCLONIA', 'UNKNOWN_UNDETERMINED', 'UNKNOWN_PRESERVED', 'UNKNOWN_IMPAIRED', 'UNKNOWN_BILATERAL_TC', 'UNCLASSIFIED');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_onset_precision') THEN
        CREATE TYPE "seizure_onset_precision" AS ENUM ('EXACT', 'APPROX', 'UNKNOWN_TIME');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_duration_source') THEN
        CREATE TYPE "seizure_duration_source" AS ENUM ('TIMED', 'ESTIMATED', 'UNKNOWN');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_certainty') THEN
        CREATE TYPE "seizure_certainty" AS ENUM ('CONFIRMED', 'SUSPECTED');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_sleep_state') THEN
        CREATE TYPE "seizure_sleep_state" AS ENUM ('AWAKE', 'ASLEEP', 'ON_WAKING', 'UNKNOWN');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_observation') THEN
        CREATE TYPE "seizure_observation" AS ENUM ('YES', 'NO', 'UNKNOWN');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_function_state') THEN
        CREATE TYPE "seizure_function_state" AS ENUM ('PRESERVED', 'IMPAIRED', 'UNKNOWN');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_semiology') THEN
        CREATE TYPE "seizure_semiology" AS ENUM ('AURA', 'BEHAVIOUR_ARREST', 'STARING', 'AUTOMATISMS', 'TONIC', 'CLONIC', 'MYOCLONIC', 'ATONIC_DROP', 'SPASMS', 'HEAD_EYE_VERSION', 'VOCALISATION', 'CYANOSIS', 'DROOLING', 'BREATHING_CHANGE');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_trigger') THEN
        CREATE TYPE "seizure_trigger" AS ENUM ('MISSED_DOSE', 'SLEEP_DEPRIVATION', 'FEVER', 'ILLNESS', 'MENSTRUATION', 'ALCOHOL', 'FLASHING_LIGHTS', 'STRESS', 'OTHER', 'NONE_IDENTIFIED');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_postictal') THEN
        CREATE TYPE "seizure_postictal" AS ENUM ('SLEEP', 'CONFUSION', 'HEADACHE', 'WEAKNESS_TODD', 'SPEECH', 'AGITATION', 'OTHER');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_injury') THEN
        CREATE TYPE "seizure_injury" AS ENUM ('NONE', 'TONGUE_BITE', 'HEAD', 'FALL_OTHER', 'BURN', 'FRACTURE', 'OTHER');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_emergency') THEN
        CREATE TYPE "seizure_emergency" AS ENUM ('NONE', 'EMS_CALLED', 'ED_VISIT', 'ADMITTED');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_observer_role') THEN
        CREATE TYPE "seizure_observer_role" AS ENUM ('SELF', 'PARENT', 'PARTNER', 'FAMILY', 'CARER', 'TEACHER', 'CLINICIAN', 'PARAMEDIC', 'OTHER');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_event_source') THEN
        CREATE TYPE "seizure_event_source" AS ENUM ('MANUAL', 'DEVICE_ALERT');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_rescue_route') THEN
        CREATE TYPE "seizure_rescue_route" AS ENUM ('BUCCAL', 'INTRANASAL', 'RECTAL', 'ORAL', 'SUBLINGUAL', 'IM', 'IV_BY_EMS');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seizure_rescue_effect') THEN
        CREATE TYPE "seizure_rescue_effect" AS ENUM ('STOPPED', 'REDUCED', 'NO_EFFECT', 'UNKNOWN');
    END IF;

    CREATE TABLE IF NOT EXISTS "seizure_type_profiles" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "label_encrypted" BYTEA NOT NULL,
        "ilae_type" "seizure_ilae_type" NOT NULL,
        "usual_duration_sec" INTEGER,
        "rescue_plan_encrypted" BYTEA,
        "rescue_medication_id" TEXT,
        "rescue_dose_amount" DOUBLE PRECISION,
        "rescue_dose_unit" TEXT,
        "rescue_route" "seizure_rescue_route",
        "sort_order" INTEGER NOT NULL DEFAULT 0,
        "archived_at" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "seizure_type_profiles_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "seizure_type_profiles_usual_duration_check"
            CHECK ("usual_duration_sec" IS NULL OR "usual_duration_sec" BETWEEN 1 AND 86400),
        CONSTRAINT "seizure_type_profiles_rescue_dose_check"
            CHECK ("rescue_dose_amount" IS NULL OR "rescue_dose_amount" > 0)
    );

    CREATE TABLE IF NOT EXISTS "seizure_events" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "type_profile_id" TEXT,
        "ilae_type" "seizure_ilae_type",
        "onset_at" TIMESTAMP(3) NOT NULL,
        "onset_precision" "seizure_onset_precision" NOT NULL DEFAULT 'EXACT',
        "duration_sec" INTEGER,
        "duration_source" "seizure_duration_source" NOT NULL DEFAULT 'UNKNOWN',
        "count" INTEGER NOT NULL DEFAULT 1,
        "certainty" "seizure_certainty" NOT NULL DEFAULT 'CONFIRMED',
        "sleep_state" "seizure_sleep_state" NOT NULL DEFAULT 'UNKNOWN',
        "observable_manifestations" "seizure_observation",
        "responsiveness" "seizure_function_state",
        "recall" "seizure_function_state",
        "semiology" "seizure_semiology"[] DEFAULT ARRAY[]::"seizure_semiology"[],
        "semiology_note_encrypted" BYTEA,
        "aura_encrypted" BYTEA,
        "triggers" "seizure_trigger"[] DEFAULT ARRAY[]::"seizure_trigger"[],
        "postictal_minutes" INTEGER,
        "postictal" "seizure_postictal"[] DEFAULT ARRAY[]::"seizure_postictal"[],
        "injuries" "seizure_injury"[] DEFAULT ARRAY[]::"seizure_injury"[],
        "incontinence" BOOLEAN,
        "emergency" "seizure_emergency" NOT NULL DEFAULT 'NONE',
        "witnessed" BOOLEAN,
        "witness_role" "seizure_observer_role",
        "witness_note_encrypted" BYTEA,
        "logged_by_user_id" TEXT,
        "source" "seizure_event_source" NOT NULL DEFAULT 'MANUAL',
        "note_encrypted" BYTEA,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "seizure_events_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "seizure_events_count_check"
            CHECK ("count" BETWEEN 1 AND 500),
        CONSTRAINT "seizure_events_duration_check"
            CHECK ("duration_sec" IS NULL OR "duration_sec" BETWEEN 0 AND 86400),
        CONSTRAINT "seizure_events_postictal_minutes_check"
            CHECK ("postictal_minutes" IS NULL OR "postictal_minutes" BETWEEN 0 AND 10080)
    );

    CREATE TABLE IF NOT EXISTS "seizure_rescue_doses" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "event_id" TEXT NOT NULL,
        "medication_id" TEXT,
        "medication_name" TEXT NOT NULL,
        "dose_amount" DOUBLE PRECISION,
        "dose_unit" TEXT,
        "route" "seizure_rescue_route",
        "given_at" TIMESTAMP(3) NOT NULL,
        "given_by" "seizure_observer_role",
        "effect" "seizure_rescue_effect" NOT NULL DEFAULT 'UNKNOWN',
        "seizure_ended_at" TIMESTAMP(3),
        "intake_event_id" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "seizure_rescue_doses_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "seizure_rescue_doses_dose_check"
            CHECK ("dose_amount" IS NULL OR "dose_amount" > 0)
    );

    CREATE TABLE IF NOT EXISTS "seizure_diary_settings" (
        "user_id" TEXT NOT NULL,
        "cluster_count" INTEGER NOT NULL DEFAULT 2,
        "cluster_window_hours" INTEGER NOT NULL DEFAULT 24,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "seizure_diary_settings_pkey" PRIMARY KEY ("user_id"),
        CONSTRAINT "seizure_diary_settings_cluster_count_check"
            CHECK ("cluster_count" BETWEEN 2 AND 20),
        CONSTRAINT "seizure_diary_settings_cluster_window_check"
            CHECK ("cluster_window_hours" BETWEEN 1 AND 168)
    );

    CREATE INDEX IF NOT EXISTS "seizure_type_profiles_user_id_archived_at_sort_order_idx" ON "seizure_type_profiles"("user_id", "archived_at", "sort_order");

    CREATE INDEX IF NOT EXISTS "seizure_type_profiles_rescue_medication_id_idx" ON "seizure_type_profiles"("rescue_medication_id");

    CREATE INDEX IF NOT EXISTS "seizure_events_user_id_onset_at_idx" ON "seizure_events"("user_id", "onset_at");

    CREATE INDEX IF NOT EXISTS "seizure_events_type_profile_id_onset_at_idx" ON "seizure_events"("type_profile_id", "onset_at");

    CREATE INDEX IF NOT EXISTS "seizure_rescue_doses_user_id_given_at_idx" ON "seizure_rescue_doses"("user_id", "given_at");

    CREATE INDEX IF NOT EXISTS "seizure_rescue_doses_event_id_idx" ON "seizure_rescue_doses"("event_id");

    CREATE INDEX IF NOT EXISTS "seizure_rescue_doses_medication_id_idx" ON "seizure_rescue_doses"("medication_id");

    CREATE INDEX IF NOT EXISTS "seizure_rescue_doses_intake_event_id_idx" ON "seizure_rescue_doses"("intake_event_id");

    ALTER TABLE "seizure_type_profiles"
        ADD CONSTRAINT "seizure_type_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    ALTER TABLE "seizure_type_profiles"
        ADD CONSTRAINT "seizure_type_profiles_rescue_medication_id_fkey" FOREIGN KEY ("rescue_medication_id") REFERENCES "medications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

    ALTER TABLE "seizure_events"
        ADD CONSTRAINT "seizure_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    ALTER TABLE "seizure_events"
        ADD CONSTRAINT "seizure_events_type_profile_id_fkey" FOREIGN KEY ("type_profile_id") REFERENCES "seizure_type_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

    ALTER TABLE "seizure_rescue_doses"
        ADD CONSTRAINT "seizure_rescue_doses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    ALTER TABLE "seizure_rescue_doses"
        ADD CONSTRAINT "seizure_rescue_doses_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "seizure_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    ALTER TABLE "seizure_rescue_doses"
        ADD CONSTRAINT "seizure_rescue_doses_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

    ALTER TABLE "seizure_rescue_doses"
        ADD CONSTRAINT "seizure_rescue_doses_intake_event_id_fkey" FOREIGN KEY ("intake_event_id") REFERENCES "medication_intake_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

    ALTER TABLE "seizure_diary_settings"
        ADD CONSTRAINT "seizure_diary_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
END
$migration$;
