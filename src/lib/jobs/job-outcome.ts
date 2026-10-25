/**
 * The value a background-job handler returns to say what it did.
 *
 * Before this type existed, a pg-boss handler signalled success by falling
 * off the end of a function. Every one of the queue bindings in this tree
 * resolved to `undefined`, and none of them was read anywhere, so a handler
 * that caught an error, logged a warning and returned was indistinguishable
 * from one that finished its work. pg-boss marked both `completed`; the
 * operator surfaces that read `pgboss.job` saw nothing; the nightly pass
 * looked healthy for as long as it kept failing.
 *
 * A returned `JobOutcome` closes that specific gap: completion is now
 * derived from a value the handler had to construct, and `runJob` turns
 * `ok: false` into a failed pg-boss job. What the type CANNOT do is make a
 * handler honest — `jobDone()` after swallowing an exception compiles and
 * passes every check in this repository. It converts omission (forgetting to
 * signal a failure) into commission (claiming a success that did not
 * happen), which is a smaller and much more reviewable class of defect.
 *
 * A fan-out pass is judged on the pass, not on its legs. A nightly sweep
 * over every connected account is `ok: true` when the sweep ran, even if one
 * account's grant was revoked: that belongs on the account's own integration
 * ledger, and failing the queue would retry the whole cohort over one user's
 * expired token. The per-leg failures ride out as a count in `did`, which is
 * what makes them visible at all — today they are visible nowhere.
 *
 * `did` is the small pinned-shape bag of facts about the run — counts,
 * stable codes, booleans. It rides into the failure report and, once the
 * failure ledger lands, into the operator surface. Keep it to scalars that
 * a dashboard can key on; it is not a place for payload data or free text.
 */

/** A single fact about a run. Scalars only — never payload data. */
export type JobFact = string | number | boolean;

/** The pinned-shape bag of facts a handler reports about its run. */
export type JobFacts = Readonly<Record<string, JobFact>>;

/**
 * Facts cross a persistence/observability boundary. Keep their vocabulary
 * explicit so a caller cannot attach an identifier, credential, URL,
 * free-form error, or health value to a durable job result.
 */
