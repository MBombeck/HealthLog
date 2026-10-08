/**
 * Operational handlers: host metric sampling, recommendation-feedback aggregation, geo backfill, TLS pin monitoring, and personal-record detection.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { jobBudget } from "@/lib/jobs/job-budget";
import { type Job } from "pg-boss";
import { runGeoBackfill } from "@/lib/jobs/geo-backfill";
import { fetchGeoLite2Databases } from "@/lib/geo/geolite2-fetch";
import { type Geolite2FetchPayload } from "@/lib/jobs/geolite2-fetch";
import { runTlsPinMonitor } from "@/lib/jobs/tls-pin-monitor";
import {
  listPrDetectionFallbackUserIds,
  nextPrDetectionFallbackSince,
  type PrDetectionPayload,
} from "@/lib/jobs/pr-detection";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { runHostMetricTick } from "@/lib/jobs/host-metric-sampler";
import { aggregateRecommendationFeedback } from "@/lib/jobs/feedback-aggregator";
import { detectPersonalRecordsForUser } from "@/lib/personal-records/pr-detection-worker";
import { getWorkerPrisma } from "./shared";

export interface HostMetricSamplePayload {
  triggeredAt: string;
}

export interface FeedbackAggregatorPayload {
  triggeredAt: string;
}

export interface GeoBackfillPayload {
  triggeredAt: string;
}

export interface TlsPinMonitorPayload {
  triggeredAt: string;
}

// Re-export timezone utilities under local names for backward compatibility

export async function handleHostMetricSample(
  jobs: Job<HostMetricSamplePayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.host_metric_sample", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const { pruned } = await runHostMetricTick(p);
      evt.addMeta("host_metric_pruned", pruned);
      return jobDone({ host_metric_pruned: pruned });
    } catch (err) {
      // The chart degrades gracefully when samples are missing, so the
      // warning stays — but a tick that took no sample did not do its work.
      evt.addWarning(`host-metric-sample failed: ${err}`);
      return jobFailed("host metric sample failed", err);
    }
  });
}

export async function handleFeedbackAggregator(
  jobs: Job<FeedbackAggregatorPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.feedback_aggregator", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const summary = await aggregateRecommendationFeedback(p);
      const totalRows = summary.buckets.reduce((acc, b) => acc + b.total, 0);
      evt.addMeta("feedback_buckets", summary.buckets.length);
      evt.addMeta("feedback_total_rows", totalRows);
      evt.addMeta("feedback_window_days", summary.windowDays);
      return jobDone({
        feedback_buckets: summary.buckets.length,
        feedback_total_rows: totalRows,
        feedback_window_days: summary.windowDays,
      });
    } catch (err) {
      // The admin dashboard tolerates a stale summary, so the warning stays —
      // but a pass that aggregated nothing did not do its work.
      evt.addWarning(`feedback-aggregator failed: ${err}`);
      return jobFailed("feedback aggregation failed", err);
    }
  });
}

/**
 * v1.4.37 — geo-backfill worker. Walks `audit_logs` rows that landed
 * with a null `location` (offline MMDB missing at write time, online
 * provider unreachable) and re-resolves them through the now-bundled
 * resolver chain. The helper is idempotent and capped per pass so
 * the hourly cadence cannot starve a live login spike.
 *
 * v1.4.38 — in-process singleton guard. pg-boss already coalesces
 * concurrent cron ticks across multiple worker containers via the
 * shared queue lease, but a single container that takes longer than
 * one cron interval can pick up two jobs back-to-back when the
 * second tick fires while the first pass is still running. The
 * in-process `geoBackfillRunning` flag fans the second invocation
 * out as a no-op log line instead of stacking two concurrent passes
 * inside the same Node process — the next cron tick after the first
 * completes will catch up the work the skipped pass would have done.
 */
let geoBackfillRunning = false;

export async function handleGeoBackfill(
  jobs: Job<GeoBackfillPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.geo_backfill", async (evt) => {
    if (geoBackfillRunning) {
      // Earlier pass still in flight; skip this tick. Idempotent + the
      // next tick after the in-flight pass completes will pick up
      // anything we miss here. Deliberately ceding to the in-flight pass
      // is not a failure, so the tick reports the skip and succeeds.
      evt.addWarning(
        "geo-backfill skipped — earlier pass still in flight inside the same worker process",
      );
      evt.addMeta("geo_backfill_skipped", true);
      return jobDone({ geo_backfill_skipped: true });
    }
    geoBackfillRunning = true;
    const p = getWorkerPrisma();
    try {
      const summary = await runGeoBackfill(p);
      evt.addMeta("geo_backfill_scanned", summary.scanned);
      evt.addMeta("geo_backfill_located", summary.located);
      evt.addMeta("geo_backfill_carrier_resolved", summary.carrierResolved);
      evt.addMeta("geo_backfill_still_unresolved", summary.stillUnresolved);
      return jobDone({
        geo_backfill_scanned: summary.scanned,
        geo_backfill_located: summary.located,
        geo_backfill_carrier_resolved: summary.carrierResolved,
        geo_backfill_still_unresolved: summary.stillUnresolved,
      });
    } catch (err) {
      // The admin sign-in overview tolerates a stale Standort cell, so the
      // warning stays — but a pass that resolved nothing did not do its work.
      evt.addWarning(`geo-backfill failed: ${err}`);
      return jobFailed("geo backfill pass failed", err);
    } finally {
      geoBackfillRunning = false;
    }
  });
}

