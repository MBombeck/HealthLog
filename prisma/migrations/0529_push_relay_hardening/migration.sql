-- Push relay hardening: staged sender keys, and APNs token ownership that
-- does not depend on letter case.
--
-- 1. `push_envelope_keys` gains the announced next sender key. A new key is
--    published as `next` for at least 7 days before it seals anything, so a
--    device that has not opened the app never gets an envelope sealed with a
--    key it has not pinned.
-- 2. APNs device tokens are hex, and the relay path compares them in lower
--    case. The ownership check did not: the same token in other letters
--    passed the guard that keeps one token on one account. Existing tokens
--    are lowered. Where two rows hold the same token in different case, the
--    most recently seen keeps it; the other loses its APNs token (and
--    environment, which the check constraint pairs with it) and re-registers
--    on its next launch. The route lowers every token it stores, and a unique
--    index on `lower(apns_token)` refuses a second spelling of one token.
--
-- One DO block, every statement guarded, so a replay after a lock timeout
-- changes nothing. Reversibility: drop the three columns and the index;
-- lowered tokens stay valid hex.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "push_envelope_keys"
        ADD COLUMN IF NOT EXISTS "next_sender_key_encrypted" TEXT,
        ADD COLUMN IF NOT EXISTS "next_sender_public_key" TEXT,
        ADD COLUMN IF NOT EXISTS "next_announced_at" TIMESTAMP(3);

    -- Writes wait from the lowering to the build, so a still-running older
    -- container cannot store a second spelling of a token in between and
    -- fail the build with 23505. Reads go on.
    LOCK TABLE "devices" IN SHARE ROW EXCLUSIVE MODE;

    UPDATE "devices" AS d
       SET "apns_token" = NULL,
           "apns_environment" = NULL
      FROM "devices" AS keep
     WHERE d."apns_token" IS NOT NULL
       AND keep."apns_token" IS NOT NULL
       AND d."id" <> keep."id"
       AND lower(d."apns_token") = lower(keep."apns_token")
       AND (d."last_seen", d."id") < (keep."last_seen", keep."id");

    UPDATE "devices"
       SET "apns_token" = lower("apns_token")
     WHERE "apns_token" IS NOT NULL
       AND "apns_token" <> lower("apns_token");

    CREATE UNIQUE INDEX IF NOT EXISTS "devices_apns_token_lower_unique"
        ON "devices" (lower("apns_token"))
        WHERE "apns_token" IS NOT NULL;

END
$migration$;
