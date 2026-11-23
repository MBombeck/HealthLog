/**
 * The scheduled-report pass: who is due, what each gate skips, that a held
 * source key renders nothing, and what is stamped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const updateMany = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findMany: (a: unknown) => findMany(a),
      updateMany: (a: unknown) => updateMany(a),
      findUnique: (a: unknown) => findUnique(a),
    },
  },
  toJson: <T>(v: T) => v,
}));
const isModuleEnabled = vi.fn();
vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: (...a: unknown[]) => isModuleEnabled(...a),
}));
const findSourceKey = vi.fn();
vi.mock("@/lib/documents/source-key", () => ({
  findSourceKey: (...a: unknown[]) => findSourceKey(...a),
}));
const resolveSavedSelection = vi.fn();
vi.mock("@/lib/report-selection/saved-profile", () => ({
  resolveSavedSelection: (...a: unknown[]) => resolveSavedSelection(...a),
}));
const collectDoctorReportData = vi.fn();
vi.mock("@/lib/doctor-report/collect", () => ({
  collectDoctorReportData: (...a: unknown[]) => collectDoctorReportData(...a),
}));
const renderDoctorReportPdfBytes = vi.fn();
vi.mock("@/lib/doctor-report-pdf-core", () => ({
  renderDoctorReportPdfBytes: (...a: unknown[]) =>
    renderDoctorReportPdfBytes(...a),
}));
const ingestDocument = vi.fn();
vi.mock("@/lib/documents/ingest", () => ({
  ingestDocument: (a: unknown) => ingestDocument(a),
}));
vi.mock("@/lib/documents/upload-policy", () => ({
  resolveDocumentLimits: async () => ({
    maxFileBytes: 1_000_000,
    quotaBytes: 5_000_000,
  }),
}));
vi.mock("@/lib/jobs/report-worker-error", () => ({
  reportWorkerError: vi.fn(async () => undefined),
}));
vi.mock("@/lib/i18n/job-locale", () => ({
  resolveJobLocale: async () => "en",
}));

import { JOB_FACT_ALLOWLIST } from "@/lib/jobs/job-outcome";
import {
  dueReports,
  reportScheduleFacts,
  runOneReport,
  runReportScheduleTick,
} from "@/lib/jobs/report-schedule";
import { REPORT_SCHEDULE_MAX_PER_TICK } from "@/lib/jobs/report-schedule-queue";

const NOW = new Date("2026-11-21T10:00:00Z");

function schedule(lastPeriod: string | null, lastRunAt: string | null = null) {
  return {
    v: 1,
    cadence: "MONTHLY",
    window: "PERIOD",
    lastPeriod,
    lastOutcome: null,
    lastRunAt,
  };
}

const row = (id: string, s: unknown) => ({
  id,
  timezone: "Europe/Berlin",
  locale: "en",
  reportScheduleJson: s,
});

beforeEach(() => {
  vi.clearAllMocks();
  isModuleEnabled.mockResolvedValue(true);
  findSourceKey.mockResolvedValue(null);
  resolveSavedSelection.mockResolvedValue({
    leaves: ["VITALS"],
    has: () => false,
  });
  collectDoctorReportData.mockResolvedValue({});
  findUnique.mockResolvedValue({
    insuranceNumberEncrypted: null,
    timeFormat: "AUTO",
    dateFormat: "AUTO",
  });
  renderDoctorReportPdfBytes.mockReturnValue(new Uint8Array([37, 80, 68, 70]));
  ingestDocument.mockResolvedValue({ kind: "stored" });
  updateMany.mockResolvedValue({ count: 1 });
});

describe("dueReports", () => {
  it("is due until the closed period is stamped, the longest-waiting first", () => {
    const due = dueReports(
      [
        row("filed", schedule("2026-10")),
        row("tried", schedule("2026-09", "2026-11-21T09:25:00Z")),
        row("never", schedule(null)),
        row("broken", { v: 9 }),
      ],
      NOW,
    );
    expect(due.map((d) => d.userId)).toEqual(["never", "tried"]);
    expect(due[0].period.key).toBe("2026-10");
  });
});

describe("runOneReport", () => {
  const due = () => dueReports([row("u1", schedule(null))], NOW)[0];

  it("files the period's PDF under its source key and stamps it", async () => {
    expect(await runOneReport(due(), NOW)).toBe("stored");
    const input = ingestDocument.mock.calls[0][0];
    expect(input).toMatchObject({
      userId: "u1",
      sourceSystem: "REPORT_SCHEDULE",
      sourceId: "MONTHLY:2026-10",
      kind: "DOCTOR_REPORT",
      documentDate: "2026-10-31",
      aiDeferred: true,
      sourceKeyChecked: true,
      limits: { maxFileBytes: 1_000_000, quotaBytes: 5_000_000 },
    });
    // The report covers October on the record's clock.
    const range = collectDoctorReportData.mock.calls[0][1];
    expect(range.start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-10-31T22:59:59.999Z");
    expect(updateMany.mock.calls[0][0].data.reportScheduleJson).toMatchObject({
      lastPeriod: "2026-10",
      lastOutcome: "stored",
    });
  });

  it("renders nothing for a key the vault already holds", async () => {
    findSourceKey.mockResolvedValue({ state: "live", document: {} });
    expect(await runOneReport(due(), NOW)).toBe("alreadyFiled");
    findSourceKey.mockResolvedValue({ state: "deleted", id: null });
    expect(await runOneReport(due(), NOW)).toBe("deletedByOwner");
    expect(renderDoctorReportPdfBytes).not.toHaveBeenCalled();
    expect(ingestDocument).not.toHaveBeenCalled();
    expect(
      updateMany.mock.calls.map((c) => c[0].data.reportScheduleJson.lastPeriod),
    ).toEqual(["2026-10", "2026-10"]);
  });

  it("skips without a stamp while either module is off", async () => {
    isModuleEnabled.mockImplementation(
      async (_u: string, key: string) => key !== "doctorReport",
    );
    expect(await runOneReport(due(), NOW)).toBe("moduleOff");
    isModuleEnabled.mockImplementation(
      async (_u: string, key: string) => key !== "inboundDocuments",
    );
    expect(await runOneReport(due(), NOW)).toBe("moduleOff");
    expect(findSourceKey).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("files nothing for an empty selection and keeps the period due", async () => {
    resolveSavedSelection.mockResolvedValue({ leaves: [], has: () => false });
    expect(await runOneReport(due(), NOW)).toBe("noSelection");
    expect(renderDoctorReportPdfBytes).not.toHaveBeenCalled();
    const stamped = updateMany.mock.calls[0][0].data.reportScheduleJson;
    expect(stamped).toMatchObject({
      lastPeriod: null,
      lastOutcome: "noSelection",
    });
  });

  it("stamps a report over the quota with its period, a failure without", async () => {
    ingestDocument.mockResolvedValue({
      kind: "quotaExceeded",
      usedBytes: 1,
      quotaBytes: 1,
    });
    expect(await runOneReport(due(), NOW)).toBe("quotaExceeded");
    expect(updateMany.mock.calls[0][0].data.reportScheduleJson.lastPeriod).toBe(
      "2026-10",
    );
    renderDoctorReportPdfBytes.mockImplementation(() => {
      throw new Error("render");
    });
    expect(await runOneReport(due(), NOW)).toBe("failed");
    expect(updateMany.mock.calls[1][0].data.reportScheduleJson).toMatchObject({
      lastPeriod: null,
      lastOutcome: "failed",
    });
  });

  it("stamps only while the stored schedule is the one it read", async () => {
    await runOneReport(due(), NOW);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: "u1",
      reportScheduleJson: { equals: schedule(null) },
    });
  });
});

describe("runReportScheduleTick", () => {
  it("reads only active accounts with a schedule and caps renders per tick", async () => {
    const rows = Array.from(
      { length: REPORT_SCHEDULE_MAX_PER_TICK + 3 },
      (_, i) => row(`u${String(i).padStart(2, "0")}`, schedule(null)),
    );
    findMany.mockResolvedValue(rows);
    const counts = await runReportScheduleTick(NOW);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      deletionRequestedAt: null,
    });
    expect(counts).toMatchObject({
      scheduled: rows.length,
      due: rows.length,
      stored: REPORT_SCHEDULE_MAX_PER_TICK,
      deferred: 3,
    });
    expect(ingestDocument).toHaveBeenCalledTimes(REPORT_SCHEDULE_MAX_PER_TICK);
  });

  it("does not count a gate skip against the cap", async () => {
    const rows = Array.from(
      { length: REPORT_SCHEDULE_MAX_PER_TICK + 3 },
      (_, i) => row(`u${String(i).padStart(2, "0")}`, schedule(null)),
    );
    findMany.mockResolvedValue(rows);
    findSourceKey.mockResolvedValue({ state: "live", document: {} });
    const counts = await runReportScheduleTick(NOW);
    expect(counts).toMatchObject({ alreadyFiled: rows.length, deferred: 0 });
  });
});

describe("reportScheduleFacts", () => {
  it("names every count the tick can produce with an allowed fact key", () => {
    const counts = {
      scheduled: 1,
      due: 1,
      deferred: 0,
      stored: 1,
      alreadyFiled: 1,
      deletedByOwner: 1,
      quotaExceeded: 1,
      tooLarge: 1,
      noSelection: 1,
      failed: 1,
      moduleOff: 1,
      gone: 1,
    };
    const facts = reportScheduleFacts(counts);
    // Every count, plus the three item facts every fan-out pass reports.
    expect(Object.keys(facts)).toHaveLength(Object.keys(counts).length + 3);
    expect(facts).toMatchObject({
      items_attempted: 1,
      items_failed: 1,
      partial_failed: true,
    });
    for (const key of Object.keys(facts)) {
      expect(JOB_FACT_ALLOWLIST.has(key), key).toBe(true);
    }
  });
});
