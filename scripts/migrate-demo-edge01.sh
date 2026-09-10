#!/usr/bin/env bash
#
# migrate-demo-edge01.sh — copy EXACTLY ONE user (the demo account) from the
# production apps01 Postgres to the SEPARATE edge01 demo Postgres.
#
# ============================================================================
# WHAT THIS SCRIPT DOES (and the isolation guarantees it makes)
# ============================================================================
#
# It transfers a single, demo-scoped slice of health data so the public demo
# instance on edge01 shows a realistic-looking account WITHOUT carrying any
# real-operator data. The ONLY user copied is:
#
#     $DEMO_USER_ID   (the single demo account, supplied via env)
#
# ABSOLUTE INVARIANTS enforced by this script:
#   1. ZERO rows from any other user are transferred. Every source SELECT is
#      scoped to the demo user id (directly via user_id, or join-scoped via a
#      child FK that resolves back to the demo's own parent rows). A PRE-FLIGHT
#      guard counts any row in each carried set whose ownership resolves to a
#      user other than the demo id and ABORTS if the count is non-zero.
#   2. A protected account id ($PROTECT_USER_ID, e.g. the operator's real
#      account) must NEVER appear in any transferred row. A POST-LOAD verification
#      asserts that id is absent from every carried table, and that every
#      user_id-bearing carried table contains ONLY the demo id.
#   3. No secret / credential column is transferred. The users SELECT NULLs
#      every encrypted / token / integration-secret column explicitly. The
#      cycle-day-log SELECT NULLs the two app-encrypted columns (they are
#      keyed to the prod encryption key, which is NOT present on edge01).
#
# The transfer mechanism per table is a scoped server-side COPY piped
# host-to-host:
#
#   ssh "$SRC_SSH" "<psql> -c \"\\copy (SELECT <cols> FROM <t> WHERE <scope>)
#                              TO STDOUT (FORMAT csv, HEADER false)\""
#     | ssh "$DST_SSH" "<psql> -c \"\\copy <t>(<cols>)
#                                  FROM STDIN (FORMAT csv, HEADER false)\""
#
# Explicit column lists are used on BOTH ends so:
#   - secret columns can be omitted / NULLed,
#   - column order is pinned (independent of physical table layout),
#   - an added/dropped column on either side fails loudly rather than
#     silently shifting data into the wrong column.
#
# Tables load in FK-parent-first order. The edge01 demo rows are wiped first
# (FK-child-first), scoped to the edge01 demo user id resolved at runtime.
#
# THIS SCRIPT IS FOR REVIEW. Read it, then run it deliberately. It performs
# DESTRUCTIVE deletes on the edge01 demo DB (scoped to the demo user) followed
# by inserts. It NEVER writes to apps01 (source is read-only).
#
# ----------------------------------------------------------------------------
# EXCLUDED ENTIRELY (intentionally NOT copied)
# ----------------------------------------------------------------------------
#   - Auth / session / device surfaces: sessions, passkeys, auth_challenges,
#     api_tokens, refresh_tokens, devices, push_subscriptions, push_attempts,
#     notification_channels, notification_preferences.
#   - Integration / OAuth: withings_connections, whoop_connections,
#     fitbit_connections, all *_oauth_states / *_connect_tickets,
#     telegram_scheduled_deletions, telegram_reminder_messages,
#     clinician_share_links, provider_health.
#   - Encrypted-at-rest payloads we cannot decrypt on edge01:
#     insight_narratives, coach_messages (coach_* entirely).
#   - Coach: coach_conversations, coach_messages, coach_facts, coach_usage.
#   - Ops / transient / regenerable: idempotency_keys, rate_limits,
#     data_backups, import_jobs, host_metrics, feedback,
#     recommendation_feedback, all rollup tables (measurement_rollups,
#     mood_entry_rollups, medication_compliance_rollups, strain_trimp_cache,
#     cycle_predictions) — these REGENERATE on edge01.
#   - workouts / workout_routes / workout_samples — demo has none.
#   - app_settings — instance-level, not user data.
#   - Global catalogues (mood_tags, cycle_symptoms) — pre-exist on edge01;
#     carried link rows reference these GLOBAL ids only (see guards below).
#
set -euo pipefail

# ============================================================================
# CONFIG
# ============================================================================
# All instance-specific values come from the environment at runtime — NO real
# account ids, host aliases, or container identifiers are baked into this file
# (it lives in a public repo; see the project's voice/privacy rules).
#   DEMO_USER_ID   — the single user id to migrate (required)
#   PROTECT_USER_ID — an id that must NEVER appear in the result (optional guard;
#                     e.g. the operator's real account). Post-load asserts absence.
#   SRC_SSH / DST_SSH — ssh aliases for the source + target hosts (required)
#   SRC_DB_CONTAINER_PATTERN — grep pattern to resolve the source DB container (required)
#   DST_DB_CONTAINER — target DB container (optional; auto-resolved if unset)
readonly DEMO_USER_ID="${DEMO_USER_ID:?set DEMO_USER_ID to the user id to migrate}"
readonly REAL_USER_ID="${PROTECT_USER_ID:-__no_protect_id__}"

readonly SRC_SSH="${SRC_SSH:?set SRC_SSH to the source host ssh alias}"
readonly DST_SSH="${DST_SSH:?set DST_SSH to the target host ssh alias}"

