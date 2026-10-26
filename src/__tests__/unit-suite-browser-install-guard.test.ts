/**
 * Every job that runs the unit suite installs the browser the suite needs.
 *
 * `health-score-card-geometry.test.tsx` renders the real hero band in a real
 * Chromium and measures the boxes. It used to catch its own launch failure and
 * pass, so for months it measured nothing in CI; since v1.38 it throws when
 * `CI` is set instead, which is right — and which turns a job that runs
 * `pnpm test` without a browser from silently useless into loudly red.
 *
 * That is exactly what happened. The install step was added to the quality job
 * in `security.yml` and nowhere else, and `dependabot-auto-merge.yml` runs the
 * same suite: every dependency bump failed on a launch error that said nothing
 * about the bump. One workflow was fixed, one class was not.
 *
 * Since v1.46 the suite also carries the `browser` project
 * (`*.browser.test.tsx`, see `tests/browser/`), which launches the same
 * headless shell through Vitest's Playwright provider for every interaction
 * test. A slice without the browser now fails on many files rather than one;
 * the install it needs is the same, so this guard covers both.
 *
 * The sweep is textual and file-scoped, which is its limit: a workflow with two
 * jobs, only one of which installs the browser, satisfies it. It catches the
 * thing that actually went wrong — a whole workflow running the suite with no
 * browser anywhere in it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(process.cwd(), ".github", "workflows");

/**
 * `run: pnpm test`, or a direct `vitest run` of the unit config with flags
 * only (the sharded CI job, the nightly shuffled run): the whole unit suite
 * or a slice of it, geometry check included. A run that names a path or
 * another `--config` is a different, narrower suite and does not count.
 */
const RUNS_UNIT_SUITE =
  /^\s*(?:-\s*)?run:\s*pnpm test\s*$|pnpm exec vitest run(?![^\n]*--config)(?=\s*$|\s+--)/m;
const INSTALLS_BROWSER = /playwright install --only-shell chromium/;

describe("the browser the unit suite measures with", () => {
  it("is installed by every workflow that runs the suite", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));
    expect(
      files.length,
      "no workflow files found — the walk is broken, not the tree clean",
    ).toBeGreaterThanOrEqual(5);

    const runners = files.filter((f) =>
      RUNS_UNIT_SUITE.test(readFileSync(join(WORKFLOWS, f), "utf8")),
    );
    // An empty match set would agree with an empty violation list. It is two
    // workflows today; pinned at one so removing a job is not a guard failure,
    // but a matcher that stops matching is.
    expect(
      runners.length,
      "no workflow runs `pnpm test` — the matcher stopped matching",
    ).toBeGreaterThanOrEqual(1);

    const missing = runners.filter(
      (f) => !INSTALLS_BROWSER.test(readFileSync(join(WORKFLOWS, f), "utf8")),
    );
    expect(
      missing,
      "a workflow runs the unit suite without installing the headless " +
        "Chromium the hero-geometry check and the browser project launch — " +
        "neither skips under CI, so the job fails on a launch error instead",
    ).toEqual([]);
  });
});
