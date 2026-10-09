-- Health Connect export DB (health_connect_export.db) - reconstructed subset.
-- Source: AOSP platform/packages/modules/HealthFitness, branch android17-release
-- (a292a16, 2026-04-15); base columns identical in android15-release (37f52da).
-- Built by CreateTableRequest.getCreateCommand(): "CREATE TABLE IF NOT EXISTS t (col TYPE, ...,
-- gen TYPE AS (expr), FOREIGN KEY (...) REFERENCES p(row_id) ON DELETE CASCADE)".
-- Column ORDER on real devices can differ (columns added later via ALTER TABLE in
-- DatabaseUpgradeHelper); readers must select by NAME, never by position.
-- device_data_provider_id only exists when the DDP flag is on (DB v26+).

CREATE TABLE application_info_table (
  row_id INTEGER PRIMARY KEY, package_name TEXT NOT NULL UNIQUE, app_name TEXT,
  app_icon BLOB, record_types_used TEXT);

CREATE TABLE device_info_table (
  row_id INTEGER PRIMARY KEY, manufacturer TEXT, model TEXT, device_type INTEGER);

CREATE TABLE health_data_category_priority_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, health_data_category INTEGER UNIQUE,
  app_id_priority_order TEXT);

-- Common prefix of every record table (RecordHelper.getColumnInfo):
--   row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE (16 bytes, msb|lsb big-endian),
--   last_modified_time INTEGER (epoch ms), client_record_id TEXT, client_record_version TEXT,
--   device_info_id INTEGER -> device_info_table, app_info_id INTEGER -> application_info_table,
--   recording_method INTEGER (0 unknown, 1 active, 2 automatic, 3 manual), dedupe_hash BLOB UNIQUE
-- Instant suffix: time INTEGER (epoch ms UTC), zone_offset INTEGER (SECONDS), local_date INTEGER (epoch day),
--   local_date_time INTEGER AS (time + 1000 * zone_offset)
-- Interval suffix: start_time, start_zone_offset, end_time, end_zone_offset, local_date,
--   local_date_time_start_time AS (start_time + 1000*start_zone_offset), local_date_time_end_time AS (...)

CREATE TABLE weight_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  weight REAL,                                  -- GRAMS (Mass.fromGrams)
  local_date_time INTEGER AS (time + 1000 * zone_offset),
  FOREIGN KEY (device_info_id) REFERENCES device_info_table(row_id) ON DELETE CASCADE,
  FOREIGN KEY (app_info_id) REFERENCES application_info_table(row_id) ON DELETE CASCADE);

CREATE TABLE body_fat_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  percentage REAL,                              -- 0..100
  local_date_time INTEGER AS (time + 1000 * zone_offset));

CREATE TABLE blood_pressure_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  measurement_location TEXT NOT NULL,           -- int written into TEXT affinity -> comes back as '3'
  systolic REAL, diastolic REAL,                -- mmHg
  body_position TEXT NOT NULL,                  -- int as text
  local_date_time INTEGER AS (time + 1000 * zone_offset));

CREATE TABLE resting_heart_rate_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  beats_per_minute INTEGER,
  local_date_time INTEGER AS (time + 1000 * zone_offset));

CREATE TABLE heart_rate_variability_rmssd_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  heart_rate_variability_millis REAL NOT NULL,  -- RMSSD in ms
  local_date_time INTEGER AS (time + 1000 * zone_offset));

CREATE TABLE oxygen_saturation_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  percentage REAL,                              -- 0..100
  local_date_time INTEGER AS (time + 1000 * zone_offset));

CREATE TABLE respiratory_rate_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  rate REAL,                                    -- breaths/min
  local_date_time INTEGER AS (time + 1000 * zone_offset));

CREATE TABLE blood_glucose_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  specimen_source TEXT NOT NULL, level REAL,    -- level in mmol/L
  relation_to_meal TEXT NOT NULL, meal_type TEXT NOT NULL,
  local_date_time INTEGER AS (time + 1000 * zone_offset));

CREATE TABLE body_temperature_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  measurement_location INTEGER, temperature REAL, -- Celsius
  local_date_time INTEGER AS (time + 1000 * zone_offset));

CREATE TABLE vo2_max_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  measurement_method INTEGER, vo2_milliliters_per_minute_kilogram REAL,
  local_date_time INTEGER AS (time + 1000 * zone_offset));

CREATE TABLE menstruation_flow_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  flow INTEGER,                                 -- 0 unknown, 1 light, 2 medium, 3 heavy
  local_date_time INTEGER AS (time + 1000 * zone_offset));

-- Interval tables
CREATE TABLE steps_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER,
  count INTEGER,
  local_date_time_start_time INTEGER AS (start_time + 1000 * start_zone_offset),
  local_date_time_end_time INTEGER AS (end_time + 1000 * end_zone_offset));

CREATE TABLE hydration_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER,
  volume REAL);                                 -- LITERS

CREATE TABLE active_calories_burned_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER,
  energy REAL);                                 -- small CALORIES (kcal = /1000)

CREATE TABLE distance_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER,
  distance REAL);                               -- meters

CREATE TABLE menstruation_period_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER);

CREATE TABLE sleep_session_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER,
  notes TEXT, title TEXT);

CREATE TABLE sleep_stages_table (
  parent_key INTEGER NOT NULL, stage_start_time INTEGER NOT NULL, stage_end_time INTEGER NOT NULL,
  stage_type INTEGER NOT NULL,                  -- 0 unknown,1 awake,2 sleeping,3 out_of_bed,4 light,5 deep,6 rem,7 awake_in_bed
  FOREIGN KEY (parent_key) REFERENCES sleep_session_record_table(row_id) ON DELETE CASCADE);

CREATE TABLE exercise_session_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER,
  notes TEXT, exercise_type INTEGER, title TEXT, has_route INTEGER,
  planned_exercise_session_id BLOB NULL);       -- + rate_of_perceived_exertion REAL on newer DB versions

-- Series: parent row is an interval record, samples in the child table
CREATE TABLE heart_rate_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER);

CREATE TABLE heart_rate_record_series_table (
  parent_key INTEGER, beats_per_minute INTEGER, epoch_millis INTEGER,
  FOREIGN KEY (parent_key) REFERENCES heart_rate_record_table(row_id) ON DELETE CASCADE);

-- nutrition_record_table: interval prefix + ~40 REAL nutrient columns (grams; energy/energy_from_fat in
-- small calories), meal_type INTEGER, meal_name TEXT. See NutritionRecordHelper.java.

CREATE TABLE lean_body_mass_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  time INTEGER, zone_offset INTEGER, local_date INTEGER,
  mass REAL,                                    -- GRAMS
  local_date_time INTEGER AS (time + 1000 * zone_offset));

-- Subset of the ~40 nutrient columns (grams; energy in small calories).
CREATE TABLE nutrition_record_table (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB NOT NULL UNIQUE, last_modified_time INTEGER,
  client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
  recording_method INTEGER, dedupe_hash BLOB UNIQUE,
  start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER,
  energy REAL, protein REAL, total_fat REAL, vitamin_c REAL, vitamin_d REAL, magnesium REAL, caffeine REAL,
  meal_type INTEGER, meal_name TEXT);