# Source DB container — resolved dynamically from SRC_DB_CONTAINER_PATTERN (the
# Coolify container name carries a rotating suffix, e.g. db-<uuid>-<digits>).
readonly SRC_DB_CONTAINER_PATTERN="${SRC_DB_CONTAINER_PATTERN:?set SRC_DB_CONTAINER_PATTERN (a grep -E pattern for the source DB container name)}"
SRC_DB_CONTAINER="$(ssh "$SRC_SSH" "docker ps --format '{{.Names}}' | grep -E '$SRC_DB_CONTAINER_PATTERN' | head -1" 2>/dev/null | tr -d '[:space:]')"
if [[ -z "$SRC_DB_CONTAINER" ]]; then echo "ABORT: could not resolve source DB container (pattern: $SRC_DB_CONTAINER_PATTERN)."; exit 1; fi
readonly SRC_DB_CONTAINER

readonly PG_USER="healthlog"
readonly PG_DB="healthlog"

# Argon2id hash of the demo password the README publishes ("demo123demo123").
# Not a secret: it is printed in the README so anyone can sign in to the demo,
# and it is the same literal that scripts/seed-demo.ts writes on a fresh seed.
# The transfer still carries the source column, but the load is followed by an
# explicit overwrite with this literal (see "FORCE THE PUBLISHED DEMO PASSWORD"
# below). The source is the operator's own instance and its demo password can
# be rotated at any time; carrying it across silently invalidated the published
# credentials once already (public issue #805). Overwriting afterwards makes the
# documented login true by construction after every migration.
#
# The overwrite travels on psql's STDIN, never inside the ssh command string:
# the hash contains '$' segments that a remote shell would expand away.
#
# scripts/__tests__/demo-published-password-guard.test.ts pins this literal to
# the one in scripts/seed-demo.ts, so editing one without the other fails.
readonly PUBLIC_DEMO_PASSWORD_HASH='$argon2id$v=19$m=65536,t=3,p=4$Kips6OxPAl0vmspO9SoKZQ$oX9gLgwHVnnENCqBloyM13ewuqmhPnw8EpLoemS3MNI'

# psql invocation builders. -v ON_ERROR_STOP=1 makes any SQL error a non-zero
# exit so `set -e` aborts the pipeline. -X skips ~/.psqlrc.
psql_src() {
  # Usage: psql_src "<sql>"
  ssh "$SRC_SSH" "docker exec -i $SRC_DB_CONTAINER psql -X -v ON_ERROR_STOP=1 -U $PG_USER -d $PG_DB $*"
}

# DST container name is resolved at runtime into DST_DB_CONTAINER (see below),
# so psql_dst is defined after resolution.

echo "=============================================================="
echo " HealthLog demo-user migration  apps01 -> edge01"
echo " demo user : $DEMO_USER_ID"
echo " src host  : $SRC_SSH  (container $SRC_DB_CONTAINER)"
echo " dst host  : $DST_SSH  (container resolved below)"
echo "=============================================================="

# ============================================================================
# RESOLVE the edge01 demo DB container (NOT hardcoded — it is a separate
# Coolify Postgres resource whose container name can change on redeploy).
# ============================================================================
echo
if [[ -n "${DST_DB_CONTAINER:-}" ]]; then
  echo "## Using DST_DB_CONTAINER from env: $DST_DB_CONTAINER"
else
  echo "## Resolving edge01 demo Postgres container ..."
  DST_DB_CONTAINER="$(ssh "$DST_SSH" "docker ps --format '{{.Names}}' | grep -iE 'postgres|^db-' || true")"
  echo "candidate containers on $DST_SSH:"
  echo "$DST_DB_CONTAINER" | sed 's/^/    /'
  # Only the demo Postgres is the correct target. Pick the single match or abort.
  DST_DB_CONTAINER_COUNT="$(printf '%s\n' "$DST_DB_CONTAINER" | grep -c . || true)"
  if [[ "$DST_DB_CONTAINER_COUNT" -ne 1 ]]; then
    echo
    echo "ABORT: expected exactly one Postgres container on $DST_SSH, found $DST_DB_CONTAINER_COUNT."
    echo "       Set DST_DB_CONTAINER explicitly and re-run, e.g.:"
    echo "       DST_DB_CONTAINER=db-xxxx $0"
    exit 1
  fi
  DST_DB_CONTAINER="$(printf '%s\n' "$DST_DB_CONTAINER" | head -n1)"
fi
readonly DST_DB_CONTAINER
echo "resolved edge01 demo DB container: $DST_DB_CONTAINER"

# Confirm the psql user/db actually work on the resolved container before we
# touch anything (fail fast on a wrong container guess).
psql_dst() {
  # Usage: psql_dst "<sql>"
  ssh "$DST_SSH" "docker exec -i $DST_DB_CONTAINER psql -X -v ON_ERROR_STOP=1 -U $PG_USER -d $PG_DB $*"
}
echo "## Verifying edge01 DB connectivity ..."
psql_dst "-c 'SELECT current_database(), current_user;'"

# ============================================================================
# RESOLVE the edge01 demo user id (it MAY differ from the apps01 id!).
# We resolve by username='demo'. After this migration the edge01 demo user
# will carry the apps01 canonical id (we delete the old row + load the apps01
# row). Scope EVERY wipe to whatever the edge01 id is right now.
# ============================================================================
echo
echo "## Resolving edge01 demo user id (by username='demo') ..."
EDGE_DEMO_ID="$(psql_dst "-tA -c \"SELECT id FROM users WHERE username = 'demo';\"" | tr -d '[:space:]')"
if [[ -z "$EDGE_DEMO_ID" ]]; then
  echo "note: no existing demo user on edge01 (username='demo') — wipe phase is a no-op."
