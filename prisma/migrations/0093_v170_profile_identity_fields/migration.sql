-- v1.7.0 — optional patient-identity profile fields for the health-record export.
--
-- Surfaced on the doctor-handover PDF cover and the FHIR `Patient` resource:
--   * full_name                 — legal patient name (plaintext, like date_of_birth/gender)
--   * insurer_name              — health-insurer display name (plaintext)
--   * insurance_number_encrypted — German KVNR, a quasi-identifier, stored
--                                  AES-256-GCM encrypted under the active
--                                  ENCRYPTION_KEYS entry (see src/lib/crypto.ts).
--
-- All three are nullable with no default, so each ADD COLUMN is a single
-- non-blocking metadata operation on Postgres 11+. Existing rows read NULL,
-- which the export cover + FHIR builder collapse exactly like an absent
-- practice name.

ALTER TABLE "users"
  ADD COLUMN "full_name" TEXT,
  ADD COLUMN "insurer_name" TEXT,
  ADD COLUMN "insurance_number_encrypted" TEXT;
