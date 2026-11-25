#!/usr/bin/env node
/**
 * Check each module's mutation score against its floor.
 *
 *   node scripts/mutation-floors.mjs [reports/mutation/mutation.json]
 *
 * Stryker's own `thresholds.break` is one number for the whole run, which
 * lets a well-tested module hide a weak one. `stryker.floors.json` names a
 * floor per module instead (a module is a set of path prefixes), and this
 * script reads the JSON report Stryker writes and fails when any module
 * scores below its floor. The score is Stryker's: killed and timed-out
 * mutants over every mutant that was valid and covered or not, so a mutant no
 * test reaches counts against the module.
 *
 * A mutated file that no module claims fails the check too. Before this it
 * was skipped without a word: `seizures-backup-schema.ts` was mutated every
 * night, scored 0 %, and no floor ever looked at it.
 *
 * Floors sit just below the last measured score. Raise one when a change
 * raises the score; a floor that is lowered to let a run pass has stopped
 * being a floor.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

/**
 * Judge a Stryker JSON report against the module floors.
 *
 * `report` is the parsed `mutation.json`, `modules` the `modules` object of
 * `stryker.floors.json`, `root` the directory the report's paths are
 * relative to. Returns one printable row per module, the mutated files no
 * module claims, whether a module is under its floor (or matched nothing),
 * and whether the check failed for either reason.
 */
export function checkFloors({ report, modules, root }) {
  const files = Object.entries(report.files ?? {}).map(([path, file]) => [
    relative(root, resolve(root, path)).split("\\").join("/"),
    file,
  ]);

  const claimed = new Set();
  const rows = [];
  let belowFloor = false;
  for (const [name, { paths, floor }] of Object.entries(modules)) {
    let detected = 0;
    let undetected = 0;
    let matched = 0;
    for (const [path, file] of files) {
      if (!paths.some((prefix) => path.startsWith(prefix))) continue;
      claimed.add(path);
      matched += 1;
      for (const mutant of file.mutants ?? []) {
        if (DETECTED.has(mutant.status)) detected += 1;
        else if (UNDETECTED.has(mutant.status)) undetected += 1;
      }
    }
    const total = detected + undetected;
    const score = total === 0 ? null : (100 * detected) / total;
    const ok = matched > 0 && score !== null && score >= floor;
    if (!ok) belowFloor = true;
    rows.push(
      `${ok ? "ok  " : "FAIL"} ${name.padEnd(22)} ${
        score === null ? "no mutants" : `${score.toFixed(1)} %`
      } (floor ${floor} %, ${detected}/${total} mutants, ${matched} files)`,
    );
  }

  const unassigned = files
    .map(([path]) => path)
    .filter((path) => !claimed.has(path))
    .sort();
  for (const path of unassigned) {
    rows.push(`FAIL ${path} is mutated but belongs to no module`);
  }

  return {
    rows,
    unassigned,
    belowFloor,
    failed: belowFloor || unassigned.length > 0,
  };
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const reportPath = resolve(
    root,
    process.argv[2] ?? "reports/mutation/mutation.json",
  );
  const floorsPath = resolve(root, "stryker.floors.json");

  if (!existsSync(reportPath)) {
    console.error(
      `no mutation report at ${reportPath}; run pnpm exec stryker run`,
    );
    process.exit(2);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const { modules } = JSON.parse(readFileSync(floorsPath, "utf8"));
  const { rows, unassigned, belowFloor, failed } = checkFloors({
    report,
    modules,
    root,
  });

  console.log(rows.join("\n"));
  if (belowFloor) {
    console.error(
      "\nA module scored below its floor, or the report covered none of its files.",
    );
  }
  if (unassigned.length > 0) {
    console.error(
      "\nA mutated file belongs to no module in stryker.floors.json; add it to one.",
    );
  }
  if (failed) process.exit(1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
