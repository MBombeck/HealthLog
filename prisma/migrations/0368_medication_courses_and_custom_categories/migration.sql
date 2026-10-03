-- Medication categories: adopt the side table into the schema.
--
-- `medication_categories` used to be created by the app at runtime (migration
-- 0004 had dropped it as orphaned and the app recreated it on first use). It
-- is now a Prisma model. The DDL below is identical to what the runtime
-- helper ran, and Postgres gives the unnamed primary key, foreign key and
-- index the same names Prisma expects, so a database that already holds the
-- runtime table keeps it untouched and every row in it; a fresh database gets
-- the same table. Idempotent.
CREATE TABLE IF NOT EXISTS "medication_categories" (
  "medication_id" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'OTHER',
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "medication_categories_pkey" PRIMARY KEY ("medication_id"),
  CONSTRAINT "medication_categories_medication_id_fkey"
    FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "medication_categories_category_idx"
  ON "medication_categories"("category");

-- Custom medication categories (#1041): the person's own labels, shown next
-- to the built-in ones. A medication filed under one carries its `key` in
-- `medication_categories.category`. Idempotent.
CREATE TABLE IF NOT EXISTS "medication_category_labels" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label_encrypted" BYTEA NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "medication_category_labels_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "medication_category_labels_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "medication_category_labels_key_key"
  ON "medication_category_labels"("key");
CREATE INDEX IF NOT EXISTS "medication_category_labels_user_id_sort_order_idx"
  ON "medication_category_labels"("user_id", "sort_order");

-- Several courses per medication (#1024). A course is a calendar span the
-- person took the medication for; the medication's own starts_on / ends_on
-- stay and now project the latest course, so every reader that predates
-- courses keeps working unchanged. Idempotent.
CREATE TABLE IF NOT EXISTS "medication_courses" (
  "id" TEXT NOT NULL,
  "medication_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "starts_on" DATE NOT NULL,
  "ends_on" DATE,
  "note_encrypted" BYTEA,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "medication_courses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "medication_courses_medication_id_fkey"
    FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "medication_courses_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "medication_courses_medication_id_starts_on_idx"
  ON "medication_courses"("medication_id", "starts_on");
CREATE INDEX IF NOT EXISTS "medication_courses_user_id_idx"
  ON "medication_courses"("user_id");

-- Backfill: one course for every medication that has a window today.
--
--   * Start and end, in order: the course is that window.
--   * Only a start: an open course from that day.
--   * Only an end: the app has always read it as running since the day the
--     medication was created, on the person's clock, so that is the start;
--     the end day itself when it lies before the creation (a backdated
--     record). The creation day is taken in the account's time zone, the
--     zone every reader of the window uses, falling back to the app default
--     (Europe/Berlin) when the stored zone is unknown to Postgres.
--   * Start after end (a row written before the API refused it): every
--     reader has treated that window as empty and ended, with no dose
--     expected. It becomes a one-day course on the end day, which keeps it
--     ended and never invents a stretch of expected doses a swap would.
--
-- A medication with neither keeps no course: chronic since creation stays the
-- absence of courses. The medication columns are not touched, so the data is
-- preserved either way. The id is derived from the medication id, which makes
-- a re-run a no-op through ON CONFLICT.
--
-- Reversal: dropping the table loses nothing while every medication has at
-- most one course (its columns still hold it). Once a second course exists, a
-- rollback keeps the current window on the medication and the earlier
-- courses' intakes in the ledger; only the earlier spans go.
INSERT INTO "medication_courses"
  ("id", "medication_id", "user_id", "starts_on", "ends_on", "created_at", "updated_at")
SELECT
  'mc_' || w."id",
  w."id",
  w."user_id",
  CASE
    WHEN w."starts_on" IS NOT NULL AND w."ends_on" IS NOT NULL
         AND w."starts_on" > w."ends_on" THEN w."ends_on"
    WHEN w."starts_on" IS NOT NULL THEN w."starts_on"
    ELSE LEAST(w."created_day", w."ends_on")
  END,
  w."ends_on",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT
    m."id",
    m."user_id",
    m."starts_on",
    m."ends_on",
    (m."created_at" AT TIME ZONE 'UTC' AT TIME ZONE
      CASE
        WHEN EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z."name" = u."timezone")
          THEN u."timezone"
        ELSE 'Europe/Berlin'
      END
    )::date AS "created_day"
  FROM "medications" m
  JOIN "users" u ON u."id" = m."user_id"
  WHERE m."starts_on" IS NOT NULL OR m."ends_on" IS NOT NULL
) w
ON CONFLICT ("id") DO NOTHING;
