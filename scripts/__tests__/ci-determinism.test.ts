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
    // Three servers, and which is which matters. The suite's own server runs
    // with the dashboard's RSC prefetch OFF so `page.route` fixtures govern
    // what the dashboard paints; the second runs it ON, which is the default
    // and therefore the only configuration self-hosters ever see. A React #418
    // hydration bailout shipped on `/` precisely because nothing in CI ran the
    // shipped one. The third is the mail-configured, scheduler-free process the
    // notification journey drives, kept apart so the SMTP env never renders
    // the Email card for every other spec. Pin all three so no gap can reopen
    // by deletion.
    const servers = config.webServer;
    expect(Array.isArray(servers)).toBe(true);
    const webServers = servers as Array<Record<string, unknown>>;
    expect(webServers).toHaveLength(3);
    for (const server of webServers) {
      expect(server).toMatchObject({
        command: expect.stringContaining(
          `${JSON.stringify(process.execPath)} .next/standalone/server.js`,
        ),
        env: expect.objectContaining({
          NATIVE_CANVAS: "off",
        }),
      });
    }
    expect(webServers[0]!.env).toMatchObject({
      DASHBOARD_SSR_PREFETCH: "false",
    });
    expect(webServers[1]!.env).toMatchObject({
      DASHBOARD_SSR_PREFETCH: "true",
    });
    expect(webServers[2]!.env).toMatchObject({
      HEALTHLOG_PROCESS_TYPE: "web",
      SMTP_HOST: expect.any(String),
    });
    expect(webServers[0]!.env).not.toHaveProperty("SMTP_HOST");
    expect(webServers[1]!.env).not.toHaveProperty("SMTP_HOST");
  });

  it("retains the Playwright report after every workflow outcome", () => {
    const workflow = parse(
      readRepoFile(".github/workflows/e2e.yml"),
    ) as Workflow;
    // The suite runs as a shard matrix since the single job outgrew its
    // timeout; the running job is `shard`, while `e2e` is the gate that
    // carries the required check name and runs no browser. The report
    // therefore lives on the shard job, named per shard so the two
    // artifacts cannot clobber each other.
    const upload = workflow.jobs.shard?.steps?.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );

    expect(upload).toBeDefined();
    expect(upload?.if).toBe("always()");
    expect(upload?.with).toMatchObject({
      name: "playwright-report-shard-${{ matrix.shard }}",
      path: "playwright-report/",
      "retention-days": 7,
      "if-no-files-found": "ignore",
    });
  });

  it("uses production-valid secrets and plain-HTTP cookies", () => {
    const workflow = parse(
      readRepoFile(".github/workflows/e2e.yml"),
    ) as Workflow;
    const env = workflow.jobs.shard?.env;

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

/**
 * `>= 0` comparison over a dotted version, enough for the floor checks below.
 * Pre-release suffixes are not expected in an override replacement and are
 * ignored rather than guessed at.
 */
function atLeast(version: string, floor: string): boolean {
  const parts = (value: string) =>
    value
      .replace(/^[\^~>=<\s]+/, "")
      .split("-")[0]
      .split(".")
      .map((piece) => Number.parseInt(piece, 10) || 0);
  const [a, b] = [parts(version), parts(floor)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

describe("production dependency advisory floors", () => {
  /**
   * The floor an advisory demands, by package. Raising an override past one of
   * these must not break this test: an earlier version of it asserted the exact
   * key and replacement string, so every legitimate floor raise failed it while
   * a floor that had gone STALE against a newer advisory passed. It now asserts
   * the property that matters, which is that the pin is at or above the fixed
   * version. Update a floor here when a new advisory raises it.
   */
  const floors: Record<string, string> = {
    // GHSA-55q2-fjhq-7xh7, reached through jspdf's optional HTML renderer.
    dompurify: "3.4.13",
    // CVE-2026-69153.
    postcss: "8.5.23",
    // GHSA-frvp-7c67-39w9 and CVE-2026-39406. Mirrored in the Dockerfile.
    "@hono/node-server": "1.19.15",
    hono: "4.12.25",
    // CVE-2026-59952. Mirrored in the Dockerfile.
    valibot: "1.4.2",
  };

  it("pins vulnerable transitive ranges at or above the fixed version", () => {
    const workspace = parse(readRepoFile("pnpm-workspace.yaml")) as {
      overrides?: Record<string, string>;
    };
    const overrides = workspace.overrides ?? {};

    const byName = new Map<string, string>();
    for (const [key, replacement] of Object.entries(overrides)) {
      const selectorAt = key.startsWith("@")
        ? key.indexOf("@", 1)
        : key.indexOf("@");
      byName.set(
        selectorAt === -1 ? key : key.slice(0, selectorAt),
        replacement,
      );
    }
    expect(byName.size).toBeGreaterThan(0);

    for (const [name, floor] of Object.entries(floors)) {
      const replacement = byName.get(name);
      expect(
        replacement,
        `${name} has no override in pnpm-workspace.yaml`,
      ).toBeDefined();
      expect(
        atLeast(replacement as string, floor),
        `${name} is pinned to ${replacement}, below the advisory floor ${floor}.`,
      ).toBe(true);
    }
  });

  it("compares versions rather than always agreeing", () => {
    // The comparison is the whole test above; a helper that never returns
    // false would make it vacuous.
    expect(atLeast("^3.4.13", "3.4.13")).toBe(true);
    expect(atLeast("^3.4.14", "3.4.13")).toBe(true);
    expect(atLeast("^3.4.12", "3.4.13")).toBe(false);
    expect(atLeast("^1.19.9", "1.19.15")).toBe(false);
    expect(atLeast("^2.0.5", "1.19.15")).toBe(true);
  });
});
