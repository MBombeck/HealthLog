-- v1.5.5 — self-hosted avatar storage.
--
-- Replaces the Gravatar third-party leak. The previous /me payload
-- carried a `gravatarUrl` built from `SHA-256(email)` and pointed
-- every authenticated page-load at www.gravatar.com — Automattic
-- could correlate the digest against its known-email table on each
-- request. The new path stores the image bytes on the User row and
-- serves them from same-origin.
--
-- Three nullable columns; null on all three = the user has not
-- uploaded an avatar and the profile response returns
-- `avatarUrl: null`. The upload route guards the size + content-
-- type + dimensions before the row write, so the column-level
-- constraints intentionally stay loose (the validation is enforced
-- at the API layer where it can return a useful 4xx).
--
-- The bytes ride in pg_dump alongside the rest of the row, so the
-- standard backup path already covers them. No new filesystem
-- volume to mount, no new Docker compose change.

ALTER TABLE "users"
  ADD COLUMN "avatar_bytes" BYTEA,
  ADD COLUMN "avatar_content_type" TEXT,
  ADD COLUMN "avatar_updated_at" TIMESTAMP(3);
