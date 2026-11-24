import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

function readRepoFile(path: string): string {
  const testPath = expect.getState().testPath;
  if (!testPath) throw new Error("Vitest did not expose the current test path");
  return readFileSync(join(dirname(testPath), "../..", path), "utf8");
}
type WorkflowStep = {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
  "continue-on-error"?: boolean;
};
type WorkflowJob = {
  environment?: string;
  permissions?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, string | boolean>;
};
type Workflow = {
  on?: {
    push?: { branches?: string[]; tags?: string[] };
    pull_request?: { branches?: string[] };
    workflow_call?: { inputs?: Record<string, { required?: boolean }> };
  };
  jobs: Record<string, WorkflowJob>;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function loadWorkflow(name: string): Workflow {
  return parse(readRepoFile(join(".github/workflows", name))) as Workflow;
}

function stepScript(
  workflow: Workflow,
  jobName: string,
  stepName: string,
): string {
  const step = workflow.jobs[jobName]?.steps?.find(
    (candidate) => candidate.name === stepName,
  );
  if (!step?.run) {
    throw new Error(`Missing ${jobName}/${stepName} run step`);
  }
  return step.run;
}

function runReleasePolicy(
  overrides: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), "healthlog-release-policy-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ version: overrides.FIXTURE_PACKAGE_VERSION ?? "1.31.4" }),
  );

  const gitPath = join(binDirectory, "git");
  writeFileSync(
    gitPath,
    `#!/bin/sh
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "merge-base" ] && [ "$FIXTURE_MAIN_ANCESTRY" = "yes" ]; then exit 0; fi
exit 1
`,
  );
  chmodSync(gitPath, 0o755);

  const ghPath = join(binDirectory, "gh");
  writeFileSync(
    ghPath,
    `#!/bin/sh
if [ "$FIXTURE_PRIOR_CI" = "yes" ]; then printf '1\\n'; else printf '0\\n'; fi
`,
  );
  chmodSync(ghPath, 0o755);

  const workflow = loadWorkflow("docker-publish.yml");
  return spawnSync(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      stepScript(workflow, "release-policy", "Validate release policy"),
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v1.31.4",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        GITHUB_REPOSITORY: "MBombeck/HealthLog",
        GH_TOKEN: "fixture-token",
        FIXTURE_MAIN_ANCESTRY: "yes",
        FIXTURE_PRIOR_CI: "yes",
        ...overrides,
      },
    },
  );
}

