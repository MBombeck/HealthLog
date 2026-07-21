import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import integrationConfig from "../../vitest.integration.config.mts";
import unitConfig from "../../vitest.config.mts";

function repositoryRoot(): string {
  const testPath = expect.getState().testPath;
  if (!testPath) throw new Error("Vitest did not expose the current test path");
  return join(dirname(testPath), "../..");
}

function readRepoFile(path: string): string {
  return readFileSync(join(repositoryRoot(), path), "utf8");
}

type WorkflowStep = {
  if?: string;
  uses?: string;
  with?: Record<string, string | number>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Playwright CI determinism", () => {
  it("fails CI when a retry resolves a flaky test", async () => {
    vi.stubEnv("CI", "true");
    // Re-import after stubbing CI so config conditionals are evaluated as CI.
    const { default: config } = await import("../../playwright.config");

    expect(config.retries).toBe(2);
    expect(config.failOnFlakyTests).toBe(true);
    expect(config.reporter).toEqual([["github"], ["html", { open: "never" }]]);
  });

  it("retains the Playwright report after every workflow outcome", () => {
    const workflow = parse(
      readRepoFile(".github/workflows/e2e.yml"),
    ) as Workflow;
    const upload = workflow.jobs.e2e?.steps?.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );

    expect(upload).toBeDefined();
    expect(upload?.if).toBe("always()");
    expect(upload?.with).toMatchObject({
      name: "playwright-report",
      path: "playwright-report/",
      "retention-days": 7,
      "if-no-files-found": "ignore",
    });
  });

  it("uses production-valid secrets and plain-HTTP cookies", () => {
    const workflow = parse(
      readRepoFile(".github/workflows/e2e.yml"),
    ) as Workflow;
    const env = workflow.jobs.e2e?.env;

    expect(env?.API_TOKEN_HMAC_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env?.SESSION_COOKIE_SECURE).toBe("false");
  });
});

describe("local worktree isolation", () => {
  it("keeps nested worktree suites out of the root unit run", () => {
    expect(unitConfig.test?.exclude ?? []).toContain(".worktrees/**");
  });
});

describe("integration environment isolation", () => {
  it("registers a worker setup bridge and authoritative test secrets", () => {
    const test = integrationConfig.test;

    expect(test?.setupFiles ?? []).toContain(
      "./tests/integration/environment-setup.ts",
    );
    expect(test?.env).toMatchObject({
      TZ: "UTC",
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      ENCRYPTION_KEYS: "",
      ENCRYPTION_ACTIVE_KEY_ID: "",
      API_TOKEN_HMAC_KEY:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      SESSION_SECRET: "integration-test-session-secret-32-bytes",
    });
    expect(
      existsSync(
        join(repositoryRoot(), "tests/integration/environment-setup.ts"),
      ),
    ).toBe(true);
  });
});

describe("container dependency installation", () => {
  it("copies the prepare helper before the Git-free frozen install", () => {
    const dockerfile = readRepoFile("Dockerfile");

    expect(dockerfile).toContain(
      "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\n" +
        "COPY scripts/prepare.mjs scripts/prepare.mjs\n" +
        "RUN pnpm install --frozen-lockfile --prod=false",
    );
  });
});

describe("production dependency advisory floors", () => {
  it("pins vulnerable transitive ranges to compatible patched versions", () => {
    const workspace = parse(readRepoFile("pnpm-workspace.yaml")) as {
      overrides?: Record<string, string>;
    };

    expect(workspace.overrides).toMatchObject({
      "dompurify@<=3.4.10": "^3.4.11",
      "postcss@<8.5.10": "^8.5.10",
      "@hono/node-server@<1.19.13": "^1.19.13",
      "hono@<4.12.25": "^4.12.25",
    });
  });
});
