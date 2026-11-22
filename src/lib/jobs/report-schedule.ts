/**
 * The scheduled doctor report: once a month, quarter or year has closed on a
 * record's clock, render the doctor report for it and file it into the
 * document vault. No notification is sent: the report is simply there, in
 * the vault and in whatever the vault feeds.
 *
 * One pass per tick over the records that turned a schedule on and are not
 * pending deletion. A record is due when the latest closed period of its
 * cadence is not the one it last stamped. For each due record, at most
 * `REPORT_SCHEDULE_MAX_PER_TICK` a tick:
 *
 *   1. Gates. The `doctorReport` and `inboundDocuments` modules must both be
 *      on; with either off the record is skipped without a stamp, so turning
 *      the module back on files the period that is due then.
 *   2. The source key `REPORT_SCHEDULE` / `<cadence>:<period>` is looked up
 *      first. A key the vault holds (filed, or filed and deleted by the
 *      owner) stamps the period and renders nothing: a re-run, a retry and a
 *      second worker file nothing twice, and a deleted report stays deleted.
 *   3. The scope is the owner's saved selection, the one the export panel
 *      shows above the schedule card. An empty one files nothing and says
 *      so on the card; it is not stamped, so the period is filed once a
 *      selection exists.
 *   4. The PDF is rendered with `renderDoctorReportPdfBytes` and stored with
 *      `ingestDocument`, which holds it to the vault's per-file cap and the
 *      record's quota like any upload. Automatic AI reading is deferred: the
 *      report is HealthLog's own text, and a model reading it back would be
 *      egress for nothing.
 *
 * The outcome and the period are stamped on the schedule for the card to
 * show. A failure stamps the outcome but not the period, so the next tick
 * tries again; a report over the cap or the quota stamps both, and the next
 * period tries again.
 */
import { Buffer } from "node:buffer";

import { Prisma } from "@/generated/prisma/client";
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { decrypt } from "@/lib/crypto";
import { prisma, toJson } from "@/lib/db";
import { collectDoctorReportData } from "@/lib/doctor-report/collect";
import {
  latestClosedPeriod,
  reportRangeForPeriod,
  reportScheduleSourceId,
  stampReportSchedule,
  type ReportPeriod,
} from "@/lib/doctor-report/schedule";
import {
  parseReportSchedule,
  type ReportSchedule,
  type ReportScheduleOutcome,
} from "@/lib/doctor-report/schedule-shape";
import { normaliseDateRange } from "@/lib/doctor-report-data";
import { renderDoctorReportPdfBytes } from "@/lib/doctor-report-pdf-core";
import { ingestDocument } from "@/lib/documents/ingest";
import { findSourceKey } from "@/lib/documents/source-key";
import { resolveDocumentLimits } from "@/lib/documents/upload-policy";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import {
  REPORT_SCHEDULE_MAX_PER_TICK,
  REPORT_SCHEDULE_QUEUE,
} from "@/lib/jobs/report-schedule-queue";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { withBackgroundEvent } from "@/lib/logging/background";
import { isModuleEnabled } from "@/lib/modules/gate";
import { resolveSavedSelection } from "@/lib/report-selection/saved-profile";
import { DEFAULT_TIMEZONE, isValidTimezone } from "@/lib/tz/format";

export const REPORT_SCHEDULE_SOURCE_SYSTEM = "REPORT_SCHEDULE" as const;

interface ScheduledRow {
  id: string;
  timezone: string | null;
  locale: string | null;
  reportScheduleJson: unknown;
}

export interface DueReport {
  userId: string;
  tz: string;
  locale: string | null;
  schedule: ReportSchedule;
  /** The stored blob as read, so the stamp can tell it was not changed. */
  stored: unknown;
  period: ReportPeriod;
}

/**
 * The due records among `rows`, the longest-waiting first: never attempted,
 * then by the last attempt. A record whose run failed is stamped with the
 * attempt, so it goes to the back and cannot hold the others up. Pure.
 */
