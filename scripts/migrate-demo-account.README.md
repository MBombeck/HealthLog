# migrate-demo-account.sh

Copies **exactly one** user, the demo account named by `DEMO_USER_ID`, from a
source instance's Postgres to the **separate** Postgres of a demo instance. No
other user's rows are transferred under any circumstance.

> Review the script first, then run it deliberately. It performs destructive,
> demo-scoped deletes on the target demo DB, then loads the demo slice from the
> source. It never writes to the source (read-only).

## How it connects

Everything instance-specific comes from the environment:

- `DEMO_USER_ID`: the user id to copy. `PROTECT_USER_ID`: an id that must
  never appear on the target (the operator's own account).
- `SRC_SSH` and `SRC_DB_CONTAINER_PATTERN`: the source host's ssh alias and a
  `grep -E` pattern for its database container; psql `healthlog`/`healthlog`.
- `DST_SSH`: the target host's ssh alias. The demo Postgres container is
  **not hardcoded**: the script resolves it at runtime via
  `docker ps | grep -iE 'postgres|^db-'` and aborts if it cannot pick a single
  match (override with `DST_DB_CONTAINER=db-xxxx`). Match the demo app's own
  Postgres, not a docs or landing-page database on the same host.
- **The target demo user id is resolved at runtime** by `username='demo'` (it
  may differ from the source id). The wipe phase is scoped to that resolved id;
  the load then brings the source row in, so afterwards the target demo user
  carries the source's canonical id.

Each table is transferred with a scoped, server-side `\copy ... TO STDOUT`
piped host-to-host into `\copy ... FROM STDIN`, using **explicit column lists
on both ends** so secret columns can be NULLed and column order is pinned.

## What moves (FK-parent-first, 20 tables)

| #   | Table                         | Scope predicate                                                                   |
| --- | ----------------------------- | --------------------------------------------------------------------------------- |
| 1   | `users`                       | `id = demo` (the one row; secrets NULLed, `role='ADMIN'`)                         |
| 2   | `measurements`                | `user_id = demo AND deleted_at IS NULL` (incl. RECOVERY/STRAIN/STRESS_SCORE rows) |
| 3   | `cycle_profiles`              | `user_id = demo`                                                                  |
| 4   | `menstrual_cycles`            | `user_id = demo`                                                                  |
| 5   | `cycle_day_logs`              | `user_id = demo` (encrypted cols NULLed)                                          |
| 6   | `cycle_symptom_links`         | `day_log_id IN (demo's day logs)`                                                 |
| 7   | `mood_entries`                | `user_id = demo AND deleted_at IS NULL`                                           |
| 8   | `mood_entry_tag_links`        | `mood_entry_id IN (demo's entries)` — global tags only                            |
| 9   | `medications`                 | `user_id = demo`                                                                  |
| 10  | `medication_schedules`        | `medication_id IN (demo's meds)`                                                  |
| 11  | `medication_intake_events`    | `user_id = demo AND deleted_at IS NULL`                                           |
| 12  | `medication_dose_changes`     | `medication_id IN (demo's meds)`                                                  |
| 13  | `medication_inventory_items`  | `user_id = demo`                                                                  |
| 14  | `medication_inventory_events` | `medication_id IN (demo's meds)`                                                  |
| 15  | `medication_side_effects`     | `user_id = demo`                                                                  |
| 16  | `reminder_phase_configs`      | `medication_id IN (demo's meds)`                                                  |
| 17  | `personal_records`            | `user_id = demo`                                                                  |
| 18  | `user_achievements`           | `user_id = demo`                                                                  |
| 19  | `consent_receipts`            | `user_id = demo` (carries the `ai_full` consent)                                  |
| 20  | `audit_logs`                  | `user_id = demo AND action LIKE 'insights.%'` (plaintext AI assessments)          |

## Secret / credential columns NULLed on the `users` row

`codex_access_token_encrypted`, `codex_refresh_token_encrypted`,
`codex_token_expires_at`, `codex_connected_at` (and `codex_connection_status`
reset to `'disconnected'`), `ai_anthropic_key_encrypted`,
`ai_local_key_encrypted`, `ai_openai_key_encrypted`,
`withings_client_id_encrypted`, `withings_client_secret_encrypted`,
`whoop_client_id_encrypted`, `whoop_client_secret_encrypted`,
`fitbit_client_id_encrypted`, `fitbit_client_secret_encrypted`,
`telegram_bot_token`, `telegram_chat_id`,
`insurance_number_encrypted`, `insurer_name`, `insurer_ik_number`.

Forced flags: `telegram_enabled=false`,
`role='ADMIN'`.

**Overwritten:** `password_hash`. The row arrives carrying the source
account's hash, and the load is immediately followed by an `UPDATE` that sets
the Argon2id hash of the demo password the README publishes, then asserts the
stored value matches it byte for byte and aborts if it does not. The source is
the operator's own instance, so its demo password can be rotated at any time;
carrying that hash across is what silently broke the advertised demo login in
issue #805. The statement travels on psql's stdin, never inside the ssh command
string, because the hash contains `$argon2id` / `$v` / `$m` / `$t` / `$p`
segments that a remote shell would expand to nothing.

**Kept:** `avatar_bytes` /
`avatar_content_type` / `avatar_updated_at` (profile photo), and all
display / preference / layout JSON (`thresholds_json`,
`dashboard_widgets_json`, `insights_layout_json`, `coach_prefs_json`,
`source_priority_json`, `doctor_report_prefs_json`, `notification_prefs`,
`healthkit_config_json`, unit prefs, `height_cm`, `gender`, `timezone`,
`locale`, `date_of_birth`, `display_name`, onboarding state, research-mode
acknowledgement).

## What is excluded — and why

- **Auth / device / push** (sessions, passkeys, auth_challenges, api_tokens,
  refresh_tokens, devices, push_subscriptions, push_attempts,
  notification_channels, notification_preferences) — per-environment, never
  portable.
- **Integration / OAuth** (withings/whoop/fitbit connections, all
  `*_oauth_states` / `*_connect_tickets`, telegram scheduled-deletions +
  reminder messages, clinician_share_links, provider_health) — tied to live
  credentials.
- **Encrypted-at-rest payloads the target cannot decrypt:**
  `insight_narratives` and all `coach_*` (coach_conversations, coach_messages,
  coach_facts, coach_usage). The target does not hold the source's
  encryption key, so the AES-256-GCM ciphertext would be unreadable. The same
  reason drives NULLing `cycle_day_logs.sensitive_encrypted` /
  `notes_encrypted` while still carrying that table's plaintext cycle fields.
  The plaintext AI assessment text is preserved through the `insights.%`
  `audit_logs` rows (the text lives in the `details` JSON) instead.
- **Transient / regenerable:** idempotency_keys, rate_limits, data_backups,
  import_jobs, host_metrics, feedback, recommendation_feedback, and all rollup
  tables (measurement_rollups, mood_entry_rollups, strain_trimp_cache,
  cycle_predictions) — these
  rebuild on the target.
- **No rows:** workouts / workout_routes / workout_samples (demo has none).
- **Instance / global:** app_settings; global catalogues (mood_tags,
  cycle_symptoms) pre-exist on the target and the carried link rows
  reference the global ids only.

## Encryption note

The demo instance is assumed **not** to share the source's encryption key.
Every column whose value is AES-256-GCM ciphertext under the source key is
either NULLed (secrets on `users`, `cycle_day_logs.*_encrypted`) or skipped
entirely (`insight_narratives`, `coach_messages.encryptedContent`). Carrying
that ciphertext would produce undecryptable rows that the app's fail-closed
loader would reject.

## role = ADMIN + DEMO_MODE expectations

The demo user is loaded with `role='ADMIN'` so the admin surfaces are
viewable in the demo. This is **only safe because DEMO_MODE must stay ON** on
the target: the proxy layer (`src/proxy.ts`) blocks every mutating request in
demo mode, so an admin demo session can browse admin pages but cannot change
anything. If DEMO_MODE were ever off on the target, this admin demo account would
be a write-capable admin. Keep DEMO_MODE enabled.

## Safety mechanisms built into the script

- `set -euo pipefail` and `ON_ERROR_STOP=1` on every psql call.
- **Pre-flight guard (source):** for each carried set, a query that must
  return `0` foreign-owned rows — aborts on any non-zero. Includes a check
  that the demo owns **0 custom mood_tags** (so every carried
  `mood_entry_tag_link` points at a global tag that pre-exists on the target) plus
  a defensive "non-global tag" link count.
- **Scoped wipe-first (target):** FK-child-first deletes, every one scoped to
  the runtime-resolved target demo id. No unscoped delete anywhere. Refuses to
  proceed if `username='demo'` on the target resolves to the operator id.
- **Post-load verification (target):** per-table demo row counts; a hard
  assertion that `PROTECT_USER_ID` appears in zero rows; a check that user_id-bearing carried tables hold only the demo id; and
  a confirmation the demo user exists with `role=ADMIN`.

## Caveats / things to confirm before running

- **`FOREIGN_HITS` assertion** counts _all_ non-demo rows in the carried
  tables on the target, not just what this run inserted. On a clean
  single-demo-user DB it is `0`. If the target legitimately hosts other demo-only
  accounts, treat a non-zero value as a warning to inspect, not an automatic
  failure (the script prints it as a WARNING, not an abort).
- Confirm the target's psql credentials are `healthlog`/`healthlog` (the script
  verifies connectivity before any write; adjust `PG_USER` / `PG_DB` if the
  demo Postgres resource uses different ones).
- The script assumes the target's schema is at the same (or a compatible)
  Prisma migration level as the source. A column present on the source but
  missing on the target fails the `\copy` loudly rather than silently
  corrupting data; run migrations on the target first if the two have drifted.
