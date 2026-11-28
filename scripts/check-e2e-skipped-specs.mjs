#!/usr/bin/env node
/**
 * Fail CI when a whole e2e spec file ran nothing.
 *
 * A spec that skips all of its tests reports green, and in a summary a quiet
 * skip looks exactly like a pass. `delegated-writes.spec.ts` skipped every
 * test on every run for months that way: its skip condition was evaluated
 * before the form it looked for had painted.
 *
 * This reads Playwright's JSON report (one per shard; the e2e workflow's gate
 * job passes all of them) and counts, per spec FILE, the tests that ran across
 * every project and shard together. A file is only reported when none of its
 * tests ran anywhere, so a mobile-only spec that skips on the desktop project
 * is fine as long as the mobile project ran it. Aggregating across shards is
 * the reason this runs in the gate job and not inside each shard: a shard can
 * receive only the skipped half of a file.
 *
 * A file that is meant to skip entirely goes in `ALLOWED_ALL_SKIPPED` below
 * with the reason written next to it. The per-call half of the rule, that
 * every conditional skip carries a reason, is the unit guard
 * `src/__tests__/e2e-conditional-skip-guard.test.ts`.
 *
 * Usage: node scripts/check-e2e-skipped-specs.mjs <report.json> [...]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Spec files allowed to report every test skipped, keyed by the path the JSON
 * report prints (relative to `testDir`), each with the reason it is allowed.
 *
 * @type {Record<string, string>}
 */
export const ALLOWED_ALL_SKIPPED = {
  "first-run.spec.ts":
    "claims a second, empty server (E2E_FRESH_BASE_URL, E2E_FRESH_DATABASE_URL, E2E_FRESH_SETUP_TOKEN); the e2e workflow starts none, so it runs only where one is configured",
};

/**
 * Walk a report's suites and tally each spec file's tests.
 *
 * @param {Array<{ suites?: unknown[] }>} reports parsed Playwright JSON reports
 * @returns {Map<string, { total: number; ran: number }>}
 */
export function tallySpecFiles(reports) {
  /** @type {Map<string, { total: number; ran: number }>} */
  const files = new Map();
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      const entry = files.get(spec.file) ?? { total: 0, ran: 0 };
      for (const test of spec.tests ?? []) {
        entry.total += 1;
        if (test.status !== "skipped") entry.ran += 1;
      }
      files.set(spec.file, entry);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const report of reports) {
    for (const suite of report.suites ?? []) visit(suite);
  }
  return files;
}

/**
 * The problems to report: files whose every test skipped and that are not
 * allowlisted, allowlist entries that no longer apply, and an empty report.
 *
 * @param {Array<{ suites?: unknown[] }>} reports
 * @param {Record<string, string>} [allowed]
 * @returns {string[]}
 */
export function findProblems(reports, allowed = ALLOWED_ALL_SKIPPED) {
  const files = tallySpecFiles(reports);
  const problems = [];
  let total = 0;
  for (const entry of files.values()) total += entry.total;
  if (total === 0) {
    // A check over nothing passes for the wrong reason; say so instead.
    problems.push("the report(s) hold no tests at all");
    return problems;
  }
  for (const [file, { total: count, ran }] of [...files].sort()) {
    if (ran > 0) continue;
    if (Object.hasOwn(allowed, file)) continue;
    problems.push(
      `${file}: all ${count} test(s) skipped in every project and shard`,
    );
  }
  for (const file of Object.keys(allowed)) {
    const entry = files.get(file);
    if (!entry) {
      problems.push(`${file}: allowlisted but absent from the report`);
    } else if (entry.ran > 0) {
      problems.push(`${file}: allowlisted but ${entry.ran} test(s) ran`);
    }
  }
  return problems;
}

function main(paths) {
  if (paths.length === 0) {
    console.error("usage: check-e2e-skipped-specs.mjs <report.json> [...]");
    return 2;
  }
  const reports = paths.map((p) => JSON.parse(readFileSync(p, "utf8")));
  const problems = findProblems(reports);
  const files = tallySpecFiles(reports);
  if (problems.length > 0) {
    console.error("e2e spec files that ran nothing:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `check-e2e-skipped-specs: ${files.size} spec file(s) across ${paths.length} report(s), each ran at least one test`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