export const JOB_FACT_ALLOWLIST: ReadonlySet<string> = new Set([
  "access_tokens_deleted",
  // The account-deletion purge: accounts whose grace window ended and
  // were erased, ones whose erasure was refused and stays pending, and the
  // copies taken before a data wipe that aged out with their window.
  "account_deletions_due",
  "account_deletions_purged",
  "account_deletions_refused",
  "accounts_completed",
  // v1.40 — the document AI run reaper's three outcomes.
  "ai_runs_deleted",
  "ai_runs_timed_out",
  "ai_runs_worker_unavailable",
  // v1.42 — every candidate a fan-out pass attempted failed (`reportJobRun`).
  "all_failed",
  // An admission delivery that found its import still running from an
  // earlier delivery of the same job and did nothing.
  "already_running",
  "appointment_addresses_cleared",
  "assessments_warmed",
  "auto_resolved",
  "backed",
  // The nightly measurements check: heap size over what the live rows need,
  // in percent (130 is a heap 1.3 times the size its live rows need).
  "bloat_percent",
  "buckets_collapsed",
  "buckets_recomputed",
  "budget_blocked",
  "cached",
  // The daily Withings OAuth-state cleanup also sweeps the callback claims.
  "callback_claims_deleted",
  "candidates_scanned",
  // The nightly sign-in ledger cleanup (`auth-ledger-cleanup`).
  "challenges_deleted",
  "connect_tickets_deleted",
  "connections_deleted",
  "considered",
  "contact_audit_rows_scrubbed",
  "context_surfaced",
  "continuation",
  "continued",
  "conversation_titles_migrated",
  "created",
  // The nightly whole-database dump: where it went and how big.
  "database_backup_bytes",
  "database_backup_local",
  "database_backup_offhost",
  "database_backup_removed",
  "database_backup_status",
  "daily_rows_retired",
  "days_consolidated",
  "days_rebuilt",
  "days_recomputed",
  "days_skipped",
  "days_skipped_no_tombstones",
  "days_stored",
  "dead_rows",
  // Tombstone purge: accounts left for the next run because a restore of
  // the account was running.
  "deferred_accounts",
  "deleted",
  "dense_days_consolidated",
  "dense_rows_soft_deleted",
  "dense_skipped",
  "derived_resting_rows_upserted",
  "discovery_enqueued",
  "discovery_failed",
  "discovery_skipped",
  "dispatched",
  "dispatched_period_confirm",
  "dispatched_period_soon",
  "document_purge_deleted",
  "documents",
  "documents_failed",
  "documents_indexed",
  // v1.37.20 — rows re-tokenised because their stored tokenizerVersion
  // trailed the current one (the content-index migration sweep).
  "documents_retokenised",
  "documents_skipped",
  "dose_changes_migrated",
  "downstream_failed",
  "drained",
  "duration_ms",
  "errored",
  "failed",
  "failures",
  "feedback_buckets",
  "feedback_total_rows",
  "feedback_window_days",
  "fetches",
  "finalised",
  "finalized",
  // v1.42.4 — integration watchdog: the pass found no watch row (first run).
  "first_run",
  "forced",
  "generated",
  "geo_backfill_carrier_resolved",
  "geo_backfill_located",
  "geo_backfill_scanned",
  "geo_backfill_skipped",
  "geo_backfill_still_unresolved",
  "geolite2_fetch_status",
  "host_metric_pruned",
  "hourly_rows_upserted",
  "import_staging_swept",
  "imported",
  // v1.42.4 — integration watchdog: operator incidents opened / closed.
  "incidents_closed",
  "incidents_opened",
  "in_slot",
  "in_window",
  "insufficient",
  "intake_auto_skip_count",
  "intake_auto_take_medications",
  "intake_auto_take_recorded",
  "intakes_pruned",
  "inventory_expired_count",
  "inventory_items_migrated",
  "jobs",
  // Heavy jobs that found the lane taken and went back to their queue.
  "lane_deferred",
  "legacy_rows_soft_deleted",
  "linked",
  "malformed",
  "manual_mints_removed",
  "markers",
  "mean_days_consolidated",
  // v1.42 — the one-time fold repair: windows whose stored mean was compared
  // with the mean over every sample, and those it corrected. Counts only.
  "means_checked",
  "means_corrected",
  // Windows it left as stored because a tombstone in them may be a person's
  // deletion, windows before the horizon it left as stored, and live samples
  // it took into a checked mean.
  "means_left_ambiguous",
  "means_samples_absorbed",
  "means_skipped_beyond_horizon",
  "mean_rows_soft_deleted",
  "measurements_imported",
  "measurements_migrated",
  "measurements_pruned",
  "medications",
  "medications_evaluated",
  "metric_assessments_warmed",
  "metric_notes_migrated",
  "missed_doses_minted",
  "module_off",
  "mood_entries_migrated",
  "mood_pruned",
  // v1.37.19 — ignored Coach reminders auto-dismissed at the nag cap.
  "nag_dismissed",
  "notifications_dispatched",
  "notifications_failed",
  "notified",
  "offhost_backup_already_uploaded",
  "offhost_backup_configured",
  "offhost_backup_failed",
  "offhost_backup_oversized",
  "offhost_backup_total_users",
  "offhost_backup_uploaded",
  "offhost_purge_awaiting_run",
  "offhost_purge_completed",
  "offhost_purge_failed",
  "offhost_purge_objects_deleted",
  "offhost_purge_pending",
  "outcome",
  "passes_failed",
  "per_sample_rows_deleted",
  "per_sample_rows_soft_deleted",
  "persisted",
  "plan_reviews_minted",
  "practitioner_contacts_migrated",
  "pre_wipe_copies_deleted",
  "pr_detection_inserted",
  "pr_detection_jobs",
  "pr_detection_ties",
  "pr_detection_users",
  "pr_detection_users_failed",
  "processed",
  "provider",
  "queued",
  "rearmed",
  "records_oversized",
  "records_read",
  "refreshed",
  "refresh_tokens_deleted",
  "refused",
  "reminders_due",
  "removed",
  "resting_corrected",
  "rows_written",
  // v1.39.1 — the background restore of a stored backup, and the sweep that
  // re-queues one a stopped worker left running. Counts and a claim flag.
  "restore_claimed",
  "restore_drill_accounts",
  "restore_drill_accounts_failed",
  "restore_drill_age_days",
  "restore_drill_date",
  "restore_drill_ciphertext_bytes",
  "restore_drill_intake_events",
  "restore_drill_measurements",
  "restore_drill_medications",
  "restore_drill_mood_entries",
  "restore_drill_plaintext_bytes",
  "restore_drill_unchecked",
  "restore_drill_stale",
  // The hourly recovery readiness evaluation: the overall verdict, how many
  // signals need attention or are failing, notices sent, admins reached.
  "recovery_readiness_admins",
  "recovery_readiness_attention",
  "recovery_readiness_failing",
  "recovery_readiness_notices",
  "recovery_readiness_state",
  "restore_fail_cause",
  "restore_failed",
  "restore_measurements",
  "restore_requeued",
  "restore_skipped_links",
  "retried",
  "reviewed",
  "rollup_failed",
  "route_geometries_migrated",
  "rotate_dropped",
  "rotate_errors",
  "rotate_rotated",
  "rotate_scanned",
  "rows_deleted",
  "rows_normalised",
  "rows_reinserted",
  "rows_resurrected",
  "rows_soft_deleted",
  "rows_upserted",
  "satisfied",
  "scheduled",
  "sent",
  "served",
  "sessions_deleted",
  "side_effects_migrated",
  // v1.42.4 — integration watchdog: sources newly flagged as silent.
  "silences_flagged",
  "single_user",
  "skipped",
  "skipped_already_dispatched",
  "skipped_already_logged",
  "skipped_already_notified",
  "skipped_incomplete",
  "skipped_no_channel",
  "skipped_not_due",
  "skipped_outside_window",
  "slots_collapsed",
  "states_deleted",
  "stopped_early",
  "stored",
  "subscription_repair_failed",
  "summaries_enqueued",
  // v1.37.19 — stale-PENDING summary rows the hourly reaper healed.
  "summary_pending_healed",
  "suppressed_client_managed",
  "suppressed_discreet",
  "thumbnails_enqueued",
  "tls_pin_monitor_known_count",
  "tls_pin_monitor_outcome",
  "total",
  "trusted_devices_deleted",
  "unchanged",
  "updated",
  "users",
  "users_clean_zero",
  "users_complete",
  "users_enqueued",
  "users_failed",
  "users_parked",
  "users_partial",
  "users_retryable",
  "users_scanned",
  "users_skipped",
  // v1.39.2 — accounts the weekly backup left alone because a restore of their
  // current copy was queued or running.
  "users_skipped_restoring",
  "users_synced",
  "users_useful",
  "wedge_skipped",
]);

