-- Per-user document vault presentation (view + month arrangement).
-- Nullable, display-only; null reads as the defaults.
ALTER TABLE "users" ADD COLUMN "documents_layout_json" JSONB;
