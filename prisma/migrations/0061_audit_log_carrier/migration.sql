-- v1.4.27 B3 — Persist the ASN + carrier on login audit rows.
--
-- The bundled MaxMind GeoLite2-ASN MMDB resolves an autonomous-system
-- number and the organisation string ("Deutsche Telekom AG") at
-- audit-creation time. Both columns are nullable so the schema stays
-- valid for older rows, for private/loopback IPs that skip the
-- lookup entirely, and for offline-miss rows that the resolver could
-- not match.
--
--   asn      — INTEGER, the autonomous-system number from the MMDB.
--   carrier  — TEXT, the autonomous-system organisation string.
--
-- The `IF NOT EXISTS` guards make the migration idempotent — the
-- demo server may already carry hand-edited columns from a prior
-- partial run, and the same migration must apply cleanly to a fresh
-- database. Same posture as 0058_user_research_mode.

ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "asn" INTEGER,
  ADD COLUMN IF NOT EXISTS "carrier" TEXT;
