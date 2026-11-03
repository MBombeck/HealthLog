/**
 * Structural guard: a script a runbook tells the operator to run inside the
 * container is actually in the image, together with every local file it
 * imports.
 *
 * ## The failure this freezes
 *
 * `docs/ops/password-reset.md` told operators to run
 * `docker compose exec app node scripts/reset-password.mjs`, and the runner
 * stage of the Dockerfile copied nothing from `scripts/`: the standalone
 * output does not carry it. The recovery path for a locked-out admin failed
 * with "Cannot find module" at the moment it was needed. The intake-repair
 * runbook had the same gap under the `healthlog-tsx` launcher.
 *
 * ## What it proves and what it does not
 *
 * Every `docker compose exec … node scripts/…` or `healthlog-tsx scripts/…`
 * command in `docs/` names
 * a file the runner stage copies, and every relative import of that file is
 * copied too. Whether the package imports resolve is proved at image build by
 * the `RUN` checks next to the copies; this file cannot see the traced tree.
 * A command written in some other form (a different launcher) is outside the
 * matcher.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ROOT = process.cwd();
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");

/**
 * In-container command forms: `docker compose exec <service> node scripts/…`
 * or the image's own `healthlog-tsx scripts/…` launcher. A bare
 * `node scripts/…` is a workstation or source-checkout command and is out of
 * scope.
 */
const CONTAINER_COMMAND =
  /(?:docker compose exec\s+(?:-\S+\s+)*\S+\s+node|\bhealthlog-tsx)\s+(scripts\/[\w.-]+)/g;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".md"))
    .map((rel) => join(dir, rel));
}

function runnerStage(): string {
  const start = DOCKERFILE.search(/^FROM .* AS runner$/m);
  expect(start, "the Dockerfile has a runner stage").toBeGreaterThan(0);
  return DOCKERFILE.slice(start);
}

function copiedIntoRunner(path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^COPY --from=builder (?:--chown=\\S+ )?/app/${escaped} \\./${escaped}$`,
    "m",
  ).test(runnerStage());
}

/** Scripts named by a container command anywhere under docs/. */
function documentedContainerScripts(): string[] {
  const found = new Set<string>();
  for (const file of markdownFiles(join(ROOT, "docs"))) {
    for (const m of readFileSync(file, "utf8").matchAll(CONTAINER_COMMAND)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

/** Scripts `docker-entrypoint.sh` runs with `node scripts/…` on every boot. */
function entrypointScripts(): string[] {
  const entrypoint = readFileSync(join(ROOT, "docker-entrypoint.sh"), "utf8");
  return [
    ...new Set(
      // A line that starts with the call, or a command substitution that
      // makes it (`url="$(node scripts/db-app-role.mjs …)"`).
      [
        ...entrypoint.matchAll(/(?:^\s*|\$\(\s*)node\s+(scripts\/[\w.-]+)/gm),
      ].map((m) => m[1]),
    ),
  ].sort();
}

/** Relative import specifiers of a script, resolved against its location. */
function localImports(script: string): string[] {
  const src = readFileSync(join(ROOT, script), "utf8");
  const specs = [
    ...src.matchAll(/^\s*import\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm),
  ].map((m) => m[1]);
  return specs.map((spec) => normalize(join(dirname(script), spec)));
}

describe("scripts the runbooks run inside the container ship in the image", () => {
  it("finds the commands it is meant to check", () => {
    const scripts = documentedContainerScripts();
    // A matcher that found nothing would agree with any Dockerfile.
    expect(scripts).toContain("scripts/reset-password.mjs");
    expect(scripts).toContain("scripts/repair-intake-anomalies.ts");
    expect(localImports("scripts/reset-password.mjs")).toContain(
      "src/lib/auth/argon2-params.mjs",
    );
    expect(copiedIntoRunner("scripts/not-a-real-script.mjs")).toBe(false);
  });

  it("copies every documented script into the runner stage", () => {
    const missing = documentedContainerScripts().filter(
      (script) => !copiedIntoRunner(script),
    );
    expect(
      missing,
      "A runbook runs these inside the container, but the Dockerfile runner " +
        "stage does not COPY them. Add the COPY (and its local imports), or " +
        "change the runbook to a source-checkout command.",
    ).toEqual([]);
  });

  it("copies every local file those scripts import", () => {
    const missing = documentedContainerScripts()
      .flatMap((script) => localImports(script))
      .filter((path) => !copiedIntoRunner(path));
    expect(missing).toEqual([]);
  });
});

describe("scripts the entrypoint runs ship in the image", () => {
  it("finds the boot scripts it is meant to check", () => {
    // An empty match would agree with any Dockerfile.
    expect(entrypointScripts()).toContain("scripts/pending-migrations.mjs");
    expect(entrypointScripts()).toContain("scripts/db-app-role.mjs");
  });

  it("copies every boot script and its local imports into the runner stage", () => {
    const missing = entrypointScripts()
      .flatMap((script) => [script, ...localImports(script)])
      .filter((path) => !copiedIntoRunner(path));
    expect(
      missing,
      "docker-entrypoint.sh runs these on every boot, but the Dockerfile " +
        "runner stage does not COPY them; the container would fail to start.",
    ).toEqual([]);
  });
});
