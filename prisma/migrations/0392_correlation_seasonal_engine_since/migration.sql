-- When the instance first stored a discovery finding under the seasonally
-- adjusted correlation engine. Stamped once by the engine itself; null until
-- its first run, which counts every existing pattern as an earlier finding.
ALTER TABLE "app_settings" ADD COLUMN "correlation_seasonal_engine_since" TIMESTAMP(3);
