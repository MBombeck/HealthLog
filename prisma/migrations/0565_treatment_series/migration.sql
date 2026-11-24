-- Treatment series (v1.50): a course of several visits, such as a
-- physiotherapy prescription of six sessions, a run of radiation or a dental
-- treatment plan. `treatment_series` holds the course (its encrypted title,
-- the planned count, the window, who ordered it, who gives it, the condition);
-- the sessions stay ordinary visits and point at it by `encounters.series_id`.
-- Every count and the status are derived from the sessions on read.
--
-- One DO block, so the file is one statement that rolls back whole and the
-- foreign keys' lock waits are bounded. Every step is guarded, so a replay
-- after a lock timeout finishes what is missing. The new column is nullable
-- with no default, so adding it rewrites nothing; its index is built on a
-- column that is NULL everywhere. Reversibility: drop `encounters.series_id`
-- and the table; the visits stay as they were, ungrouped.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "treatment_series" (
        "id"               TEXT NOT NULL,
        "user_id"          TEXT NOT NULL,
        "title_encrypted"  BYTEA NOT NULL,
        "kind"             "encounter_kind" NOT NULL DEFAULT 'THERAPY',
        "planned_sessions" INTEGER,
        "starts_on"        DATE NOT NULL,
        "valid_until"      DATE,
        "ended_on"         DATE,
        "prescriber_id"    TEXT,
        "performer_id"     TEXT,
        "episode_id"       TEXT,
        "note_encrypted"   BYTEA,
        "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at"       TIMESTAMP(3) NOT NULL,
        "deleted_at"       TIMESTAMP(3),

        CONSTRAINT "treatment_series_pkey" PRIMARY KEY ("id")
    );

    CREATE INDEX IF NOT EXISTS "treatment_series_user_id_deleted_at_starts_on_idx"
        ON "treatment_series" ("user_id", "deleted_at", "starts_on");
    CREATE INDEX IF NOT EXISTS "treatment_series_prescriber_id_idx"
        ON "treatment_series" ("prescriber_id");
    CREATE INDEX IF NOT EXISTS "treatment_series_performer_id_idx"
        ON "treatment_series" ("performer_id");
    CREATE INDEX IF NOT EXISTS "treatment_series_episode_id_idx"
        ON "treatment_series" ("episode_id");

    ALTER TABLE "encounters" ADD COLUMN IF NOT EXISTS "series_id" TEXT;
    CREATE INDEX IF NOT EXISTS "encounters_series_id_idx"
        ON "encounters" ("series_id");

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'treatment_series_user_id_fkey'
    ) THEN
        ALTER TABLE "treatment_series"
            ADD CONSTRAINT "treatment_series_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'treatment_series_prescriber_id_fkey'
    ) THEN
        ALTER TABLE "treatment_series"
            ADD CONSTRAINT "treatment_series_prescriber_id_fkey"
            FOREIGN KEY ("prescriber_id") REFERENCES "practitioners"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'treatment_series_performer_id_fkey'
    ) THEN
        ALTER TABLE "treatment_series"
            ADD CONSTRAINT "treatment_series_performer_id_fkey"
            FOREIGN KEY ("performer_id") REFERENCES "practitioners"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'treatment_series_episode_id_fkey'
    ) THEN
        ALTER TABLE "treatment_series"
            ADD CONSTRAINT "treatment_series_episode_id_fkey"
            FOREIGN KEY ("episode_id") REFERENCES "illness_episodes"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'encounters_series_id_fkey'
    ) THEN
        ALTER TABLE "encounters"
            ADD CONSTRAINT "encounters_series_id_fkey"
            FOREIGN KEY ("series_id") REFERENCES "treatment_series"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$migration$;
