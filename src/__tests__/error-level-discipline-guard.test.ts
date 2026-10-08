/**
 * A caught error in a background job is either reported or explained.
 *
 * The failures that cost the most in this codebase were never thrown at
 * anyone: a nightly pass that caught its error, annotated an `info` line and
 * carried on, completed in pg-boss every night while doing nothing. The
 * briefing warm read "all-failed" for a week before anyone could tell which
 * account and why; the environment fetch threw on every run for the life of
 * the module. A `catch` that drops what it caught is where that starts.
 *
 * Scope: every `catch` clause and every `.catch(handler)` under
 * `src/lib/jobs/` (tests excluded). A catch passes when its body does one of:
 *
 *   - rethrows, rejects, or hands the error to a stream callback;
 *   - fails the job (`jobFailed`);
 *   - logs at warn or error: `logCaught` / `caughtAs`, `emitSignal`,
 *     `reportWorkerError`,
 *     `addWarning`, `setError`, `elevateLevel`, `workerLog("error", …)`,
 *     `console.error` / `console.warn`;
 *   - writes the failure to a ledger an operator surface reads
 *     (`recordSyncFailure`, `failAiRun`, `markFailed`,
 *     `recordThumbnailFailure`, `recordBriefingFailure`);
 *   - counts it into a failure tally (`failed += 1`, `errored++`,
 *     `failedSubjects.set(…)`) that the job reports in its outcome facts, so a
 *     systemic failure shows as a count and a partial run as
 *     `job.run.partial`;
 *   - hands it back to its caller in the result (`error: err…`), which is
 *     how every boot-time discovery enqueue reports to the registrar that
 *     logs it at error.
 *
 * Anything else is listed in `ALLOWED` below with the reason it may stay
 * silent, keyed by file and enclosing function, with how many such catches
 * that function holds. The reasons are the review: "best effort" is not one;
 * "the pgboss schema is absent on a web-only deployment and null is the
 * documented answer" is.
 *
 * The list cannot rot quietly in either direction. A new silent catch fails
 * the second case. An entry whose catches were fixed or removed fails the
 * third case (stale entry). And the fourth case removes each entry in turn
 * and asserts the sweep goes red without it, so every entry is shown to be
 * load-bearing, and the sweep is shown to find what it claims to find.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const SCOPE = "lib/jobs/";

const REPORTS =
  /\bthrow\b|\breject\(|\bcallback\(\s*err|\bjobFailed\(|\blogCaught\(|\bcaughtAs\(|\bemitSignal\(|\breportWorkerError\(|\.addWarning\(|\.setError\(|\belevateLevel\(|\bworkerLog\(\s*["']error|\bconsole\.(error|warn)\(|\brecordSyncFailure\(|\bfailAiRun\(|\bmarkFailed\(|\brecordThumbnailFailure\(|\brecordBriefingFailure\(|\berror:\s*err\b/;

/** A failure tally: `summary.failed += 1`, `errored++`, `failures += 1`. */
const COUNTS =
  /\b[\w.]*(?:failed|failures|errored|Failed|Failures)\w*\s*(?:\+=|\+\+|\.set\(|\.push\()/;

interface Finding {
  /** `<file under src>::<enclosing function>` */
  key: string;
  line: number;
  body: string;
}

function scan(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Finding[] = [];
  const visit = (node: ts.Node, fn: string): void => {
    let name = fn;
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name
    ) {
      name = node.name.getText(sf);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      name = node.name.getText(sf);
    }
    let body: string | null = null;
    if (ts.isCatchClause(node)) body = node.block.getText(sf);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.getText(sf) === "catch" &&
      node.arguments[0]
    ) {
      body = node.arguments[0].getText(sf);
    }
    if (body !== null && !REPORTS.test(body) && !COUNTS.test(body)) {
      out.push({
        key: `${file}::${name}`,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        body,
      });
    }
    ts.forEachChild(node, (child) => visit(child, name));
  };
  visit(sf, "<module>");
  return out;
}

/**
 * Catches allowed to stay silent, by file and function: how many, and why.
 * Keep the reason checkable against the code it names.
 */
