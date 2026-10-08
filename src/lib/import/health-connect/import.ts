/**
 * Import one Health Connect export database for one account.
 *
 * The worker hands over the extracted `health_connect_export.db`; this module
 * reads it (`reader.ts`), maps each record (`mapper.ts`) and writes HealthLog
 * rows under source `HEALTH_CONNECT`. Everything is bounded: the SQLite side
 * is walked in batches of 500 and aggregated in SQL, and every write is a
 * batch of at most 500 rows, so the heap holds one batch and a handful of
 * small per-import maps (apps, devices, sleep and exercise sessions), never a
 * table.
 *
 * What becomes what:
 *   - Spot readings (weight, body fat, lean mass, blood pressure as two rows,
 *     resting heart rate, RMSSD, SpO2, respiratory rate, glucose, body
 *     temperature, VO2 max): one row each, keyed `hc:<uuid>`.
 *   - Steps, active energy and distance: one total per local day, from one
 *     app per day — the first the person's Health Connect priority list names
 *     for activity, else the app with the largest total. Summing every app
 *     would count a step the phone and the watch both saw twice.
 *   - Heart rate: per-minute samples of the last 90 days as raw rows, older
 *     ones as hourly means (min and max kept), one app per hour by the vitals
 *     priority. The Apple Health retention fold only folds Apple Health rows,
 *     so this import folds its own history as it writes it.
 *   - Sleep: one row per stage (`sleep-stage-map.ts`), a session without
 *     stages as one asleep row; of two overlapping sessions from different
 *     apps the higher-ranked app's is kept.
 *   - Exercise sessions: workouts, the raw exercise type kept on metadata;
 *     overlapping sessions from different apps resolve the same way.
 *   - Menstruation flow and periods: one cycle day-log per day, never over a
 *     day the person (or another source) already logged.
 *   - Hydration and micronutrients: daily nutrient totals, behind the opt-in
 *     nutrients module like every other nutrient ingest.
 *   Left out on purpose: dietary energy and macronutrients, exercise routes,
 *   planned exercise, access logs, and every record of an app whose data
 *   HealthLog already receives through a connected integration
 *   (`skip-packages.ts`).
 *
 * Re-importing the same export, or a later one that overlaps it, writes
 * nothing twice: spot rows and stages are keyed by the record's UUID, day
 * totals and hourly means by their `stats:` id. A record whose value changed
 * since the last import is updated; a row the person deleted stays deleted.
 *
 * Privacy: the result carries counts only, per type and per app. No value,
 * no timestamp and nothing a person typed (notes, titles) leaves this module.
 */
import type {
  FlowLevel,
  GlucoseContext,
  MeasurementType,
  Prisma,
  PrismaClient,
  SleepStage,
} from "@/generated/prisma/client";
import { insertNewMeasurementRows } from "@/lib/export/measurement-bulk-insert";
import {
  measuredAtMatch,
  MEASURED_AT_TOLERANCE_MS,
  valuesMatch,
} from "@/lib/measurements/cross-source-merge";
import { reconcileExternalMeasurement } from "@/lib/measurements/reconcile-external-measurement";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { validateMeasurementRange } from "@/lib/validations/measurement";
import { isModuleEnabled } from "@/lib/modules/gate";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import { NUTRIENT_CATALOG, type NutrientCode } from "@/lib/nutrients/catalog";

import {
  hcInt,
  hcNumber,
  hcUuid,
  openHealthConnectDb,
  type HealthConnectDb,
  type HcRow,
} from "./reader";
import {
  AppRanking,
  DAILY_SUM_SPECS,
  HC_CATEGORY,
  HYDRATION_ML_PER_LITRE,
  INSTANT_OPTIONAL_COLUMNS,
  INSTANT_SPECS,
  NUTRITION_COLUMNS,
  dayKeyFromEpochDay,
  deviceClassFromHc,
  hcDailyStatsExternalId,
  hcExternalId,
  hcHourlyPulseExternalId,
  hcUnit,
  mapHealthConnectSportType,
} from "./mapper";
import {
  isKnownSleepStage,
  mapHealthConnectSleepStage,
} from "./sleep-stage-map";
import { packagesToSkip, type DirectIntegration } from "./skip-packages";

const SOURCE = "HEALTH_CONNECT" as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Heart-rate samples newer than this stay per-sample; older ones fold. */
export const HC_RAW_PULSE_WINDOW_MS = 90 * DAY_MS;

/** Rows written per statement batch. */
const WRITE_BATCH = 500;

/** A period longer than this many days is clipped, not trusted. */
const MAX_PERIOD_DAYS = 15;

