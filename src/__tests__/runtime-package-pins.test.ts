/**
 * The runtime image is pinned by image digest, carries no package manager,
 * and its PostgreSQL client moves with the bundled database.
 *
 * Node comes from the official node:22-trixie-slim image and pg_dump /
 * pg_restore from the official PostgreSQL image, both by digest. Without
 * the digest a rebuild of the same commit could ship another Node or
 * another pg_dump than the one the release was checked with. Dependabot's
 * `docker` ecosystem proposes the next digest or minor; the image scan
 * names a fix the pinned base has not absorbed. This file holds the pins'
 * shape, the runner's lack of npm, and the client's agreement with the
 * bundled database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");

const DIGEST = /@sha256:[0-9a-f]{64}$/;

function froms(): { image: string; stage: string }[] {
  return [...DOCKERFILE.matchAll(/^FROM (\S+) AS (\S+)$/gm)].map((m) => ({
    image: m[1]!,
    stage: m[2]!,
  }));
}

function stage(name: string): string {
  const start = DOCKERFILE.search(new RegExp(`^FROM .* AS ${name}$`, "m"));
  expect(start, `the Dockerfile has a ${name} stage`).toBeGreaterThan(0);
  const next = DOCKERFILE.slice(start + 1).search(/^FROM /m);
  return next < 0
    ? DOCKERFILE.slice(start)
    : DOCKERFILE.slice(start, start + 1 + next);
}

/** The runner's instructions, comments dropped. */
function runnerInstructions(): string {
  return stage("runner")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("runtime package pins", () => {
  it("pins every stage's base image by digest", () => {
    const all = froms();
    // Every FROM names a stage, so none escapes the list above.
    expect(DOCKERFILE.match(/^FROM /gm)).toHaveLength(all.length);
    for (const { image, stage: name } of all) {
      expect(image, `${name} pins its base by digest`).toMatch(DIGEST);
    }
  });

  it("runs on the builder's own official Node 22 image", () => {
    const byStage = new Map(froms().map((f) => [f.stage, f.image]));
    const runner = byStage.get("runner");
    expect(runner).toMatch(/^node:22-trixie-slim@sha256:[0-9a-f]{64}$/);
    // Same image as the stage the native packages were installed in.
    expect(runner).toBe(byStage.get("builder"));
  });

  it("removes npm, npx, corepack and yarn from the runner and runs none of them", () => {
    const runner = runnerInstructions();
    for (const path of [
      "/usr/local/lib/node_modules/npm",
      "/usr/local/lib/node_modules/corepack",
      "/usr/local/bin/npm",
      "/usr/local/bin/npx",
      "/usr/local/bin/corepack",
      "/usr/local/bin/yarn",
    ]) {
      expect(runner).toContain(path);
    }
    expect(runner).toContain(
      "sh -c '! command -v npm && ! command -v npx && ! command -v corepack && ! command -v yarn && ! command -v pnpm'",
    );
    // Nothing in the runner installs a package manager or runs one.
    expect(runner).not.toMatch(/\b(npm|npx|corepack|yarn|pnpm) [a-z]/);
    expect(runner).not.toMatch(/apt-get install[^;&]*\b(npm|nodejs)\b/);
    expect(runner).not.toMatch(/\bapk\b/);
  });

  it("takes the PostgreSQL client from the bundled database's minor", () => {
    const pg = froms().find((f) => f.stage === "pgclient");
    expect(pg, "the Dockerfile has a pgclient stage").toBeDefined();
    const client = /^postgres:(18\.\d+)-trixie@sha256:[0-9a-f]{64}$/.exec(
      pg!.image,
    );
    expect(client, `a pinned major 18 image, not ${pg!.image}`).not.toBeNull();
    const db = /^\s*image:\s*postgres:(\d+\.\d+)-alpine$/m.exec(COMPOSE);
    expect(db, "the compose file pins the database").not.toBeNull();
    // One decision: a database minor bump moves the client with it.
    expect(client![1]).toBe(db![1]);
    expect(stage("runner")).toContain(
      "COPY --from=pgclient /out/bin/ /usr/lib/postgresql/18/bin/",
    );
  });
});
