/**
 * The monthly restore drill's verdict, kept until the next drill replaces it.
 *
 * The drill used to say what it found only through `reportWorkerError`
 * (stderr, and GlitchTip where configured) and through the pg-boss row of its
 * run. The row is gone after seven days and the admin failing-jobs card reads
 * 72 hours of it, so a drill that failed on the first of the month was on
 * screen until the fourth and invisible for the rest of it. One row, written
 * at the end of every drill that had something to check, is what the recovery
 * readiness tile and its push read instead, with no window at all.
 *
 * A failure stays the verdict until a later drill passes: `lastFailureAt`
 * newer than `lastSuccessAt` is the rule (`evaluateRestoreDrill`).
 */
import { prisma } from "@/lib/db";
import { redactSecrets } from "@/lib/logging/redact";

/** The reason is a line on a status tile, not a stack trace. */
const MAX_REASON_CHARS = 300;

export interface RestoreDrillResult {
  /**
   * The verdict; null for a run that checked nothing (it stopped on its time
   * budget before the first object), which is no verdict at all: the run and
   * its counts are kept, the last pass or failure stands.
   */
  ok: boolean | null;
  accountsChecked: number;
  accountsFailed: number;
  /** Why it failed; ignored when `ok`. */
  reason?: string | null;
}

export async function recordRestoreDrillOutcome(
  result: RestoreDrillResult,
  at: Date = new Date(),
): Promise<void> {
  const reason =
    result.ok !== false
      ? null
      : (() => {
          const text = redactSecrets((result.reason ?? "").trim());
          return text.length > MAX_REASON_CHARS
            ? `${text.slice(0, MAX_REASON_CHARS)}…`
            : text || null;
        })();
  const verdict =
    result.ok === null
      ? {}
      : result.ok
        ? { lastSuccessAt: at }
        : { lastFailureAt: at, lastFailureReason: reason };
  const counts = {
    lastRunAt: at,
    accountsChecked: result.accountsChecked,
    accountsFailed: result.accountsFailed,
  };
  await prisma.restoreDrillOutcome.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...counts, ...verdict },
    update: { ...counts, ...verdict },
  });
}