const ALLOWED: Readonly<Record<string, { count: number; reason: string }>> = {
  "lib/jobs/apple-health-import-worker.ts::reconcileOrphanImportJobs": {
    count: 1,
    reason:
      "A failed live-state lookup reads as live on purpose: the heartbeat is fresh, flipping a running import would kill it, and the next boot re-evaluates once the heartbeat goes stale.",
  },
  "lib/jobs/apple-health-import-worker.ts::safeUnlink": {
    count: 1,
    reason:
      "Deleting a staged file that a previous step or sweep already removed; ENOENT is the expected case and nothing is lost either way.",
  },
  "lib/jobs/backup-restore.ts::writeProgress": {
    count: 1,
    reason:
      "A progress tick for the status poll; the next tick rewrites it and the job's own outcome is recorded by `finish`.",
  },
  "lib/jobs/backup-restore.ts::runBackupRestoreJob": {
    count: 1,
    reason:
      "Waits out the in-flight progress write before the final state is written; that write's failure is the progress tick's, see writeProgress.",
  },
  "lib/jobs/backup-restore.ts::sweepInterruptedRestores": {
    count: 1,
    reason:
      "Completing the dead worker's superseded pg-boss delivery; if it fails the delivery expires on its own, and the restore row it belonged to is already failed and counted.",
  },
  "lib/jobs/boss-instance.ts::startProducerAttempts": {
    count: 2,
    reason:
      "The start error is kept and thrown after the last attempt; stopping a boss that never started can only fail for the same reason.",
  },
  "lib/jobs/boss-instance.ts::superviseProducerReconnect": {
    count: 1,
    reason:
      "Stopping the producer whose connection already failed, before reconnecting; the reconnect loop reports its own failures.",
  },
  "lib/jobs/free-text-encryption-backfill.ts::scrubContactAuditDetails": {
    count: 1,
    reason:
      "A parser: details that are not this action's JSON are left alone by contract (null means 'nothing to scrub'), not an error.",
  },
  "lib/jobs/geo-backfill.ts::runGeoBackfill": {
    count: 1,
    reason:
      "The row was deleted by the retention sweep between read and update; counted as still unresolved, and the next pass no longer sees it.",
  },
  "lib/jobs/host-metric-sampler.ts::captureHostMetric": {
    count: 1,
    reason:
      "Disk counters exist only on Linux; elsewhere the sample records null for them by design.",
  },
  "lib/jobs/host-metric-sampler.ts::readLinuxDiskStats": {
    count: 1,
    reason: "No /proc/diskstats outside Linux; see captureHostMetric.",
  },
  "lib/jobs/job-failures.ts::readActiveJobsStartedBefore": {
    count: 1,
    reason:
      "No pgboss schema on a web-only deployment; null is the documented 'no queue to ask', kept apart from an empty list.",
  },
  "lib/jobs/job-failures.ts::readConsecutiveRunFailures": {
    count: 1,
    reason:
      "Called from a failure path that is already logging at error; when the queue cannot be read, 1 (this run) is the only known count.",
  },
  "lib/jobs/job-failures.ts::readFailingQueues": {
    count: 1,
    reason: "See readActiveJobsStartedBefore: null means no queue schema.",
  },
  "lib/jobs/job-failures.ts::readLastQueueRun": {
    count: 1,
    reason: "See readActiveJobsStartedBefore: null means no queue schema.",
  },
  "lib/jobs/job-failures.ts::readQueueFailureForUser": {
    count: 1,
    reason: "See readActiveJobsStartedBefore: null means no queue schema.",
  },
  "lib/jobs/job-failures.ts::readQueueRunningSince": {
    count: 1,
    reason: "See readActiveJobsStartedBefore: null means no queue schema.",
  },
  "lib/jobs/job-observer.ts::emitJobLine": {
    count: 1,
    reason:
      "The catch around writing a log line itself; there is nowhere further to log to, and a log line must not break the job.",
  },
  "lib/jobs/offhost-backup.ts::getS3Client": {
    count: 2,
    reason:
      "headObject answers 'absent' for a missing object (its contract), and the lifecycle read maps NoSuchLifecycleConfiguration to 'missing' and anything else to 'unknown', which the status card shows.",
  },
  "lib/jobs/offhost-backup.ts::loadOffhostConfigSafe": {
    count: 1,
    reason:
      "A malformed key reads as 'not configured' for the status card; the backup pass itself calls the throwing loader and fails loudly.",
  },
  "lib/jobs/offhost-backup.ts::probeOffhostLifecycle": {
    count: 1,
    reason:
      "The lifecycle probe answers 'unknown', which the admin card renders as such; it is a display read, not a pass.",
  },
  "lib/jobs/offhost-backup.ts::runOffhostRoundtripTest": {
    count: 2,
    reason:
      "The admin's connection test returns its error in the result it shows (ok: false, error), and deleting its own probe object is cleanup.",
  },
  "lib/jobs/offhost-backup.ts::withEachKey": {
    count: 1,
    reason:
      "Trying each key of the ring in turn; the last error is thrown when no key opens the object.",
  },
  "lib/jobs/reminder/medication-reminder-check.ts::cleanupScheduledTelegramDeletions":
    {
      count: 1,
      reason:
        "Deleting a reminder message the person usually already deleted; the scheduled row is removed either way, and logging every expected 400 would bury the real ones.",
    },
  "lib/jobs/reminder/polar-sync.ts::syncUserPolarLegs": {
    count: 2,
    reason:
      "Both legs run, the first error is kept and thrown after the second leg.",
  },
  "lib/jobs/restore-drill.ts::runRestoreDrill": {
    count: 1,
    reason:
      "The per-account drill failure is recorded on the account's result (ok: false, error) and counted into the run's restore_drill_accounts_failed fact.",
  },
};

