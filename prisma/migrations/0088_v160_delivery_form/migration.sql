-- v1.6.0 — route-of-administration on medications.
--
-- Adds `delivery_form` (ORAL | INJECTION | OTHER), decoupled from the
-- existing `treatment_class` discriminator. This lets the injection-site
-- picker surface for ANY injection dose (not only GLP-1) and gives the
-- one-time-injection shape a first-class flag (`one_shot = true` +
-- `delivery_form = INJECTION`).
--
-- Every existing row backfills to ORAL via the column default, so the
-- ADD COLUMN is a single non-blocking metadata operation on Postgres 11+
-- (the default is a constant, not a volatile expression).

CREATE TYPE "medication_delivery_form" AS ENUM ('ORAL', 'INJECTION', 'OTHER');

ALTER TABLE "medications"
  ADD COLUMN "delivery_form" "medication_delivery_form" NOT NULL DEFAULT 'ORAL';
