ALTER TABLE "app_settings"
ADD COLUMN IF NOT EXISTS "umami_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "umami_script_url" TEXT,
ADD COLUMN IF NOT EXISTS "umami_website_id" TEXT,
ADD COLUMN IF NOT EXISTS "glitchtip_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "glitchtip_dsn" TEXT,
ADD COLUMN IF NOT EXISTS "glitchtip_environment" TEXT;