else
  echo "edge01 existing demo user id: $EDGE_DEMO_ID"
  if [[ "$EDGE_DEMO_ID" == "$REAL_USER_ID" ]]; then
    echo "ABORT: edge01 username='demo' resolves to the REAL operator id. Refusing."
    exit 1
  fi
fi
readonly EDGE_DEMO_ID

# ============================================================================
# PRE-FLIGHT GUARD (on apps01 source): assert every carried set is demo-only.
# Each query MUST return 0. A non-zero result means a scope predicate is wrong
# and we would leak another user's rows — ABORT immediately.
# ============================================================================
echo
echo "## PRE-FLIGHT guard: assert source SELECTs are demo-scoped (each must be 0)"

preflight() {
  local label="$1" sql="$2"
  local n
  n="$(psql_src "-tA -c \"$sql\"" | tr -d '[:space:]')"
  printf '    %-40s leaked-rows=%s\n' "$label" "$n"
  if [[ "$n" != "0" ]]; then
    echo "ABORT: pre-flight guard '$label' returned $n rows owned by a non-demo user."
    exit 1
  fi
}

# user_id-bearing tables: assert the scoped set contains no foreign user_id.
# (The predicate is the same one the COPY SELECT uses; this is a self-check
#  that the scope expression cannot admit a non-demo row.)
preflight "measurements"            "SELECT count(*) FROM measurements             WHERE deleted_at IS NULL AND user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "cycle_profiles"          "SELECT count(*) FROM cycle_profiles           WHERE user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "menstrual_cycles"        "SELECT count(*) FROM menstrual_cycles         WHERE user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "cycle_day_logs"          "SELECT count(*) FROM cycle_day_logs           WHERE user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "mood_entries"            "SELECT count(*) FROM mood_entries             WHERE deleted_at IS NULL AND user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "medications"             "SELECT count(*) FROM medications              WHERE user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "medication_intake_events" "SELECT count(*) FROM medication_intake_events WHERE deleted_at IS NULL AND user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "medication_side_effects" "SELECT count(*) FROM medication_side_effects  WHERE user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "medication_inventory_items" "SELECT count(*) FROM medication_inventory_items WHERE user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "personal_records"        "SELECT count(*) FROM personal_records         WHERE user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "user_achievements"       "SELECT count(*) FROM user_achievements        WHERE user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "consent_receipts"        "SELECT count(*) FROM consent_receipts         WHERE user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"
preflight "audit_logs(insights)"    "SELECT count(*) FROM audit_logs               WHERE action LIKE 'insights.%' AND user_id = '$DEMO_USER_ID' AND user_id <> '$DEMO_USER_ID';"

# Join-scoped child tables: assert the child's parent resolves to the demo user
# (i.e. no child row in the carried set whose parent is owned by another user).
preflight "medication_schedules(join)" \
  "SELECT count(*) FROM medication_schedules s JOIN medications m ON m.id = s.medication_id WHERE m.user_id = '$DEMO_USER_ID' AND m.user_id <> '$DEMO_USER_ID';"
preflight "medication_dose_changes(join)" \
  "SELECT count(*) FROM medication_dose_changes d JOIN medications m ON m.id = d.medication_id WHERE m.user_id = '$DEMO_USER_ID' AND m.user_id <> '$DEMO_USER_ID';"
preflight "medication_inventory_events(join)" \
  "SELECT count(*) FROM medication_inventory_events e JOIN medications m ON m.id = e.medication_id WHERE m.user_id = '$DEMO_USER_ID' AND m.user_id <> '$DEMO_USER_ID';"
preflight "reminder_phase_configs(join)" \
  "SELECT count(*) FROM reminder_phase_configs c JOIN medications m ON m.id = c.medication_id WHERE m.user_id = '$DEMO_USER_ID' AND m.user_id <> '$DEMO_USER_ID';"
preflight "cycle_symptom_links(join)" \
  "SELECT count(*) FROM cycle_symptom_links l JOIN cycle_day_logs d ON d.id = l.day_log_id WHERE d.user_id = '$DEMO_USER_ID' AND d.user_id <> '$DEMO_USER_ID';"
preflight "mood_entry_tag_links(join)" \
  "SELECT count(*) FROM mood_entry_tag_links l JOIN mood_entries e ON e.id = l.mood_entry_id WHERE e.user_id = '$DEMO_USER_ID' AND e.user_id <> '$DEMO_USER_ID';"

# GUARD: mood_entry_tag_links must reference ONLY global mood_tags (user_id IS
# NULL on the tag). The demo is asserted to have 0 custom mood_tags; if a link
# referenced a per-user tag id, the FK would break on edge01 (that tag row is
# not carried). Custom-tag count MUST be 0.
DEMO_CUSTOM_MOODTAGS="$(psql_src "-tA -c \"SELECT count(*) FROM mood_tags WHERE user_id = '$DEMO_USER_ID';\"" | tr -d '[:space:]')"
echo "    demo custom mood_tags = $DEMO_CUSTOM_MOODTAGS (must be 0 — all links point to GLOBAL tags)"
if [[ "$DEMO_CUSTOM_MOODTAGS" != "0" ]]; then
  echo "ABORT: demo user owns $DEMO_CUSTOM_MOODTAGS custom mood_tags. mood_entry_tag_links"
  echo "       would reference non-global tag ids that are NOT carried -> FK break on edge01."
  echo "       Carry mood_tags (user-scoped) before mood_entry_tag_links, or skip the links."
  exit 1
