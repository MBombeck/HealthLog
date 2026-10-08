/**
 * Every place that writes `Measurement` rows either runs the shared
 * post-write tail or says here why it does not.
 *
 * Two readers hang off every measurement write: the rollup buckets the write
 * dirtied, and the cached status assessments of the types it touched. The
 * shared tail (`afterMeasurementMutation`) runs both. Several write paths
 * refreshed the rollups by hand and never re-warmed the assessments (the MCP
 * writes, the Telegram reply, both importers), so a reading logged there kept
 * the day's old assessment until the nightly pass. This guard freezes the set
 * of write sites: a new one fails until it is listed with its tail.
 *
 * A tripwire, not a proof: it cannot tell whether a listed reason is still
 * true, only that the set did not change without someone editing this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * `prisma.measurement.create(`, `tx.measurement.deleteMany(`, … Whitespace
 * and line breaks between the parts are tolerated so a formatter reflow does
 * not hide a site.
 */
const WRITE_RE =
  /\.\s*measurement\s*\.\s*(?:create|createMany|createManyAndReturn|upsert|update|updateMany|delete|deleteMany)\s*\(/g;

/** Runs `afterMeasurementMutation` on the rows it wrote. */
const TAIL = "runs afterMeasurementMutation";

/**
 * Every file with a measurement write, and how it keeps the two readers
 * current. A file listed here must still contain a write (a stale entry
 * fails too).
 */
const WRITE_SITES: Record<string, string> = {
  "app/api/import/csv/route.ts": TAIL,
  "app/api/import/route.ts": TAIL,
  "app/api/measurements/[id]/route.ts": TAIL,
  "app/api/measurements/bulk-delete/route.ts": TAIL,
  "app/api/measurements/by-external-ids/route.ts": TAIL,
  "app/api/measurements/restore/route.ts": TAIL,
  "app/api/measurements/route.ts": TAIL,
  "app/api/mental-health/assessments/route.ts": TAIL,
  "lib/insights/score-row.ts": TAIL,
  "lib/mcp/writes.ts": TAIL,
  "lib/measurements/create-from-telegram.ts": TAIL,
  "lib/whoop/sync-body.ts": TAIL,
  "lib/whoop/webhook-handler.ts": TAIL,
  // Integration syncs: each collects the (type, day) pairs it touched and
  // runs both legs itself at the end of the sync.
  "lib/fitbit/sync-core.ts":
    "refolds the touched days and re-warms the touched types at the end of the upsert",
  "lib/google-health/sync-core.ts":
    "refolds the touched days and re-warms the touched types at the end of the upsert",
  "lib/nightscout/sync.ts":
    "refolds the touched days and re-warms the touched types at the end of the sync",
  "lib/withings/sync.ts":
    "refolds the touched days and re-warms the touched types at the end of the sync",
  "lib/withings/sync-activity.ts":
    "refolds the touched days (and the day a moved row left) and re-warms the touched types",
  "lib/withings/sync-ecg.ts":
    "refolds the touched days and re-warms the touched types at the end of the sync",
  // The reconcile primitive writes one row inside the caller's transaction;
  // its callers (Polar, Oura, WHOOP, the Apple export import) collect the
  // verdicts' dirty identities and run the tail once per batch.
  "lib/measurements/reconcile-external-measurement.ts":
    "a primitive; every caller runs the tail over the verdicts' dirty identities",
  "lib/measurements/import-apple-health-export.ts":
    "the import worker refolds the import's span and re-warms every imported type",
  "lib/export/restore-backup.ts":
    "a restore replaces the whole record: it refolds the whole window and drops every per-user cache",
  // Value-preserving reshapes: the same readings folded into daily or hourly
  // rows. The rollups are refolded; the figures an assessment reads do not
  // change, so re-warming would only re-bill the same text.
  "lib/measurements/consolidate-daily-mean.ts":
    "value-preserving consolidation; refolds the touched days",
  "lib/measurements/consolidate-legacy-steps.ts":
    "value-preserving consolidation; refolds the touched days",
  "lib/measurements/drain-per-sample-cumulative.ts":
    "value-preserving consolidation; refolds the touched days",
  "lib/measurements/dense-intraday-hourly-rebuild.ts":
    "value-preserving hourly fold; refolds the touched spans",
  "lib/measurements/dense-intraday-retention.ts":
    "value-preserving retention fold; refolds the touched days",
  "lib/jobs/sleep-timeline-backfill.ts":
    "one-shot re-stamp of stored sleep rows onto their timeline; refolds the touched days",
  "lib/jobs/step-consolidation-repair.ts":
    "one-shot restore of step rows an old consolidation removed; refolds the touched days",
  "lib/sleep/sweep-stale-segments.ts":
    "tombstones re-scored sleep segments inside a sync; the calling sync refolds the night",
  // Writes that do not change a reading.
  "lib/jobs/note-encryption-backfill.ts":
    "encrypts the note column in place; no value, instant or type changes",
  "lib/jobs/measurement-tombstone-cleanup.ts":
    "hard-deletes rows that were already soft-deleted and read nowhere",
  "lib/jobs/compaction-tombstone-purge.ts":
    "hard-deletes compaction tombstones, rows already soft-deleted and read nowhere",
};

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function writeCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const rel of sourceFiles()) {
    const matches = readFileSync(join(SRC, rel), "utf8").match(WRITE_RE);
    if (matches && matches.length > 0) out.set(rel, matches.length);
  }
  return out;
}

describe("measurement write tail", () => {
  const counts = writeCounts();

  it("finds the write sites at all", () => {
    // An empty match set would agree with any allowlist.
    expect(counts.size).toBeGreaterThanOrEqual(30);
  });

  it("lists every file that writes measurements", () => {
    const unlisted = [...counts.keys()].filter((f) => !(f in WRITE_SITES));
    expect(
      unlisted,
      "a new measurement write site: run afterMeasurementMutation on the rows it writes, or list it here with the reason it does not",
    ).toEqual([]);
  });

  it("has no stale entries", () => {
    const stale = Object.keys(WRITE_SITES).filter((f) => !counts.has(f));
    expect(stale).toEqual([]);
  });

  it("the files that claim the shared tail call it", () => {
    const missing = Object.entries(WRITE_SITES)
      .filter(([, reason]) => reason === TAIL)
      .map(([file]) => file)
      .filter(
        (file) =>
          !/afterMeasurementMutation\s*\(/.test(
            readFileSync(join(SRC, file), "utf8"),
          ),
      );
    expect(missing).toEqual([]);
  });

  it("the syncs that run both legs by hand call both", () => {
    const handRolled = Object.entries(WRITE_SITES)
      .filter(([, reason]) => reason.includes("re-warms"))
      .map(([file]) => file)
      .filter(
        (file) => file !== "lib/measurements/import-apple-health-export.ts",
      );
    expect(handRolled.length).toBeGreaterThan(0);
    const missing = handRolled.filter((file) => {
      const src = readFileSync(join(SRC, file), "utf8");
      return !(
        /recomputeBucketsForMeasurement|afterMeasurementMutation/.test(src) &&
        /invalidateStatusInsightsForTypes|afterMeasurementMutation/.test(src)
      );
    });
    expect(missing).toEqual([]);
  });
});