export const MAX_JOB_FACTS = 32;
export const MAX_JOB_OUTCOME_BYTES = 2_048;

const STABLE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * What a handler did. `ok: true` means the work named by the queue actually
 * happened; `ok: false` means it did not, and `runJob` will fail the pg-boss
 * job so the failure reaches the retry policy and the operator surfaces.
 *
 * A run that legitimately had nothing to do is `ok: true` with a zero count
 * in `did` — absence of work is not failure. A run that could not do its
 * work (provider down, query timed out, key missing) is `ok: false` even
 * when the handler previously chose to carry on.
 */
export type JobOutcome =
  | {
      readonly ok: true;
      readonly did: JobFacts;
    }
  | {
      readonly ok: false;
      /** Short, stable, greppable. `"nightscout fetch failed"`, not a stack. */
      readonly reason: string;
      /** The thrown value, when there was one. Preserved for the stack. */
      readonly cause?: unknown;
      /** Whatever the run managed before it failed. */
      readonly did?: JobFacts;
    };

/** The run did its work. Pass the counts that make the run auditable. */
export function jobDone(did: JobFacts = {}): JobOutcome {
  return { ok: true, did };
}

/**
 * The run did not do its work. `runJob` reports this and rethrows, so the
 * pg-boss job fails and the queue's retry policy applies — check that policy
 * when converting a handler that used to swallow, because a deterministic
 * failure now retries instead of passing quietly.
 */
