/**
 * Every npm install in the image is `npm ci` from a committed lockfile.
 *
 * The `prisma-cli` stage once ran `npm install prisma@… tsx@…` against a
 * package.json it had just generated. The four named versions were pinned,
 * but the rest of the tree resolved fresh on every build, with no recorded
 * integrity hash, so two builds of one commit could ship different code and
 * the dependency scanners had no lockfile to read. The stage now copies
 * `docker/prisma-cli/package.json` and `package-lock.json` and runs `npm ci`,
 * which installs exactly the lockfile and refuses to start when the two
 * files disagree.
 *
 * This guard holds that shape: no resolving npm command in the Dockerfile,
 * each `npm ci` preceded in its stage by a COPY of a lockfile that exists,
 * every locked package carrying a registry URL and an integrity hash, the
 * lockfile's root matching the package.json it was made from, and
 * Dependabot reading that directory.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const CLI_DIR = "docker/prisma-cli";

/** Non-comment Dockerfile lines, continuation lines included. */
function codeLines(dockerfile: string): string[] {
  return dockerfile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * npm invocations that resolve versions at build time. `npm ci` is the one
 * npm install form allowed; everything else that fetches or rewrites a
 * manifest is reported. pnpm installs in the deps stage run with
 * `--frozen-lockfile` and are held by the ci-determinism guard.
 */
export function resolvingNpmCommands(dockerfile: string): string[] {
  const resolving =
    /\bnpm\s+(?:install|i|add|update|up|upgrade|init|pkg\s+set|exec|x)\b/;
  return codeLines(dockerfile).filter((line) => resolving.test(line));
}

/** The `COPY` sources and `npm ci` lines of each stage, by stage name. */
function stages(dockerfile: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current = "";
  for (const line of codeLines(dockerfile)) {
    const from = /^FROM\s+\S+\s+AS\s+(\S+)$/i.exec(line);
    if (from) {
      current = from[1];
      result.set(current, []);
      continue;
    }
    result.get(current)?.push(line);
  }
  return result;
}

describe("Dockerfile npm installs come from committed lockfiles", () => {
  const dockerfile = read("Dockerfile");

  it("runs no npm command that resolves versions at build time", () => {
    expect(resolvingNpmCommands(dockerfile)).toEqual([]);
  });

  it("detects the install form it exists to refuse", () => {
    // Proof the matcher can fail: the stage as it used to be.
    expect(
      resolvingNpmCommands(
        [
          "RUN mkdir -p /opt/prisma-cli && \\",
          "    npm init -y && \\",
          "    npm pkg set 'overrides.x=^1.0.0' && \\",
          "    npm install --omit=dev prisma@7.10.1 --no-fund",
          "# npm install in a comment is fine",
          "RUN npm ci --omit=dev",
        ].join("\n"),
      ),
    ).toHaveLength(3);
  });

  it("copies a committed lockfile into every stage that runs npm ci", () => {
    const withCi = [...stages(dockerfile)].filter(([, lines]) =>
      lines.some((line) => /\bnpm\s+ci\b/.test(line)),
    );
    // The prisma-cli stage is the one npm install the image has.
    expect(withCi.map(([name]) => name)).toContain("prisma-cli");

    for (const [name, lines] of withCi) {
      const ciAt = lines.findIndex((line) => /\bnpm\s+ci\b/.test(line));
      const lockCopies = lines
        .slice(0, ciAt)
        .filter((line) => /^COPY\s/.test(line))
        .flatMap((line) => line.split(/\s+/).slice(1, -1))
        .filter((source) => source.endsWith("package-lock.json"));
      expect(
        lockCopies,
        `stage ${name} runs npm ci without a lockfile`,
      ).not.toEqual([]);
      for (const source of lockCopies) {
        expect(
          existsSync(join(ROOT, source)),
          `${source} is not committed`,
        ).toBe(true);
      }
    }
  });

  it("locks every package of the prisma-cli tree to a registry URL and hash", () => {
    const lock = JSON.parse(read(`${CLI_DIR}/package-lock.json`)) as {
      lockfileVersion: number;
      packages: Record<
        string,
        {
          version?: string;
          resolved?: string;
          integrity?: string;
          link?: boolean;
        }
      >;
    };
    expect(lock.lockfileVersion).toBe(3);
    const entries = Object.entries(lock.packages).filter(([key]) => key !== "");
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, entry] of entries) {
      expect(
        entry.link,
        `${key} is a link, not a registry package`,
      ).toBeUndefined();
      expect(entry.resolved, `${key} has no resolved URL`).toMatch(
        /^https:\/\/registry\.npmjs\.org\//,
      );
      expect(entry.integrity, `${key} has no integrity hash`).toMatch(
        /^sha512-/,
      );
    }
  });

  it("keeps the prisma-cli lockfile in step with its package.json", () => {
    const manifest = JSON.parse(read(`${CLI_DIR}/package.json`)) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const lock = JSON.parse(read(`${CLI_DIR}/package-lock.json`)) as {
      packages: Record<
        string,
        { version?: string; dependencies?: Record<string, string> }
      >;
    };
    // Exact versions only: the four top-level packages are the ones the
    // image's checks and the app's own pins name.
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      expect(range, `${name} is not an exact version`).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(range);
    }
    expect(manifest.devDependencies).toBeUndefined();
    expect(lock.packages[""]?.dependencies).toEqual(manifest.dependencies);
  });

  it("has Dependabot read the prisma-cli lockfile", () => {
    const dependabot = read(".github/dependabot.yml");
    expect(dependabot).toMatch(
      /- package-ecosystem: "npm"\s*\n\s*directory: "\/docker\/prisma-cli"/,
    );
  });
});
