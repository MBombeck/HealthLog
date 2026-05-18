-- v1.4.39 W-MED — persistent medication compliance rollup table.
--
-- Replaces the unbounded MedicationIntakeEvent.findMany walk on
-- `/api/medications/intake?scope=compliance` and the equivalent fan-out
-- inside `computeUserHealthScoreFastPath`. Per-(userId, medicationId,
-- day) stats with scheduled / taken / skipped counts.
--
-- `day` is a TEXT column (YYYY-MM-DD anchored to the user's timezone)
-- rather than a DATE because the day-key has to survive a
-- multi-instance read that may pick a different node than the writer.
-- Storing the user-tz-anchored string removes the per-row tz round-trip
-- the writer would otherwise have to perform.
--
-- Additive only. PK + FK + descending index for the "last N days" read
-- path. IF NOT EXISTS / EXCEPTION guards mirror 0067 / 0069 / 0070.

CREATE TABLE IF NOT EXISTS "medication_compliance_rollups" (
    "user_id"       TEXT            NOT NULL,
    "medication_id" TEXT            NOT NULL,
    "day"           TEXT            NOT NULL,
    "scheduled"     INTEGER         NOT NULL,
    "taken"         INTEGER         NOT NULL,
    "skipped"       INTEGER         NOT NULL,
    "computed_at"   TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medication_compliance_rollups_pkey"
        PRIMARY KEY ("user_id", "medication_id", "day")
);

CREATE INDEX IF NOT EXISTS "medication_compliance_rollups_user_day_desc_idx"
    ON "medication_compliance_rollups" ("user_id", "day" DESC);

DO $$ BEGIN
    ALTER TABLE "medication_compliance_rollups"
        ADD CONSTRAINT "medication_compliance_rollups_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "medication_compliance_rollups"
        ADD CONSTRAINT "medication_compliance_rollups_medication_id_fkey"
        FOREIGN KEY ("medication_id") REFERENCES "medications"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