export function jobFailed(
  reason: string,
  cause?: unknown,
  did?: JobFacts,
): JobOutcome {
  return { ok: false, reason, cause, did };
}

export type SerializedJobOutcome =
  | { readonly ok: true; readonly did: JobFacts }
  | {
      readonly ok: false;
      readonly reason_code: string;
      readonly did?: JobFacts;
    };

function assertStableCode(value: string, label: string): void {
  if (!STABLE_CODE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a stable lowercase code`);
  }
}

/**
 * A measured quantity as a fact: a duration or an amount computed in floating
 * point, rounded on purpose. A fact is a non-negative whole number, and a
 * value that is not one fails the outcome's validation.
 */
export function wholeFact(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/**
 * A ratio as a fact, in whole percent: 1.3 is 130. A ratio is not a whole
 * number, so it cannot be a fact as it stands; this is the one way to report
 * one. Absent or unmeasurable is 0.
 */
export function percentFact(ratio: number | null | undefined): number {
  if (ratio == null || !Number.isFinite(ratio)) return 0;
  return wholeFact(ratio * 100);
}

/** Why one fact is refused, or null when it is a valid fact. */
function invalidFact(key: string, value: unknown): string | null {
  if (!JOB_FACT_ALLOWLIST.has(key))
    return `job fact key is not allowed: ${key}`;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? null
      : `job fact ${key} must be a non-negative safe integer`;
  }
  if (typeof value === "string") {
    return STABLE_CODE_PATTERN.test(value)
      ? null
      : `job fact ${key} must be a stable lowercase code`;
  }
  return typeof value === "boolean"
    ? null
    : `job fact ${key} must be a bounded scalar`;
}

/**
 * Called for each fact the serializer drops instead of throwing over it. A
 * caller that passes it has already done the run's work: refusing the whole
 * outcome over one malformed fact would fail completed work, and pg-boss
 * would retry it.
 */
export type InvalidFactHandler = (key: string, reason: string) => void;

function validateFacts(
  facts: JobFacts,
  onInvalidFact?: InvalidFactHandler,
): JobFacts {
  const entries = Object.entries(facts);

  if (entries.length > MAX_JOB_FACTS) {
    throw new RangeError(`job outcome exceeds ${MAX_JOB_FACTS} facts`);
  }

  const kept: Array<[string, JobFact]> = [];
  for (const [key, value] of entries) {
    const reason = invalidFact(key, value);
    if (reason === null) {
      kept.push([key, value]);
      continue;
    }
    if (!onInvalidFact) throw new TypeError(reason);
    onInvalidFact(key, reason);
  }

  return Object.freeze(Object.fromEntries(kept)) as JobFacts;
}

/**
 * Produce the only representation suitable for persistence or structured
 * logging. The raw `cause` deliberately remains in-process for retry handling.
 */
export function serializeJobOutcome(
  outcome: JobOutcome,
  options: { onInvalidFact?: InvalidFactHandler } = {},
): SerializedJobOutcome {
  const did = validateFacts(outcome.did ?? {}, options.onInvalidFact);
  const serialized: SerializedJobOutcome = outcome.ok
    ? { ok: true, did }
    : (() => {
        assertStableCode(outcome.reason, "job failure reason");
        return outcome.did === undefined
          ? { ok: false, reason_code: outcome.reason }
          : { ok: false, reason_code: outcome.reason, did };
      })();

  const byteLength = new TextEncoder().encode(
    JSON.stringify(serialized),
  ).length;
  if (byteLength > MAX_JOB_OUTCOME_BYTES) {
    throw new RangeError(
      `serialized job outcome exceeds ${MAX_JOB_OUTCOME_BYTES} bytes`,
    );
  }

  return serialized;
}