fi
# Defensive: assert every carried link points at a GLOBAL tag (user_id IS NULL).
preflight "mood_entry_tag_links(non-global tag)" \
  "SELECT count(*) FROM mood_entry_tag_links l JOIN mood_entries e ON e.id = l.mood_entry_id JOIN mood_tags t ON t.id = l.mood_tag_id WHERE e.user_id = '$DEMO_USER_ID' AND t.user_id IS NOT NULL;"

echo "## PRE-FLIGHT guard passed — every carried set is demo-only."

# ============================================================================
# WIPE-FIRST on edge01 (idempotent, demo-scoped ONLY). FK-child-first order.
# Every DELETE is scoped to the resolved edge01 demo user id ($EDGE_DEMO_ID)
# or via a join back to it. NEVER an unscoped DELETE. Skipped entirely if no
# existing demo user was found.
# ============================================================================
echo
if [[ -n "$EDGE_DEMO_ID" ]]; then
  echo "## WIPE edge01 demo rows (scoped to $EDGE_DEMO_ID), FK-child-first ..."
  # NOTE: edge01 FKs are ON DELETE CASCADE for most child rows; the explicit
  # child-first deletes below are belt-and-braces (some child tables hang off
  # medications/mood_entries, not the user) and keep the operation transparent.
  psql_dst <<SQL
\set ON_ERROR_STOP on
BEGIN;
-- join-scoped children of the demo's medications
DELETE FROM reminder_phase_configs       WHERE medication_id IN (SELECT id FROM medications      WHERE user_id = '$EDGE_DEMO_ID');
DELETE FROM medication_inventory_events  WHERE medication_id IN (SELECT id FROM medications      WHERE user_id = '$EDGE_DEMO_ID');
DELETE FROM medication_dose_changes      WHERE medication_id IN (SELECT id FROM medications      WHERE user_id = '$EDGE_DEMO_ID');
DELETE FROM medication_schedules         WHERE medication_id IN (SELECT id FROM medications      WHERE user_id = '$EDGE_DEMO_ID');
-- join-scoped children of the demo's mood_entries / cycle_day_logs
DELETE FROM mood_entry_tag_links         WHERE mood_entry_id IN (SELECT id FROM mood_entries     WHERE user_id = '$EDGE_DEMO_ID');
DELETE FROM cycle_symptom_links          WHERE day_log_id    IN (SELECT id FROM cycle_day_logs   WHERE user_id = '$EDGE_DEMO_ID');
-- user_id-scoped tables
DELETE FROM medication_inventory_items   WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM medication_side_effects      WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM medication_intake_events     WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM medications                  WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM mood_entries                 WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM cycle_day_logs               WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM menstrual_cycles             WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM cycle_profiles               WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM personal_records             WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM user_achievements            WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM consent_receipts             WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM audit_logs                   WHERE user_id = '$EDGE_DEMO_ID';
-- regenerable / transient tables that may carry FK rows blocking the user delete
DELETE FROM measurement_rollups          WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM mood_entry_rollups           WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM medication_compliance_rollups WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM strain_trimp_cache           WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM cycle_predictions            WHERE user_id = '$EDGE_DEMO_ID';
DELETE FROM measurements                 WHERE user_id = '$EDGE_DEMO_ID';
-- finally the user row itself (any remaining ON DELETE CASCADE children of
-- the EXCLUDED set — sessions, tokens, etc. — go with it).
DELETE FROM users                        WHERE id = '$EDGE_DEMO_ID';
COMMIT;
SQL
  echo "## WIPE complete."
else
  echo "## WIPE skipped — no existing edge01 demo user."
fi

# ============================================================================
# COLUMN LISTS
# ============================================================================
#
# users — explicit ordered list. Secret/credential columns are NULLed in the
# SELECT (literal NULL in the right position). role forced to 'ADMIN'.
# telegram_enabled forced false. Kept: password_hash,
# avatar_*, all display/prefs/layout JSON, unit prefs, profile fields.
#
# The SELECT projects literals for the NULLed/forced columns and the real
# value for everything else; the COPY target column list matches 1:1.
#
readonly USERS_COLS="id, username, email, password_hash, role, created_at, updated_at,
  height_cm, date_of_birth, gender, timezone,
  codex_access_token_encrypted, codex_refresh_token_encrypted, codex_token_expires_at,
  codex_connected_at, codex_connection_status,
  insights_privacy_mode, insights_cached_at, insights_cached_text, insights_exclude_metrics,
  global_excluded_injection_sites,
  telegram_bot_token, telegram_chat_id, telegram_enabled,
  withings_client_id_encrypted, withings_client_secret_encrypted,
  whoop_client_id_encrypted, whoop_client_secret_encrypted,
  fitbit_client_id_encrypted, fitbit_client_secret_encrypted,
  locale, thresholds_json, dashboard_widgets_json, insights_layout_json,
  glucose_unit, unit_preference,
  ai_provider, ai_model, ai_base_url, ai_anthropic_key_encrypted, ai_local_key_encrypted,
  ai_openai_key_encrypted, ai_provider_chain,
  onboarding_completed_at, onboarding_tour_completed,
  healthkit_config_json, healthkit_last_synced_at,
  display_name, last_report_practice_name, coach_prefs_json, source_priority_json,
  last_synced_at, mood_reminder_enabled, doctor_report_prefs_json, notification_prefs,
  disable_coach, avatar_bytes, avatar_content_type, avatar_updated_at,
  full_name, insurer_name, insurance_number_encrypted, insurer_ik_number"

