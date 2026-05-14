-- v1.4.25 W19c — Research Mode acknowledgment fields.
--
-- Adds three columns to the `users` table that together gate the
-- opt-in GLP-1 PK research-view chart behind an undismissable
-- MDR-disclaimer dialog (research §2.3 + §11). The chart never
-- renders unless `research_mode_enabled = true`, and the dialog
-- only flips that flag after the user explicitly acknowledges the
-- disclaimer copy at a specific version.
--
--   research_mode_enabled              — master on/off switch.
--                                        Default `false` keeps the
--                                        chart hidden for every
--                                        existing user.
--   research_mode_acknowledged_at      — timestamp of the most
--                                        recent acknowledgment.
--                                        NULL when the user has
--                                        never acknowledged.
--   research_mode_acknowledged_version — string identifier of the
--                                        disclaimer copy version
--                                        the user acknowledged
--                                        (e.g. "2026-05-14.1"). The
--                                        Settings UI re-prompts when
--                                        the version drifts ahead
--                                        of the persisted value, so
--                                        copy updates cannot quietly
--                                        keep the chart visible.
--
-- The `IF NOT EXISTS` guards make the migration idempotent — if any
-- column landed via a prior dev-DB hand-edit, the migration still
-- runs cleanly to completion (mirrors the 0057 onboarding-step
-- migration's posture).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "research_mode_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "research_mode_acknowledged_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "research_mode_acknowledged_version" TEXT;
