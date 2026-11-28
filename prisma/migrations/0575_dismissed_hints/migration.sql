-- One-time hints, notes and banners a person has put away, per account.
--
-- These dismissals lived in the browser's local storage, so a closed hint
-- came back on another device, in another browser, and whenever the browser
-- evicted the site's storage. The ids are listed in
-- `src/lib/hints/dismissible-hints.ts`.
--
-- Not null with a default, so the previous image ignores it after a
-- rollback. Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "dismissed_hints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
END
$migration$;
