import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PATCH_HEADINGS,
  SCHEDULE_STARTS_AFTER,
  describeNext,
  earliestMinorDay,
  evaluatePullRequest,
  evaluateRelease,
  formatDay,
  main,
  outOfScheduleLine,
  readTags,
  releaseWindow,
  tagCommand,
} from "../release-policy.mjs";

const at = (iso: string) => new Date(iso);
const tag = (name: string, iso: string) => ({ name, date: at(iso) });

function changelog(
  sections: Record<string, string[]>,
  extra: Record<string, string> = {},
): string {
  const parts = ["# Changelog", ""];
  for (const [version, headings] of Object.entries(sections)) {
    parts.push(`## [${version}] — 2026-12-01`, "");
    if (extra[version]) parts.push(extra[version], "");
    for (const heading of headings) {
      parts.push(`### ${heading}`, "", "- An entry.", "");
    }
  }
  return parts.join("\n");
}

// 1.49.0 ships on a Thursday in December; the calendar starts after it.
const HISTORY = [
  tag("v1.48.5", "2026-11-21T09:44:00+01:00"),
  tag("v1.49.0", "2026-12-10T18:00:00+01:00"),
];

type ReleaseInput = Parameters<typeof evaluateRelease>[0];

function judge(overrides: Partial<ReleaseInput> & { tag: string; now: Date }) {
  return evaluateRelease({
    tags: HISTORY,
    changelog: changelog({ [overrides.tag.slice(1)]: ["Fixed"] }),
    commitSubjects: ["fix(sync): keep a deleted row deleted"],
    ...overrides,
  });
}

describe("release windows", () => {
  it.each([
    ["2026-12-19T00:00:00+01:00", "2026-12-19"],
    ["2026-12-19T23:59:00+01:00", "2026-12-19"],
    ["2026-12-20T05:59:00+01:00", "2026-12-19"],
    // Summer time: the window still follows the Berlin wall clock.
    ["2027-04-10T00:30:00+02:00", "2027-04-10"],
  ])("puts %s in the window of %s", (iso, expected) => {
    const window = releaseWindow(at(iso));
    expect(window && formatDay(window)).toBe(expected);
  });

  it.each([
    "2026-12-18T23:59:00+01:00",
    "2026-12-20T06:00:00+01:00",
    "2026-12-17T12:00:00+01:00",
  ])("finds no window at %s", (iso) => {
    expect(releaseWindow(at(iso))).toBeNull();
  });

  it.each([
    // An early-December 1.49.0 leaves room for a January minor.
    ["2026-12-08T20:00:00+01:00", "2027-01-02"],
    // A mid-December one is too close to January: the first minor is February.
    ["2026-12-19T20:00:00+01:00", "2027-02-06"],
    // A regular minor on a first Saturday is followed by next month's.
    ["2027-01-02T20:00:00+01:00", "2027-02-06"],
    ["2027-07-03T20:00:00+02:00", "2027-08-07"],
    // Exactly three weeks before the 1st still counts.
    ["2027-03-11T12:00:00+01:00", "2027-04-03"],
  ])("dates the minor after one shipped at %s to %s", (iso, expected) => {
    expect(formatDay(earliestMinorDay(at(iso)))).toBe(expected);
  });
});

describe("the transition release", () => {
  it("lets the last release before the calendar ship on any day", () => {
    expect(SCHEDULE_STARTS_AFTER).toBe("1.49.0");
    const result = evaluateRelease({
      tag: "v1.49.0",
      now: at("2026-12-10T18:00:00+01:00"), // a Thursday
      tags: HISTORY,
      changelog: changelog({ "1.49.0": ["Added", "Changed", "Fixed"] }),
      commitSubjects: ["feat(push): relay"],
    });
    expect(result.errors).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.offSchedule).toBe(false);
  });

  it("checks the first tag after it", () => {
    const result = judge({
      tag: "v1.49.1",
      now: at("2026-12-11T12:00:00+01:00"), // the Friday after
    });
    expect(result.violations).toHaveLength(1);
    expect(result.errors[0]).toContain("Out of schedule");
  });
});

