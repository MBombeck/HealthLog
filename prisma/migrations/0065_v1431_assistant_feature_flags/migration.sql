-- v1.4.31 — Assistant-surface operator feature flags
--
-- Six new boolean columns on `app_settings`. One master flag plus
-- five sub-flags covering the seven LLM-driven surfaces (Coach,
-- Daily Briefing, per-metric status cards, correlations,
-- Health-Score delta explainer). All default `true` so existing
-- installs upgrade without losing surfaces. The runtime resolver
-- forces every sub-flag false when the master is off — so flipping
-- one row in the admin panel can mute the whole assistant.
--
-- Additive-only — six nullable-then-default columns, no data
-- movement. `IF NOT EXISTS` keeps the migration idempotent against
-- partial historical runs (same posture as 0058, 0061, 0063).
--
-- Locks per `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R5
-- and the architecture doc at
-- `.planning/research/v15-assistant-optional.md`.

ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "assistant_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "assistant_coach_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "assistant_briefing_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "assistant_insight_status_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "assistant_correlations_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "assistant_health_score_explainer_enabled" BOOLEAN NOT NULL DEFAULT true;
