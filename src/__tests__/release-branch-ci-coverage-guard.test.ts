/**
 * Every gate that runs for a pull request into `main` also runs for a pull
 * request into `release/vX.Y.0`.
 *
 * Features land on the release branch through `feat/X` pull requests and
 * reach `main` once a month (docs/contributing/release-policy.md). The gate
 * workflows used to filter on `branches: [main]` alone, so a pull request
 * into a release branch ran nothing but the Dependabot auto-merge check and
 * could be merged with no test run at all; the first time anything tested
 * that code was the release pull request, a month later. This file reads
 * every workflow and fails when one covers `main` but not `release/**`,
 * for pull requests and for pushes alike.
 *
 * Two workflows are main-only on purpose and named below with the reason.
 * The exemption list is checked too: an entry that no longer exists, or that
 * has started covering release branches, fails, so the list cannot go stale.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS = join(process.cwd(), ".github/workflows");

/** A branch name the release model actually produces. */
const RELEASE_BRANCH = "release/v1.50.0";

type BranchFilter = {
  branches?: string[];
  "branches-ignore"?: string[];
  tags?: string[];
};
type Trigger = BranchFilter | null;
type Job = { if?: string };
type Workflow = {
  on?: string | string[] | Record<string, Trigger>;
  jobs?: Record<string, Job>;
};

/** Main-only by design. Keyed by file, then by event. */
const MAIN_ONLY: Record<
  string,
  { event: "pull_request" | "push"; why: string }[]
> = {
  "release-branch-policy.yml": [
    {
      event: "pull_request",
      why: "checks the fix line: a pull request to main may not carry a feat commit; on a release branch feat commits are the point",
    },
  ],
  "edge-image.yml": [
    {
      event: "push",
      why: "publishes the :edge image, which is defined as the head of main",
    },
  ],
};

function loadAll(): { file: string; workflow: Workflow }[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => ({
      file,
      workflow: parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow,
    }));
}

/** GitHub's branch-filter glob: `*` stops at `/`, `**` does not. */
function globMatches(pattern: string, branch: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`).test(branch);
}

/**
 * Whether the workflow runs for `event` on `branch`. A trigger without a
 * branch filter runs for every branch; one with only `tags` runs for none.
 */
function covers(
  workflow: Workflow,
  event: "pull_request" | "push",
  branch: string,
): boolean {
  const on = workflow.on;
  if (on === undefined) return false;
  if (typeof on === "string") return on === event;
  if (Array.isArray(on)) return on.includes(event);
  if (!(event in on)) return false;
  const filter = on[event];
  if (filter === null || filter === undefined) return true;
  if (filter.branches)
    return filter.branches.some((p) => globMatches(p, branch));
  if (filter["branches-ignore"]) {
    return !filter["branches-ignore"].some((p) => globMatches(p, branch));
  }
  return filter.tags === undefined;
}

function isExempt(file: string, event: "pull_request" | "push"): boolean {
  return (MAIN_ONLY[file] ?? []).some((entry) => entry.event === event);
}

describe("release-branch CI coverage", () => {
  const all = loadAll();

  it("reads the workflow directory", () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it("matches branch globs the way GitHub does", () => {
    expect(globMatches("release/**", RELEASE_BRANCH)).toBe(true);
    expect(globMatches("release/*", RELEASE_BRANCH)).toBe(true);
    expect(globMatches("main", RELEASE_BRANCH)).toBe(false);
    expect(globMatches("release/*", "release/a/b")).toBe(false);
    expect(globMatches("release/v1.50.0", "release/v1x50x0")).toBe(false);
  });

  for (const event of ["pull_request", "push"] as const) {
    it(`runs every ${event} gate on main for release branches too`, () => {
      const gates = all.filter(
        ({ file, workflow }) =>
          covers(workflow, event, "main") && !isExempt(file, event),
      );
      // The guard proves nothing if it finds nothing to check.
      expect(gates.length).toBeGreaterThanOrEqual(
        event === "pull_request" ? 9 : 7,
      );
      for (const core of ["security.yml", "integration.yml", "e2e.yml"]) {
        expect(gates.map((g) => g.file)).toContain(core);
      }

      const missing = gates
        .filter(({ workflow }) => !covers(workflow, event, RELEASE_BRANCH))
        .map(({ file }) => file);
      expect(
        missing,
        `${event} into main but not into ${RELEASE_BRANCH}`,
      ).toEqual([]);
    });
  }

  it("keeps the exemptions real and main-only", () => {
    const files = new Set(all.map((w) => w.file));
    for (const [file, entries] of Object.entries(MAIN_ONLY)) {
      expect(files.has(file), `${file} is exempt but does not exist`).toBe(
        true,
      );
      const workflow = all.find((w) => w.file === file)!.workflow;
      for (const { event } of entries) {
        expect(covers(workflow, event, "main"), `${file} ${event}`).toBe(true);
        expect(
          covers(workflow, event, RELEASE_BRANCH),
          `${file} ${event}`,
        ).toBe(false);
      }
    }
  });

  it("skips no gate job on the base branch name", () => {
    // A trigger that admits release branches is undone by a job condition
    // that pins the base to main. Pushes to main may gate a job (the image
    // scan does); a pull request's base may not.
    const offenders: string[] = [];
    for (const { file, workflow } of all) {
      for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
        if (/base_ref\s*==\s*'main'/.test(job.if ?? ""))
          offenders.push(`${file}#${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
