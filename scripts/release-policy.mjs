#!/usr/bin/env node
// Release calendar and content rules. One source for CI and for a local run;
// docs/contributing/release-policy.md is the prose version of this file.
//
//   node scripts/release-policy.mjs check vX.Y.Z [--now <iso|unix>] [--github-output <file>]
//        [--schedule-starts-after X.Y.Z]   (dry run of the rules against older tags)
//   node scripts/release-policy.mjs next [--now <iso|unix>]          (pnpm release:next)
//   node scripts/release-policy.mjs pr --base <rev> --head <rev> --source <branch>
//
// `check` runs in the release-policy job of docker-publish.yml. It exits 1 on
// a hard error and writes `off_schedule=true|false` to the GitHub output. An
// off-schedule tag needs an `Out of schedule:` line in its changelog section
// and the maintainer's approval on the `off-schedule-release` environment.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The last release before the calendar applies. Tags up to it are exempt. */
export const SCHEDULE_STARTS_AFTER = "1.49.0";
export const TIME_ZONE = "Europe/Berlin";
/** Releases ship on Saturday, when self-hosters have time to update. */
export const RELEASE_WEEKDAY = 6;
/** A Saturday window runs until this hour on Sunday morning. */
export const WINDOW_CLOSES_HOUR = 6;
export const OUT_OF_SCHEDULE_REASONS = [
  "security",
  "data loss",
  "broken install",
];
/** Headings a patch entry may carry. `Updating` and `Thanks` describe no change. */
export const PATCH_HEADINGS = ["Fixed", "Security", "Updating", "Thanks"];

const STRICT_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FEAT_SUBJECT = /^feat(\([^)]*\))?!?:/;
const OUT_OF_SCHEDULE_PREFIX = /^Out of schedule:/m;
const OUT_OF_SCHEDULE_LINE = new RegExp(
  `^Out of schedule: (${OUT_OF_SCHEDULE_REASONS.join("|")}), (\\S.*)$`,
  "m",
);

// ── Versions ────────────────────────────────────────────────────────────

export function parseTag(tag) {
  const match = STRICT_TAG.exec(tag);
  if (!match) return null;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: tag.slice(1),
  };
}

export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

// ── Calendar (all dates are Europe/Berlin calendar days) ────────────────

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const berlinFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  hourCycle: "h23",
  weekday: "short",
});

export function berlinParts(date) {
  const parts = Object.fromEntries(
    berlinFormat.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday: WEEKDAYS[parts.weekday],
  };
}

/** A calendar day as a plain object; arithmetic runs on UTC noon. */
function day(year, month, dayOfMonth) {
  const d = new Date(Date.UTC(year, month - 1, dayOfMonth, 12));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
}

export function addDays(d, n) {
  return day(d.year, d.month, d.day + n);
}

export function compareDays(a, b) {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function formatDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

export function berlinDay(date) {
  const p = berlinParts(date);
  return day(p.year, p.month, p.day);
}

/**
 * The Saturday whose release window contains `date`, or null. A window runs
 * from Saturday 00:00 to Sunday 06:00 Europe/Berlin.
 */
export function releaseWindow(date) {
  const p = berlinParts(date);
  if (p.weekday === RELEASE_WEEKDAY) return day(p.year, p.month, p.day);
  if (p.weekday === (RELEASE_WEEKDAY + 1) % 7 && p.hour < WINDOW_CLOSES_HOUR) {
    return day(p.year, p.month, p.day - 1);
  }
  return null;
}

export function isFirstSaturday(d) {
  return d.weekday === RELEASE_WEEKDAY && d.day <= 7;
}

export function firstSaturdayOf(year, month) {
  const first = day(year, month, 1);
  return addDays(first, (RELEASE_WEEKDAY - first.weekday + 7) % 7);
}

/**
 * The first Saturday of the calendar month after the previous minor's month.
 * For a minor on a first Saturday that is the next month's first Saturday;
 * after the transition release (1.49.0, on 2026-11-23) it is 2026-12-05.
 */
export function earliestMinorDay(previousMinorDate) {
  const shipped = berlinDay(previousMinorDate);
  const nextMonth = day(shipped.year, shipped.month + 1, 1);
  return firstSaturdayOf(nextMonth.year, nextMonth.month);
}

export function nextSaturday(fromDay) {
  return addDays(fromDay, (RELEASE_WEEKDAY - fromDay.weekday + 7) % 7);
}

// ── Changelog ───────────────────────────────────────────────────────────

/** The body of `## [<name>]` up to the next `## ` heading, or null. */
export function changelogSection(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = /^## \[([^\]]+)\]/.exec(line);
    return match !== null && match[1] === name;
  });
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

