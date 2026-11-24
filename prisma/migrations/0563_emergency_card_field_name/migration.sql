-- The record's name as an emergency-card item (v1.50).
--
-- An Apple Wallet pass shows the name as its title, and the read-only link,
-- the offline copy and the printed card show it as their title line when the
-- owner ticks it. A link made before this release does not carry it, so
-- nothing it shows changes.
--
-- A file of its own: a value added with `ALTER TYPE ... ADD VALUE` cannot be
-- used inside the transaction that adds it, and nothing here uses it. Placed
-- first, the card's reading order (who this is, then what matters).
-- Reversibility: a Postgres enum value cannot be dropped; an older image
-- never writes it and reads a link that carries it as an unknown item.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TYPE "emergency_card_field" ADD VALUE IF NOT EXISTS 'NAME' BEFORE 'BLOOD_TYPE';
END
$migration$;