/**
 * Runtime GeoLite2 fetch worker (issue #659). Downloads + places the offline
 * MMDBs when a `MAXMIND_LICENSE_KEY` is set, so a self-hoster on the published
 * image gets the offline geo tier without a rebuild or a manual mount. The
 * fetch is fail-soft (a failure leaves the previous databases untouched); the
 * boot mode only fetches when no database is present yet, the cron mode always
 * refreshes. Skips (no key, egress disabled, already present) complete the job;
 * a genuine download/extract failure fails it so pg-boss's default retries get
 * a few attempts before the monthly cron catches the next window.
 */
export async function handleGeolite2Fetch(
  jobs: Job<Geolite2FetchPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.geolite2_fetch", async (evt) => {
    // Batched worker mode always hands us an array; the queue is single-flight
    // in practice, so this loop is ~always one job.
    let lastStatus = "none";
    let failure: JobOutcome | null = null;
    for (const job of jobs) {
      const mode = job.data?.mode === "boot" ? "boot" : "refresh";
      const result = await fetchGeoLite2Databases({
        skipIfPresent: mode === "boot",
      });
      lastStatus = result.status;
      evt.addMeta("geolite2_fetch_mode", mode);
      evt.addMeta("geolite2_fetch_status", result.status);
      if (result.status === "fetched") {
        evt.addMeta("geolite2_fetch_editions", result.editions.join(","));
      }
      if (result.status === "failed" && failure === null) {
        evt.addWarning(
          `geolite2-fetch failed: ${result.error ?? "unknown error"}`,
        );
        failure = jobFailed(
          "geolite2 fetch failed",
          new Error(result.error ?? "unknown error"),
        );
      }
    }
    return (
      failure ??
      jobDone({ geolite2_fetch_status: lastStatus, jobs: jobs.length })
    );
  });
}

export async function handleTlsPinMonitor(
  jobs: Job<TlsPinMonitorPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.tls_pin_monitor", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const summary = await runTlsPinMonitor(p);
      evt.addMeta("tls_pin_monitor_outcome", summary.outcome);
      evt.addMeta("tls_pin_monitor_host", summary.host);
      evt.addMeta("tls_pin_monitor_known_count", summary.knownPinCount);
      // The configured host remains in the scoped operator event above. It is
      // deliberately excluded from the durable pg-boss result, which carries
      // only the stable outcome code and non-identifying pin count.
      return jobDone({
        tls_pin_monitor_outcome: summary.outcome,
        tls_pin_monitor_known_count: summary.knownPinCount,
      });
    } catch (err) {
      // runTlsPinMonitor swallows probe failures internally; anything that
      // escapes is unexpected, and a tick that never compared a pin is
      // exactly the silence this monitor exists to break.
      evt.addWarning(`tls-pin-monitor failed: ${err}`);
      return jobFailed("tls pin probe failed", err);
    }
  });
}

export async function handlePrDetection(
  jobs: Job<PrDetectionPayload | { userId?: undefined }>[],
): Promise<JobOutcome> {
  // Each job in the batch opens its own wide event; the outcome is reported
  // once for the batch, so the per-job facts accumulate out here.
  let usersScanned = 0;
  let insertedAcrossJobs = 0;
  let tiesAcrossJobs = 0;
  let usersFailed = 0;
  let stoppedEarly = false;
  // The cron pass walks the all-time history of every account whose data
  // changed since the last tick, every thirty minutes. It stops between accounts once the job's budget is spent;
  // the ingest jobs and the next tick carry the rest.
  const shouldStop = jobBudget(jobs);
  for (const job of jobs) {
    await withBackgroundEvent("job.pr_detection", async (evt) => {
      const p = getWorkerPrisma();
      // The cron-fired job carries an empty payload — iterate all
      // users in that case. The push-suppression flag is irrelevant
      // for the cron path (the dispatcher's per-user opt-in handles
      // the loud/quiet decision once the row is written).
      const payloadUserId = (job.data as PrDetectionPayload | undefined)
        ?.userId;
      const silent =
        (job.data as PrDetectionPayload | undefined)?.silent ?? false;
      // v1.42 — the cron path re-scans only accounts whose measurements or
      // workouts changed since the previous tick (`pr-detection.ts`).
      const userIds: string[] = payloadUserId
        ? [payloadUserId]
        : await listPrDetectionFallbackUserIds(
            p,
            nextPrDetectionFallbackSince(),
          );

      let insertedTotal = 0;
      let tiesTotal = 0;
      for (const userId of userIds) {
        if (shouldStop()) {
          stoppedEarly = true;
          break;
        }
        try {
          const result = await detectPersonalRecordsForUser(userId, {
            silent,
            prisma: p,
          });
          insertedTotal += result.inserted;
          tiesTotal += result.ties;
        } catch (err) {
          // One user's detection failing is that user's problem, not the
          // pass's: it rides out as a count so the cron is not retried for
          // the whole cohort.
          usersFailed++;
          evt.addWarning(`pr-detection failed for user ${userId}: ${err}`);
        }
      }
      evt.addMeta("pr_detection_users", userIds.length);
      evt.addMeta("pr_detection_inserted", insertedTotal);
      evt.addMeta("pr_detection_ties", tiesTotal);
      evt.addMeta("pr_detection_silent", silent);
      evt.addMeta("pr_detection_mode", payloadUserId ? "ingest" : "cron");

      usersScanned += userIds.length;
      insertedAcrossJobs += insertedTotal;
      tiesAcrossJobs += tiesTotal;
    });
  }

  return jobDone({
    pr_detection_jobs: jobs.length,
    pr_detection_users: usersScanned,
    pr_detection_inserted: insertedAcrossJobs,
    pr_detection_ties: tiesAcrossJobs,
    pr_detection_users_failed: usersFailed,
    stopped_early: stoppedEarly,
  });
}