function runExactPull(resolvedDigest: string): {
  result: SpawnSyncReturns<string>;
  commands: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "healthlog-image-pull-"));
  temporaryDirectories.push(directory);
  const dockerPath = join(directory, "docker");
  const commandLog = join(directory, "commands.log");
  writeFileSync(
    dockerPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_COMMAND_LOG"
if [ "$1" = "pull" ]; then exit 0; fi
if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then
  printf '\"%s\"\\n' "$FIXTURE_RESOLVED_DIGEST"
  exit 0
fi
exit 1
`,
  );
  chmodSync(dockerPath, 0o755);

  const workflow = loadWorkflow("post-publish-verify.yml");
  const result = spawnSync(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      stepScript(workflow, "verify", "Pull exact image"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        IMAGE_REF: "ghcr.io/mbombeck/healthlog",
        IMAGE_TAG: "v1.31.4",
        IMAGE_DIGEST:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        FIXTURE_COMMAND_LOG: commandLog,
        FIXTURE_RESOLVED_DIGEST: resolvedDigest,
      },
    },
  );
  return {
    result,
    commands: readFileSync(commandLog, "utf8"),
  };
}

function runPromotion(
  overrides: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), "healthlog-promotion-"));
  temporaryDirectories.push(directory);
  const sleepPath = join(directory, "sleep");
  writeFileSync(sleepPath, "#!/bin/sh\nexit 0\n");
  chmodSync(sleepPath, 0o755);
  const curlPath = join(directory, "curl");
  writeFileSync(
    curlPath,
    `#!/bin/sh
printf '{\"deployment_uuid\":\"fixture\"}\\n__HTTP_STATUS__:%s' "$FIXTURE_HTTP_STATUS"
`,
  );
  chmodSync(curlPath, 0o755);

  const workflow = loadWorkflow("docker-publish.yml");
  return spawnSync(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      stepScript(workflow, "promote", "Trigger Coolify deploy"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        COOLIFY_AUTO_DEPLOY: "on",
        COOLIFY_WEBHOOK: "https://coolify.example/deploy?uuid=fixture",
        COOLIFY_TOKEN: "fixture-token",
        IMAGE_TAG: "v1.31.4",
        IMAGE_DIGEST:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        BUILD_SHA: "0123456789ab",
        FIXTURE_HTTP_STATUS: "200",
        ...overrides,
      },
    },
  );
}

describe("release container inputs", () => {
  it("pins every Node stage to one reviewed multi-arch digest", () => {
    const dockerfile = readRepoFile("Dockerfile");
    const fromLines = dockerfile.match(/^FROM node:[^\n]+$/gm) ?? [];

    // deps, builder, the prisma-cli install and the runner.
    expect(fromLines).toHaveLength(4);
    expect(new Set(fromLines.map((line) => line.split(" AS ")[0]))).toEqual(
      new Set([
        "FROM node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64",
      ]),
    );
  });

  it("pins pnpm for builds and removes package managers from runtime", () => {
    const dockerfile = readRepoFile("Dockerfile");
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      packageManager: string;
      dependencies: Record<string, string>;
    };
    expect(packageJson.packageManager).toBe("pnpm@11.15.1");
    expect(dockerfile).not.toContain("pnpm@latest");
    expect(
      dockerfile.match(/corepack prepare pnpm@11\.15\.1 --activate/g),
    ).toHaveLength(2);
    // The Prisma CLI is installed in its own stage and copied over; the
    // runner removes the base image's package managers and fails the build
    // if any is left (runtime-package-pins holds the rest).
    expect(dockerfile).toContain(
      "COPY --from=prisma-cli /opt/prisma-cli /opt/prisma-cli",
    );
    expect(dockerfile).toContain(
      "sh -c '! command -v npm && ! command -v npx && ! command -v corepack && ! command -v yarn && ! command -v pnpm'",
    );
    const cliPackage = JSON.parse(
      readRepoFile("docker/prisma-cli/package.json"),
    ) as { dependencies: Record<string, string> };
    expect(cliPackage.dependencies.tsx).toBe("4.23.1");
    expect(dockerfile).toContain(
      "ln -sfn /opt/prisma-cli/node_modules/.bin/tsx /usr/local/bin/healthlog-tsx",
    );
    // The image's npm-installed Prisma CLI, its engines and dotenv are a second
    // install of packages the app tree already declares; they move together or
    // the image runs a CLI the tests never did. Drift is how the dotenv pin
    // here trailed the app's by a patch.
    const floor = (name: string) =>
      packageJson.dependencies[name]!.replace(/^[\^~]/, "");
    expect(cliPackage.dependencies.prisma).toBe(floor("prisma"));
    expect(cliPackage.dependencies["@prisma/engines"]).toBe(floor("prisma"));
    expect(cliPackage.dependencies.dotenv).toBe(floor("dotenv"));
    expect(dockerfile).toContain(
      "ln -sfn /opt/prisma-cli/node_modules/dotenv /app/node_modules/dotenv",
    );
    expect(dockerfile).toContain(
      "ln -sfn /opt/prisma-cli/node_modules/prisma /app/node_modules/prisma",
    );
  });

  it("keeps linked worktrees out of the Docker build context", () => {
    const dockerignore = readRepoFile(".dockerignore");
    expect(dockerignore.split(/\r?\n/)).toContain(".worktrees");
  });

  it("bundles Prisma's adapter and verifies only runtime externals", () => {
    const dockerfile = readRepoFile("Dockerfile");
    const nextConfig = readRepoFile("next.config.ts");
    expect(dockerfile).not.toContain("/opt/pg-boss");
    expect(dockerfile).not.toContain('NODE_PATH="/opt/pg-boss/node_modules"');
    expect(dockerfile).toMatch(
      /require\.resolve\(['"]pg-boss['"]\)[\s\S]*require\.resolve\(['"]pg['"]\)/,
    );
    expect(dockerfile).not.toContain("require.resolve('@prisma/adapter-pg')");
    expect(dockerfile).not.toContain("require.resolve('@prisma/client')");
    expect(nextConfig).not.toMatch(
      /serverExternalPackages:\s*\[[\s\S]*["']@prisma\/adapter-pg["']/,
    );
  });
});

describe("release pre-build policy", () => {
  it("accepts a strict SemVer tag that matches package.json on main with prior CI", () => {
    const result = runReleasePolicy();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Release policy passed");
  });

  it.each(["v1.2", "v01.2.3", "v1.2.3-rc.1", "1.2.3"])(
    "rejects non-strict release tag %s",
    (tag) => {
      const result = runReleasePolicy({ GITHUB_REF_NAME: tag });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("strict SemVer");
    },
  );

  it("rejects a tag that does not match package.json", () => {
    const result = runReleasePolicy({ FIXTURE_PACKAGE_VERSION: "1.31.3" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("package.json version");
  });

  it("rejects a release commit outside main ancestry", () => {
    const result = runReleasePolicy({ FIXTURE_MAIN_ANCESTRY: "no" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ancestor of origin/main");
  });

  it("rejects a release commit without successful prior quality CI", () => {
    const result = runReleasePolicy({ FIXTURE_PRIOR_CI: "no" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("successful prior Security & Quality");
  });

  it("gates every image build on the release policy", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const needs = workflow.jobs.build?.needs;

    expect(Array.isArray(needs) ? needs : [needs]).toContain("release-policy");
  });
});

describe("release calendar and approval", () => {
  it("runs the calendar script on tags and publishes off_schedule", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const job = workflow.jobs["release-policy"];
    const step = job?.steps?.find((s) => s.name === "Check release calendar");

    expect(job?.outputs?.off_schedule).toBe(
      "${{ steps.calendar.outputs.off_schedule }}",
    );
    expect(step?.id).toBe("calendar");
    expect(step?.["continue-on-error"]).not.toBe(true);
    expect(step?.run).toContain("node scripts/release-policy.mjs check");
    expect(step?.run).toContain('--github-output "$GITHUB_OUTPUT"');
    // Judged by the push time, so a re-run does not turn a Saturday tag
    // into an off-schedule one.
    expect(step?.env?.PUSHED_AT).toBe(
      "${{ github.event.repository.pushed_at }}",
    );
  });

  it("holds an off-schedule tag on the approval environment", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const approval = workflow.jobs["off-schedule-approval"];

    expect(approval?.environment).toBe("off-schedule-release");
    expect(approval?.needs).toEqual(["release-policy"]);
    expect(approval?.if).toBe(
      "needs.release-policy.outputs.off_schedule == 'true'",
    );
  });

  it("builds only after the approval passed or was not needed", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const build = workflow.jobs.build;
    const condition = (build?.if ?? "").replace(/\s+/g, " ");

    expect(build?.needs).toEqual(["release-policy", "off-schedule-approval"]);
    expect(condition).toContain("!cancelled()");
    expect(condition).toContain("needs.release-policy.result == 'success'");
    expect(condition).toContain(
      "(needs.off-schedule-approval.result == 'success' || needs.off-schedule-approval.result == 'skipped')",
    );
    expect(condition).not.toContain("always()");
    expect(condition).not.toContain("failure");
  });
});

describe("edge image and fix-line check", () => {
  it("builds :edge from main pushes without touching release tags", () => {
    const workflow = loadWorkflow("edge-image.yml");
    const build = workflow.jobs.edge?.steps?.find(
      (s) => s.name === "Build & push",
    );
    const tags = String(build?.with?.tags ?? "");

    expect(workflow.on?.push?.branches).toEqual(["main"]);
    expect(workflow.on?.push?.tags).toBeUndefined();
    expect(build?.with?.platforms).toBe("linux/amd64");
    expect(tags).toContain("${{ env.IMAGE_REF }}:edge\n");
    expect(tags).toContain(
      "${{ env.IMAGE_REF }}:edge-${{ steps.provenance.outputs.build_sha }}",
    );
    expect(tags).not.toMatch(/latest|semver|\{\{ *version *\}\}/);
  });

  it("checks every pull request to main against the fix line", () => {
    const workflow = loadWorkflow("release-branch-policy.yml");
    const step = workflow.jobs["fix-line"]?.steps?.find(
      (s) => s.name === "Check commits and changelog",
    );

    expect(workflow.on?.pull_request?.branches).toEqual(["main"]);
    expect(step?.run).toContain("node scripts/release-policy.mjs pr");
    expect(step?.env?.SOURCE_BRANCH).toBe("${{ github.head_ref }}");
  });
});

const NIGHTLY_HEAD = "1".repeat(40);
const GREEN_RUNS = [
  "2026-11-24T07:00:00Z\tSecurity & Quality\tcompleted\tsuccess",
  "2026-11-24T07:00:01Z\tIntegration tests\tcompleted\tsuccess",
  "2026-11-24T07:00:02Z\te2e\tcompleted\tsuccess",
  "2026-11-24T07:00:03Z\tKnip\tcompleted\tfailure",
];

/**
 * Runs the nightly resolve step against a stubbed `gh` and `docker`. The
 * stubs print what `gh api --jq` and `imagetools inspect --raw` would.
 */
function runNightlyResolve(fixture: {
  branches: string[];
  tags: string[];
  lastRevision?: string;
  force?: boolean;
  /** `created_at<TAB>name<TAB>status<TAB>conclusion`, as the --jq prints. */
  runs?: string[];
}): { result: SpawnSyncReturns<string>; output: Record<string, string> } {
  const directory = mkdtempSync(join(tmpdir(), "healthlog-nightly-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "branches"), fixture.branches.join("\n"));
  writeFileSync(join(directory, "tags"), fixture.tags.join("\n"));
  writeFileSync(
    join(directory, "runs"),
    (fixture.runs ?? GREEN_RUNS).join("\n"),
  );
  writeFileSync(
    join(directory, "gh"),
    `#!/bin/sh
case "$*" in
  *matching-refs/heads/release/v*) cat "$FIXTURE_DIR/branches" ;;
  *matching-refs/tags/v*) cat "$FIXTURE_DIR/tags" ;;
  *contents/package.json*) printf '{"version":"1.49.0"}' ;;
  *actions/runs?head_sha=*event=push*) cat "$FIXTURE_DIR/runs" ;;
  *) exit 1 ;;
