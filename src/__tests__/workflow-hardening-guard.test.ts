/**
 * The supply-chain rules every workflow under `.github/workflows/` keeps.
 *
 * - An external action is referenced by a full commit SHA. A tag is a
 *   mutable pointer, and a compromised action repository can move it under
 *   a workflow that holds `packages: write` or `id-token: write`. The one
 *   exception is the SLSA generator, which refuses to run from a SHA and is
 *   verified by its release tag instead (see the comment in
 *   docker-publish.yml).
 * - `actions/checkout` runs with `persist-credentials: false`. Without it
 *   the job token sits in `.git/config` for every later step, including the
 *   dependency install and anything a compromised package runs from there.
 *   No job here pushes through git; the ones that write to the repository
 *   do it through `gh` with an explicit `GH_TOKEN`.
 * - The workflow declares a top-level `permissions` block that grants no
 *   write scope. Jobs that need one name it on the job.
 * - No `pull_request_target` or `workflow_run` trigger. Both run with the
 *   base repository's token on code or artifacts a fork controls.
 * - A `run:` script never interpolates a fork-controlled context
 *   (`github.event.*` text fields, `github.head_ref`) directly. Those go
 *   through `env:` and are read as shell variables, so a branch name or a
 *   PR title cannot become shell code.
 * - A step that pipes into `tee` runs with pipefail. A `run:` script runs as
 *   `bash -e {0}` unless the step names a shell, and without pipefail a
 *   pipeline's status is its last command's: `node scripts/mutation-floors.mjs
 *   | tee -a "$GITHUB_STEP_SUMMARY"` passed whatever the floors said. The
 *   step names `shell: bash` (which adds `-o pipefail`) and says
 *   `set -o pipefail` in the script, so the intent is visible at the pipe.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const WORKFLOWS = join(process.cwd(), ".github", "workflows");

/** The one reusable workflow that must be referenced by tag. */
const TAG_PINNED = new Set([
  "slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml",
]);

const UNTRUSTED_IN_RUN =
  /\$\{\{\s*github\.(head_ref|event\.(pull_request|issue|comment|review|review_comment|head_commit|commits|discussion|pages)\b)/;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, unknown>;
}
interface RunDefaults {
  defaults?: { run?: { shell?: string } };
}
interface Job extends RunDefaults {
  uses?: string;
  steps?: Step[];
}
interface Workflow extends RunDefaults {
  on?: unknown;
  true?: unknown;
  permissions?: unknown;
  jobs?: Record<string, Job>;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
}

function load(file: string): Workflow {
  return YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
}

/** Every `uses:` reference in a workflow, step-level and job-level. */
function usesRefs(doc: Workflow): string[] {
  const out: string[] = [];
  for (const job of Object.values(doc.jobs ?? {})) {
    if (job.uses) out.push(job.uses);
    for (const step of job.steps ?? []) if (step.uses) out.push(step.uses);
  }
  return out;
}

function unpinnedRefs(doc: Workflow): string[] {
  return usesRefs(doc).filter((ref) => {
    if (ref.startsWith("./") || ref.startsWith("docker://")) return false;
    const [target, version] = ref.split("@");
    if (TAG_PINNED.has(target)) return false;
    return !/^[0-9a-f]{40}$/.test(version ?? "");
  });
}

function checkoutsKeepingCredentials(doc: Workflow): string[] {
  const out: string[] = [];
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    (job.steps ?? []).forEach((step, index) => {
      if (!step.uses?.startsWith("actions/checkout@")) return;
      if (step.with?.["persist-credentials"] !== false) {
        out.push(`${jobName} #${index}`);
      }
    });
  }
  return out;
}

function topLevelWrite(doc: Workflow): string | null {
  const p = doc.permissions;
  if (p === undefined) return "no top-level permissions block";
  if (p === "read-all" || (typeof p === "object" && p !== null)) {
    if (typeof p === "object") {
      const writes = Object.entries(p as Record<string, string>)
        .filter(([, v]) => v === "write")
        .map(([k]) => k);
      if (writes.length > 0) return `top-level write: ${writes.join(", ")}`;
    }
    return null;
  }
  return `top-level permissions: ${String(p)}`;
}

function triggers(doc: Workflow): string[] {
  // YAML 1.1 readers turn a bare `on` key into `true`; the `yaml` package
  // reads 1.2 by default, but accept both.
  const on = doc.on ?? doc.true;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on as string[];
  return Object.keys((on as Record<string, unknown>) ?? {});
}

function injectableRunSteps(doc: Workflow): string[] {
  const out: string[] = [];
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    (job.steps ?? []).forEach((step, index) => {
      if (step.run && UNTRUSTED_IN_RUN.test(step.run)) {
        out.push(`${jobName} #${index} ${step.name ?? ""}`.trim());
      }
    });
  }
  return out;
}

