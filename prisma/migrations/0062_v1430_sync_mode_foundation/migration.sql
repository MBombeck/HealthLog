-- v1.4.30 — iOS SyncMode foundation (R-E C-2)
--
-- Three additive columns the iOS app reads when it pairs with the
-- server:
--
--   measurements.sync_version  — monotonic version counter per row.
--                                 Default = 1 for legacy rows; the
--                                 server bumps it on every update so
--                                 paired clients can do last-writer-
--                                 wins reconciliation.
--   measurements.deleted_at    — soft-delete timestamp. The
--                                 by-external-ids DELETE path flips
--                                 this rather than removing rows so
--                                 paired iOS clients can reconcile
--                                 deletions without losing the audit
--                                 trail.
--   users.last_synced_at       — last-known synchronization checkpoint
--                                 the iOS SyncMode store reads via
--                                 `GET /api/sync/state`.
--
-- All three are nullable / defaulted so existing rows + existing iOS
-- POSTs round-trip unchanged. The `IF NOT EXISTS` guards keep the
-- migration idempotent against partial historical runs (same posture
-- as 0058_user_research_mode and 0061_audit_log_carrier).

ALTER TABLE "measurements"
  ADD COLUMN IF NOT EXISTS "sync_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "deleted_at"   TIMESTAMP(3);

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMP(3);
