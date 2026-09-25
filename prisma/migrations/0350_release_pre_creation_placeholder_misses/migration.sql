-- The today projector mints a pending placeholder for every slot of the
-- current day, and the hourly auto-miss pass used to stamp every stale one a
-- miss. For a medication added in the afternoon that turned the placeholders
-- of that day's earlier slots, which were never expected doses, into
-- forgotten doses: the miss-free streak broke and the Coach read a miss on a
-- day before the medication existed. The pass no longer stamps them; this
-- returns the ones it already stamped to pending.
--
-- Only rows that can be nothing but such a placeholder are touched: minted by
-- the server (source REMINDER), never acted on (no take, no skip, live), and
-- anchored before the medication's creation but on its creation day. The
-- projector mints for the current local day only, which begins less than a
-- day before the creation, so the 24-hour bound is exact for placeholders and
-- leaves any older auto-miss (history carried in by a restore) as it was.
-- `sync_version` bumps so sync clients pick the change up.
UPDATE "medication_intake_events" AS e
SET "auto_missed" = false,
    "sync_version" = e."sync_version" + 1
FROM "medications" AS m
WHERE e."medication_id" = m."id"
  AND e."auto_missed" = true
  AND e."taken_at" IS NULL
  AND e."skipped" = false
  AND e."deleted_at" IS NULL
  AND e."source" = 'REMINDER'
  AND e."scheduled_for" < m."created_at"
  AND e."scheduled_for" >= m."created_at" - INTERVAL '24 hours';