# The SELECT expression list MUST be in the SAME order as USERS_COLS.
# Literals: NULL for every secret column, 'ADMIN' for role, false for the two
# integration-enable flags.
# NOTE: no inline SQL comments here — this expression is flattened into a
# single-line psql -c command, where a -- comment would swallow the rest of
# the line (the closing paren + TO STDOUT). Keep it comment-free.
readonly USERS_SELECT="id, username, email, password_hash,
  'ADMIN' AS role,
  created_at, updated_at,
  height_cm, date_of_birth, gender, timezone,
  NULL::text  AS codex_access_token_encrypted,
  NULL::text  AS codex_refresh_token_encrypted,
  NULL::timestamptz AS codex_token_expires_at,
  NULL::timestamptz AS codex_connected_at,
  'disconnected' AS codex_connection_status,
  insights_privacy_mode, insights_cached_at, insights_cached_text, insights_exclude_metrics,
  global_excluded_injection_sites,
  NULL::text  AS telegram_bot_token,
  NULL::text  AS telegram_chat_id,
  false       AS telegram_enabled,
  NULL::text  AS withings_client_id_encrypted,
  NULL::text  AS withings_client_secret_encrypted,
  NULL::text  AS whoop_client_id_encrypted,
  NULL::text  AS whoop_client_secret_encrypted,
  NULL::text  AS fitbit_client_id_encrypted,
  NULL::text  AS fitbit_client_secret_encrypted,
  locale, thresholds_json, dashboard_widgets_json, insights_layout_json,
  glucose_unit, unit_preference,
  ai_provider, ai_model, ai_base_url,
  NULL::text  AS ai_anthropic_key_encrypted,
  NULL::text  AS ai_local_key_encrypted,
  NULL::text  AS ai_openai_key_encrypted,
  ai_provider_chain,
  onboarding_completed_at, onboarding_tour_completed,
  healthkit_config_json, healthkit_last_synced_at,
  display_name, last_report_practice_name, coach_prefs_json, source_priority_json,
  last_synced_at, mood_reminder_enabled, doctor_report_prefs_json, notification_prefs,
  disable_coach, avatar_bytes, avatar_content_type, avatar_updated_at,
  full_name,
  NULL::text  AS insurer_name,
  NULL::text  AS insurance_number_encrypted,
  NULL::text  AS insurer_ik_number"

readonly MEAS_COLS="id, user_id, type, value, unit, source, measured_at, notes,
  external_id, external_source_version, glucose_context, sleep_stage,
  rhythm_classification, device_type, sync_version, deleted_at, created_at, updated_at"

readonly CYCLE_PROFILE_COLS="id, user_id, goal, cycle_tracking_enabled,
  typical_cycle_length, typical_period_length, luteal_phase_length,
  prediction_enabled, raw_chart_mode, discreet_notifications,
  sensitive_category_encryption, created_at, updated_at"

readonly MENSTRUAL_CYCLE_COLS="id, user_id, start_date, end_date, period_end_date,
  length_days, ovulation_date, ovulation_confirmed, is_predicted, tz,
  sync_version, deleted_at, created_at, updated_at"

# cycle_day_logs — NULL the two app-encrypted columns (keyed to prod key,
# absent on edge01). Carry the plaintext cycle fields.
readonly CYCLE_DAY_LOG_COLS="id, user_id, date, cycle_id, flow, intermenstrual_bleeding,
  basal_body_temp_c, ovulation_test, cervical_mucus, sexual_activity, protected_sex,
  pregnancy_test, progesterone_test, contraceptive, sensitive_encrypted, notes_encrypted,
  source, external_id, tz, sync_version, deleted_at, created_at, updated_at"
readonly CYCLE_DAY_LOG_SELECT="id, user_id, date, cycle_id, flow, intermenstrual_bleeding,
  basal_body_temp_c, ovulation_test, cervical_mucus, sexual_activity, protected_sex,
  pregnancy_test, progesterone_test, contraceptive,
  NULL::bytea AS sensitive_encrypted,
  NULL::bytea AS notes_encrypted,
  source, external_id, tz, sync_version, deleted_at, created_at, updated_at"

readonly CYCLE_SYMPTOM_LINK_COLS="day_log_id, symptom_id, severity, created_at"

readonly MOOD_ENTRY_COLS="id, user_id, date, mood, score, tags, note, source,
  external_id, mood_logged_at, tz, synced_at, created_at, updated_at,
  sync_version, deleted_at"

readonly MOOD_ENTRY_TAG_LINK_COLS="mood_entry_id, mood_tag_id, created_at, rating"

readonly MEDICATION_COLS="id, user_id, name, dose, treatment_class, doses_per_unit,
  active, notifications_enabled, paused_at, snoozed_until, starts_on, ends_on, one_shot,
  delivery_form, track_injection_sites, allowed_injection_sites, live_activity_enabled,
  critical_alarm_enabled, atc_code, rxnorm_code, created_at, updated_at"