esac
`,
  );
  writeFileSync(
    join(directory, "docker"),
    `#!/bin/sh
if [ -z "$FIXTURE_LAST_REVISION" ]; then exit 1; fi
printf '{"annotations":{"org.opencontainers.image.revision":"%s"}}' "$FIXTURE_LAST_REVISION"
`,
  );
  chmodSync(join(directory, "gh"), 0o755);
  chmodSync(join(directory, "docker"), 0o755);
  const output = join(directory, "github-output");
  writeFileSync(output, "");

  const workflow = loadWorkflow("nightly-image.yml");
  const result = spawnSync(
    "bash",
    [
      "-c",
      stepScript(
        workflow,
        "resolve",
        "Pick the branch and compare with the last nightly",
      ),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "fixture",
        GITHUB_REPOSITORY: "MBombeck/HealthLog",
        GITHUB_OUTPUT: output,
        IMAGE_REF: "ghcr.io/mbombeck/healthlog",
        FORCE: fixture.force ? "true" : "false",
        FIXTURE_DIR: directory,
        FIXTURE_LAST_REVISION: fixture.lastRevision ?? "",
      },
    },
  );
  const values = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return { result, output: values };
}

describe("nightly image", () => {
  const branches = [
    `release/v1.47.1 ${"a".repeat(40)}`,
    `release/v1.50.0 ${NIGHTLY_HEAD}`,
    `release/v1.48.5 ${"b".repeat(40)}`,
    `release/v1.9.0 ${"c".repeat(40)}`,
    `release/v1.51.0-wip ${"d".repeat(40)}`,
  ];
  const tags = ["v1.48.5", "v1.49.0", "v1.9.0", "v1.50.0-rc.1"];

  it("builds the newest release/vX.Y.0 that is ahead of the latest release", () => {
    const { result, output } = runNightlyResolve({ branches, tags });
    expect(result.status, result.stderr).toBe(0);
    expect(output.build).toBe("true");
    expect(output.branch).toBe("release/v1.50.0");
    expect(output.sha).toBe(NIGHTLY_HEAD);
    expect(output.short_sha).toBe(NIGHTLY_HEAD.slice(0, 12));
    expect(output.package_version).toBe("1.49.0");
    expect(output.version).toMatch(
      new RegExp(
        `^v1\\.50\\.0-nightly\\.\\d{8}\\.${NIGHTLY_HEAD.slice(0, 12)}$`,
      ),
    );
    expect(output.date_tag).toMatch(/^\d{8}$/);
  });

  it("skips a night on which the branch head did not move", () => {
    const { result, output } = runNightlyResolve({
      branches,
      tags,
      lastRevision: NIGHTLY_HEAD,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(output).toEqual({ build: "false" });
    expect(result.stdout).toContain("Nothing to build");
  });

  it("builds a moved head, and an unmoved one when forced", () => {
    expect(
      runNightlyResolve({ branches, tags, lastRevision: "e".repeat(40) }).output
        .build,
    ).toBe("true");
    expect(
      runNightlyResolve({
        branches,
        tags,
        lastRevision: NIGHTLY_HEAD,
        force: true,
      }).output.build,
    ).toBe("true");
  });

  it.each([
    [
      "a failed gate",
      GREEN_RUNS.map((r) =>
        r.includes("\te2e\t") ? r.replace("success", "failure") : r,
      ),
      "e2e ended failure",
    ],
    [
      "a gate still running",
      GREEN_RUNS.map((r) =>
        r.includes("Integration")
          ? "2026-11-24T07:00:01Z\tIntegration tests\tin_progress\t"
          : r,
      ),
      "Integration tests is still in_progress",
    ],
    [
      "a missing gate",
      GREEN_RUNS.filter((r) => !r.includes("Security")),
      "Security & Quality has no push run",
    ],
    [
      "a re-run that failed after a green one",
      [
        ...GREEN_RUNS,
        "2026-11-24T09:00:00Z\tSecurity & Quality\tcompleted\tfailure",
      ],
      "Security & Quality ended failure",
    ],
  ])("keeps the last nightly on %s", (_case, runs, reason) => {
    const { result, output } = runNightlyResolve({
      branches,
      tags,
      runs,
      force: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(output).toEqual({ build: "false" });
    expect(result.stdout).toContain(reason);
    expect(result.stdout).toContain("The previous :nightly stays");
  });

  it("builds once a failed gate went green on a re-run", () => {
    const { output } = runNightlyResolve({
      branches,
      tags,
      runs: ["2026-11-24T06:00:00Z\te2e\tcompleted\tfailure", ...GREEN_RUNS],
    });
    expect(output.build).toBe("true");
  });

  it("builds nothing once the branch's minor is released", () => {
    const { output } = runNightlyResolve({
      branches,
      tags: [...tags, "v1.50.0"],
    });
    expect(output).toEqual({ build: "false" });
  });

  it("builds nothing without an open release branch", () => {
    const { result, output } = runNightlyResolve({ branches: [], tags });
    expect(result.status, result.stderr).toBe(0);
    expect(output).toEqual({ build: "false" });
  });

  it("publishes :nightly multi-arch and signed, never a release tag", () => {
    const text = readRepoFile(".github/workflows/nightly-image.yml");
    const workflow = parse(text) as Workflow & {
      on: { schedule?: { cron: string }[] };
    };
    expect(workflow.on.schedule?.length).toBe(1);
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on.pull_request).toBeUndefined();

    const build = workflow.jobs.build?.steps?.find(
      (s) => s.name === "Build & push by digest",
    );
    expect(String(build?.with?.["build-args"])).toContain(
      "NEXT_PUBLIC_APP_CHANNEL=nightly",
    );
    expect(String(build?.with?.provenance)).toBe("true");
    expect(String(build?.with?.sbom)).toBe("true");
    expect(text).toContain("runner: ubuntu-24.04-arm");

    const create = stepScript(workflow, "merge", "Create multi-arch manifest");
    expect(create).toContain('-t "${IMAGE_REF}:nightly"');
    expect(create).toContain('-t "${IMAGE_REF}:${DATED_TAG}"');
    expect(create).toContain("org.opencontainers.image.revision=${SHA}");
    expect(
      stepScript(workflow, "merge", "Sign multi-arch manifest (keyless)"),
    ).toContain("cosign sign --yes");
    expect(workflow.jobs.merge?.permissions?.["id-token"]).toBe("write");

    // No `:latest`, no semver tag, no GitHub release.
    expect(text).not.toMatch(/:latest|type=semver|gh release|contents: write/);

    expect(workflow.jobs.resolve?.permissions?.actions).toBe("read");
    expect(stepScript(workflow, "merge", "Resolve published image")).toContain(
      "GITHUB_STEP_SUMMARY",
    );

    const verify = workflow.jobs.verify;
    expect(verify?.uses).toBe("./.github/workflows/post-publish-verify.yml");
    expect(verify?.with?.expected_channel).toBe("nightly");
  });
});

describe("migration immutability", () => {
  it("checks every push and pull request on main and release branches", () => {
    const workflow = loadWorkflow("migration-immutability.yml");
    expect(workflow.on?.push?.branches).toEqual(["main", "release/**"]);
    expect(workflow.on?.pull_request?.branches).toEqual(["main", "release/**"]);
    const script = stepScript(
      workflow,
      "migrations",
      "Refuse edits to merged migrations",
    );
    expect(script).toContain("node scripts/release-policy.mjs migrations");
    expect(script).toContain('base="origin/main"');
  });
});

describe("exact post-publish verification", () => {
  it("passes the published ref, tag, and digest into the blocking verifier", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const merge = workflow.jobs.merge;
    const verify = workflow.jobs["verify-published-image"];

    expect(merge?.outputs).toEqual({
      image_ref: "${{ steps.published.outputs.image_ref }}",
      image_tag: "${{ steps.published.outputs.image_tag }}",
      image_digest: "${{ steps.published.outputs.image_digest }}",
      build_sha: "${{ steps.published.outputs.build_sha }}",
    });
    expect(verify?.uses).toBe("./.github/workflows/post-publish-verify.yml");
    expect(verify?.needs).toBe("merge");
    expect(verify?.with).toEqual({
      image_ref: "${{ needs.merge.outputs.image_ref }}",
      image_tag: "${{ needs.merge.outputs.image_tag }}",
      image_digest: "${{ needs.merge.outputs.image_digest }}",
      build_sha: "${{ needs.merge.outputs.build_sha }}",
    });
  });

  it("requires exact image identity inputs for every invocation", () => {
    const workflow = loadWorkflow("post-publish-verify.yml");
    const inputs = workflow.on?.workflow_call?.inputs;

    expect(inputs?.image_ref?.required).toBe(true);
    expect(inputs?.image_tag?.required).toBe(true);
    expect(inputs?.image_digest?.required).toBe(true);
    expect(inputs?.build_sha?.required).toBe(true);
  });

  it("pulls the exact tag and digest when the registry resolves correctly", () => {
    const digest =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { result, commands } = runExactPull(digest);

    expect(result.status, result.stderr).toBe(0);
    expect(commands).toContain("pull ghcr.io/mbombeck/healthlog:v1.31.4");
    expect(commands).toContain(
      "pull ghcr.io/mbombeck/healthlog@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("fails closed when the published tag resolves to another digest", () => {
    const { result } = runExactPull(
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("digest mismatch");
  });

  it("keeps pull, migration, start, version, and health checks blocking", () => {
    const workflow = loadWorkflow("post-publish-verify.yml");
    const steps = workflow.jobs.verify?.steps ?? [];
    const requiredSteps = [
      "Pull exact image",
      "Run migrations",
      "Start exact image",
      "Verify exact version",
      "Verify health",
    ];

    for (const name of requiredSteps) {
      const step = steps.find((candidate) => candidate.name === name);
      expect(step, `missing ${name}`).toBeDefined();
      expect(step?.["continue-on-error"], name).not.toBe(true);
    }

    expect(stepScript(workflow, "verify", "Run migrations")).toContain(
      "${IMAGE_REF}@${IMAGE_DIGEST}",
    );
    const startScript = stepScript(workflow, "verify", "Start exact image");
    expect(startScript).toContain("${IMAGE_REF}@${IMAGE_DIGEST}");
    expect(startScript).toMatch(/API_TOKEN_HMAC_KEY=[0-9a-f]{64}(?:\s|\\)/);
    const versionScript = stepScript(
      workflow,
      "verify",
      "Verify exact version",
    );
    expect(versionScript).toContain('EXPECTED_VERSION="${IMAGE_TAG#v}"');
    expect(versionScript).toContain('jq -e --arg expected "$EXPECTED_VERSION"');
    expect(stepScript(workflow, "verify", "Verify health")).toContain(
      "jq -e '.status == \"ok\"'",
    );
  });
});

describe("Coolify promotion policy", () => {
  it("waits for exact-image verification and keeps enabled promotion blocking", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const promotion = workflow.jobs.promote;
    const needs = promotion?.needs;
    const trigger = promotion?.steps?.find(
      (step) => step.name === "Trigger Coolify deploy",
    );

    expect(Array.isArray(needs) ? needs : [needs]).toEqual(
      expect.arrayContaining(["merge", "verify-published-image"]),
    );
    expect(trigger).toBeDefined();
    expect(trigger?.["continue-on-error"]).not.toBe(true);
    expect(
      workflow.jobs.merge?.steps?.some(
        (step) => step.name === "Trigger Coolify deploy",
      ),
    ).toBe(false);
  });

  it("accepts an enabled promotion only after a successful webhook response", () => {
    const result = runPromotion();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Coolify deploy queued");
  });

  it.each([
    ["webhook", { COOLIFY_WEBHOOK: "" }],
    ["token", { COOLIFY_TOKEN: "" }],
  ])("rejects enabled promotion with missing %s credentials", (_name, env) => {
    const result = runPromotion(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("COOLIFY_AUTO_DEPLOY=on");
  });

  it("fails enabled promotion when Coolify rejects the webhook", () => {
    const result = runPromotion({ FIXTURE_HTTP_STATUS: "503" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("returned HTTP 503");
  });

  it("allows explicit disabled promotion without credentials", () => {
    const result = runPromotion({
      COOLIFY_AUTO_DEPLOY: "off",
      COOLIFY_WEBHOOK: "",
      COOLIFY_TOKEN: "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("COOLIFY_AUTO_DEPLOY=off");
  });
});

const INDEX_DIGEST =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const AMD64_DIGEST =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const ARM64_DIGEST =
  "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const ATTESTATION_DIGEST =
  "sha256:4444444444444444444444444444444444444444444444444444444444444444";

function indexFixture(platforms: [string, string, string][]): string {
  return JSON.stringify({
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: platforms.map(([os, architecture, digest]) => ({
      digest,
      platform: { os, architecture },
    })),
  });
}

function runManifest(index: string): {
  result: SpawnSyncReturns<string>;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "healthlog-release-manifest-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  writeFileSync(join(directory, "index.json"), index);
  writeFileSync(
    join(binDirectory, "docker"),
    `#!/bin/sh