/** Per-type outcome counts. */
export interface HealthConnectTypeStat {
  read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

/** The terminal envelope stored on `ImportJob.result`. Counts only. */
export interface HealthConnectImportResult {
  kind: "health_connect";
  userVersion: number;
  perType: Record<string, HealthConnectTypeStat>;
  /** Records read per app (package name), and the apps left out. */
  perApp: Record<string, { records: number; leftOut: boolean }>;
  workouts: {
    read: number;
    inserted: number;
    unchanged: number;
    overlapping: number;
  };
  sleep: { sessions: number; overlapping: number };
  cycle: {
    days: number;
    written: number;
    keptExisting: number;
    failed: number;
    moduleOff: boolean;
  };
  nutrients: {
    entries: number;
    written: number;
    unchanged: number;
    outOfRange: number;
    moduleOff: boolean;
  };
  /** Why rows were left out, `<type>::<reason>` or `<reason>`, with counts. */
  skipped: Record<string, number>;
  /** Codes for parts of the file the importer could not read. */
  warnings: string[];
  totals: { recordsRead: number; rowsUpserted: number; durationMs: number };
  /** Earliest and latest instant written, for the rollup refold. */
  measuredSpan: { from: string; to: string } | null;
}

/** Live counters the worker mirrors onto the job row. */
export interface HealthConnectImportProgress {
  currentPhase: "parsing" | "upserting";
  recordsRead: number;
  rowsUpserted: number;
  percent: number | null;
  elapsedMs: number;
}

export interface ImportHealthConnectOptions {
  prisma: PrismaClient;
  dbPath: string;
  userId: string;
  /** The account's zone, for the instant a day total is anchored at. */
  userTimezone: string;
  /** Integrations the account has connected; their apps are left out. */
  connectedIntegrations: readonly DirectIntegration[];
  /** Injectable clock for the 90-day raw heart-rate window. */
  now?: Date;
  onProgress?: (snapshot: HealthConnectImportProgress) => Promise<void>;
}

/** One measurement on its way to the table. */
interface PendingRow {
  type: MeasurementType;
  value: number;
  valueMin?: number | null;
  valueMax?: number | null;
  measuredAt: Date;
  externalId: string;
  sleepStage: SleepStage | null;
  glucoseContext?: GlucoseContext | null;
  deviceType: string | null;
}

/**
 * Read `dbPath` and write it for `userId`. Throws `HealthConnectImportError`
 * for a file it refuses; any other throw is a database failure part-way, and
 * what was written before it stays (every write is idempotent, so the same
 * upload can simply be imported again).
 */
export async function importHealthConnectExport(
  options: ImportHealthConnectOptions,
): Promise<HealthConnectImportResult> {
  const startedAt = Date.now();
  const hc = openHealthConnectDb(options.dbPath);
  try {
    const run = new ImportRun(hc, options, startedAt);
    await run.execute();
    return run.result();
  } finally {
    hc.close();
  }
}

class ImportRun {
  private readonly prisma: PrismaClient;
  private readonly userId: string;
  private readonly tz: string;
  private readonly now: Date;
  private readonly apps = new Map<number, string>();
  private readonly leftOutApps = new Set<number>();
  private readonly devices = new Map<number, string | null>();
  private ranking = new AppRanking([]);
  private readonly perType: Record<string, HealthConnectTypeStat> = {};
  private readonly perApp: HealthConnectImportResult["perApp"] = {};
  private readonly skipped: Record<string, number> = {};
  private readonly workouts = {
    read: 0,
    inserted: 0,
    unchanged: 0,
    overlapping: 0,
  };
  private readonly sleep = { sessions: 0, overlapping: 0 };
  private readonly cycle = {
    days: 0,
    written: 0,
    keptExisting: 0,
    failed: 0,
    moduleOff: false,
  };
  private readonly nutrients = {
    entries: 0,
    written: 0,
    unchanged: 0,
    outOfRange: 0,
    moduleOff: false,
  };
  private recordsRead = 0;
  private rowsUpserted = 0;
  private spanFrom: number | null = null;
  private spanTo: number | null = null;
  private lastProgressAt = 0;

  constructor(
    private readonly hc: HealthConnectDb,
    private readonly options: ImportHealthConnectOptions,
    private readonly startedAt: number,
  ) {
    this.prisma = options.prisma;
    this.userId = options.userId;
    this.tz = options.userTimezone;
    this.now = options.now ?? new Date();
  }

  async execute(): Promise<void> {
    this.loadApps();
    this.loadDevices();
    this.loadRanking();
    for (const spec of INSTANT_SPECS) await this.importInstant(spec);
    await this.importPulse();
    await this.importSleep();
    await this.importWorkouts();
    for (const spec of DAILY_SUM_SPECS) await this.importDailySum(spec);
    await this.importNutrients();
    await this.importCycle();
    await this.progress(true);
  }

  result(): HealthConnectImportResult {
    return {
      kind: "health_connect",
      userVersion: this.hc.userVersion,
      perType: this.perType,
      perApp: this.perApp,
      workouts: this.workouts,
      sleep: this.sleep,
      cycle: this.cycle,
      nutrients: this.nutrients,
      skipped: this.skipped,
      warnings: this.hc.warnings,
      totals: {
        recordsRead: this.recordsRead,
        rowsUpserted: this.rowsUpserted,
        durationMs: Date.now() - this.startedAt,
      },
      measuredSpan:
        this.spanFrom !== null && this.spanTo !== null
          ? {
              from: new Date(this.spanFrom).toISOString(),
              to: new Date(this.spanTo).toISOString(),
            }
          : null,
    };
  }

  // ── Lookups ─────────────────────────────────────────────────────────────

  private loadApps(): void {
    const skip = packagesToSkip(this.options.connectedIntegrations);
    for (const row of this.hc.all(
      "SELECT row_id, package_name FROM application_info_table",
    )) {
      const id = hcInt(row.row_id);
      const pkg = typeof row.package_name === "string" ? row.package_name : "";
      if (id === null || pkg === "") continue;
      this.apps.set(id, pkg);
      if (skip.has(pkg)) this.leftOutApps.add(id);
    }
  }

  private loadDevices(): void {
    if (!this.hc.usable("device_info_table", ["row_id", "device_type"])) return;
    for (const row of this.hc.all(
      "SELECT row_id, device_type FROM device_info_table",
    )) {
      const id = hcInt(row.row_id);
      if (id !== null) {
        this.devices.set(id, deviceClassFromHc(hcInt(row.device_type)));
      }
    }
  }

  private loadRanking(): void {
    if (
      !this.hc.usable("health_data_category_priority_table", [
        "health_data_category",
        "app_id_priority_order",
      ])
    ) {
      return;
    }
    this.ranking = new AppRanking(
      this.hc
        .all(
          "SELECT health_data_category AS category, app_id_priority_order AS ord FROM health_data_category_priority_table",
        )
        .map((row) => ({ category: hcInt(row.category), order: row.ord })),
    );
  }

  /**
   * Count a record against its app and answer whether it may be imported.
   * Records of an app the account receives directly are counted and left
   * out; a record without a known app is imported (Health Connect keeps the
   * app row as long as any record points at it, so this is a damaged file).
   */
  private admit(appId: number | null, records = 1): boolean {
    const pkg =
      appId === null ? "unknown" : (this.apps.get(appId) ?? "unknown");
    const leftOut = appId !== null && this.leftOutApps.has(appId);
    const entry = (this.perApp[pkg] ??= { records: 0, leftOut });
    entry.records += records;
    this.recordsRead += records;
    if (leftOut) {
      this.skip("connected_integration", records);
      return false;
    }
    return true;
  }

  private device(id: unknown): string | null {
    const n = hcInt(id);
    return n === null ? null : (this.devices.get(n) ?? null);
  }

  private stat(type: string): HealthConnectTypeStat {
    return (this.perType[type] ??= {
      read: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    });
  }

  private skip(reason: string, count = 1, type?: string): void {
    const key = type ? `${type}::${reason}` : reason;
    this.skipped[key] = (this.skipped[key] ?? 0) + count;
    if (type) this.stat(type).skipped += count;
  }

  private widen(at: Date): void {
    const t = at.getTime();
    if (this.spanFrom === null || t < this.spanFrom) this.spanFrom = t;
    if (this.spanTo === null || t > this.spanTo) this.spanTo = t;
  }

  private async progress(force = false): Promise<void> {
    if (!this.options.onProgress) return;
    const now = Date.now();
    if (!force && now - this.lastProgressAt < 1000) return;
    this.lastProgressAt = now;
    await this.options.onProgress({
      currentPhase: "upserting",
      recordsRead: this.recordsRead,
      rowsUpserted: this.rowsUpserted,
      percent: null,
      elapsedMs: now - this.startedAt,
    });
  }

