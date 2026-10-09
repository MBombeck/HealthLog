-- Lab unit conversion provenance (#1095).
--
-- `biomarkers.analyte_key` names the catalogue analyte a marker resolves to,
-- which selects its unit-conversion table. `lab_results.source_value` /
-- `source_unit` keep the value and unit as printed on the report when a write
-- converted the reading into the marker's canonical unit. All nullable; no
-- existing row changes.
ALTER TABLE "biomarkers" ADD COLUMN "analyte_key" TEXT;

ALTER TABLE "lab_results"
    ADD COLUMN "source_value" DOUBLE PRECISION,
    ADD COLUMN "source_unit" TEXT;