describe("release calendar", () => {
  it("fails when there is no earlier tag to compare against", () => {
    const result = evaluateRelease({
      tag: "v1.50.0",
      now: at("2027-01-02T20:00:00+01:00"),
      tags: [],
      changelog: changelog({ "1.50.0": ["Added"] }),
      commitSubjects: [],
    });
    expect(result.errors[0]).toContain("No release tag before v1.50.0");
    expect(result.offSchedule).toBe(false);
  });

  it("fails when there is no earlier minor to date the next one from", () => {
    const result = evaluateRelease({
      tag: "v1.50.1",
      now: at("2027-01-09T20:00:00+01:00"),
      tags: [tag("v1.49.9", "2027-01-01T12:00:00+01:00")],
      changelog: changelog({ "1.50.1": ["Fixed"] }),
      commitSubjects: [],
      scheduleStartsAfter: "1.0.0",
    });
    expect(result.errors[0]).toContain("No minor release tag");
  });

  it("accepts a minor on its first Saturday", () => {
    const result = judge({
      tag: "v1.50.0",
      now: at("2027-01-02T20:00:00+01:00"),
      changelog: changelog({ "1.50.0": ["Added", "Changed", "Fixed"] }),
      commitSubjects: ["feat(x): something new"],
    });
    expect(result.violations).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("flags a minor on a later Saturday", () => {
    const result = judge({
      tag: "v1.50.0",
      now: at("2027-01-09T20:00:00+01:00"),
    });
    expect(result.violations[0]).toContain("first Saturday");
  });

  it("flags a minor before three weeks have passed since the last one", () => {
    const result = judge({
      tag: "v1.50.0",
      now: at("2027-01-02T20:00:00+01:00"),
      tags: [
        tag("v1.48.5", "2026-11-21T09:44:00+01:00"),
        tag("v1.49.0", "2026-12-15T18:00:00+01:00"),
      ],
    });
    expect(result.violations[0]).toContain("due on 2027-02-06");
  });

  it("accepts a patch on a later Saturday, until Sunday 06:00", () => {
    for (const now of [
      "2026-12-19T20:00:00+01:00",
      "2026-12-20T05:30:00+01:00",
    ]) {
      const result = judge({ tag: "v1.49.1", now: at(now) });
      expect(result.violations, now).toEqual([]);
      expect(result.errors, now).toEqual([]);
    }
  });

  it("flags a patch outside a Saturday window", () => {
    const result = judge({
      tag: "v1.49.1",
      now: at("2026-12-17T12:00:00+01:00"),
    });
    expect(result.violations[0]).toContain("not inside a Saturday");
  });

  it("flags a patch on the minor's Saturday", () => {
    const result = judge({
      tag: "v1.49.3",
      now: at("2027-01-02T20:00:00+01:00"),
    });
    expect(result.violations[0]).toContain("minor release's Saturday");
  });

  it("allows a patch on a first Saturday that no minor claims", () => {
    const result = judge({
      tag: "v1.49.3",
      now: at("2027-01-02T20:00:00+01:00"),
      tags: [
        tag("v1.48.5", "2026-11-21T09:44:00+01:00"),
        tag("v1.49.0", "2026-12-15T18:00:00+01:00"),
      ],
    });
    expect(result.violations).toEqual([]);
  });

  it("flags a second release in the same window", () => {
    const result = judge({
      tag: "v1.49.2",
      now: at("2026-12-19T22:00:00+01:00"),
      tags: [...HISTORY, tag("v1.49.1", "2026-12-19T19:00:00+01:00")],
    });
    expect(result.violations[0]).toContain("v1.49.1 already shipped");
  });
});

describe("patch content", () => {
  const saturday = at("2026-12-19T20:00:00+01:00");

  it("flags a feat commit in a patch", () => {
    const result = judge({
      tag: "v1.49.1",
      now: saturday,
      commitSubjects: ["fix(a): b", "feat(sleep): add a chart", "feat!: drop"],
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("2 feat commit(s)");
  });

  it("does not take a subject that merely mentions a feature for feat", () => {
    const result = judge({
      tag: "v1.49.1",
      now: saturday,
      commitSubjects: ["fix(feat-flags): read the feature list again"],
    });
    expect(result.violations).toEqual([]);
  });

  it.each(["Added", "Changed", "Removed", "Deprecated", "Performance"])(
    "flags a patch changelog with ### %s",
    (heading) => {
      const result = judge({
        tag: "v1.49.1",
        now: saturday,
        changelog: changelog({ "1.49.1": ["Fixed", heading] }),
      });
      expect(result.violations[0]).toContain(`### ${heading}`);
    },
  );

  it("accepts every heading a patch may carry", () => {
    const result = judge({
      tag: "v1.49.1",
      now: saturday,
      changelog: changelog({ "1.49.1": PATCH_HEADINGS }),
    });
    expect(result.violations).toEqual([]);
  });

  it("does not hold a minor to the patch rules", () => {
    const result = judge({
      tag: "v1.50.0",
      now: at("2027-01-02T20:00:00+01:00"),
      changelog: changelog({ "1.50.0": ["Added", "Removed"] }),
      commitSubjects: ["feat(a): b"],
    });
    expect(result.violations).toEqual([]);
  });

  it("fails when the changelog has no section for the version", () => {
    const result = judge({
      tag: "v1.49.1",
      now: saturday,
      changelog: changelog({ "1.49.0": ["Fixed"] }),
    });
    expect(result.errors[0]).toContain('no "## [1.49.1]" section');
  });

  it("reads only its own section", () => {
    const result = judge({
      tag: "v1.49.1",
      now: saturday,
      changelog: changelog({ "1.49.1": ["Fixed"], "1.49.0": ["Added"] }),
    });
    expect(result.violations).toEqual([]);
  });
});

describe("out-of-schedule line", () => {
  const thursday = at("2026-12-17T12:00:00+01:00");

  it.each(["security", "data loss", "broken install"])(
    "accepts the reason %s and marks the release off schedule",
    (reason) => {
      const result = judge({
        tag: "v1.49.1",
        now: thursday,
        changelog: changelog(
          { "1.49.1": ["Security"] },
          { "1.49.1": `Out of schedule: ${reason}, the reason in a sentence.` },
        ),
      });
      expect(result.errors).toEqual([]);
      expect(result.offSchedule).toBe(true);
      expect(result.notes.join("\n")).toContain(`Out of schedule (${reason})`);
    },
  );

  it("refuses an off-schedule release without the line", () => {
    const result = judge({ tag: "v1.49.1", now: thursday });
    expect(result.errors[0]).toContain("has no");
    expect(result.offSchedule).toBe(false);
  });

  it.each([
    "Out of schedule: urgent, it had to go out.",
    "Out of schedule: security",
    "Out of schedule: security,",
  ])("refuses the malformed line %j", (line) => {
    expect(() => outOfScheduleLine(line)).toThrow(/Malformed/);
    const result = judge({
      tag: "v1.49.1",
      now: thursday,
      changelog: changelog({ "1.49.1": ["Fixed"] }, { "1.49.1": line }),
    });
    expect(result.errors[0]).toContain("Malformed");
  });

  it("finds the line only in the version's own section", () => {
    const result = judge({
      tag: "v1.49.2",
      now: thursday,
      changelog: changelog(
        { "1.49.2": ["Fixed"], "1.49.1": ["Fixed"] },
        { "1.49.1": "Out of schedule: security, an older release." },
      ),
    });
    expect(result.errors[0]).toContain("has no");
  });
});

describe("pull requests to main", () => {
  const fixOnly = changelog({ Unreleased: ["Fixed"] });

  it("lets a release branch bring features", () => {
    const result = evaluatePullRequest({
      source: "release/v1.50.0",
      commitSubjects: ["feat(a): b"],
      changelog: changelog({ Unreleased: ["Added"] }),
    });
    expect(result.errors).toEqual([]);
  });

  it("refuses a feat commit from any other branch", () => {
    for (const source of ["fix/sleep", "feat/sleep", "hotfix/v1.50.1", ""]) {
      const result = evaluatePullRequest({
        source,
        commitSubjects: ["fix(a): b", "feat(sleep): chart"],
        changelog: fixOnly,
      });
      expect(result.errors[0], source).toContain("release/vX.Y.0");
    }
  });

  it("refuses an Unreleased section that grows a feature heading", () => {
    const result = evaluatePullRequest({
      source: "fix/sleep",
      commitSubjects: ["fix(a): b"],
      changelog: changelog({ Unreleased: ["Fixed", "Changed"] }),
    });
    expect(result.errors[0]).toContain("### Changed");
  });

  it("accepts fixes", () => {
    const result = evaluatePullRequest({
      source: "fix/sleep",
      commitSubjects: ["fix(a): b", "docs: c"],
      changelog: fixOnly,
    });
    expect(result.errors).toEqual([]);
  });
});

describe("release:next", () => {
  it("names the transition release while it is still ahead", () => {
    const lines = describeNext({
      now: at("2026-11-24T12:00:00+01:00"),
      tags: [tag("v1.48.5", "2026-11-21T09:44:00+01:00")],
      changelog: "",
    });
    expect(lines.join("\n")).toContain("Next release: v1.49.0");
  });

  it("prints the next patch and minor after the transition", () => {
    const lines = describeNext({
      now: at("2026-12-11T12:00:00+01:00"),
      tags: HISTORY,
      changelog: changelog({ Unreleased: ["Fixed"], "1.49.0": ["Added"] }),
    }).join("\n");
    expect(lines).toContain("Next patch: v1.49.1 on Saturday 2026-12-12");
    expect(lines).toContain("1 entry under Unreleased");
    expect(lines).toContain("Next minor: v1.50.0 on Saturday 2027-01-02");
    expect(lines).toContain("not a release day");
  });

  it("says when today is the day", () => {
    const lines = describeNext({
      now: at("2026-12-19T20:00:00+01:00"),
      tags: HISTORY,
      changelog: changelog({ Unreleased: ["Fixed"] }),
    }).join("\n");
    expect(lines).toContain("Today: release day for v1.49.1");
    expect(lines).toContain(tagCommand("v1.49.1"));
    expect(tagCommand("v1.49.1")).toContain(
      'git tag -s -m "v1.49.1" v1.49.1 <sha>',
    );
  });

  it("finds no patch to ship with nothing under Unreleased", () => {
    const lines = describeNext({
      now: at("2026-12-19T20:00:00+01:00"),
      tags: HISTORY,
      changelog: changelog({ "1.49.0": ["Added"] }),
    }).join("\n");
    expect(lines).toContain("no patch is due");
    expect(lines).toContain("not a release day");
  });

  it("does not offer the minor's Saturday for a patch", () => {
    const lines = describeNext({
      now: at("2026-12-30T12:00:00+01:00"),
      tags: HISTORY,
      changelog: changelog({ Unreleased: ["Fixed"] }),
    }).join("\n");
    expect(lines).toContain("Next patch: v1.49.1 on Saturday 2027-01-09");
  });
});

describe("command line against a real repository", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const path of directories.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function repository() {
    const cwd = mkdtempSync(join(tmpdir(), "healthlog-release-calendar-"));
    directories.push(cwd);
    const run = (args: string[], date?: string) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          // Hermetic: the fixture repository must not inherit the machine's
          // git config. A maintainer's `tag.gpgsign=true` turns every bare
          // `git tag` into "no tag message?", and `commit.gpgsign` would
          // sign (or fail to sign) every fixture commit.
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
        },
      });
    run(["init", "-q", "-b", "main"]);
    const commit = (subject: string, date: string, log?: string) => {
      if (log !== undefined) writeFileSync(join(cwd, "CHANGELOG.md"), log);
      run(["add", "-A"]);
      run(["commit", "-q", "--allow-empty", "-m", subject], date);
    };
    return { cwd, run, commit };
  }

  function capture(argv: string[], cwd: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, {
      cwd,
      log: (line: string) => out.push(line),
      error: (line: string) => err.push(line),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("fails when the repository has no earlier tag", () => {
    const { cwd, run, commit } = repository();
    commit(
      "chore(release): v1.50.0",
      "2027-01-02T19:00:00+01:00",
      changelog({ "1.50.0": ["Added"] }),
    );
    run(["tag", "v1.50.0"]);
    const result = capture(
      ["check", "v1.50.0", "--now", "2027-01-02T20:00:00+01:00"],
      cwd,
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("No release tag before v1.50.0");
  });

  it("reads tags, commits and the changelog and writes the output", () => {
    const { cwd, run, commit } = repository();
    const output = join(cwd, "github-output");
    writeFileSync(output, "");
    commit("chore(release): v1.48.5", "2026-11-21T09:44:00+01:00");
    run(["tag", "v1.48.5"]);
    commit(
      "chore(release): v1.49.0",
      "2026-12-10T18:00:00+01:00",
      changelog({ "1.49.0": ["Added"] }),
    );
    run(["tag", "v1.49.0"]);
    commit("feat(sleep): a chart", "2026-12-12T10:00:00+01:00");
    commit(
      "chore(release): v1.49.1",
      "2026-12-19T19:00:00+01:00",
      changelog({ "1.49.1": ["Fixed"], "1.49.0": ["Added"] }),
    );
    run(["tag", "v1.49.1"]);

    const refused = capture(
      [
        "check",
        "v1.49.1",
        "--now",
        String(Date.parse("2026-12-19T20:00:00+01:00") / 1000),
        "--github-output",
        output,
      ],
      cwd,
    );
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("feat(sleep): a chart");
    expect(readFileSync(output, "utf8")).toBe("");

    const transition = capture(
      [
        "check",
        "v1.49.0",
        "--now",
        "2026-12-10T18:00:00+01:00",
        "--github-output",
        output,
      ],
      cwd,
    );
    expect(transition.code, transition.err).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("off_schedule=false\n");
  });

  it("writes off_schedule=true for an approved exception", () => {
    const { cwd, run, commit } = repository();
    const output = join(cwd, "github-output");
    writeFileSync(output, "");
    commit("chore(release): v1.48.5", "2026-11-21T09:44:00+01:00");
    run(["tag", "v1.48.5"]);
    commit(
      "chore(release): v1.49.0",
      "2026-12-10T18:00:00+01:00",
      changelog({ "1.49.0": ["Added"] }),
    );
    run(["tag", "v1.49.0"]);
    commit(
      "chore(release): v1.49.1",
      "2026-12-11T09:00:00+01:00",
      changelog(
        { "1.49.1": ["Security"], "1.49.0": ["Added"] },
        { "1.49.1": "Out of schedule: security, a session could be reused." },
      ),
    );
    run(["tag", "v1.49.1"]);
    const result = capture(
      [
        "check",
        "v1.49.1",
        "--now",
        "2026-12-11T09:30:00+01:00",
        "--github-output",
        output,
      ],
      cwd,
    );
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("off_schedule=true\n");
  });

  it("dates an annotated tag by its tagger date and a lightweight one by its commit", () => {
    const { cwd, run, commit } = repository();
    commit("chore(release): v1.48.5", "2026-11-21T09:44:00+01:00");
    run(["tag", "v1.48.5"]);
    commit(
      "chore(release): v1.49.0",
      "2026-12-10T18:00:00+01:00",
      changelog({ "1.49.0": ["Added"] }),
    );
    // The release tag is annotated (signed in real use, `-s`); the fixture
    // has no key, so `-a` stands in. Its tagger date is two days after the
    // commit, the way a tag made on Saturday points at Thursday's commit.
    run(["tag", "-a", "-m", "v1.49.0", "v1.49.0"], "2026-12-12T10:00:00+01:00");
    expect(
      run(["cat-file", "-t", "v1.49.0"]).trim(),
      "the fixture tag must be an annotated tag object",
    ).toBe("tag");

    const tags = Object.fromEntries(
      readTags(cwd).map((t) => [t.name, t.date.toISOString()]),
    );
    expect(tags).toEqual({
      "v1.48.5": "2026-11-21T08:44:00.000Z",
      "v1.49.0": "2026-12-12T09:00:00.000Z",
    });

    const output = join(cwd, "github-output");
    writeFileSync(output, "");
    const result = capture(
      [
        "check",
        "v1.49.0",
        "--now",
        "2026-12-12T10:05:00+01:00",
        "--github-output",
        output,
      ],
      cwd,
    );
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("off_schedule=false\n");
  });

  it("checks a pull request range", () => {
    const { cwd, run, commit } = repository();
    commit(
      "chore: base",
      "2026-12-10T18:00:00+01:00",
      changelog({ Unreleased: [] }),
    );
    run(["branch", "base"]);
    commit("feat(sleep): a chart", "2026-12-11T10:00:00+01:00");
    const refused = capture(
      ["pr", "--base", "base", "--head", "HEAD", "--source", "fix/sleep"],
      cwd,
    );
    expect(refused.code).toBe(1);
    const accepted = capture(
      ["pr", "--base", "base", "--head", "HEAD", "--source", "release/v1.50.0"],
      cwd,
    );
    expect(accepted.code).toBe(0);
  });
});
