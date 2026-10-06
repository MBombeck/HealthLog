-- The model-written text of a Coach turn's live trail, encrypted like the
-- message itself. Nullable and without a default: every existing turn has no
-- trail, and adding a nullable column rewrites no rows.
ALTER TABLE "coach_messages" ADD COLUMN "trail_encrypted" BYTEA;
