-- Life events for the timeline (#613).
--
-- A dated anchor in the person's life: a move, a birth, a new job, a loss.
-- Dates are calendar strings (`YYYY-MM-DD`) without a time zone, and
-- `precision` says how much of the date is known; at MONTH or YEAR the stored
-- date is the first day of that month or year. Title and note are encrypted
-- at rest. Soft-deleted like the other record tables; the index serves the
-- per-user live list in date order.
CREATE TYPE "life_event_category" AS ENUM ('FAMILY', 'HOME', 'WORK', 'LOSS', 'OTHER');

CREATE TYPE "life_event_precision" AS ENUM ('DAY', 'MONTH', 'YEAR');

CREATE TABLE "life_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category" "life_event_category" NOT NULL,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT,
    "precision" "life_event_precision" NOT NULL,
    "title_encrypted" BYTEA NOT NULL,
    "note_encrypted" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "life_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "life_events_user_id_deleted_at_start_date_idx" ON "life_events"("user_id", "deleted_at", "start_date");

ALTER TABLE "life_events" ADD CONSTRAINT "life_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
