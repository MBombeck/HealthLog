-- v1.4.25 W19b — MedicationInventoryItem (pen / vial entity).
--
-- The existing MedicationInventoryEvent ledger (W4d) tracks running
-- stock as a stream of ±delta rows; this new model tracks the
-- *individual* pen / vial entities so the UI can show "Pen #2 of 3 —
-- 12 days left in the 30-day in-use window" rather than just an
-- aggregate count. Both surfaces coexist: the ledger is the
-- consumption stream, this model is the physical-supply inventory.
--
-- Why a dedicated entity per pen / vial:
--   - EMA EPAR §6.3 sets a 30-day in-use clock per opened pen
--     (Mounjaro KwikPen, Saxenda, Trulicity), 56 days for Ozempic.
--     The clock starts at first-use, not at purchase — so we have to
--     persist the per-pen `firstUseAt` somewhere.
--   - A pen also carries its own `printedExpiry` (the date stamped
--     on the carton), which can pre-empt the 30-day clock if the
--     printed expiry lands earlier.
--   - Dose-depletion math is per-pen (Mounjaro KwikPen = 4 doses,
--     Trulicity = 1, Byetta = 60) and needs a `dosesRemaining`
--     counter independent of the aggregate ledger.
--
-- State machine (see `src/lib/medications/inventory/state-machine.ts`):
--   ACTIVE  → refrigerated, unopened (default after purchase)
--   IN_USE  → opened, 30-day clock counting down from firstUseAt
--   EXPIRED → past 30-day in-use window OR past printedExpiry
--   USED_UP → all doses consumed
--
-- Composite index (user_id, medication_id, state) for the hot read
-- path: "show me my active inventory for this medication". The state
-- column is the variable axis — the UI filters on ACTIVE | IN_USE for
-- the live tile and on EXPIRED | USED_UP for the history collapsed
-- list — so it goes last in the composite for index-prefix selectivity.

CREATE TYPE "medication_inventory_state" AS ENUM (
  'ACTIVE',
  'IN_USE',
  'EXPIRED',
  'USED_UP'
);

CREATE TABLE "medication_inventory_items" (
  "id"               TEXT PRIMARY KEY,
  "user_id"          TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "medication_id"    TEXT NOT NULL REFERENCES "medications"("id") ON DELETE CASCADE,
  "state"            "medication_inventory_state" NOT NULL DEFAULT 'ACTIVE',
  "doses_total"      INTEGER NOT NULL,
  "doses_remaining"  INTEGER NOT NULL,
  -- NULL until the pen is first opened. Sets the 30-day in-use clock.
  "first_use_at"     TIMESTAMP(3),
  -- Computed = MIN(first_use_at + 30 days, printed_expiry). Persisted
  -- rather than derived so a DB-side index / sort by expiry is cheap.
  "expires_at"       TIMESTAMP(3),
  -- The printed carton expiry date the user enters on creation.
  "printed_expiry"   TIMESTAMP(3),
  "purchased_at"     TIMESTAMP(3),
  -- Free-text note ("Apotheke Müller, 2025-10-12"). Hard-capped to
  -- 200 chars at the application layer (see Zod schema); the DB
  -- column is unbounded TEXT for consistency with the other note
  -- columns on this schema (MedicationDoseChange.note, etc.).
  "notes"            TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "medication_inventory_items_user_med_state_idx"
  ON "medication_inventory_items" ("user_id", "medication_id", "state");

-- A separate index on (user_id, expires_at) supports the daily
-- expire-stale background job — it scans IN_USE rows by expiry-asc
-- and the (user, expires_at) prefix makes that O(log n) per user.
CREATE INDEX "medication_inventory_items_user_expires_idx"
  ON "medication_inventory_items" ("user_id", "expires_at");