if [ "$1 $2 $3 $4" = "buildx imagetools inspect --raw" ] && [ "$5" = "ghcr.io/mbombeck/healthlog@${INDEX_DIGEST}" ]; then
  cat "$FIXTURE_INDEX"
  exit 0
fi
exit 1
`,
  );
  chmodSync(join(binDirectory, "docker"), 0o755);

  const workflow = loadWorkflow("docker-publish.yml");
  const result = spawnSync(
    "bash",
    ["-c", stepScript(workflow, "release-manifest", "Write image manifest")],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        IMAGE_REF: "ghcr.io/mbombeck/healthlog",
        IMAGE_TAG: "v1.49.0",
        IMAGE_DIGEST: INDEX_DIGEST,
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        FIXTURE_INDEX: join(directory, "index.json"),
      },
    },
  );
  return { result, directory };
}

function runAssetUpload(releaseExists: boolean): {
  result: SpawnSyncReturns<string>;
  commands: string[];
} {
  const directory = mkdtempSync(join(tmpdir(), "healthlog-release-assets-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  mkdirSync(join(directory, "release-assets"));
  for (const name of [
    "healthlog-v1.49.0-image.txt",
    "healthlog-v1.49.0-image.sigstore.json",
    "healthlog-v1.49.0.intoto.jsonl",
  ]) {
    writeFileSync(join(directory, "release-assets", name), "fixture\n");
  }
  const commandLog = join(directory, "commands.log");
  writeFileSync(commandLog, "");
  writeFileSync(
    join(binDirectory, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_COMMAND_LOG"
if [ "$1 $2" = "release view" ] && [ "$FIXTURE_RELEASE_EXISTS" != "yes" ]; then exit 1; fi
exit 0
`,
  );
  chmodSync(join(binDirectory, "gh"), 0o755);

  const workflow = loadWorkflow("docker-publish.yml");
  const result = spawnSync(
    "bash",
    ["-c", stepScript(workflow, "release-assets", "Upload release assets")],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "fixture",
        TAG: "v1.49.0",
        GITHUB_REPOSITORY: "MBombeck/HealthLog",
        FIXTURE_COMMAND_LOG: commandLog,
        FIXTURE_RELEASE_EXISTS: releaseExists ? "yes" : "no",
      },
    },
  );
  return {
    result,
    commands: readFileSync(commandLog, "utf8").split("\n").filter(Boolean),
  };
}