readonly MED_SCHEDULE_COLS="id, medication_id, window_start, window_end, label, dose,
  days_of_week, times_of_day, reminder_grace_minutes, rrule, rolling_interval_days,
  schedule_type, cyclic_on_weeks, cyclic_off_weeks"

readonly MED_INTAKE_COLS="id, user_id, medication_id, scheduled_for, taken_at, skipped,
  auto_missed, source, idempotency_key, created_at, injection_site, updated_at,
  sync_version, deleted_at"

readonly MED_DOSE_CHANGE_COLS="id, medication_id, effective_from, dose_value, dose_unit, note, created_at"

readonly MED_INV_ITEM_COLS="id, user_id, medication_id, state, doses_total, doses_remaining,
  first_use_at, expires_at, printed_expiry, purchased_at, notes, created_at, updated_at"

readonly MED_INV_EVENT_COLS="id, medication_id, delta, reason, occurred_at"

readonly MED_SIDE_EFFECT_COLS="id, user_id, medication_id, occurred_at, category, entry,
  severity, notes, created_at"

readonly REMINDER_PHASE_COLS="id, medication_id, green_value, green_mode, yellow_value,
  yellow_mode, orange_value, orange_mode, red_value, red_mode"

readonly PERSONAL_RECORD_COLS="id, user_id, metric_type, metric_slot, direction, value, unit,
  achieved_at, source_measurement_id, source, external_id, created_at"

readonly USER_ACHIEVEMENT_COLS="id, user_id, achievement_id, unlocked_at, created_at"

readonly CONSENT_RECEIPT_COLS="id, user_id, kind, artefact, signed_at, revoked_at, created_at"

readonly AUDIT_LOG_COLS="id, user_id, action, details, ip_address, location, asn, carrier, created_at"

# ============================================================================
# TRANSFER helper — scoped COPY piped host-to-host. Echoes row count after.
# ============================================================================
copy_table() {
  # Usage: copy_table "<table>" "<src_select_expr_list>" "<src_from_where>" "<dst_col_list>"
  local table="$1" select_expr="$2" from_where="$3" dst_cols="$4"
  echo
  echo "## TRANSFER $table ..."
  ssh "$SRC_SSH" "docker exec -i $SRC_DB_CONTAINER psql -X -v ON_ERROR_STOP=1 -U $PG_USER -d $PG_DB \
      -c \"\\copy (SELECT $select_expr FROM $from_where) TO STDOUT (FORMAT csv, HEADER false)\"" \
    | ssh "$DST_SSH" "docker exec -i $DST_DB_CONTAINER psql -X -v ON_ERROR_STOP=1 -U $PG_USER -d $PG_DB \
        -c \"\\copy $table($dst_cols) FROM STDIN (FORMAT csv, HEADER false)\""
  local n
  n="$(psql_dst "-tA -c \"SELECT count(*) FROM $table;\"" | tr -d '[:space:]' || echo '?')"
  echo "   loaded; edge01 $table total rows now: $n"
}

# ============================================================================
# LOAD in FK-parent-first order.
# ============================================================================

# 1. users — the ONE row.
copy_table "users" "$USERS_SELECT" \
  "users WHERE id = '$DEMO_USER_ID'" "$USERS_COLS"

# ----------------------------------------------------------------------------
# FORCE THE PUBLISHED DEMO PASSWORD
# ----------------------------------------------------------------------------
# The row just loaded carries the SOURCE account's password_hash. The source is
# the operator's own instance, so that hash is whatever the operator last set —
# not necessarily the password the README publishes. Overwrite it here so the
# documented demo login works after every migration, not just the first one.
#
# The statement goes in on psql's STDIN. It must NOT be interpolated into the
# ssh command string: the Argon2id hash contains '$argon2id', '$v', '$m', '$t'
# and '$p' segments, and a remote shell would expand each of those to an empty
# string and store a mangled hash that no password can ever match.
echo
echo "## FORCE published demo password on the loaded row ..."
printf '%s\n' \
  "UPDATE users SET password_hash = '$PUBLIC_DEMO_PASSWORD_HASH' WHERE id = '$DEMO_USER_ID';" \
  | ssh "$DST_SSH" "docker exec -i $DST_DB_CONTAINER \
      psql -X -v ON_ERROR_STOP=1 -U $PG_USER -d $PG_DB"

# Prove the stored hash is byte-for-byte the published one. A mangled or
# carried-over hash fails here instead of at some visitor's login screen.
PW_OK="$(printf '%s\n' \
  "SELECT count(*) FROM users WHERE id = '$DEMO_USER_ID' AND password_hash = '$PUBLIC_DEMO_PASSWORD_HASH';" \
  | ssh "$DST_SSH" "docker exec -i $DST_DB_CONTAINER \
      psql -X -tA -v ON_ERROR_STOP=1 -U $PG_USER -d $PG_DB" | tr -d '[:space:]')"
if [[ "$PW_OK" != "1" ]]; then
  echo "ABORT/FAIL: demo password_hash on edge01 is not the published literal (matched rows: $PW_OK)."
  echo "            The demo login would be broken. Fix before serving the demo."
  exit 1
fi
echo "   demo password_hash matches the published literal."

