/**
 * The reproductive side of the Apple Health `export.xml` import: samples
 * the parser routes into CYCLE day-logs rather than `Measurement`.
 */
import {
  CycleImportAccumulator,
  EMPTY_CYCLE_IMPORT_STATS,
  type CycleImportStats,
} from "@/lib/cycle/import-accumulator";
import {
  tallyReason,
  type ExportImportPrisma,
  type ImportTally,
} from "@/lib/measurements/import-apple-health-export-writer";

/** A reproductive sample bound for a CYCLE day-log. */
export interface CycleSample {
  hkType: string;
  dayKey: string;
  rawValue: string | undefined;
  protectionUsed?: boolean;
}

/** A marked reproductive sample, decided at the end of the parse. */
export interface MarkedCycleSample extends CycleSample {
  sampleKey: string;
}

/** The reproductive samples one import run read, and their flush. */
export class ExportCycleWriter {
  // Reproductive HK samples fold into one CycleDayLog per day. The
  // accumulator buckets in memory; the flush at end of parse upserts.
  private readonly cycleAccumulator: CycleImportAccumulator;
  // Marked cycle samples, held to the end of the parse: one counts as written
  // by HealthLog only when this account holds a day-log on its day.
  private readonly markedCycle: MarkedCycleSample[] = [];

  constructor(
    private readonly prisma: ExportImportPrisma,
    private readonly userId: string,
    userTimezone: string,
    private readonly tally: ImportTally,
  ) {
    this.cycleAccumulator = new CycleImportAccumulator(userId, userTimezone);
  }

  /** Hold a marked cycle sample until the end of the parse. */
  holdMarked(rec: MarkedCycleSample): void {
    this.markedCycle.push(rec);
  }

  consume(rec: CycleSample): void {
    const consumed = this.cycleAccumulator.consume(
      rec.hkType,
      rec.dayKey,
      rec.rawValue,
      rec.protectionUsed,
    );
    if (!consumed) {
      // Recognised identifier but unrecognised value — count it under
      // `unknown` with the reason tag so operators can spot it.
      tallyReason(this.tally.unknown, `${rec.hkType}::cycle_unmapped`);
    }
  }

  // Marked cycle samples: left out when this account holds a day-log on
  // their day (deleted ones included), folded in otherwise.
  async settleMarked(): Promise<void> {
    if (this.markedCycle.length === 0) return;
    const days = [...new Set(this.markedCycle.map((rec) => rec.dayKey))];
    const held = new Set<string>();
    for (let i = 0; i < days.length; i += 1000) {
      const logs = await this.prisma.cycleDayLog.findMany({
        where: { userId: this.userId, date: { in: days.slice(i, i + 1000) } },
        select: { date: true },
      });
      for (const log of logs) held.add(log.date);
    }
    for (const rec of this.markedCycle.splice(0, this.markedCycle.length)) {
      if (held.has(rec.dayKey)) this.tally.countOwn("byMarker", rec.sampleKey);
      else this.consume(rec);
    }
  }

  /**
   * Fold the accumulated reproductive samples into CYCLE day-logs. Gated on
   * cycle-tracking being enabled for the account so a non-cycle Apple Health
   * export never silently provisions cycle rows.
   */
  async flush(): Promise<CycleImportStats> {
    const cycleAccumulator = this.cycleAccumulator;
    let cycle: CycleImportStats = { ...EMPTY_CYCLE_IMPORT_STATS };
    // Only touch the cycle tables when the export actually carried
    // reproductive samples AND the account has cycle tracking enabled. The
    // empty-accumulator short-circuit also keeps the no-cycle import path
    // (and its unit tests) free of any cycle DB round-trip. A flush failure
    // must never abort the whole import — per-day failures are isolated
    // inside `flush()` (its stats stay honest); a whole-flush failure (the
    // hoisted lookups) is folded into stats that still name the consumed
    // samples and the reason instead of reading as "nothing happened".
    if (cycleAccumulator.hasSamples()) {
      if (await cycleAccumulator.isEnabled()) {
        try {
          cycle = await cycleAccumulator.flush();
          this.tally.rowsUpserted += cycle.daysUpserted;
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          cycle = {
            ...EMPTY_CYCLE_IMPORT_STATS,
            samplesConsumed: cycleAccumulator.sampleCount(),
            daysFailed: cycleAccumulator.dayCount(),
            firstFailureReason: reason,
          };
          console.warn(`cycle import flush failed: ${reason}`);
        }
      } else {
        // Cycle tracking is off for the account: the reproductive samples
        // are DROPPED, and the drop is named so the recordsRead-vs-imported
        // gap stays explained in the result the user sees.
        cycle = {
          ...EMPTY_CYCLE_IMPORT_STATS,
          samplesSkippedModuleDisabled: cycleAccumulator.sampleCount(),
        };
      }
    }
    return cycle;
  }
}
