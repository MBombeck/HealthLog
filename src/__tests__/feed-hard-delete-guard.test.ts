/**
 * Structural guard on hard deletes of the tables the sync feed serves.
 *
 * The feed (`/api/sync/changes`) tells a paired client about a removed row
 * only through a tombstone (`deletedAt`), or, when rows vanish wholesale,
 * through `stampSyncReset`, which expires every cursor issued before it. A
 * hard delete that does neither leaves the client's mirror holding rows the
 * server no longer has, and nothing in the feed will ever correct it.
 * `DELETE /api/cycle/all` did exactly that until v1.48.6.
 *
 * So every file that hard-deletes a feed row is named here with the reason
 * the client still converges. A file whose reason is a reset must call
 * `stampSyncReset` itself. The matcher is whitespace-tolerant and the match
 * count is asserted non-zero, so a broken matcher fails instead of passing on
 * an empty set. It proves a reference exists, not that it sits on every
 * branch; raw SQL deletes are swept by their own matcher.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const FEED_MODELS = [
  "measurement",
  "moodEntry",
  "medicationIntakeEvent",
  "cycleDayLog",
  "menstrualCycle",
];
const FEED_TABLES = [
  "measurements",
  "mood_entries",
  "medication_intake_events",
  "cycle_day_logs",
  "menstrual_cycles",
];

const HARD_DELETE = new RegExp(
  `\\.\\s*(?:${FEED_MODELS.join("|")})\\s*\\.\\s*(?:deleteMany|delete)\\s*\\(`,
);
const RAW_DELETE = new RegExp(
  `DELETE\\s+FROM\\s+"?(?:${FEED_TABLES.join("|")})\\b`,
  "i",
);
const RESET = /\bstampSyncReset\s*\(/;

type Why =
  | { kind: "reset"; reason: string }
  | { kind: "restore"; reason: string }
  | { kind: "tombstone-purge"; reason: string }
  | { kind: "never-mirrored"; reason: string };

const SITES: Record<string, Why> = {
  "app/api/cycle/all/route.ts": {
    kind: "reset",
    reason:
      "The cycle purge leaves no dated trace, so no tombstone; it resets the feed in the same transaction.",
  },
  "lib/jobs/sleep-timeline-backfill.ts": {
    kind: "reset",
    reason:
      "The one-shot sleep re-import deletes and rewrites rows under new ids; it resets the feed when it deleted anything.",
  },
  "lib/measurements/dense-fold-removal.ts": {
    kind: "reset",
    reason: "Dense intraday removal resets the feed when it removed rows.",
  },
  "lib/cycle/backup.ts": {
    kind: "restore",
    reason:
      "Cycle restore clears before it writes back; restore-backup.ts resets the feed for the whole restore.",
  },
  "lib/export/measurements-restore.ts": {
    kind: "restore",
    reason: "Measurement restore; restore-backup.ts resets the feed.",
  },
  "lib/export/mood-restore.ts": {
    kind: "restore",
    reason: "Mood restore; restore-backup.ts resets the feed.",
  },
  "lib/export/medications-restore.ts": {
    kind: "restore",
    reason: "Medication restore; restore-backup.ts resets the feed.",
  },
  "lib/jobs/measurement-tombstone-cleanup.ts": {
    kind: "tombstone-purge",
    reason:
      "Purges tombstones past the retention horizon; a cursor older than that horizon is expired by the feed itself.",
  },
  "lib/jobs/compaction-tombstone-purge.ts": {
    kind: "tombstone-purge",
    reason:
      "Purges compaction tombstones (re-checked `deletedAt: { not: null }` at delete time).",
  },
  "lib/measurements/consolidate-daily-mean.ts": {
    kind: "never-mirrored",
    reason:
      "Folds Apple Health per-sample rows the client uploaded into one daily row; the samples are the client's own and were never pulled back.",
  },
  "lib/measurements/drain-per-sample-cumulative.ts": {
    kind: "never-mirrored",
    reason:
      "Folds Apple Health per-sample cumulative rows into the daily total; same reasoning as consolidate-daily-mean.",
  },
};

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
}

function code(rel: string): string {
  return stripComments(readFileSync(join(SRC, rel), "utf8"));
}

describe("hard deletes of sync-feed rows", () => {
  const files = sourceFiles();
  const found = files.filter((rel) => {
    const text = code(rel);
    return HARD_DELETE.test(text) || RAW_DELETE.test(text);
  });

  it("the matcher finds the known sites", () => {
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("app/api/cycle/all/route.ts");
  });

  it("every site is named with the reason the client converges", () => {
    const unlisted = found.filter((rel) => !(rel in SITES));
    expect(unlisted, "hard delete of a feed row with no entry").toEqual([]);
  });

  it("no entry is stale", () => {
    const stale = Object.keys(SITES).filter((rel) => !found.includes(rel));
    expect(stale).toEqual([]);
  });

  it.each(
    Object.entries(SITES)
      .filter(([, why]) => why.kind === "reset")
      .map(([rel]) => rel),
  )("%s resets the feed itself", (rel) => {
    expect(RESET.test(code(rel))).toBe(true);
  });

  it("the restore entry point resets the feed", () => {
    expect(RESET.test(code("lib/export/restore-backup.ts"))).toBe(true);
  });

  it("the matcher reads a delete written across lines", () => {
    expect(HARD_DELETE.test("await tx\n  .cycleDayLog\n  .deleteMany({")).toBe(
      true,
    );
    expect(HARD_DELETE.test("tx.cycleDayLog.updateMany({")).toBe(false);
    expect(RAW_DELETE.test('DELETE FROM "measurements" WHERE')).toBe(true);
  });
});
