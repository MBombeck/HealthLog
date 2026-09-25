-- Per-medication intake tracking (#1033). A medication with tracking off
-- keeps its dose, dates and schedule as a record, but nothing is due, no
-- reminder is sent and it is left out of adherence. Every existing row
-- defaults to tracking on, so nothing changes for anyone who does not flip it.
ALTER TABLE "medications"
  ADD COLUMN "track_intake" BOOLEAN NOT NULL DEFAULT true;
