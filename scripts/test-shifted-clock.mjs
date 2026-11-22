#!/usr/bin/env node
// Runs the unit suite under moved wall clocks and reports what fails at an
// instant but not at the real one.
//
//   node scripts/test-shifted-clock.mjs                  # the default instants
//   node scripts/test-shifted-clock.mjs --at 2027-03-28T00:30:00Z [--at ...]
//   node scripts/test-shifted-clock.mjs --zone America/New_York
//   node scripts/test-shifted-clock.mjs --list           # print, run nothing
//   node scripts/test-shifted-clock.mjs -- src/lib/tz    # extra vitest args
//
// The default instants are worked out from today, in `--zone` (Europe/Berlin
// unless named): the hour before the next local midnight, 20 minutes either
// side of it, the next local morning, 30 minutes before the next spring and
// autumn change of clocks, the first half hour after the short day, the last
// half hour of the long one, and the first half hour of the next new year.
// That is where the calendar bugs live: a day boundary, a 23- or 25-hour
// day, a year change. A fixture with absolute dates that only works while
// "now" stands near them fails here too, before the calendar gets there.
//
// The suite itself runs under `TZ=UTC` (vitest.config.mts); only the wall
// clock moves. A first run at the real time (offset zero) is the control:
// anything that fails there is the clock shim or the machine, not the
// instant, and is left out of every comparison. Each run takes as long as a
// full `pnpm test`; expect the default set to take a while. Not wired into
// CI: it is a probe to run before a release and after date-handling work.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const SHIM = pathToFileURL(join(ROOT, "scripts/shifted-clock-shim.mjs")).href;
const HOUR = 3_600_000;

function parseArgs(argv) {
  const at = [];
  let zone = "Europe/Berlin";
  let list = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--at") at.push(argv[++i]);
    else if (arg === "--zone") zone = argv[++i];
    else if (arg === "--list") list = true;
    else rest.push(arg);
  }
  for (const instant of at) {
    if (Number.isNaN(Date.parse(instant))) {
      throw new Error(`--at ${instant} is not an ISO instant`);
    }
  }
  return { at, zone, list, rest };
}

/** Minutes the zone is ahead of UTC at `ms`. */
function offsetMinutes(ms, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  return Math.round((wall - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** The UTC instant of a local wall-clock time in `zone`. */
function localToUtc(year, month, day, hour, minute, zone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMinutes(guess, zone) * 60_000;
  return guess - offsetMinutes(first, zone) * 60_000;
}

function localDate(ms, zone) {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
  })
    .format(new Date(ms))
    .split("-")
    .map(Number);
  return { year, month, day };
}

/** The next instants the zone's offset changes, within a year. */
function nextTransitions(fromMs, zone) {
  const found = [];
  let before = offsetMinutes(fromMs, zone);
  for (let t = fromMs + HOUR; t < fromMs + 366 * 24 * HOUR; t += HOUR) {
    const now = offsetMinutes(t, zone);
    if (now === before) continue;
    let lo = t - HOUR;
    let hi = t;
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (offsetMinutes(mid, zone) === before) lo = mid;
      else hi = mid;
    }
    found.push({ at: hi, forward: now > before });
    before = now;
  }
  return found;
}

function defaultInstants(zone) {
  const now = Date.now();
  const today = localDate(now, zone);
  const nextDay = localDate(now + 24 * HOUR, zone);
  const midnight = localToUtc(
    nextDay.year,
    nextDay.month,
    nextDay.day,
    0,
    0,
    zone,
  );
  const morning = localToUtc(
    nextDay.year,
    nextDay.month,
    nextDay.day,
    8,
    50,
    zone,
  );
  const out = [
    ["hour before local midnight", midnight - 61 * 60_000],
    ["20 min before local midnight", midnight - 20 * 60_000],
    ["20 min after local midnight", midnight + 20 * 60_000],
    ["local morning", morning],
  ];
  const transitions = nextTransitions(now, zone);
  const spring = transitions.find((t) => t.forward);
  const autumn = transitions.find((t) => !t.forward);
  if (spring) {
    const d = localDate(spring.at + 24 * HOUR, zone);
    out.push(["30 min before the clocks go forward", spring.at - 30 * 60_000]);
    out.push([
      "first half hour after the short day",
      localToUtc(d.year, d.month, d.day, 0, 30, zone),
    ]);
  }
  if (autumn) {
    const d = localDate(autumn.at, zone);
    out.push(["30 min before the clocks go back", autumn.at - 30 * 60_000]);
    out.push([
      "last half hour of the long day",
      localToUtc(d.year, d.month, d.day, 23, 30, zone),
    ]);
  }
  out.push([
    "first half hour of the new year",
    localToUtc(today.year + 1, 1, 1, 0, 30, zone),
  ]);
  return out.map(([label, ms]) => [label, new Date(ms).toISOString()]);
}

function runSuite(probeNow, rest, dir) {
  const outputFile = join(dir, `${probeNow.replace(/[:.]/g, "-")}.json`);
  const nodeOptions = [process.env.NODE_OPTIONS, `--import ${SHIM}`]
    .filter(Boolean)
    .join(" ");
  spawnSync(
    join(ROOT, "node_modules/.bin/vitest"),
    [
      "run",
      "--project",
      "unit",
      "--project",
      "isolated",
      "--project",
      "guards",
      "--reporter=json",
      `--outputFile=${outputFile}`,
      ...rest,
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, PROBE_NOW: probeNow, NODE_OPTIONS: nodeOptions },
    },
  );
  const report = JSON.parse(readFileSync(outputFile, "utf8"));
  const failed = new Set();
  for (const file of report.testResults) {
    const name = file.name.slice(ROOT.length + 1);
    const tests = file.assertionResults.filter((a) => a.status === "failed");
    if (file.status === "failed" && tests.length === 0) {
      failed.add(`${name} (the file did not run)`);
    }
    for (const test of tests) failed.add(`${name} > ${test.fullName}`);
  }
  return { failed, total: report.numTotalTests };
}

const { at, zone, list, rest } = parseArgs(process.argv.slice(2));
const instants =
  at.length > 0 ? at.map((iso) => ["--at", iso]) : defaultInstants(zone);
if (list) {
  for (const [label, iso] of instants) console.log(`${iso}  ${label}`);
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), "shifted-clock-"));
let failures = 0;
try {
  const control = runSuite(new Date().toISOString(), rest, dir);
  console.log(
    `control (real time): ${control.total} tests, ${control.failed.size} failing, left out below`,
  );
  for (const name of control.failed) console.log(`  ${name}`);
  for (const [label, iso] of instants) {
    const run = runSuite(iso, rest, dir);
    const own = [...run.failed].filter((name) => !control.failed.has(name));
    failures += own.length;
    console.log(`${iso} (${label}): ${own.length} failing`);
    for (const name of own) console.log(`  ${name}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failures > 0 ? 1 : 0);
