import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
  name?: string;
  run?: string;
  "continue-on-error"?: boolean;
};
type WorkflowJob = {
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, string>;
};
type Workflow = {
  on?: {
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

    expect(fromLines).toHaveLength(3);
    expect(new Set(fromLines.map((line) => line.split(" AS ")[0]))).toEqual(
      new Set([
        "FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2",
      ]),
    );
  });

  it("pins pnpm for builds and removes package managers from runtime", () => {
    const dockerfile = readRepoFile("Dockerfile");
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      packageManager: string;
    };
    expect(packageJson.packageManager).toBe("pnpm@11.15.1");
    expect(dockerfile).not.toContain("pnpm@latest");
    expect(
      dockerfile.match(/corepack prepare pnpm@11\.15\.1 --activate/g),
    ).toHaveLength(2);
    expect(dockerfile).toContain(
      "rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /root/.cache/node/corepack",
    );
    expect(dockerfile).toContain("tsx@4.23.1");
    expect(dockerfile).toContain(
      "ln -sfn /opt/prisma-cli/node_modules/.bin/tsx /usr/local/bin/healthlog-tsx",
    );
    expect(dockerfile).toContain("dotenv@17.4.2");
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
