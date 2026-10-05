/**
 * A write that is not activity keeps the row's `updatedAt`.
 *
 * Prisma's `@updatedAt` stamps "now" on every `update` / `updateMany` /
 * `upsert` that does not name the column. That is right for an edit and
 * wrong for a one-shot rewrite of how a value is stored: the title
 * encryption backfill bumped every Coach conversation it touched, and the
 * Coach panel, which groups and orders conversations by `updatedAt`, then
 * showed months-old threads under "Today". The same column is the sync
 * cursor for measurements and mood entries, so a storage-only rewrite there
 * made every client pull rows that had not changed.
 *
 * Two freezes:
 *
 *   1. Every Prisma write in a backfill (`lib/jobs/*-backfill.ts`,
 *      `scripts/backfill-*.ts`) on a model with an `@updatedAt` column names
 *      `updatedAt` in the call (carrying the row's own value forward), or is
 *      listed below with the reason the stamp is wanted.
 *   2. Every `coachConversation` write anywhere names `updatedAt`, or is
 *      listed as something the person did in the conversation. Background
 *      bookkeeping (the memory summary) writes through raw SQL, which Prisma
 *      does not stamp.
 *
 * A tripwire, not a proof: it cannot tell whether a listed reason is still
 * true, only that the set did not change without someone editing this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Models (as Prisma client accessors) that carry an `@updatedAt` column. */
function modelsWithUpdatedAt(): Set<string> {
  const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
  const out = new Set<string>();
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    if (/@updatedAt\b/.test(m[2])) {
      out.add(m[1][0].toLowerCase() + m[1].slice(1));
    }
  }
  return out;
}

const WRITE_RE = /\.\s*([a-zA-Z]+)\s*\.\s*(update|updateMany|upsert)\s*\(/g;

/** The argument text of the call whose `(` sits at `open`. */
function callArgs(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

interface Write {
  file: string;
  model: string;
  namesUpdatedAt: boolean;
}

function writesIn(file: string, source: string): Write[] {
  const out: Write[] = [];
  for (const m of source.matchAll(WRITE_RE)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    out.push({
      file,
      model: m[1],
      namesUpdatedAt: /\bupdatedAt\s*:/.test(callArgs(source, open)),
    });
  }
  return out;
}

function backfillFiles(): string[] {
  const jobs = readdirSync(join(SRC, "lib/jobs"))
    .filter((f) => /-backfill\.ts$/.test(f))
    .map((f) => `src/lib/jobs/${f}`);
  const scripts = readdirSync(join(ROOT, "scripts"))
    .filter((f) => /^backfill-.*\.ts$/.test(f))
    .map((f) => `scripts/${f}`);
  return [...jobs, ...scripts].sort();
}

/**
 * Backfill writes that stamp `updatedAt` on purpose, keyed `file > model`.
 */
const BACKFILL_STAMPS: Record<string, string> = {
  "src/lib/jobs/fitbit-backfill.ts > fitbitConnection":
    "the job's own progress on the connection row; not a listed record",
  "src/lib/jobs/google-health-backfill.ts > googleHealthConnection":
    "the job's own progress on the connection row; not a listed record",
  "src/lib/jobs/whoop-backfill.ts > whoopConnection":
    "the job's own progress on the connection row; not a listed record",
  "src/lib/jobs/sleep-timeline-backfill.ts > whoopConnection":
    "marks the connection's one-shot as done; not a listed record",
  "src/lib/jobs/sleep-timeline-backfill.ts > withingsConnection":
    "marks the connection's one-shot as done; not a listed record",
  "src/lib/jobs/strava-backfill.ts > user":
    "stamps the account's backfill-completed marker",
  "src/lib/jobs/document-content-index-backfill.ts > documentContentIndex":
    "the index row is rebuilt content; its updatedAt is the rebuild time",
  "src/lib/jobs/lab-biomarker-backfill.ts > biomarker":
    "shared catalogue row created or refreshed by the backfill",
  "src/lib/jobs/lab-biomarker-backfill.ts > labResult":
    "bulk link to a catalogue id; no lab surface orders by updatedAt and a bulk write cannot carry each row's own value",
  "src/lib/jobs/free-text-encryption-backfill.ts > measurementReminder":
    "bulk clear of a retired readable copy; reminders are listed by schedule, not by updatedAt",
};

/**
 * `coachConversation` writes outside backfills that stamp `updatedAt`
 * because the person did something in the conversation, keyed by file.
 */
const COACH_ACTIVITY: Record<string, string> = {
  "src/lib/ai/coach/persistence.ts":
    "a turn sets updatedAt to now explicitly; a rename and a document attach are the person acting on the thread",
};

describe("backfills keep updatedAt", () => {
  const stamped = modelsWithUpdatedAt();
  const files = backfillFiles();
  const writes = files.flatMap((f) =>
    writesIn(f, readFileSync(join(ROOT, f), "utf8")),
  );

  it("reads the schema and the backfills at all", () => {
    // An empty match set would agree with any allowlist.
    expect(stamped.size).toBeGreaterThanOrEqual(40);
    expect(stamped.has("coachConversation")).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(writes.length).toBeGreaterThanOrEqual(15);
  });

  it("carries updatedAt through every storage-only rewrite", () => {
    const offenders = writes
      .filter((w) => stamped.has(w.model) && !w.namesUpdatedAt)
      .map((w) => `${w.file} > ${w.model}`)
      .filter((key) => !(key in BACKFILL_STAMPS));
    expect(
      [...new Set(offenders)],
      "a backfill write bumps updatedAt: carry the row's own value (`updatedAt: fresh.updatedAt`), or list it with the reason the stamp is wanted",
    ).toEqual([]);
  });

  it("has no stale entries", () => {
    const seen = new Set(
      writes
        .filter((w) => stamped.has(w.model) && !w.namesUpdatedAt)
        .map((w) => `${w.file} > ${w.model}`),
    );
    expect(Object.keys(BACKFILL_STAMPS).filter((k) => !seen.has(k))).toEqual(
      [],
    );
  });
});

describe("coach conversations move only on activity", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .map((p) => `src/${p}`);
  const writes = [
    ...files.flatMap((f) => writesIn(f, readFileSync(join(ROOT, f), "utf8"))),
    ...backfillFiles()
      .filter((f) => f.startsWith("scripts/"))
      .flatMap((f) => writesIn(f, readFileSync(join(ROOT, f), "utf8"))),
  ].filter((w) => w.model === "coachConversation");

  it("finds the conversation writes at all", () => {
    expect(writes.length).toBeGreaterThanOrEqual(3);
  });

  it("names updatedAt in every write that is not the person's own action", () => {
    const offenders = writes
      .filter((w) => !w.namesUpdatedAt && !(w.file in COACH_ACTIVITY))
      .map((w) => w.file);
    expect(
      [...new Set(offenders)],
      "a coachConversation write that is not activity must keep updatedAt (carry it, or write through raw SQL)",
    ).toEqual([]);
  });
});
