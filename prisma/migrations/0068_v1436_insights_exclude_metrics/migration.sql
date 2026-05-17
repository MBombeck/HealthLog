-- v1.4.36 W3 T3 — per-user AI Insights exclude-metrics list.
--
-- Mirrors `coachPrefsJson.excludeMetrics` so the user has a single
-- contract for "which data blocks reach the LLM" across both Coach
-- and Insights. Stored as a plain Postgres TEXT[] (not Json) because
-- the values are a closed enum and we want straightforward array
-- containment queries in case ops ever needs to audit them.
--
-- Additive only: NOT NULL with DEFAULT '{}' keeps every existing row
-- on the "exclude nothing" path, byte-identical to v1.4.35 behaviour
-- for accounts that haven't opened the new toggle. The `IF NOT EXISTS`
-- guard makes the migration idempotent — same posture as 0058 /
-- 0061.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "insights_exclude_metrics" TEXT[] NOT NULL DEFAULT '{}';