describe("signed release assets", () => {
  const SLSA_GENERATOR =
    "slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml";

  it("pins every action by commit SHA, the SLSA generator by release tag", () => {
    const directory = join(
      dirname(expect.getState().testPath!),
      "../..",
      ".github/workflows",
    );
    const files = readdirSync(directory).filter((f) => /\.ya?ml$/.test(f));
    const references = files.flatMap((file) =>
      [
        ...readRepoFile(join(".github/workflows", file)).matchAll(
          /^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/gm,
        ),
      ].map((match) => `${file}: ${match[1]}`),
    );
    const offenders = references.filter((reference) => {
      const target = reference.split(": ")[1]!;
      if (target.startsWith("./")) return false;
      if (target.startsWith(`${SLSA_GENERATOR}@`)) {
        return !/@v\d+\.\d+\.\d+$/.test(target);
      }
      return !/@[0-9a-f]{40}$/.test(target);
    });

    expect(references.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it("runs the asset chain on release tags only, after the image is verified", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const manifest = workflow.jobs["release-manifest"];

    const manifestIf = (manifest?.if ?? "").replace(/\s+/g, " ");
    expect(manifestIf).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(manifest?.needs).toEqual(["merge", "verify-published-image"]);
    expect(workflow.jobs["release-provenance"]?.needs).toEqual([
      "release-manifest",
    ]);
    expect(workflow.jobs["release-assets"]?.needs).toEqual([
      "release-manifest",
      "release-provenance",
    ]);
    // :edge comes from edge-image.yml, which this file does not touch.
    expect(workflow.on?.push?.branches).toBeUndefined();
    expect(workflow.on?.push?.tags).toEqual(["v*"]);
  });

  it("gives each job only the permissions its step needs", () => {
    const workflow = loadWorkflow("docker-publish.yml");

    expect(workflow.jobs["release-manifest"]?.permissions).toEqual({
      contents: "read",
      packages: "read",
      "id-token": "write",
    });
    expect(workflow.jobs["release-provenance"]?.permissions).toEqual({
      actions: "read",
      "id-token": "write",
      contents: "write",
    });
    expect(workflow.jobs["release-assets"]?.permissions).toEqual({
      contents: "write",
    });

    const holding = (scope: string) =>
      Object.entries(workflow.jobs)
        .filter(([, job]) => job.permissions?.[scope] === "write")
        .map(([name]) => name)
        .sort();
    expect(holding("contents")).toEqual([
      "release-assets",
      "release-provenance",
    ]);
    expect(holding("id-token")).toEqual([
      "image-provenance",
      "merge",
      "release-manifest",
      "release-provenance",
    ]);
  });

  it("signs the manifest keyless and hands its hash to the SLSA generator", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const provenance = workflow.jobs["release-provenance"];

    expect(
      stepScript(workflow, "release-manifest", "Sign image manifest (keyless)"),
    ).toContain(
      'cosign sign-blob --yes \\\n  --bundle "healthlog-${IMAGE_TAG}-image.sigstore.json" \\\n  "healthlog-${IMAGE_TAG}-image.txt"',
    );
    expect(provenance?.uses).toMatch(
      new RegExp(
        `^${SLSA_GENERATOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@v\\d+\\.\\d+\\.\\d+$`,
      ),
    );
    expect(provenance?.with).toEqual({
      "base64-subjects": "${{ needs.release-manifest.outputs.hashes }}",
      "provenance-name": "healthlog-${{ github.ref_name }}.intoto.jsonl",
      "upload-assets": false,
    });
  });

  it("writes the index and both platform digests, without attestation manifests", () => {
    const { result, directory } = runManifest(
      indexFixture([
        ["linux", "arm64", ARM64_DIGEST],
        ["linux", "amd64", AMD64_DIGEST],
        ["unknown", "unknown", ATTESTATION_DIGEST],
      ]),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(join(directory, "healthlog-v1.49.0-image.txt"), "utf8"),
    ).toBe(
      [
        "# HealthLog v1.49.0 container image, built from commit 0123456789abcdef0123456789abcdef01234567",
        `ghcr.io/mbombeck/healthlog:v1.49.0@${INDEX_DIGEST} index`,
        `ghcr.io/mbombeck/healthlog:1.49.0@${INDEX_DIGEST} index`,
        `ghcr.io/mbombeck/healthlog@${AMD64_DIGEST} linux/amd64`,
        `ghcr.io/mbombeck/healthlog@${ARM64_DIGEST} linux/arm64`,
        "",
      ].join("\n"),
    );
  });

  it("refuses an index that lacks a platform", () => {
    const { result } = runManifest(
      indexFixture([
        ["linux", "amd64", AMD64_DIGEST],
        ["unknown", "unknown", ATTESTATION_DIGEST],
      ]),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected linux/amd64 and linux/arm64");
  });

  it("creates a missing release as a draft and attaches the three files", () => {
    const { result, commands } = runAssetUpload(false);

    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual([
      "release view v1.49.0 --repo MBombeck/HealthLog",
      "release create v1.49.0 --repo MBombeck/HealthLog --draft --verify-tag --title v1.49.0 --notes ",
      "release upload v1.49.0 --repo MBombeck/HealthLog --clobber release-assets/healthlog-v1.49.0-image.txt release-assets/healthlog-v1.49.0-image.sigstore.json release-assets/healthlog-v1.49.0.intoto.jsonl",
    ]);
  });

  it("attaches to an existing release and never publishes or edits it", () => {
    const { result, commands } = runAssetUpload(true);
    const script = stepScript(
      loadWorkflow("docker-publish.yml"),
      "release-assets",
      "Upload release assets",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("release upload v1.49.0");
    expect(script).not.toMatch(/release edit|--draft=false|--latest/);
  });
});

function runCachePolicy(refType: string, refName: string) {
  const directory = mkdtempSync(join(tmpdir(), "healthlog-cache-policy-"));
  temporaryDirectories.push(directory);
  const output = join(directory, "github-output");
  writeFileSync(output, "");
  const workflow = loadWorkflow("docker-publish.yml");
  const result = spawnSync(
    "bash",
    [
      "-eo",
      "pipefail",
      "-c",
      stepScript(workflow, "build", "Resolve cache policy"),
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_REF_TYPE: refType,
        GITHUB_REF_NAME: refName,
        SCOPE: "amd64",
      },
    },
  );
  return { result, output: readFileSync(output, "utf8") };
}

function runProvenanceCheck(ghExit: number) {
  const directory = mkdtempSync(join(tmpdir(), "healthlog-provenance-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  const commandLog = join(directory, "commands.log");
  writeFileSync(commandLog, "");
  writeFileSync(
    join(binDirectory, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_COMMAND_LOG"
exit ${ghExit}
`,
  );
  writeFileSync(join(binDirectory, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDirectory, "gh"), 0o755);
  chmodSync(join(binDirectory, "sleep"), 0o755);

  const workflow = loadWorkflow("image-provenance.yml");
  const result = spawnSync(
    "bash",
    ["-c", stepScript(workflow, "attest", "Verify the attestation")],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "fixture",
        IMAGE: "ghcr.io/mbombeck/healthlog",
        DIGEST: INDEX_DIGEST,
        GITHUB_REPOSITORY: "MBombeck/HealthLog",
        GITHUB_REF: "refs/tags/v1.49.0",
        FIXTURE_COMMAND_LOG: commandLog,
      },
    },
  );
  return {
    result,
    commands: readFileSync(commandLog, "utf8").split("\n").filter(Boolean),
  };
}

describe("image provenance at SLSA Build L3", () => {
  const SIGNER = "MBombeck/HealthLog/.github/workflows/image-provenance.yml";

  it("attests the index from the reusable workflow on release tags", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const job = workflow.jobs["image-provenance"];

    expect(job?.uses).toBe("./.github/workflows/image-provenance.yml");
    expect(job?.needs).toEqual(["merge"]);
    const condition = (job?.if ?? "").replace(/\s+/g, " ");
    expect(condition).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(condition).toContain("needs.merge.result == 'success'");
    expect(job?.with).toEqual({
      image: "${{ needs.merge.outputs.image_ref }}",
      digest: "${{ needs.merge.outputs.image_digest }}",
    });
    expect(job?.permissions).toEqual({
      "id-token": "write",
      attestations: "write",
      packages: "write",
    });
  });

  it("signs the provenance in its own job, pushed next to the index", () => {
    const workflow = loadWorkflow("image-provenance.yml");
    const raw = parse(
      readRepoFile(".github/workflows/image-provenance.yml"),
    ) as { permissions?: unknown };
    const attest = workflow.jobs.attest;
    const step = attest?.steps?.find(
      (s) => s.name === "Attest build provenance",
    ) as (WorkflowStep & { uses?: string }) | undefined;

    expect(Object.keys(workflow.jobs)).toEqual(["attest"]);
    expect(raw.permissions).toEqual({});
    expect(workflow.on?.workflow_call?.inputs?.image?.required).toBe(true);
    expect(workflow.on?.workflow_call?.inputs?.digest?.required).toBe(true);
    expect(attest?.permissions).toEqual({
      "id-token": "write",
      attestations: "write",
      packages: "write",
    });
    expect(step?.uses).toMatch(
      /^actions\/attest-build-provenance@[0-9a-f]{40}$/,
    );
    expect(step?.with).toEqual({
      "subject-name": "${{ inputs.image }}",
      "subject-digest": "${{ inputs.digest }}",
      "push-to-registry": true,
      "create-storage-record": false,
    });
  });

  it("verifies the attestation from the API and the registry under its own signer", () => {
    const { result, commands } = runProvenanceCheck(0);

    expect(result.status).toBe(0);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain(
        `attestation verify oci://ghcr.io/mbombeck/healthlog@${INDEX_DIGEST}`,
      );
      expect(command).toContain(`--signer-workflow ${SIGNER}`);
      expect(command).toContain("--source-ref refs/tags/v1.49.0");
    }
    expect(commands[0]).toContain("--bundle-from-oci=false");
    expect(commands[1]).toContain("--bundle-from-oci=true");
  });

  it("fails when the attestation does not verify", () => {
    const { result, commands } = runProvenanceCheck(1);

    expect(result.status).toBe(1);
    expect(commands).toHaveLength(3);
    expect(result.stderr).toContain("does not verify");
  });

  it("keeps OIDC tokens out of every job that runs repository code", () => {
    const workflow = loadWorkflow("docker-publish.yml");

    expect(workflow.jobs.build?.permissions?.["id-token"]).toBeUndefined();
    const signingJobsWithCheckout = Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions?.["id-token"] === "write")
      .filter(([, job]) =>
        (job.steps ?? []).some((s) =>
          String((s as { uses?: string }).uses ?? "").startsWith(
            "actions/checkout@",
          ),
        ),
      )
      .map(([name]) => name);
    expect(signingJobsWithCheckout).toEqual([]);
  });

  it("builds with full BuildKit provenance and the resolved cache policy", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const build = workflow.jobs.build?.steps?.find(
      (s) => s.name === "Build & push by digest",
    );

    expect(build?.with?.provenance).toBe("mode=max");
    expect(build?.with?.["no-cache"]).toBe(
      "${{ steps.cache.outputs.no_cache }}",
    );
    expect(build?.with?.["cache-from"]).toBe("${{ steps.cache.outputs.from }}");
    expect(build?.with?.["cache-to"]).toBe("${{ steps.cache.outputs.to }}");
  });

  it("gives a release tag build no shared cache", () => {
    const { result, output } = runCachePolicy("tag", "v1.49.0");

    expect(result.status).toBe(0);
    expect(output).toBe("no_cache=true\n");
  });

  it("keeps the per-ref cache for pull-request builds", () => {
    const { result, output } = runCachePolicy("branch", "1481/merge");

    expect(result.status).toBe(0);
    expect(output).toContain("no_cache=false\n");
    expect(output).toContain(
      "from<<EOF\ntype=gha,scope=build-amd64-1481/merge\ntype=gha,scope=build-amd64-main\nEOF\n",
    );
    expect(output).toContain(
      "to=type=gha,mode=max,scope=build-amd64-1481/merge\n",
    );
  });
});