/** Whether a script pipes something into `tee` on a line that is not a comment. */
function pipesIntoTee(script: string): boolean {
  return script
    .split("\n")
    .some((line) => !/^\s*#/.test(line) && /[^|]\|\s*tee\b/.test(line));
}

/** The steps of a workflow that pipe into `tee` without pipefail. */
function teeWithoutPipefail(doc: Workflow): string[] {
  const out: string[] = [];
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    (job.steps ?? []).forEach((step, index) => {
      if (!step.run || !pipesIntoTee(step.run)) return;
      const shell =
        step.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell;
      const ok = shell === "bash" && /\bset -o pipefail\b/.test(step.run);
      if (!ok) out.push(`${jobName} #${index} ${step.name ?? ""}`.trim());
    });
  }
  return out;
}

describe("workflow hardening", () => {
  it("reads the workflows it claims to check", () => {
    const files = workflowFiles();
    expect(files.length).toBeGreaterThan(10);
    const refs = files.flatMap((f) => usesRefs(load(f)));
    expect(refs.filter((r) => r.startsWith("actions/checkout@")).length).toBe(
      files.reduce(
        (n, f) =>
          n +
          (readFileSync(join(WORKFLOWS, f), "utf8").match(
            /uses: actions\/checkout@/g,
          )?.length ?? 0),
        0,
      ),
    );
    expect(refs.length).toBeGreaterThan(50);
    expect(
      files.filter((f) =>
        pipesIntoTee(readFileSync(join(WORKFLOWS, f), "utf8")),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("runs every step that pipes into tee with pipefail", () => {
    const found = workflowFiles().flatMap((f) =>
      teeWithoutPipefail(load(f)).map((s) => `${f}: ${s}`),
    );
    expect(found).toEqual([]);
  });

  it("pins every external action by commit SHA", () => {
    const found = workflowFiles().flatMap((f) =>
      unpinnedRefs(load(f)).map((r) => `${f}: ${r}`),
    );
    expect(found).toEqual([]);
  });

  it("drops the checkout token after the checkout", () => {
    const found = workflowFiles().flatMap((f) =>
      checkoutsKeepingCredentials(load(f)).map((s) => `${f}: ${s}`),
    );
    expect(found).toEqual([]);
  });

  it("grants no write scope at the top level", () => {
    const found = workflowFiles()
      .map((f) => [f, topLevelWrite(load(f))] as const)
      .filter(([, why]) => why !== null)
      .map(([f, why]) => `${f}: ${why}`);
    expect(found).toEqual([]);
  });

  it("has no trigger that runs fork input with the base token", () => {
    const found = workflowFiles().flatMap((f) =>
      triggers(load(f))
        .filter((t) => t === "pull_request_target" || t === "workflow_run")
        .map((t) => `${f}: ${t}`),
    );
    expect(found).toEqual([]);
  });

  it("passes fork-controlled text to scripts through env only", () => {
    const found = workflowFiles().flatMap((f) =>
      injectableRunSteps(load(f)).map((s) => `${f}: ${s}`),
    );
    expect(found).toEqual([]);
  });

  it("catches each shape it guards against", () => {
    const bad = YAML.parse(
      [
        "on: pull_request_target",
        "permissions:",
        "  contents: write",
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "      - uses: some/action@0123456789abcdef0123456789abcdef01234567",
        "      - name: greet",
        '        run: echo "${{ github.event.pull_request.title }}"',
        "      - run: echo ${{ github.head_ref }}",
        "      - name: floors",
        '        run: node scripts/mutation-floors.mjs | tee -a "$GITHUB_STEP_SUMMARY"',
      ].join("\n"),
    ) as Workflow;
    expect(unpinnedRefs(bad)).toEqual(["actions/checkout@v7"]);
    expect(checkoutsKeepingCredentials(bad)).toEqual(["build #0"]);
    expect(topLevelWrite(bad)).toBe("top-level write: contents");
    expect(triggers(bad)).toEqual(["pull_request_target"]);
    expect(injectableRunSteps(bad)).toEqual(["build #2 greet", "build #3"]);
    expect(teeWithoutPipefail(bad)).toEqual(["build #4 floors"]);

    const good = YAML.parse(
      [
        "on: [push]",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567",
        "        with:",
        "          persist-credentials: false",
        "      - env:",
        "          TITLE: ${{ github.event.pull_request.title }}",
        '        run: echo "$TITLE"',
        "      - name: floors",
        "        shell: bash",
        "        run: |",
        "          set -o pipefail",
        '          node scripts/mutation-floors.mjs | tee -a "$GITHUB_STEP_SUMMARY"',
      ].join("\n"),
    ) as Workflow;
    expect(unpinnedRefs(good)).toEqual([]);
    expect(checkoutsKeepingCredentials(good)).toEqual([]);
    expect(topLevelWrite(good)).toBeNull();
    expect(injectableRunSteps(good)).toEqual([]);
    expect(teeWithoutPipefail(good)).toEqual([]);
  });
});