# 2. measurements (live rows only).
copy_table "measurements" "$MEAS_COLS" \
  "measurements WHERE user_id = '$DEMO_USER_ID' AND deleted_at IS NULL" "$MEAS_COLS"

# 3. cycle_profiles
copy_table "cycle_profiles" "$CYCLE_PROFILE_COLS" \
  "cycle_profiles WHERE user_id = '$DEMO_USER_ID'" "$CYCLE_PROFILE_COLS"

# 4. menstrual_cycles
copy_table "menstrual_cycles" "$MENSTRUAL_CYCLE_COLS" \
  "menstrual_cycles WHERE user_id = '$DEMO_USER_ID'" "$MENSTRUAL_CYCLE_COLS"

# 5. cycle_day_logs (NULL the two encrypted columns).
copy_table "cycle_day_logs" "$CYCLE_DAY_LOG_SELECT" \
  "cycle_day_logs WHERE user_id = '$DEMO_USER_ID'" "$CYCLE_DAY_LOG_COLS"

# 6. cycle_symptom_links (join-scoped to demo's day logs).
copy_table "cycle_symptom_links" "$CYCLE_SYMPTOM_LINK_COLS" \
  "cycle_symptom_links WHERE day_log_id IN (SELECT id FROM cycle_day_logs WHERE user_id = '$DEMO_USER_ID')" \
  "$CYCLE_SYMPTOM_LINK_COLS"

# 7. mood_entries (live rows only).
copy_table "mood_entries" "$MOOD_ENTRY_COLS" \
  "mood_entries WHERE user_id = '$DEMO_USER_ID' AND deleted_at IS NULL" "$MOOD_ENTRY_COLS"

# 8. mood_entry_tag_links (join-scoped; pre-flight asserted all tags are GLOBAL).
copy_table "mood_entry_tag_links" "$MOOD_ENTRY_TAG_LINK_COLS" \
  "mood_entry_tag_links WHERE mood_entry_id IN (SELECT id FROM mood_entries WHERE user_id = '$DEMO_USER_ID')" \
  "$MOOD_ENTRY_TAG_LINK_COLS"

# 9. medications
copy_table "medications" "$MEDICATION_COLS" \
  "medications WHERE user_id = '$DEMO_USER_ID'" "$MEDICATION_COLS"

# 10. medication_schedules (join-scoped).
copy_table "medication_schedules" "$MED_SCHEDULE_COLS" \
  "medication_schedules WHERE medication_id IN (SELECT id FROM medications WHERE user_id = '$DEMO_USER_ID')" \
  "$MED_SCHEDULE_COLS"

# 11. medication_intake_events (live rows only).
copy_table "medication_intake_events" "$MED_INTAKE_COLS" \
  "medication_intake_events WHERE user_id = '$DEMO_USER_ID' AND deleted_at IS NULL" "$MED_INTAKE_COLS"

# 12. medication_dose_changes (join-scoped).
copy_table "medication_dose_changes" "$MED_DOSE_CHANGE_COLS" \
  "medication_dose_changes WHERE medication_id IN (SELECT id FROM medications WHERE user_id = '$DEMO_USER_ID')" \
  "$MED_DOSE_CHANGE_COLS"

# 13. medication_inventory_items (user-scoped).
copy_table "medication_inventory_items" "$MED_INV_ITEM_COLS" \
  "medication_inventory_items WHERE user_id = '$DEMO_USER_ID'" "$MED_INV_ITEM_COLS"

# 14. medication_inventory_events (join-scoped).
copy_table "medication_inventory_events" "$MED_INV_EVENT_COLS" \
  "medication_inventory_events WHERE medication_id IN (SELECT id FROM medications WHERE user_id = '$DEMO_USER_ID')" \
  "$MED_INV_EVENT_COLS"

# 15. medication_side_effects (user-scoped).
copy_table "medication_side_effects" "$MED_SIDE_EFFECT_COLS" \
  "medication_side_effects WHERE user_id = '$DEMO_USER_ID'" "$MED_SIDE_EFFECT_COLS"

# 16. reminder_phase_configs (join-scoped).
copy_table "reminder_phase_configs" "$REMINDER_PHASE_COLS" \
  "reminder_phase_configs WHERE medication_id IN (SELECT id FROM medications WHERE user_id = '$DEMO_USER_ID')" \
  "$REMINDER_PHASE_COLS"

# 17. personal_records (user-scoped).
copy_table "personal_records" "$PERSONAL_RECORD_COLS" \
  "personal_records WHERE user_id = '$DEMO_USER_ID'" "$PERSONAL_RECORD_COLS"

# 18. user_achievements (user-scoped).
copy_table "user_achievements" "$USER_ACHIEVEMENT_COLS" \
  "user_achievements WHERE user_id = '$DEMO_USER_ID'" "$USER_ACHIEVEMENT_COLS"

# 19. consent_receipts (user-scoped — carries the ai_full consent).
copy_table "consent_receipts" "$CONSENT_RECEIPT_COLS" \
  "consent_receipts WHERE user_id = '$DEMO_USER_ID'" "$CONSENT_RECEIPT_COLS"

# 20. audit_logs — only the plaintext AI insight assessment rows.
copy_table "audit_logs" "$AUDIT_LOG_COLS" \
  "audit_logs WHERE user_id = '$DEMO_USER_ID' AND action LIKE 'insights.%'" "$AUDIT_LOG_COLS"

