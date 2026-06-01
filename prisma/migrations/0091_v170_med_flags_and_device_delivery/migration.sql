-- v1.7.0 — per-medication iOS reminder flags + per-device delivery override.
--
-- Three additive columns, no data step:
--
--   * medications.live_activity_enabled — iOS Live Activity opt-in for a
--     medication's reminders. The iOS client owns the ActivityKit
--     lifecycle; the server only stores and echoes the flag. Backfills
--     false via the column default.
--
--   * medications.critical_alarm_enabled — iOS 26 AlarmKit critical
--     reminder opt-in. Critical alarms bypass the mute switch / Focus on
--     the device; the server stores the preference only and hangs no
--     server-side behaviour off it. Backfills false via the default.
--
--   * devices.medication_delivery — per-device delivery override. NULL =
--     inherit the user-level roaming default
--     (User.notificationPrefs.medication.deliveryDefault). "server" forces
--     server APNs for this device; "client" forces local. v1.7.0 stores +
--     echoes this; cron suppression stays user-level (APNs fans out to all
--     devices and iOS dedupes locally).
--
-- All three defaults / NULLs are constants, so the ADD COLUMNs are
-- single non-blocking metadata operations on Postgres 11+.

ALTER TABLE "medications"
  ADD COLUMN "live_activity_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "critical_alarm_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "devices"
  ADD COLUMN "medication_delivery" TEXT;
