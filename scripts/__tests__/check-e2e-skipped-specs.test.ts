/**
 * `scripts/check-e2e-skipped-specs.mjs`: the CI half of "a spec file that
 * skips everything must say so". The logic is exercised on hand-built reports
 * in Playwright's JSON shape, the CLI is run once end to end, and the workflow
 * wiring is pinned so the check cannot be dropped from the gate job silently.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ALLOWED_ALL_SKIPPED,
  findProblems,
  tallySpecFiles,
} from "../check-e2e-skipped-specs.mjs";

const ROOT = join(__dirname, "../..");
const SCRIPT = join(ROOT, "scripts/check-e2e-skipped-specs.mjs");

type Status = "expected" | "unexpected" | "flaky" | "skipped";

/** One report in Playwright's JSON shape: file suite → describe → spec → tests. */
function report(
  entries: Array<{ file: string; tests: Array<[string, Status]> }>,
) {
  return {
    suites: entries.map(({ file, tests }) => ({
      title: file,
      file,
      specs: [],
      suites: [
        {
          title: "describe",
          file,
          specs: tests.map(([projectName, status], i) => ({
            title: `t${i}`,
            file,
            tests: [{ projectName, status }],
          })),
        },
      ],
    })),
  };
}

describe("check-e2e-skipped-specs", () => {
  it("flags a file whose every test skipped", () => {
    const problems = findProblems(
      [
        report([
          { file: "a.spec.ts", tests: [["chromium-desktop", "expected"]] },
          {
            file: "b.spec.ts",
            tests: [
              ["chromium-desktop", "skipped"],
              ["chromium-mobile", "skipped"],
            ],
          },
        ]),
      ],
      {},
    );
    expect(problems).toEqual([
      "b.spec.ts: all 2 test(s) skipped in every project and shard",
    ]);
  });

  it("aggregates across projects and shards before judging a file", () => {
    // The desktop half skipped in shard 1, the mobile half ran in shard 2.
    const reports = [
      report([{ file: "m.spec.ts", tests: [["chromium-desktop", "skipped"]] }]),
      report([{ file: "m.spec.ts", tests: [["chromium-mobile", "expected"]] }]),
    ];
    expect(tallySpecFiles(reports).get("m.spec.ts")).toEqual({
      total: 2,
      ran: 1,
    });
    expect(findProblems(reports, {})).toEqual([]);
  });

  it("counts a failed or flaky test as having run", () => {
    const reports = [
      report([
        { file: "f.spec.ts", tests: [["chromium-desktop", "unexpected"]] },
        { file: "g.spec.ts", tests: [["chromium-desktop", "flaky"]] },
      ]),
    ];
    expect(findProblems(reports, {})).toEqual([]);
  });

  it("accepts an allowlisted file and rejects a stale allowlist entry", () => {
    const reports = [
      report([
        { file: "a.spec.ts", tests: [["chromium-desktop", "skipped"]] },
        { file: "b.spec.ts", tests: [["chromium-desktop", "expected"]] },
      ]),
    ];
    expect(findProblems(reports, { "a.spec.ts": "reason" })).toEqual([]);
    expect(findProblems(reports, { "b.spec.ts": "reason" })).toEqual([
      "a.spec.ts: all 1 test(s) skipped in every project and shard",
      "b.spec.ts: allowlisted but 1 test(s) ran",
    ]);
    expect(
      findProblems(reports, {
        "a.spec.ts": "reason",
        "gone.spec.ts": "reason",
      }),
    ).toEqual(["gone.spec.ts: allowlisted but absent from the report"]);
  });

  it("refuses an empty report rather than passing over nothing", () => {
    expect(findProblems([{ suites: [] }], {})).toEqual([
      "the report(s) hold no tests at all",
    ]);
  });

  it("gives every allowlist entry a written reason", () => {
    for (const [file, reason] of Object.entries(ALLOWED_ALL_SKIPPED)) {
      expect(file).toMatch(/\.spec\.ts$/);
      expect(reason.trim().length, file).toBeGreaterThan(10);
    }
  });

  describe("the command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-skip-check-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    function run(payload: unknown): number {
      const path = join(dir, `r${Math.random()}.json`);
      writeFileSync(path, JSON.stringify(payload));
      try {
        execFileSync("node", [SCRIPT, path], { stdio: "pipe" });
        return 0;
      } catch (err) {
        return (err as { status: number }).status;
      }
    }

    it("exits 0 on a clean report and 1 on an all-skipped file", () => {
      // The allowlisted files skip as they do on CI.
      const allowed = Object.keys(ALLOWED_ALL_SKIPPED).map((file) => ({
        file,
        tests: [["chromium-desktop", "skipped"]] as Array<[string, Status]>,
      }));
      expect(
        run(
          report([
            { file: "a.spec.ts", tests: [["chromium-desktop", "expected"]] },
            ...allowed,
          ]),
        ),
      ).toBe(0);
      expect(
        run(
          report([
            { file: "z.spec.ts", tests: [["chromium-desktop", "skipped"]] },
            ...allowed,
          ]),
        ),
      ).toBe(1);
    });
  });
});

describe("the e2e workflow runs the check", () => {
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
  const workflow = parse(
    readFileSync(join(ROOT, ".github/workflows/e2e.yml"), "utf8"),
  ) as { jobs: Record<string, { steps?: Step[] }> };

  it("each shard uploads its JSON report", () => {
    const upload = workflow.jobs.shard?.steps?.find(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact@") &&
        step.with?.name === "playwright-json-shard-${{ matrix.shard }}",
    );
    expect(upload?.with).toMatchObject({
      path: "playwright-json/results.json",
      "if-no-files-found": "error",
    });
  });

  it("the gate job downloads every shard's report and runs the script", () => {
    const steps = workflow.jobs.e2e?.steps ?? [];
    const download = steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download?.with).toMatchObject({
      pattern: "playwright-json-shard-*",
      path: "playwright-json",
    });
    expect(steps.map((step) => step.run ?? "")).toContain(
      "node scripts/check-e2e-skipped-specs.mjs playwright-json/*/results.json",
    );
  });
});
