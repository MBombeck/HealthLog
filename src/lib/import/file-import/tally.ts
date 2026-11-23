/**
 * The counts a record-file import reports, built as it runs. Bounded: the
 * skip list keeps at most {@link MAX_SKIP_ENTRIES} distinct (key, reason)
 * pairs, so a file of a million unreadable rows answers with a summary of a
 * fixed size.
 */
import {
  RECORD_FILE_IMPORT_BUDGET_MS,
  type RecordFileImportKind,
  type RecordFileImportResult,
} from "./kinds";

const MAX_SKIP_ENTRIES = 100;

export class RecordFileImportTally {
  private readonly started = Date.now();
  private readonly lines = new Map<
    string,
    { imported: number; duplicates: number }
  >();
  private readonly skips = new Map<string, number>();
  private failedCount = 0;
  private from: number | null = null;
  private to: number | null = null;
  budgetExceeded = false;

  /**
   * @param stop The job's own budget (`jobBudget`): its share of the queue's
   *   expiry, or an abort. Whichever comes first, it or `budgetMs`, ends the
   *   run.
   */
  constructor(
    readonly kind: RecordFileImportKind,
    private readonly budgetMs: number = RECORD_FILE_IMPORT_BUDGET_MS,
    private readonly stop: () => boolean = () => false,
  ) {}

  private line(key: string) {
    let entry = this.lines.get(key);
    if (!entry) {
      entry = { imported: 0, duplicates: 0 };
      this.lines.set(key, entry);
    }
    return entry;
  }

  imported(key: string, count = 1): void {
    this.line(key).imported += count;
  }

  duplicate(key: string, count = 1): void {
    this.line(key).duplicates += count;
  }

  skip(key: string, reason: string, count = 1): void {
    if (count <= 0) return;
    const id = `${key}\u0000${reason}`;
    if (!this.skips.has(id) && this.skips.size >= MAX_SKIP_ENTRIES) {
      const other = `other\u0000${reason}`;
      this.skips.set(other, (this.skips.get(other) ?? 0) + count);
      return;
    }
    this.skips.set(id, (this.skips.get(id) ?? 0) + count);
  }

  failed(key: string, reason: string, count = 1): void {
    this.failedCount += count;
    this.skip(key, reason, count);
  }

  /** Widen the written span by one measurement instant. */
  widen(at: Date): void {
    const t = at.getTime();
    if (this.from === null || t < this.from) this.from = t;
    if (this.to === null || t > this.to) this.to = t;
  }

  /** Whether the run has used its time budget; marks the result if so. */
  outOfTime(): boolean {
    if (Date.now() - this.started >= this.budgetMs || this.stop()) {
      this.budgetExceeded = true;
    }
    return this.budgetExceeded;
  }

  toResult(): RecordFileImportResult {
    let imported = 0;
    let duplicates = 0;
    const lines = [...this.lines.entries()]
      .map(([key, v]) => {
        imported += v.imported;
        duplicates += v.duplicates;
        return { key, ...v };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
    let skipped = 0;
    const skips = [...this.skips.entries()]
      .map(([id, count]) => {
        const [key, reason] = id.split("\u0000") as [string, string];
        skipped += count;
        return { key, reason, count };
      })
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    return {
      kind: this.kind,
      imported,
      duplicates,
      skipped: skipped - this.failedCount,
      failed: this.failedCount,
      lines,
      skips,
      budgetExceeded: this.budgetExceeded,
      measuredSpan:
        this.from !== null && this.to !== null
          ? {
              from: new Date(this.from).toISOString(),
              to: new Date(this.to).toISOString(),
            }
          : null,
      durationMs: Date.now() - this.started,
    };
  }
}
