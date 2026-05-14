-- v1.4.25 W8d — PersonalRecord schema (no detection worker yet).
--
-- Schema lands now so the v1.5 iOS-Swift app can build its query path
-- against a real GET /api/personal-records route from day one. The
-- worker that populates the rows (sweep on insert / nightly job) is
-- explicitly out of v1.4.25 scope — see the deferred section in the
-- W8d phase report. v1.4.25 ships the bare list endpoint that returns
-- whatever rows the DB carries (initially empty for every user).
--
-- Direction enum (MAX | MIN) is stored on the row rather than derived
-- at read time so the future worker doesn't re-resolve a per-metric
-- lookup on every query. Some metric types deliberately carry NULL
-- direction in the helper (BP, glucose, weight, ambiguous-direction
-- metrics) — those never produce a PersonalRecord row at all, so the
-- column stays NOT NULL for the metrics where a record is actually
-- defined.
--
-- Composite uniqueness on (userId, metricType, metricSlot, achievedAt)
-- ensures the detection worker is idempotent — re-running it never
-- inserts a duplicate. A multi-source tie (e.g. iPhone + Apple Watch
-- both report 12_348 steps for the same day) is broken by including
-- `source` so each provenance retains its row; the display layer
-- runs the existing pickCanonicalSourceRows() helper to surface one.

CREATE TYPE "personal_record_direction" AS ENUM ('MAX', 'MIN');

CREATE TABLE "personal_records" (
  "id"                     TEXT PRIMARY KEY,
  "user_id"                TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "metric_type"            "measurement_type" NOT NULL,
  -- Sport-specific slot for workout-driven PRs (e.g. "running_5km_time").
  -- NULL for measurement-driven PRs that don't need a sport dimension.
  "metric_slot"            TEXT,
  "direction"              "personal_record_direction" NOT NULL,
  "value"                  DOUBLE PRECISION NOT NULL,
  "unit"                   TEXT NOT NULL,
  "achieved_at"            TIMESTAMP(3) NOT NULL,
  -- FK to the Measurement row that achieved the record. SET NULL on
  -- delete so a PR survives the deletion of the originating
  -- measurement (the PR is the historical fact, not a derived view).
  "source_measurement_id"  TEXT REFERENCES "measurements"("id") ON DELETE SET NULL,
  "source"                 "measurement_source" NOT NULL DEFAULT 'MANUAL',
  "external_id"            TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "personal_records_dedup_key"
  ON "personal_records" ("user_id", "metric_type", "metric_slot", "achieved_at");
CREATE INDEX "personal_records_user_metric_idx"
  ON "personal_records" ("user_id", "metric_type", "value");