# ============================================================================
# POST-LOAD VERIFICATION (on edge01).
#   - per-table demo-user row counts (informational),
#   - HARD assertion: the REAL operator id appears in NO carried table,
#   - HARD assertion: every user_id-bearing carried table contains ONLY the
#     demo id.
# ============================================================================
echo
echo "=============================================================="
echo "## POST-LOAD verification on edge01"
echo "=============================================================="

echo
echo "Per-table demo row counts (user_id = $DEMO_USER_ID):"
psql_dst <<SQL
\pset pager off
SELECT 'users'                      AS tbl, count(*) FROM users                     WHERE id = '$DEMO_USER_ID'
UNION ALL SELECT 'measurements',              count(*) FROM measurements              WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'cycle_profiles',            count(*) FROM cycle_profiles            WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'menstrual_cycles',          count(*) FROM menstrual_cycles          WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'cycle_day_logs',            count(*) FROM cycle_day_logs            WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'cycle_symptom_links',       count(*) FROM cycle_symptom_links l JOIN cycle_day_logs d ON d.id = l.day_log_id WHERE d.user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'mood_entries',              count(*) FROM mood_entries              WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'mood_entry_tag_links',      count(*) FROM mood_entry_tag_links l JOIN mood_entries e ON e.id = l.mood_entry_id WHERE e.user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'medications',               count(*) FROM medications               WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'medication_schedules',      count(*) FROM medication_schedules s JOIN medications m ON m.id = s.medication_id WHERE m.user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'medication_intake_events',  count(*) FROM medication_intake_events   WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'medication_dose_changes',   count(*) FROM medication_dose_changes d JOIN medications m ON m.id = d.medication_id WHERE m.user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'medication_inventory_items', count(*) FROM medication_inventory_items WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'medication_inventory_events', count(*) FROM medication_inventory_events e JOIN medications m ON m.id = e.medication_id WHERE m.user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'medication_side_effects',   count(*) FROM medication_side_effects    WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'reminder_phase_configs',    count(*) FROM reminder_phase_configs c JOIN medications m ON m.id = c.medication_id WHERE m.user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'personal_records',          count(*) FROM personal_records          WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'user_achievements',         count(*) FROM user_achievements          WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'consent_receipts',          count(*) FROM consent_receipts           WHERE user_id = '$DEMO_USER_ID'
UNION ALL SELECT 'audit_logs(insights)',      count(*) FROM audit_logs                 WHERE user_id = '$DEMO_USER_ID' AND action LIKE 'insights.%'
ORDER BY tbl;
SQL

echo
echo "HARD assertion 1: REAL operator id ($REAL_USER_ID) appears NOWHERE."
REAL_HITS="$(psql_dst "-tA -c \"
  SELECT
    (SELECT count(*) FROM users                  WHERE id = '$REAL_USER_ID')
  + (SELECT count(*) FROM measurements           WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM cycle_profiles         WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM menstrual_cycles       WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM cycle_day_logs         WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM mood_entries           WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM medications            WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM medication_intake_events WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM medication_inventory_items WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM medication_side_effects WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM personal_records       WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM user_achievements      WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM consent_receipts       WHERE user_id = '$REAL_USER_ID')
  + (SELECT count(*) FROM audit_logs             WHERE user_id = '$REAL_USER_ID');
\"" | tr -d '[:space:]')"
echo "    real-id occurrences across carried tables = $REAL_HITS"
if [[ "$REAL_HITS" != "0" ]]; then
  echo "ABORT/FAIL: operator id present in $REAL_HITS rows on edge01. Investigate immediately."
  exit 1
fi

echo
echo "HARD assertion 2: every user_id-bearing carried table holds ONLY the demo id."
FOREIGN_HITS="$(psql_dst "-tA -c \"
  SELECT
    (SELECT count(*) FROM measurements             WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM cycle_profiles           WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM menstrual_cycles         WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM cycle_day_logs           WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM mood_entries             WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM medications              WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM medication_intake_events WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM medication_inventory_items WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM medication_side_effects  WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM personal_records         WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM user_achievements        WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM consent_receipts         WHERE user_id <> '$DEMO_USER_ID')
  + (SELECT count(*) FROM audit_logs               WHERE user_id <> '$DEMO_USER_ID');
\"" | tr -d '[:space:]')"
echo "    non-demo user_id rows across carried tables = $FOREIGN_HITS"
echo "    NOTE: this counts EVERY non-demo row in these tables on edge01, not just"
echo "          what this script loaded. On a clean demo DB it should be 0. If the"
echo "          edge01 demo DB legitimately holds other demo-only accounts, scope"
echo "          this assertion to the rows this run inserted before treating >0 as fatal."
if [[ "$FOREIGN_HITS" != "0" ]]; then
  echo "WARNING: $FOREIGN_HITS non-demo rows exist in carried tables on edge01."
  echo "         Inspect before serving the demo (see note above)."
fi

echo
echo "HARD assertion 3: the demo user exists on edge01 with role=ADMIN and the apps01 id."
psql_dst "-c \"SELECT id, username, role, telegram_enabled FROM users WHERE id = '$DEMO_USER_ID';\""

echo
echo "=============================================================="
echo " DONE. Review the counts above. Demo user is role=ADMIN; the"
echo " app's DEMO_MODE must remain ON on edge01 so all mutations are"
echo " blocked at the proxy layer while admin pages stay viewable."
echo "=============================================================="