  // ── Spot readings ───────────────────────────────────────────────────────

  private async importInstant(
    spec: (typeof INSTANT_SPECS)[number],
  ): Promise<void> {
    const common = ["uuid", "time", "app_info_id"];
    if (!this.hc.usable(spec.table, [...common, ...spec.columns])) return;
    const cols = this.hc.columns(spec.table)!;
    const optional = (INSTANT_OPTIONAL_COLUMNS[spec.table] ?? []).filter((c) =>
      cols.has(c),
    );
    const device = cols.has("device_info_id") ? ", device_info_id" : "";
    const select = [...common, ...spec.columns, ...optional].join(", ");
    // `spec.table` and the columns are the closed names in mapper.ts.
    const sql = `SELECT ${select}${device} FROM ${spec.table} ORDER BY time, app_info_id`;
    const sink = new MeasurementSink(this, true);
    const collapse = new NaturalKeyCollapse(sink, this, spec.category);
    for (const batch of this.hc.batches(sql)) {
      for (const row of batch) {
        const appId = hcInt(row.app_info_id);
        if (!this.admit(appId)) continue;
        const uuid = hcUuid(row.uuid);
        const time = hcInt(row.time);
        if (!uuid || time === null) {
          this.skip("unreadable_record", 1, spec.table);
          continue;
        }
        const measuredAt = new Date(time);
        for (const mapped of spec.map(row)) {
          this.stat(mapped.type).read += 1;
          await collapse.push(
            {
              type: mapped.type,
              value: mapped.value,
              measuredAt,
              externalId: hcExternalId(uuid),
              sleepStage: null,
              glucoseContext: mapped.glucoseContext ?? null,
              deviceType: this.device(row.device_info_id),
            },
            appId,
          );
        }
      }
    }
    await collapse.end();
    await sink.flush();
  }

  // ── Heart rate ──────────────────────────────────────────────────────────

  private async importPulse(): Promise<void> {
    if (
      !this.hc.usable("heart_rate_record_table", [
        "row_id",
        "uuid",
        "app_info_id",
        "start_zone_offset",
      ]) ||
      !this.hc.usable("heart_rate_record_series_table", [
        "parent_key",
        "beats_per_minute",
        "epoch_millis",
      ])
    ) {
      return;
    }
    const cutoff = this.now.getTime() - HC_RAW_PULSE_WINDOW_MS;
    await this.importHourlyPulse(cutoff);
    await this.importRawPulse(cutoff);
  }

  /** Samples before `cutoff`, folded in SQLite to one mean per local hour. */
  private async importHourlyPulse(cutoff: number): Promise<void> {
    const sql = `
      SELECT (s.epoch_millis + p.start_zone_offset * 1000) / 3600000 AS lh,
             p.app_info_id AS app,
             AVG(s.beats_per_minute) AS mean,
             MIN(s.beats_per_minute) AS lo,
             MAX(s.beats_per_minute) AS hi,
             COUNT(*) AS n,
             MIN(p.start_zone_offset) AS off
      FROM heart_rate_record_series_table s
      JOIN heart_rate_record_table p ON p.row_id = s.parent_key
      WHERE s.epoch_millis < ?
      GROUP BY lh, app
      ORDER BY lh, app`;
    const sink = new MeasurementSink(this, false, true);
    let hour: number | null = null;
    let group: HcRow[] = [];
    const settle = async () => {
      if (hour === null || group.length === 0) return;
      let best: HcRow | null = null;
      for (const row of group) {
        const appId = hcInt(row.app);
        const n = hcInt(row.n) ?? 0;
        if (!this.admit(appId, n)) continue;
        if (
          !best ||
          this.ranking.better(
            HC_CATEGORY.VITALS,
            appId ?? 0,
            hcInt(best.app) ?? 0,
          ) === (appId ?? 0)
        ) {
          best = row;
        }
      }
      group = [];
      if (!best) return;
      const mean = hcNumber(best.mean);
      const off = hcInt(best.off) ?? 0;
      if (mean === null) return;
      const lh = hour;
      const dayKey = dayKeyFromEpochDay(Math.floor(lh / 24));
      this.stat("PULSE").read += 1;
      await sink.push({
        type: "PULSE",
        value: Math.round(mean * 10) / 10,
        valueMin: hcNumber(best.lo),
        valueMax: hcNumber(best.hi),
        // The middle of the local hour, in the record's own zone.
        measuredAt: new Date(lh * HOUR_MS + HOUR_MS / 2 - off * 1000),
        externalId: hcHourlyPulseExternalId(dayKey, ((lh % 24) + 24) % 24),
        sleepStage: null,
        deviceType: null,
      });
    };
    for (const batch of this.hc.batches(sql, [cutoff])) {
      for (const row of batch) {
        const lh = hcInt(row.lh);
        if (lh === null) continue;
        if (lh !== hour) {
          await settle();
          hour = lh;
        }
        group.push(row);
      }
    }
    await settle();
    await sink.flush();
  }

  /** Samples from `cutoff` on, one row each, from one app per local hour. */
  private async importRawPulse(cutoff: number): Promise<void> {
    const chosen = new Map<number, number>();
    for (const row of this.hc.all(
      `SELECT (s.epoch_millis + p.start_zone_offset * 1000) / 3600000 AS lh,
              p.app_info_id AS app
       FROM heart_rate_record_series_table s
       JOIN heart_rate_record_table p ON p.row_id = s.parent_key
       WHERE s.epoch_millis >= ?
       GROUP BY lh, app`,
      [cutoff],
    )) {
      const lh = hcInt(row.lh);
      const app = hcInt(row.app);
      if (lh === null || app === null || this.leftOutApps.has(app)) continue;
      const current = chosen.get(lh);
      chosen.set(
        lh,
        current === undefined
          ? app
          : this.ranking.better(HC_CATEGORY.VITALS, current, app),
      );
    }
    const sql = `
      SELECT p.uuid AS uuid, p.app_info_id AS app, p.start_zone_offset AS off,
             s.epoch_millis AS t, s.beats_per_minute AS bpm${
               this.hc.columns("heart_rate_record_table")!.has("device_info_id")
                 ? ", p.device_info_id AS dev"
                 : ""
             }
      FROM heart_rate_record_series_table s
      JOIN heart_rate_record_table p ON p.row_id = s.parent_key
      WHERE s.epoch_millis >= ?
      ORDER BY s.epoch_millis, p.app_info_id`;
    const sink = new MeasurementSink(this, false);
    const collapse = new NaturalKeyCollapse(sink, this, HC_CATEGORY.VITALS);
    for (const batch of this.hc.batches(sql, [cutoff])) {
      for (const row of batch) {
        const appId = hcInt(row.app);
        if (!this.admit(appId)) continue;
        const t = hcInt(row.t);
        const bpm = hcNumber(row.bpm);
        const uuid = hcUuid(row.uuid);
        if (t === null || bpm === null || !uuid) {
          this.skip("unreadable_record", 1, "PULSE");
          continue;
        }
        const lh = Math.floor((t + (hcInt(row.off) ?? 0) * 1000) / HOUR_MS);
        if (appId !== null && chosen.get(lh) !== appId) {
          this.skip("lower_priority_app", 1, "PULSE");
          continue;
        }
        this.stat("PULSE").read += 1;
        await collapse.push(
          {
            type: "PULSE",
            value: bpm,
            measuredAt: new Date(t),
            externalId: hcExternalId(uuid, t),
            sleepStage: null,
            deviceType: this.device(row.dev),
          },
          appId,
        );
      }
    }
    await collapse.end();
    await sink.flush();
  }