export function sectionHeadings(section) {
  return [...section.matchAll(/^### (.+?)\s*$/gm)].map((m) => m[1]);
}

export function foreignPatchHeadings(section) {
  return sectionHeadings(section).filter((h) => !PATCH_HEADINGS.includes(h));
}

/** { reason, sentence } for a valid line, null for none, throws on a malformed one. */
export function outOfScheduleLine(section) {
  if (!OUT_OF_SCHEDULE_PREFIX.test(section)) return null;
  const match = OUT_OF_SCHEDULE_LINE.exec(section);
  if (!match) {
    throw new Error(
      `Malformed out-of-schedule line. Write "Out of schedule: <${OUT_OF_SCHEDULE_REASONS.join(" | ")}>, <one sentence>".`,
    );
  }
  return { reason: match[1], sentence: match[2].trim() };
}

export function unreleasedEntries(text) {
  const section = changelogSection(text, "Unreleased");
  if (section === null) return 0;
  return section.split("\n").filter((line) => /^- /.test(line)).length;
}

export function isFeatSubject(subject) {
  return FEAT_SUBJECT.test(subject);
}

// ── Rules ───────────────────────────────────────────────────────────────

/**
 * Judge one release tag.
 *
 * @param {object} input
 * @param {string} input.tag            the tag being released
 * @param {Date}   input.now            when it was pushed
 * @param {{name: string, date: Date}[]} input.tags  every tag in the repository
 * @param {string} input.changelog      CHANGELOG.md at the tag
 * @param {string[]} input.commitSubjects  non-merge subjects since the previous tag
 * @param {string} [input.scheduleStartsAfter]  override for a dry run against old tags
 * @returns {{ errors: string[], violations: string[], offSchedule: boolean, notes: string[] }}
 */
export function evaluateRelease({
  tag,
  now,
  tags,
  changelog,
  commitSubjects,
  scheduleStartsAfter = SCHEDULE_STARTS_AFTER,
}) {
  const errors = [];
  const violations = [];
  const notes = [];
  const result = () => ({
    errors,
    violations,
    notes,
    offSchedule: errors.length === 0 && violations.length > 0,
  });

  const current = parseTag(tag);
  if (!current) {
    errors.push(`'${tag}' is not a strict vMAJOR.MINOR.PATCH tag.`);
    return result();
  }

  const released = tags
    .map((t) => ({ ...parseTag(t.name), date: t.date }))
    .filter((t) => t.tag !== undefined && t.tag !== tag);
  const earlier = released
    .filter((t) => compareVersions(t, current) < 0)
    .sort(compareVersions);
  const previous = earlier.at(-1);
  if (!previous) {
    // A rule that finds nothing to compare against must not pass.
    errors.push(`No release tag before ${tag}. The calendar check needs one.`);
    return result();
  }
  notes.push(`Previous release: ${previous.tag}.`);

  if (compareVersions(current, parseTag(`v${scheduleStartsAfter}`)) <= 0) {
    notes.push(
      `${tag} is not after v${scheduleStartsAfter}, the last release before the calendar. No calendar check.`,
    );
    return result();
  }

  const section = changelogSection(changelog, current.version);
  if (section === null) {
    errors.push(`CHANGELOG.md has no "## [${current.version}]" section.`);
    return result();
  }

  const window = releaseWindow(now);
  const isMinor = current.patch === 0;
  const previousMinor = earlier.filter((t) => t.patch === 0).at(-1);
  if (!previousMinor) {
    errors.push(
      `No minor release tag before ${tag}. The calendar check needs one.`,
    );
    return result();
  }
  const minorDue = earliestMinorDay(previousMinor.date);

  if (!window) {
    violations.push(
      `${formatDay(berlinDay(now))} is not inside a Saturday release window (Saturday 00:00 to Sunday 0${WINDOW_CLOSES_HOUR}:00 ${TIME_ZONE}).`,
    );
  } else if (isMinor) {
    if (!isFirstSaturday(window)) {
      violations.push(
        `A minor release ships on the first Saturday of a month; ${formatDay(window)} is not one.`,
      );
    } else if (compareDays(window, minorDue) < 0) {
      violations.push(
        `The next minor after ${previousMinor.tag} is due on ${formatDay(minorDue)}, not ${formatDay(window)}.`,
      );
    }
  } else if (isFirstSaturday(window) && compareDays(window, minorDue) >= 0) {
    violations.push(
      `${formatDay(window)} is the minor release's Saturday; a patch takes another Saturday.`,
    );
  }

  if (window) {
    const sameWindow = released.filter((t) => {
      const other = releaseWindow(t.date);
      return other !== null && compareDays(other, window) === 0;
    });
    if (sameWindow.length > 0) {
      violations.push(
        `${sameWindow.map((t) => t.tag).join(", ")} already shipped in the window of ${formatDay(window)}; one release per Saturday.`,
      );
    }
  }

  if (!isMinor) {
    const feats = commitSubjects.filter(isFeatSubject);
    if (feats.length > 0) {
      violations.push(
        `A patch carries fixes only, but ${previous.tag}..${tag} has ${feats.length} feat commit(s): ${feats.join(" | ")}`,
      );
    }
    const foreign = foreignPatchHeadings(section);
    if (foreign.length > 0) {
      violations.push(
        `A patch changelog entry has only ${PATCH_HEADINGS.map((h) => `### ${h}`).join(", ")}; found ${foreign.map((h) => `### ${h}`).join(", ")}.`,
      );
    }
  }

  let line = null;
  try {
    line = outOfScheduleLine(section);
  } catch (error) {
    errors.push(error.message);
    return result();
  }
  if (violations.length > 0) {
    if (!line) {
      errors.push(
        `${tag} breaks the release calendar and its changelog section has no "Out of schedule: <${OUT_OF_SCHEDULE_REASONS.join(" | ")}>, <one sentence>" line.`,
      );
    } else {
      notes.push(`Out of schedule (${line.reason}): ${line.sentence}`);
    }
  }
  return result();
}

/**
 * Judge a pull request to main. Only a release branch may bring features.
 */
export function evaluatePullRequest({ source, commitSubjects, changelog }) {
  const errors = [];
  if (/^release\/v/.test(source)) {
    return {
      errors,
      notes: [`${source} is a release branch; features are expected.`],
    };
  }
  const feats = commitSubjects.filter(isFeatSubject);
  if (feats.length > 0) {
    errors.push(
      `main is the fix line. ${feats.length} feat commit(s) belong on the current release/vX.Y.0 branch: ${feats.join(" | ")}`,
    );
  }
  const unreleased =
    changelog === null ? null : changelogSection(changelog, "Unreleased");
  if (unreleased !== null) {
    const foreign = foreignPatchHeadings(unreleased);
    if (foreign.length > 0) {
      errors.push(
        `"## [Unreleased]" on main takes ${PATCH_HEADINGS.map((h) => `### ${h}`).join(", ")} only; ${foreign.map((h) => `### ${h}`).join(", ")} belongs on the current release/vX.Y.0 branch.`,
      );
    }
  }
  return { errors, notes: [] };
}

/** What `pnpm release:next` prints. */
/**
 * The release tag is annotated and signed. With `tag.gpgsign` set, a bare
 * `git tag vX.Y.Z` stops at "no tag message", and the tag ruleset allows no
 * delete and no move, so the command is printed in full rather than recalled.
 */
export function tagCommand(tag) {
  return `Tag the release commit on main as an annotated, signed tag, then push it: git tag -s -m "${tag}" ${tag} <sha> && git push origin ${tag}`;
}

export function describeNext({ now, tags, changelog }) {
  const stable = tags
    .map((t) => ({ ...parseTag(t.name), date: t.date }))
    .filter((t) => t.tag !== undefined)
    .sort(compareVersions);
  const latest = stable.at(-1);
  if (!latest) return ["No release tag found."];
  const lines = [
    `Latest release: ${latest.tag} (${formatDay(berlinDay(latest.date))}).`,
  ];

  if (compareVersions(latest, parseTag(`v${SCHEDULE_STARTS_AFTER}`)) < 0) {
    lines.push(
      `Next release: v${SCHEDULE_STARTS_AFTER}, the last one before the calendar. It ships when its planned work is done and green, on any day.`,
    );
    lines.push(
      "After it, the first minor is on the first Saturday of the next calendar month.",
      tagCommand(`v${SCHEDULE_STARTS_AFTER}`),
    );
    return lines;
  }

  const previousMinor = stable.filter((t) => t.patch === 0).at(-1);
  const minorDue = earliestMinorDay(previousMinor.date);
  const nextMinor = `v${latest.major}.${latest.minor + 1}.0`;
  const today = berlinDay(now);
  const window = releaseWindow(now);
  const shippedThisWindow =
    window !== null &&
    stable.some((t) => {
      const other = releaseWindow(t.date);
      return other !== null && compareDays(other, window) === 0;
    });
  const searchFrom =
    window && !shippedThisWindow ? window : addDays(window ?? today, 1);
  let patchDay = nextSaturday(searchFrom);
  if (compareDays(patchDay, minorDue) === 0) patchDay = addDays(patchDay, 7);

  const entries = unreleasedEntries(changelog);
  const nextPatch = `v${latest.major}.${latest.minor}.${latest.patch + 1}`;
  lines.push(
    entries > 0
      ? `Next patch: ${nextPatch} on Saturday ${formatDay(patchDay)}, ${entries} entr${entries === 1 ? "y" : "ies"} under Unreleased.`
      : `Next patch: nothing under Unreleased, so no patch is due (earliest Saturday ${formatDay(patchDay)}).`,
  );
  lines.push(
    `Next minor: ${nextMinor} on Saturday ${formatDay(minorDue)}, with whatever is done and green on release/${nextMinor} by then.`,
  );

  if (window && !shippedThisWindow && compareDays(window, minorDue) === 0) {
    lines.push(`Today: release day for ${nextMinor}.`, tagCommand(nextMinor));
  } else if (window && !shippedThisWindow && entries > 0) {
    lines.push(`Today: release day for ${nextPatch}.`, tagCommand(nextPatch));
  } else {
    lines.push(
      "Today: not a release day. Stop here; a tag today needs an out-of-schedule reason and approval.",
    );
  }
  return lines;
}

// ── CLI ─────────────────────────────────────────────────────────────────

export function parseNow(value) {
  if (value === undefined || value === "") return new Date();
  const date = /^\d+$/.test(value)
    ? new Date(Number(value) * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Cannot read --now '${value}'.`);
  return date;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * An annotated tag carries its own time (the tagger date), which is when the
 * release was made. A lightweight tag (every tag up to v1.48.5) has none; the
 * tagged commit's date stands in. `creatordate` picks whichever applies.
 */
export function readTags(cwd) {
  return git(
    [
      "for-each-ref",
      "refs/tags",
      "--format=%(refname:short)%09%(creatordate:iso-strict)",
    ],
    cwd,
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, date] = line.split("\t");
      return { name, date: new Date(date) };
    });
}

function readSubjects(range, cwd) {
  return git(["log", "--no-merges", "--format=%s", range], cwd)
    .split("\n")
    .filter(Boolean);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

export function main(
  argv,
  { cwd = process.cwd(), log = console.log, error = console.error } = {},
) {
  const { positional, flags } = parseArgs(argv);
  const [command, tagArg] = positional;
  const changelogPath = flags.changelog ?? "CHANGELOG.md";

  if (command === "check") {
    if (!tagArg) {
      error(
        "Usage: release-policy.mjs check vX.Y.Z [--now <iso|unix>] [--github-output <file>]",
      );
      return 2;
    }
    const tags = readTags(cwd);
    const current = parseTag(tagArg);
    const previous = current
      ? tags
          .map((t) => parseTag(t.name))
          .filter((t) => t && compareVersions(t, current) < 0)
          .sort(compareVersions)
          .at(-1)
      : undefined;
    const outcome = evaluateRelease({
      tag: tagArg,
      now: parseNow(flags.now),
      tags,
      changelog: readFileSync(resolve(cwd, changelogPath), "utf8"),
      commitSubjects: previous
        ? readSubjects(`${previous.tag}..${tagArg}`, cwd)
        : [],
      scheduleStartsAfter: flags["schedule-starts-after"],
    });
    for (const note of outcome.notes) log(note);
    for (const violation of outcome.violations)
      log(`Off schedule: ${violation}`);
    for (const message of outcome.errors) error(`::error::${message}`);
    const output = flags["github-output"];
    if (output && outcome.errors.length === 0) {
      appendFileSync(output, `off_schedule=${outcome.offSchedule}\n`);
    }
    if (outcome.errors.length > 0) return 1;
    log(
      outcome.offSchedule
        ? `${tagArg} is out of schedule; publishing waits for approval on the off-schedule-release environment.`
        : `${tagArg} passes the release policy without approval.`,
    );
    return 0;
  }

  if (command === "next") {
    let changelog = "";
    try {
      changelog = readFileSync(resolve(cwd, changelogPath), "utf8");
    } catch {
      changelog = "";
    }
    for (const line of describeNext({
      now: parseNow(flags.now),
      tags: readTags(cwd),
      changelog,
    })) {
      log(line);
    }
    return 0;
  }

  if (command === "pr") {
    if (!flags.base || !flags.head || flags.source === undefined) {
      error(
        "Usage: release-policy.mjs pr --base <rev> --head <rev> --source <branch>",
      );
      return 2;
    }
    let changelog = null;
    try {
      changelog = git(["show", `${flags.head}:${changelogPath}`], cwd);
    } catch {
      changelog = null;
    }
    const outcome = evaluatePullRequest({
      source: flags.source,
      commitSubjects: readSubjects(`${flags.base}..${flags.head}`, cwd),
      changelog,
    });
    for (const note of outcome.notes) log(note);
    for (const message of outcome.errors) error(`::error::${message}`);
    if (outcome.errors.length > 0) return 1;
    log("Pull request follows the release policy.");
    return 0;
  }

  error("Usage: release-policy.mjs <check|next|pr> ...");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
