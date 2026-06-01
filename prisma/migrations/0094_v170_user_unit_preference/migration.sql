-- v1.7.0 unit pref — global metric/imperial display preference.
--
-- Canonical storage stays SI on every measurement row. This column
-- only selects which branch of the display-time transform registry
-- (`src/lib/measurements/display-transform.ts`) the client renders:
-- km/h vs mph, km vs mi. No measurement value is rewritten.
--
-- Single nullable text column. Null = the application resolver reads
-- `DEFAULT_UNIT_PREFERENCE` ("metric"), matching the established
-- single-purpose display-unit precedent on the same table
-- (`glucose_unit`, which stays mg/dL canonical and switches mg/dL vs
-- mmol/L at display only). No JSON settings bag exists on `users`, so
-- a dedicated scalar mirrors `glucose_unit` rather than abusing one of
-- the domain-specific JSON columns (thresholds / dashboard / insights
-- layout / healthkit config).
--
-- Idempotent guard (`IF NOT EXISTS`) matches the 0084 / 0085 pattern
-- so reruns are safe where the migration already applied.
--
-- Reversibility: down migration is
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "unit_preference";
-- A roll-back loses the saved preference (users fall back to metric);
-- the application reads tolerate a missing column / null row.
--
-- No index — reads at request time are per-user (`WHERE id = $1`),
-- matching `glucose_unit` and every other display-pref column.

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "unit_preference" TEXT;