  // ── Sleep ───────────────────────────────────────────────────────────────

  private async importSleep(): Promise<void> {
    if (
      !this.hc.usable("sleep_session_record_table", [
        "row_id",
        "uuid",
        "app_info_id",
        "start_time",
        "end_time",
      ])
    ) {
      return;
    }
    const hasDevice = this.hc
      .columns("sleep_session_record_table")!
      .has("device_info_id");
    const sessions: Array<{
      rowId: number;
      uuid: string;
      app: number | null;
      start: number;
      end: number;
      device: string | null;
    }> = [];
    for (const batch of this.hc.batches(
      `SELECT row_id, uuid, app_info_id, start_time, end_time${hasDevice ? ", device_info_id" : ""}
       FROM sleep_session_record_table ORDER BY start_time`,
    )) {
      for (const row of batch) {
        const app = hcInt(row.app_info_id);
        if (!this.admit(app)) continue;
        const rowId = hcInt(row.row_id);
        const uuid = hcUuid(row.uuid);
        const start = hcInt(row.start_time);
        const end = hcInt(row.end_time);
        if (
          rowId === null ||
          !uuid ||
          start === null ||
          end === null ||
          end <= start
        ) {
          this.skip("unreadable_record", 1, "SLEEP_DURATION");
          continue;
        }
        sessions.push({
          rowId,
          uuid,
          app,
          start,
          end,
          device: this.device(row.device_info_id),
        });
      }
    }
    const kept = keepNonOverlapping(sessions, (s) =>
      this.ranking.rank(HC_CATEGORY.SLEEP, s.app ?? 0),
    );
    this.sleep.sessions = kept.length;
    this.sleep.overlapping = sessions.length - kept.length;
    if (sessions.length > kept.length) {
      this.skip(
        "overlapping_session",
        sessions.length - kept.length,
        "SLEEP_DURATION",
      );
    }
    const byRow = new Map(kept.map((s) => [s.rowId, s]));

    // Which kept sessions have stages, and whether any is a classified one.
    const stageInfo = new Map<number, boolean>();
    const stagesUsable = this.hc.usable("sleep_stages_table", [
      "parent_key",
      "stage_start_time",
      "stage_end_time",
      "stage_type",
    ]);
    if (stagesUsable) {
      for (const row of this.hc.all(
        "SELECT parent_key AS k, group_concat(DISTINCT stage_type) AS types FROM sleep_stages_table GROUP BY parent_key",
      )) {
        const key = hcInt(row.k);
        if (key === null || !byRow.has(key)) continue;
        const types = String(row.types ?? "")
          .split(",")
          .map((t) => Number(t));
        stageInfo.set(
          key,
          types.some((t) => isKnownSleepStage(t)),
        );
      }
    }

    const sink = new MeasurementSink(this, false);
    // A session with no stages is one stretch of sleep.
    const bare = new NaturalKeyCollapse(sink, this, HC_CATEGORY.SLEEP);
    for (const s of [...kept].sort((a, b) => a.end - b.end)) {
      if (stageInfo.has(s.rowId)) continue;
      this.stat("SLEEP_DURATION").read += 1;
      await bare.push(
        {
          type: "SLEEP_DURATION",
          value: (s.end - s.start) / 60_000,
          measuredAt: new Date(s.end),
          externalId: hcExternalId(s.uuid),
          sleepStage: "ASLEEP",
          deviceType: s.device,
        },
        s.app,
      );
    }
    await bare.end();

    if (stagesUsable) {
      const staged = new NaturalKeyCollapse(sink, this, HC_CATEGORY.SLEEP);
      for (const batch of this.hc.batches(
        "SELECT parent_key AS k, stage_start_time AS s, stage_end_time AS e, stage_type AS t FROM sleep_stages_table ORDER BY stage_end_time, parent_key",
      )) {
        for (const row of batch) {
          const session = byRow.get(hcInt(row.k) ?? -1);
          if (!session) continue;
          const start = hcInt(row.s);
          const end = hcInt(row.e);
          const type = hcInt(row.t);
          this.stat("SLEEP_DURATION").read += 1;
          if (start === null || end === null || type === null || end <= start) {
            this.skip("unreadable_record", 1, "SLEEP_DURATION");
            continue;
          }
          const mapped = mapHealthConnectSleepStage(
            type,
            stageInfo.get(session.rowId) ?? false,
          );
          if ("skip" in mapped) {
            this.skip(mapped.skip, 1, "SLEEP_DURATION");
            continue;
          }
          await staged.push(
            {
              type: "SLEEP_DURATION",
              value: (end - start) / 60_000,
              measuredAt: new Date(end),
              externalId: hcExternalId(session.uuid, start),
              sleepStage: mapped.stage,
              deviceType: session.device,
            },
            session.app,
          );
        }
      }
      await staged.end();
    }
    await sink.flush();
  }

  // ── Workouts ────────────────────────────────────────────────────────────