function sweep(): Finding[] {
  return walkSourceFiles(join(SRC, SCOPE), { floor: 100 })
    .filter((p) => !p.includes("__tests__") && !p.endsWith(".test.ts"))
    .flatMap((p) =>
      scan(`${SCOPE}${p}`, readFileSync(join(SRC, SCOPE, p), "utf8")),
    );
}

function unallowed(
  findings: readonly Finding[],
  allowed: Readonly<Record<string, { count: number }>>,
): string[] {
  const byKey = new Map<string, Finding[]>();
  for (const f of findings) {
    byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  }
  const out: string[] = [];
  for (const [key, list] of byKey) {
    const allowance = allowed[key]?.count ?? 0;
    if (list.length > allowance) {
      for (const f of list.slice(allowance)) {
        out.push(
          `${key} (line ${f.line}): ${f.body.replace(/\s+/g, " ").slice(0, 120)}`,
        );
      }
    }
  }
  return out.sort();
}

describe("error-level discipline in background jobs", () => {
  it("the scanner flags a silent catch and passes a reported one", () => {
    const planted = scan(
      "lib/jobs/planted.ts",
      [
        "async function quiet() { try { await a(); } catch { /* best effort */ } }",
        "async function info() { try { await a(); } catch (e) { annotate({ action: { name: 'x.failed' } }); } }",
        "async function chained() { await a().catch(() => {}); }",
        "async function loud() { try { await a(); } catch (e) { logCaught('x.y.failed', e); } }",
        "async function counted() { try { await a(); } catch { summary.failed += 1; } }",
        "async function rethrown() { try { await a(); } catch (e) { throw e; } }",
      ].join("\n"),
    );
    expect(planted.map((f) => f.key)).toEqual([
      "lib/jobs/planted.ts::quiet",
      "lib/jobs/planted.ts::info",
      "lib/jobs/planted.ts::chained",
    ]);
  });

  it("every silent catch in src/lib/jobs is fixed or explained", () => {
    expect(unallowed(sweep(), ALLOWED)).toEqual([]);
  });

  it("no allow-list entry outlives the catches it explains", () => {
    const counts = new Map<string, number>();
    for (const f of sweep()) counts.set(f.key, (counts.get(f.key) ?? 0) + 1);
    const stale = Object.entries(ALLOWED)
      .filter(([key, { count }]) => (counts.get(key) ?? 0) < count)
      .map(
        ([key, { count }]) =>
          `${key}: allows ${count}, finds ${counts.get(key) ?? 0}`,
      );
    expect(stale).toEqual([]);
  });

  it("every allow-list entry is load-bearing: removing it turns the sweep red", () => {
    const findings = sweep();
    const notLoadBearing = Object.keys(ALLOWED).filter((key) => {
      const without = { ...ALLOWED };
      delete (without as Record<string, unknown>)[key];
      return unallowed(findings, without).length === 0;
    });
    expect(notLoadBearing).toEqual([]);
  });
});