describe("skipped jobs do not silently end a chain", () => {
  // GitHub skips a job when ANY job in its dependency chain was skipped,
  // unless the job's own condition replaces the implicit success(). The
  // off-schedule approval is skipped on every scheduled tag, so before this
  // guard every job after `build` was skipped on the first real release:
  // no manifest, no signature, no provenance, no release assets, all green.
  const files = readdirSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "../..",
      ".github/workflows",
    ),
  ).filter((f) => /\.ya?ml$/.test(f));

  it("finds the workflows and the conditional jobs it reasons about", () => {
    expect(files).toContain("docker-publish.yml");
    const jobs = loadWorkflow("docker-publish.yml").jobs;
    expect(jobs["off-schedule-approval"]?.if).toBeTruthy();
  });

  for (const file of files) {
    it(`${file}: every job below a skippable job states its own condition`, () => {
      const jobs = (loadWorkflow(file).jobs ?? {}) as Record<
        string,
        { needs?: string | string[]; if?: string; steps?: unknown }
      >;
      const needsOf = (id: string): string[] => {
        const n = jobs[id]?.needs;
        return n === undefined ? [] : Array.isArray(n) ? n : [n];
      };
      const skippable = new Map<string, boolean>();
      const canSkip = (id: string): boolean => {
        const known = skippable.get(id);
        if (known !== undefined) return known;
        const value =
          Boolean(jobs[id]?.if) || needsOf(id).some((need) => canSkip(need));
        skippable.set(id, value);
        return value;
      };
      const offenders: string[] = [];
      for (const id of Object.keys(jobs)) {
        const upstream = needsOf(id);
        if (!upstream.some((need) => canSkip(need))) continue;
        const condition = (jobs[id]?.if ?? "").replace(/\s+/g, " ");
        // The results may be checked in the condition or, for an aggregate
        // job that runs under always(), in its own steps.
        const body = JSON.stringify(jobs[id]);
        const explicit =
          /!cancelled\(\)|always\(\)/.test(condition) &&
          upstream.every((need) => body.includes(`needs.${need}.result`));
        if (!explicit) offenders.push(id);
      }
      expect(offenders).toEqual([]);
    });
  }
});