  private async importWorkouts(): Promise<void> {
    if (
      !this.hc.usable("exercise_session_record_table", [
        "uuid",
        "app_info_id",
        "start_time",
        "end_time",
        "exercise_type",
      ])
    ) {
      return;
    }
    const sessions: Array<{
      uuid: string;
      app: number | null;
      start: number;
      end: number;
      exerciseType: number | null;
    }> = [];
    for (const batch of this.hc.batches(
      "SELECT uuid, app_info_id, start_time, end_time, exercise_type FROM exercise_session_record_table ORDER BY start_time",
    )) {
      for (const row of batch) {
        const app = hcInt(row.app_info_id);
        if (!this.admit(app)) continue;
        this.workouts.read += 1;
        const uuid = hcUuid(row.uuid);
        const start = hcInt(row.start_time);
        const end = hcInt(row.end_time);
        if (!uuid || start === null || end === null || end <= start) {
          this.skip("unreadable_record", 1, "WORKOUT");
          continue;
        }
        sessions.push({
          uuid,
          app,
          start,
          end,
          exerciseType: hcInt(row.exercise_type),
        });
      }
    }
    const kept = keepNonOverlapping(sessions, (s) =>
      this.ranking.rank(HC_CATEGORY.ACTIVITY, s.app ?? 0),
    );
    this.workouts.overlapping = sessions.length - kept.length;
    for (let at = 0; at < kept.length; at += WRITE_BATCH) {
      const chunk = kept.slice(at, at + WRITE_BATCH);
      const data: Prisma.WorkoutCreateManyInput[] = chunk.map((s) => ({
        userId: this.userId,
        sportType: mapHealthConnectSportType(s.exerciseType),
        startedAt: new Date(s.start),
        endedAt: new Date(s.end),
        durationSec: Math.round((s.end - s.start) / 1000),
        source: SOURCE,
        externalId: hcExternalId(s.uuid),
        // The raw Health Connect type, so the sport mapping stays reversible.
        metadata: { healthConnectExerciseType: s.exerciseType },
      }));
      const created = await this.prisma.workout.createMany({
        data,
        skipDuplicates: true,
      });
      this.workouts.inserted += created.count;
      this.workouts.unchanged += chunk.length - created.count;
      this.rowsUpserted += created.count;
      for (const s of chunk) {
        this.widen(new Date(s.start));
        this.widen(new Date(s.end));
      }
      await this.progress();
    }
  }

  // ── Day totals ──────────────────────────────────────────────────────────

  private async importDailySum(
    spec: (typeof DAILY_SUM_SPECS)[number],
  ): Promise<void> {
    if (
      !this.hc.usable(spec.table, ["local_date", "app_info_id", spec.column])
    ) {
      return;
    }
    const sql = `SELECT local_date AS day, app_info_id AS app, SUM(${spec.column}) AS total, COUNT(*) AS n
      FROM ${spec.table} GROUP BY local_date, app_info_id ORDER BY local_date, app_info_id`;
    const days: Array<{ dayKey: string; value: number }> = [];
    for (const day of this.dailyGroups(sql, HC_CATEGORY.ACTIVITY)) {
      this.stat(spec.type).read += 1;
      days.push({ dayKey: day.dayKey, value: day.total * spec.factor });
      if (days.length >= WRITE_BATCH) {
        await this.writeDayTotals(spec.type, days.splice(0));
      }
    }
    await this.writeDayTotals(spec.type, days);
  }

  /**
   * Walk `sql` (rows of `day`, `app`, `total`, `n`, ordered by day) and yield
   * one total per day from the app the category's ranking picks.
   */
  private *dailyGroups(
    sql: string,
    category: number,
  ): Generator<{ dayKey: string; total: number; app: number }> {
    let day: number | null = null;
    let candidates: Array<{ appId: number; total: number }> = [];
    const pick = () => {
      const best = this.ranking.pickDaily(category, candidates);
      candidates = [];
      return best;
    };
    for (const batch of this.hc.batches(sql)) {
      for (const row of batch) {
        const d = hcInt(row.day);
        const app = hcInt(row.app) ?? 0;
        const total = hcNumber(row.total);
        const n = hcInt(row.n) ?? 0;
        if (d === null) continue;
        if (d !== day) {
          const best = day === null ? null : pick();
          if (best && day !== null) {
            yield {
              dayKey: dayKeyFromEpochDay(day),
              total: best.total,
              app: best.appId,
            };
          }
          day = d;
        }
        if (!this.admit(app, n) || total === null) continue;
        candidates.push({ appId: app, total });
      }
    }
    const best = day === null ? null : pick();
    if (best && day !== null) {
      yield {
        dayKey: dayKeyFromEpochDay(day),
        total: best.total,
        app: best.appId,
      };
    }
  }

  private async writeDayTotals(
    type: MeasurementType,
    days: ReadonlyArray<{ dayKey: string; value: number }>,
  ): Promise<void> {
    if (days.length === 0) return;
    const ids = days.map((d) => hcDailyStatsExternalId(type, d.dayKey));
    const existing = new Map(
      (
        await this.prisma.measurement.findMany({
          where: {
            userId: this.userId,
            type,
            source: SOURCE,
            externalId: { in: ids },
          },
          select: { externalId: true, value: true, deletedAt: true },
        })
      ).map((row) => [row.externalId, row]),
    );
    const stat = this.stat(type);
    for (let i = 0; i < days.length; i++) {
      const { dayKey, value } = days[i];
      if (validateMeasurementRange(type, value) !== null) {
        this.skip("out_of_range", 1, type);
        continue;
      }
      const prior = existing.get(ids[i]);
      if (
        prior &&
        prior.deletedAt === null &&
        valuesMatch(prior.value, value)
      ) {
        stat.unchanged += 1;
        continue;
      }
      const measuredAt = canonicalDailyTimestamp(dayKey, this.tz);
      const verdict = await this.prisma.$transaction((tx) =>
        reconcileExternalMeasurement(
          tx,
          {
            userId: this.userId,
            type,
            value,
            unit: hcUnit(type),
            source: SOURCE,
            measuredAt,
            externalId: ids[i],
            externalSourceVersion: null,
            sleepStage: null,
            deviceType: null,
          },
          { exactExternalMatch: "update" },
        ),
      );
      if (verdict.status === "inserted") {
        stat.inserted += 1;
      } else if (
        verdict.status === "updated" ||
        verdict.status === "resurrected"
      ) {
        stat.updated += 1;
      } else if (verdict.status === "duplicate") {
        stat.unchanged += 1;
        continue;
      } else {
        this.skip(
          verdict.status === "rejected_range" ? "out_of_range" : "write_failed",
          1,
          type,
        );
        continue;
      }
      this.rowsUpserted += 1;
      this.widen(measuredAt);
    }
    await this.progress();
  }

  // ── Nutrients ───────────────────────────────────────────────────────────