export function dueReports(
  rows: readonly ScheduledRow[],
  now: Date,
): DueReport[] {
  const due: DueReport[] = [];
  for (const row of rows) {
    const schedule = parseReportSchedule(row.reportScheduleJson);
    if (!schedule) continue;
    const tz =
      row.timezone && isValidTimezone(row.timezone)
        ? row.timezone
        : DEFAULT_TIMEZONE;
    const period = latestClosedPeriod(schedule.cadence, now, tz);
    if (schedule.lastPeriod === period.key) continue;
    due.push({
      userId: row.id,
      tz,
      locale: row.locale,
      schedule,
      stored: row.reportScheduleJson,
      period,
    });
  }
  const at = (d: DueReport) => d.schedule.lastRunAt ?? "";
  return due.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
}

export type ReportRunResult = ReportScheduleOutcome | "moduleOff" | "gone";

async function stamp(
  due: DueReport,
  outcome: ReportScheduleOutcome,
  now: Date,
  advance: boolean,
): Promise<void> {
  const next = advance
    ? stampReportSchedule(due.schedule, due.period, outcome, now)
    : { ...due.schedule, lastOutcome: outcome, lastRunAt: now.toISOString() };
  // Written only while the schedule the run read is still the one stored, so
  // a schedule turned off or changed mid-run is not overwritten.
  await prisma.user.updateMany({
    where: {
      id: due.userId,
      reportScheduleJson: { equals: toJson(due.stored) },
    },
    data: { reportScheduleJson: toJson(next) },
  });
}

/** Render and file one due report. Never throws for a per-record problem. */
export async function runOneReport(
  due: DueReport,
  now: Date,
): Promise<ReportRunResult> {
  const { userId, period } = due;
  const [reportOn, vaultOn] = await Promise.all([
    isModuleEnabled(userId, "doctorReport"),
    isModuleEnabled(userId, "inboundDocuments"),
  ]);
  if (!reportOn || !vaultOn) return "moduleOff";

  const sourceId = reportScheduleSourceId(period);
  const held = await findSourceKey(
    userId,
    REPORT_SCHEDULE_SOURCE_SYSTEM,
    sourceId,
  );
  if (held) {
    const outcome = held.state === "live" ? "alreadyFiled" : "deletedByOwner";
    await stamp(due, outcome, now, true);
    return outcome;
  }

  const selection = await resolveSavedSelection(userId);
  if (selection.leaves.length === 0) {
    await stamp(due, "noSelection", now, false);
    return "noSelection";
  }

  try {
    const bounds = reportRangeForPeriod(period, due.schedule.window, due.tz);
    const range = normaliseDateRange(
      {
        startDate: bounds.start.toISOString(),
        endDate: bounds.end.toISOString(),
      },
      now,
      due.tz,
    );
    const [data, row, limits, locale] = await Promise.all([
      collectDoctorReportData(userId, range, selection, { practiceName: null }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          insuranceNumberEncrypted: true,
          timeFormat: true,
          dateFormat: true,
        },
      }),
      resolveDocumentLimits(userId),
      resolveJobLocale(due.locale),
    ]);
    if (!row) return "gone";
    let insuranceNumber: string | null = null;
    if (selection.has("INSURANCE") && row.insuranceNumberEncrypted) {
      try {
        insuranceNumber = decrypt(row.insuranceNumberEncrypted);
      } catch {
        insuranceNumber = null;
      }
    }
    const { t } = getServerTranslator(locale);
    const pdf = renderDoctorReportPdfBytes(data, {
      t,
      locale,
      userTz: due.tz,
      timeFormat: row.timeFormat,
      dateFormat: row.dateFormat,
      insuranceNumber,
      includeCharts: true,
    });

    const result = await ingestDocument({
      userId,
      scoped: false,
      ipAddress: null,
      bytes: Buffer.from(pdf),
      filename: `healthlog-report-${period.key}.pdf`,
      title: t("reportSchedule.documentTitle", { period: period.key }),
      kind: "DOCTOR_REPORT",
      documentDate: period.lastDay,
      episodeIds: [],
      encounterIds: [],
      sourceSystem: REPORT_SCHEDULE_SOURCE_SYSTEM,
      sourceId,
      sourceInstance: null,
      aiDeferred: true,
      sourceKeyChecked: true,
      limits,
      // Never asked while `aiDeferred` holds; closed all the same, so a later
      // change to the ingest cannot open a model path for this job.
      documentAi: async () => ({
        available: false,
        reason: "not_permitted_for_record",
        onDeviceAllowed: false,
      }),
    });
    const outcome: ReportScheduleOutcome =
      result.kind === "stored"
        ? "stored"
        : result.kind === "duplicate"
          ? "alreadyFiled"
          : result.kind === "sourceKey"
            ? result.match.state === "live"
              ? "alreadyFiled"
              : "deletedByOwner"
            : result.kind === "quotaExceeded"
              ? "quotaExceeded"
              : result.kind === "tooLarge"
                ? "tooLarge"
                : "failed";
    await stamp(due, outcome, now, outcome !== "failed");
    return outcome;
  } catch (err) {
    // Reported, never rethrown: one record's failure does not stop the pass.
    void reportWorkerError(REPORT_SCHEDULE_QUEUE, err, {
      cadence: due.schedule.cadence,
    });
    await stamp(due, "failed", now, false).catch(() => undefined);
    return "failed";
  }
}

