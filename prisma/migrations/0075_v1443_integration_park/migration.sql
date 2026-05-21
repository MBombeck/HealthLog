-- v1.4.43 W14 — IntegrationStatus parking + per-kind failure counters.
--
-- Two additive columns on `integration_statuses`:
--
--   1. `consecutive_failures_by_kind` (jsonb)
--      A bucketed counter that increments only the bucket matching the
--      failure kind. The single-column `consecutive_failures` integer
--      stays in place for one release as a fallback (callers reading
--      the alert-ladder still use `Math.max(...buckets)`); it will be
--      removed in v1.4.44 once every reader is migrated.
--
--      Default shape: { "transient": 0, "reauth_required": 0,
--                       "persistent": 0 }. A `null` value means the
--      row predates this migration — the status writer back-fills it
--      on the next write by bucketing the old `consecutive_failures`
--      value into the current `state`.
--
--   2. `persistent_failure_started_at` (timestamp)
--      Wall-clock timestamp of the first persistent failure in the
--      current streak. Cleared whenever the persistent bucket resets
--      to zero. Once the gap between `now()` and this timestamp
--      exceeds 24h with the persistent bucket still non-zero, the
--      status writer flips `state` to `"parked"` — the integration
--      stops retrying and the UI surfaces a "Paused — reconnect
--      manually" pill that hits `/api/integrations/withings/resume`
--      to clear the park.
--
-- Idempotent guards (`IF NOT EXISTS`) match the 0067 / 0070 / 0071
-- pattern so reruns are safe.
--
-- The `state` column is a free-form string today (deliberate per the
-- 0029 migration comment — "adding new sentinels in v1.5 doesn't
-- require a migration"). Adding `"parked"` as a recognised value is
-- therefore a no-op at the schema level; the application layer owns
-- the enum widening.
--
-- Reversibility: down migration is `ALTER TABLE ... DROP COLUMN IF
-- EXISTS` on both new columns + a single UPDATE that clears any
-- `state = 'parked'` rows back to `'error_transient'`. Both columns
-- are nullable so existing rows keep working.

ALTER TABLE "integration_statuses"
    ADD COLUMN IF NOT EXISTS "consecutive_failures_by_kind" JSONB;

ALTER TABLE "integration_statuses"
    ADD COLUMN IF NOT EXISTS "persistent_failure_started_at" TIMESTAMP(3);