  private async importNutrients(): Promise<void> {
    const hydration = this.hc.usable("hydration_record_table", [
      "local_date",
      "app_info_id",
      "volume",
    ]);
    const nutritionBase = this.hc.usable("nutrition_record_table", [
      "local_date",
      "app_info_id",
    ]);
    if (!hydration && !nutritionBase) return;
    if (!(await isModuleEnabled(this.userId, "nutrients"))) {
      this.nutrients.moduleOff = true;
      // Counted, so the person sees why nothing arrived.
      for (const table of [
        "hydration_record_table",
        "nutrition_record_table",
      ] as const) {
        if (!this.hc.columns(table)) continue;
        const [row] = this.hc.all(`SELECT COUNT(*) AS n FROM ${table}`);
        const n = hcInt(row?.n) ?? 0;
        this.recordsRead += n;
        if (n > 0) this.skip("nutrients_module_off", n);
      }
      return;
    }

    const entries: Array<{ day: string; code: NutrientCode; amount: number }> =
      [];
    const flushIfFull = async () => {
      if (entries.length >= WRITE_BATCH)
        await this.writeNutrients(entries.splice(0));
    };

    if (hydration) {
      for (const day of this.dailyGroups(
        `SELECT local_date AS day, app_info_id AS app, SUM(volume) AS total, COUNT(*) AS n
         FROM hydration_record_table GROUP BY local_date, app_info_id ORDER BY local_date, app_info_id`,
        HC_CATEGORY.NUTRITION,
      )) {
        entries.push({
          day: day.dayKey,
          code: "water",
          amount: day.total * HYDRATION_ML_PER_LITRE,
        });
        await flushIfFull();
      }
    }

    if (nutritionBase) {
      const cols = this.hc.columns("nutrition_record_table")!;
      const present = (
        Object.entries(NUTRITION_COLUMNS) as Array<
          [NutrientCode, { column: string; factor: number }]
        >
      ).filter(([, def]) => cols.has(def.column));
      if (present.length > 0) {
        // One app per day (the one with the most meals logged that day, after
        // the priority list), then that app's sum per nutrient.
        const sums = present
          .map(([code, def]) => `SUM(${def.column}) AS "${code}"`)
          .join(", ");
        const sql = `SELECT local_date AS day, app_info_id AS app, COUNT(*) AS n, ${sums}
          FROM nutrition_record_table GROUP BY local_date, app_info_id ORDER BY local_date, app_info_id`;
        let day: number | null = null;
        let rows: HcRow[] = [];
        const settle = async () => {
          if (day === null || rows.length === 0) return;
          const best = this.ranking.pickDaily(
            HC_CATEGORY.NUTRITION,
            rows.map((r) => ({
              appId: hcInt(r.app) ?? 0,
              total: hcInt(r.n) ?? 0,
              row: r,
            })),
          );
          rows = [];
          if (!best) return;
          for (const [code, def] of present) {
            const grams = hcNumber(best.row[code]);
            if (grams === null || grams <= 0) continue;
            entries.push({
              day: dayKeyFromEpochDay(day),
              code,
              amount: grams * def.factor,
            });
          }
          await flushIfFull();
        };
        for (const batch of this.hc.batches(sql)) {
          for (const row of batch) {
            const d = hcInt(row.day);
            if (d === null) continue;
            if (d !== day) {
              await settle();
              day = d;
            }
            if (!this.admit(hcInt(row.app), hcInt(row.n) ?? 0)) continue;
            rows.push(row);
          }
        }
        await settle();
      }
    }
    await this.writeNutrients(entries);
  }

  private async writeNutrients(
    entries: ReadonlyArray<{ day: string; code: NutrientCode; amount: number }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const valid = entries.filter((e) => {
      const amount = Math.round(e.amount * 1000) / 1000;
      if (amount > NUTRIENT_CATALOG[e.code].plausibleDailyMax) {
        this.nutrients.outOfRange += 1;
        this.skip("out_of_range", 1, `nutrient:${e.code}`);
        return false;
      }
      return true;
    });
    this.nutrients.entries += entries.length;
    if (valid.length === 0) return;
    const existing = new Map(
      (
        await this.prisma.nutrientIntakeDay.findMany({
          where: {
            userId: this.userId,
            source: SOURCE,
            OR: valid.map((e) => ({ day: e.day, nutrient: e.code })),
          },
          select: { day: true, nutrient: true, amount: true },
        })
      ).map((r) => [`${r.day}|${r.nutrient}`, r.amount]),
    );
    const fresh: Prisma.NutrientIntakeDayCreateManyInput[] = [];
    for (const e of valid) {
      const amount = Math.round(e.amount * 1000) / 1000;
      const prior = existing.get(`${e.day}|${e.code}`);
      if (prior === undefined) {
        fresh.push({
          userId: this.userId,
          day: e.day,
          nutrient: e.code,
          amount,
          unit: NUTRIENT_CATALOG[e.code].unit,
          source: SOURCE,
        });
      } else if (valuesMatch(prior, amount)) {
        this.nutrients.unchanged += 1;
      } else {
        await this.prisma.nutrientIntakeDay.update({
          where: {
            userId_day_nutrient_source: {
              userId: this.userId,
              day: e.day,
              nutrient: e.code,
              source: SOURCE,
            },
          },
          data: { amount },
        });
        this.nutrients.written += 1;
        this.rowsUpserted += 1;
      }
    }
    if (fresh.length > 0) {
      const created = await this.prisma.nutrientIntakeDay.createMany({
        data: fresh,
        skipDuplicates: true,
      });
      this.nutrients.written += created.count;
      this.rowsUpserted += created.count;
    }
    await this.progress();
  }

  // ── Cycle ───────────────────────────────────────────────────────────────

