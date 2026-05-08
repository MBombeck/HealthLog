-- 0025_refresh_tokens — down migration (v1.4 G4 rollback).
-- Forward-compatible: the up migration only ADDS a table, so this is a
-- safe DROP. Any in-flight refresh tokens are invalidated; native clients
-- need to re-authenticate.

DROP TABLE IF EXISTS "refresh_tokens";