/** The results that rendered a PDF (or tried to). */
const RENDERED: ReadonlySet<ReportRunResult> = new Set([
  "stored",
  "quotaExceeded",
  "tooLarge",
  "failed",
]);

/** One tick: read the scheduled records, file what is due, count it. */
export async function runReportScheduleTick(
  now: Date,
): Promise<Record<string, number>> {
  const rows = await prisma.user.findMany({
    where: { ...ACTIVE_ACCOUNT, reportScheduleJson: { not: Prisma.DbNull } },
    select: {
      id: true,
      timezone: true,
      locale: true,
      reportScheduleJson: true,
    },
    orderBy: { id: "asc" },
  });
  const due = dueReports(rows, now);
  const counts: Record<string, number> = {
    scheduled: rows.length,
    due: due.length,
  };
  // The cap counts renders. A record skipped by a gate or answered by a held
  // key costs a read or two and does not take a render's place.
  let attempts = 0;
  let deferred = 0;
  for (const item of due) {
    if (attempts >= REPORT_SCHEDULE_MAX_PER_TICK) {
      deferred += 1;
      continue;
    }
    const result = await runOneReport(item, now);
    if (RENDERED.has(result)) attempts += 1;
    counts[result] = (counts[result] ?? 0) + 1;
  }
  counts.deferred = deferred;
  return counts;
}

/** The tick's counts under the job-fact vocabulary. */
const FACT_OF: Record<string, string> = {
  scheduled: "report_schedules_read",
  due: "reports_due",
  deferred: "reports_deferred",
  stored: "reports_stored",
  alreadyFiled: "reports_already_filed",
  deletedByOwner: "reports_deleted_by_owner",
  quotaExceeded: "reports_over_quota",
  tooLarge: "reports_too_large",
  noSelection: "reports_no_selection",
  failed: "reports_failed",
  moduleOff: "reports_module_off",
  gone: "reports_gone",
};

export function reportScheduleFacts(
  counts: Readonly<Record<string, number>>,
): Record<string, number | boolean> {
  const facts: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(counts)) {
    const fact = FACT_OF[key];
    if (fact) facts[fact] = value;
  }
  // The records the tick attempted and the ones whose render or filing
  // failed (`FanOutTally`): each failed one is stamped on its own schedule,
  // and the run says how many there were, so a host that cannot render
  // reports shows on the failing jobs card rather than as a green run.
  const failed = counts.failed ?? 0;
  facts.items_attempted = (counts.due ?? 0) - (counts.deferred ?? 0);
  facts.items_failed = failed;
  facts.partial_failed = failed > 0;
  return facts;
}

export async function handleReportSchedule(): Promise<JobOutcome> {
  return withBackgroundEvent("job.report_schedule", async (evt) => {
    const facts = reportScheduleFacts(await runReportScheduleTick(new Date()));
    evt.setBackground({ task_name: "job.report_schedule", result: facts });
    return jobDone(facts);
  });
}