  private async importCycle(): Promise<void> {
    const flowUsable = this.hc.usable("menstruation_flow_record_table", [
      "local_date",
      "app_info_id",
      "flow",
    ]);
    const periodUsable = this.hc.usable("menstruation_period_record_table", [
      "app_info_id",
      "local_date",
      "start_time",
      "end_time",
      "end_zone_offset",
    ]);
    if (!flowUsable && !periodUsable) return;

    const flowByDay = new Map<number, FlowLevel>();
    const order: Record<FlowLevel, number> = {
      NONE: 0,
      SPOTTING: 1,
      LIGHT: 2,
      MEDIUM: 3,
      HEAVY: 4,
    };
    const raise = (day: number, level: FlowLevel) => {
      const current = flowByDay.get(day);
      if (!current || order[level] > order[current]) flowByDay.set(day, level);
    };
    if (flowUsable) {
      for (const row of this.hc.all(
        "SELECT local_date AS day, app_info_id AS app, MAX(flow) AS flow, COUNT(*) AS n FROM menstruation_flow_record_table GROUP BY local_date, app_info_id",
      )) {
        if (!this.admit(hcInt(row.app), hcInt(row.n) ?? 0)) continue;
        const day = hcInt(row.day);
        if (day === null) continue;
        // 1 light, 2 medium, 3 heavy; 0 is "flow of unknown amount", which
        // is at least light, the way the Apple Health mapping reads it.
        const flow = hcInt(row.flow);
        raise(day, flow === 3 ? "HEAVY" : flow === 2 ? "MEDIUM" : "LIGHT");
      }
    }
    if (periodUsable) {
      for (const batch of this.hc.batches(
        "SELECT app_info_id AS app, local_date AS day, end_time AS e, end_zone_offset AS eo FROM menstruation_period_record_table",
      )) {
        for (const row of batch) {
          if (!this.admit(hcInt(row.app))) continue;
          const first = hcInt(row.day);
          const end = hcInt(row.e);
          if (first === null || end === null) continue;
          const last = Math.floor(
            (end + (hcInt(row.eo) ?? 0) * 1000 - 1) / DAY_MS,
          );
          for (
            let d = first;
            d <= Math.min(last, first + MAX_PERIOD_DAYS - 1);
            d++
          ) {
            if (!flowByDay.has(d)) raise(d, "LIGHT");
          }
        }
      }
    }
    if (flowByDay.size === 0) return;
    this.cycle.days = flowByDay.size;
    if (!(await isCycleAvailableForUser(this.userId))) {
      this.cycle.moduleOff = true;
      this.skip("cycle_module_off", flowByDay.size);
      return;
    }

    const days = [...flowByDay.keys()]
      .sort((a, b) => a - b)
      .map((d) => ({
        dayKey: dayKeyFromEpochDay(d),
        flow: flowByDay.get(d)!,
      }));
    const cycles = await this.prisma.menstrualCycle.findMany({
      where: { userId: this.userId, deletedAt: null },
      orderBy: { startDate: "asc" },
      select: { id: true, startDate: true },
    });
    const owningCycle = (date: string): string | null => {
      let id: string | null = null;
      for (const c of cycles) {
        if (c.startDate <= date) id = c.id;
        else break;
      }
      return id;
    };
    const profile = await this.prisma.cycleProfile.findUnique({
      where: { userId: this.userId },
      select: { sensitiveCategoryEncryption: true },
    });
    for (let at = 0; at < days.length; at += WRITE_BATCH) {
      const chunk = days.slice(at, at + WRITE_BATCH);
      const logged = new Map(
        (
          await this.prisma.cycleDayLog.findMany({
            where: {
              userId: this.userId,
              date: { in: chunk.map((d) => d.dayKey) },
            },
            select: { date: true, source: true },
          })
        ).map((r) => [r.date, r.source]),
      );
      for (const { dayKey, flow } of chunk) {
        const prior = logged.get(dayKey);
        // A day already logged by hand or by another source is theirs.
        if (prior !== undefined && prior !== SOURCE) {
          this.cycle.keptExisting += 1;
          continue;
        }
        try {
          const written = await upsertCycleDayLog(
            this.userId,
            {
              date: dayKey,
              flow,
              source: SOURCE,
              externalId: `hccycle:${dayKey}`,
              loggedAt: `${dayKey}T12:00:00.000Z`,
            } as Parameters<typeof upsertCycleDayLog>[1],
            this.tz,
            owningCycle(dayKey),
            profile?.sensitiveCategoryEncryption ?? true,
          );
          if (!written.existed || written.changed) {
            this.cycle.written += 1;
            this.rowsUpserted += 1;
          }
        } catch {
          this.cycle.failed += 1;
        }
      }
      await this.progress();
    }
  }

  // ── Writing measurements ────────────────────────────────────────────────

  /** Write one batch of rows and count what happened to each. */
  async writeMeasurements(
    rows: PendingRow[],
    sameReadingCheck: boolean,
    hourlyPulse: boolean,
  ): Promise<void> {
    let batch = rows.filter((row) => {
      if (validateMeasurementRange(row.type, row.value) !== null) {
        this.skip("out_of_range", 1, row.type);
        return false;
      }
      return true;
    });
    if (sameReadingCheck) batch = await this.withoutOtherSourceTwins(batch);
    if (hourlyPulse) batch = await this.withoutRawPulseHours(batch);
    if (batch.length === 0) return;

    const inserted = await insertNewMeasurementRows(
      this.prisma,
      batch.map((row) => ({
        userId: this.userId,
        type: row.type,
        value: row.value,
        valueMin: row.valueMin ?? null,
        valueMax: row.valueMax ?? null,
        unit: hcUnit(row.type),
        source: SOURCE,
        measuredAt: row.measuredAt,
        externalId: row.externalId,
        externalSourceVersion: null,
        glucoseContext: row.glucoseContext ?? null,
        sleepStage: row.sleepStage,
        deviceType: row.deviceType,
      })),
    );
    const landed = new Set(inserted.map((r) => `${r.type}|${r.externalId}`));
    const rest: PendingRow[] = [];
    for (const row of batch) {
      if (landed.has(`${row.type}|${row.externalId}`)) {
        this.stat(row.type).inserted += 1;
        this.rowsUpserted += 1;
        this.widen(row.measuredAt);
      } else {
        rest.push(row);
      }
    }
    if (rest.length > 0) await this.reconcileExisting(rest);
    await this.progress();
  }

  /**
   * Rows the insert skipped: either this record was imported before (update
   * it when its value changed, leave it when the person deleted it), or
   * another row already holds the same instant.
   */
  private async reconcileExisting(rows: PendingRow[]): Promise<void> {
    const found = await this.prisma.measurement.findMany({
      where: {
        userId: this.userId,
        source: SOURCE,
        type: { in: [...new Set(rows.map((r) => r.type))] },
        externalId: { in: [...new Set(rows.map((r) => r.externalId))] },
      },
      select: {
        id: true,
        type: true,
        externalId: true,
        value: true,
        valueMin: true,
        valueMax: true,
        deletedAt: true,
      },
    });
    const byKey = new Map(found.map((r) => [`${r.type}|${r.externalId}`, r]));
    for (const row of rows) {
      const prior = byKey.get(`${row.type}|${row.externalId}`);
      if (!prior) {
        this.skip("same_instant_exists", 1, row.type);
        continue;
      }
      if (prior.deletedAt !== null) {
        this.skip("deleted_in_healthlog", 1, row.type);
        continue;
      }
      const same =
        valuesMatch(prior.value, row.value) &&
        (prior.valueMin ?? null) === (row.valueMin ?? null) &&
        (prior.valueMax ?? null) === (row.valueMax ?? null);
      if (same) {
        this.stat(row.type).unchanged += 1;
        continue;
      }
      await this.prisma.measurement.update({
        where: { id: prior.id },
        data: {
          value: row.value,
          valueMin: row.valueMin ?? null,
          valueMax: row.valueMax ?? null,
          syncVersion: { increment: 1 },
        },
      });
      this.stat(row.type).updated += 1;
      this.rowsUpserted += 1;
      this.widen(row.measuredAt);
    }
  }

  /**
   * The same reading already stored under another source (same type and
   * value within two seconds) is left out. The connected-integration skip
   * removes the known duplicates by app; this catches what it cannot name,
   * such as a reading typed into HealthLog and into a phone app alike.
   */
  private async withoutOtherSourceTwins(
    rows: PendingRow[],
  ): Promise<PendingRow[]> {
    if (rows.length === 0) return rows;
    let from = Infinity;
    let to = -Infinity;
    for (const row of rows) {
      const t = row.measuredAt.getTime();
      if (t < from) from = t;
      if (t > to) to = t;
    }
    // Spot types only: the dense types (heart rate, sleep) never take this
    // check, so the read is bounded by one batch's window of sparse readings.
    const spotTypes = [...new Set(rows.map((r) => r.type))];
    const others = await this.prisma.measurement.findMany({
      where: {
        userId: this.userId,
        source: { not: SOURCE },
        deletedAt: null,
        type: { in: spotTypes },
        measuredAt: {
          gte: new Date(from - MEASURED_AT_TOLERANCE_MS),
          lte: new Date(to + MEASURED_AT_TOLERANCE_MS),
        },
      },
      select: { type: true, value: true, measuredAt: true },
      orderBy: { measuredAt: "asc" },
    });
    if (others.length === 0) return rows;
    const byType = new Map<string, typeof others>();
    for (const o of others) {
      const list = byType.get(o.type);
      if (list) list.push(o);
      else byType.set(o.type, [o]);
    }
    return rows.filter((row) => {
      const list = byType.get(row.type);
      if (!list) return true;
      const twin = list.some(
        (o) =>
          measuredAtMatch(o.measuredAt, row.measuredAt) &&
          valuesMatch(o.value, row.value),
      );
      if (twin) this.skip("same_reading_other_source", 1, row.type);
      return !twin;
    });
  }

  /**
   * An hourly mean is left out for an hour that already holds raw samples of
   * this import's source. A sample imported raw while it was recent falls
   * past the 90-day window by the next import; folding it then would put the
   * mean beside the samples it summarises.
   */
  private async withoutRawPulseHours(
    rows: PendingRow[],
  ): Promise<PendingRow[]> {
    if (rows.length === 0) return rows;
    let from = Infinity;
    let to = -Infinity;
    for (const row of rows) {
      const t = row.measuredAt.getTime();
      if (t < from) from = t;
      if (t > to) to = t;
    }
    const hours = await this.prisma.$queryRaw<Array<{ h: bigint }>>`
      SELECT DISTINCT floor(extract(epoch FROM measured_at) / 3600)::bigint AS h
      FROM measurements
      WHERE user_id = ${this.userId}
        AND type = 'PULSE'::measurement_type
        AND source = 'HEALTH_CONNECT'::measurement_source
        AND external_id LIKE 'hc:%'
        AND deleted_at IS NULL
        AND measured_at >= ${new Date(from - HOUR_MS)}
        AND measured_at < ${new Date(to + HOUR_MS)}`;
    if (hours.length === 0) return rows;
    const taken = new Set(hours.map((r) => Number(r.h)));
    return rows.filter((row) => {
      // The mean sits mid-hour; its hour spans half an hour either side.
      const start = row.measuredAt.getTime() - HOUR_MS / 2;
      const clash =
        taken.has(Math.floor(start / HOUR_MS)) ||
        taken.has(Math.floor((start + HOUR_MS - 1) / HOUR_MS));
      if (clash) this.skip("hour_already_raw", 1, row.type);
      return !clash;
    });
  }

  /** Called by the collapse when two apps write the same instant. */
  noteCollision(type: string): void {
    this.skip("same_instant_other_app", 1, type);
  }

  rank(category: number, appId: number | null): number {
    return this.ranking.rank(category, appId ?? 0);
  }
}

/** Buffers rows and writes them a batch at a time. */
class MeasurementSink {
  private rows: PendingRow[] = [];

  constructor(
    private readonly run: ImportRun,
    private readonly sameReadingCheck: boolean,
    private readonly hourlyPulse = false,
  ) {}

  async push(row: PendingRow): Promise<void> {
    this.rows.push(row);
    if (this.rows.length >= WRITE_BATCH) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.rows.length === 0) return;
    const rows = this.rows;
    this.rows = [];
    await this.run.writeMeasurements(
      rows,
      this.sameReadingCheck,
      this.hourlyPulse,
    );
  }
}

/**
 * Keeps one row per natural key (type, instant, sleep stage) among rows that
 * arrive ordered by instant. Two apps writing the same type at the same
 * millisecond would otherwise both reach the insert, and the second would be
 * dropped silently by the unique index; here the better-ranked app's row is
 * the one that goes on.
 */
class NaturalKeyCollapse {
  private at: number | null = null;
  private pending = new Map<string, { row: PendingRow; rank: number }>();

  constructor(
    private readonly sink: MeasurementSink,
    private readonly run: ImportRun,
    private readonly category: number,
  ) {}

  async push(row: PendingRow, appId: number | null): Promise<void> {
    const t = row.measuredAt.getTime();
    if (t !== this.at) {
      await this.end();
      this.at = t;
    }
    const key = `${row.type}|${row.sleepStage ?? ""}`;
    const rank = this.run.rank(this.category, appId);
    const held = this.pending.get(key);
    if (!held) {
      this.pending.set(key, { row, rank });
      return;
    }
    this.run.noteCollision(row.type);
    if (rank < held.rank) this.pending.set(key, { row, rank });
  }

  async end(): Promise<void> {
    for (const { row } of this.pending.values()) await this.sink.push(row);
    this.pending.clear();
  }
}

/**
 * Of sessions that overlap in time, keep the one from the better-ranked app
 * (ties: the earlier start). Sessions that overlap nothing are all kept.
 */
export function keepNonOverlapping<T extends { start: number; end: number }>(
  sessions: readonly T[],
  rank: (s: T) => number,
): T[] {
  const ordered = [...sessions].sort(
    (a, b) => rank(a) - rank(b) || a.start - b.start,
  );
  const kept: T[] = [];
  for (const s of ordered) {
    if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}
