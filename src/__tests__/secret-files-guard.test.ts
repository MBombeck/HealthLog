/**
 * Structural guard: the secrets that can come from a file are the same list
 * everywhere an operator meets them.
 *
 * `src/lib/boot/secret-files.mjs` holds the list the container acts on. Four
 * other places name it, and each would fail quietly if it drifted:
 *
 *   - the compose whitelist (`docker-compose.yml`): a `<NAME>_FILE` it does
 *     not forward never reaches the container, so the file is never read and
 *     the secret is simply missing;
 *   - `scripts/env-manifest.json`: `pnpm check-env` only accepts `_FILE` for
 *     a variable marked `"secret": true`, and would call a correctly
 *     configured instance broken;
 *   - `docs/self-hosting/secrets.md`: the table operators read;
 *   - the code: a name on the list that nothing reads is a stale entry.
 *
 * Mutation check: drop `"SMTP_PASS",` from the list and the compose, docs
 * and manifest cases name `SMTP_PASS`; drop the `SMTP_PASS_FILE` line from
 * compose and the first case names it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FOREIGN_FILE_VARIABLES,
  SECRET_ENV_NAMES,
} from "@/lib/boot/secret-files.mjs";

import {
  readSource,
  readSourceText,
  walkSourceFiles,
} from "./helpers/source-files";

const ROOT = process.cwd();
const COMPOSE = readSource("docker-compose.yml", [
  "x-healthlog-env: &healthlog_env",
  "\nservices:\n",
]);
const DOCS = readSource("docs/self-hosting/secrets.md", [
  "## Which variables",
  "## Docker Compose",
]);
const MANIFEST = JSON.parse(
  readSource("scripts/env-manifest.json", '"secret": true'),
) as {
  groups: Array<{ variables: Array<{ name: string; secret?: boolean }> }>;
};

/** Read by the Postgres image and `db-upgrade`, not by the app. */
const DB_SERVICE_ONLY = new Set(["POSTGRES_PASSWORD"]);

/** The shared `x-healthlog-env` block every app container merges. */
function sharedEnvBlock(): string {
  const start = COMPOSE.indexOf("x-healthlog-env: &healthlog_env");
  const end = COMPOSE.indexOf("\nservices:\n");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return COMPOSE.slice(start, end);
}

/** The body of one top-level service, up to the next one. */
function service(name: string): string {
  const match = new RegExp(
    `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|^\\S)`,
    "m",
  ).exec(COMPOSE);
  expect(match, `service ${name}`).not.toBeNull();
  return match![1];
}

function forwards(block: string, name: string): boolean {
  return new RegExp(`^\\s+${name}: "\\$\\{${name}(:-[^}]*)?\\}"$`, "m").test(
    block,
  );
}

describe("secrets from files: one list everywhere", () => {
  it("the list is closed, and APNS_KEY keeps its own APNS_KEY_FILE", () => {
    expect(SECRET_ENV_NAMES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SECRET_ENV_NAMES).size).toBe(SECRET_ENV_NAMES.length);
    expect(SECRET_ENV_NAMES).not.toContain("APNS_KEY");
    for (const foreign of FOREIGN_FILE_VARIABLES) {
      expect(SECRET_ENV_NAMES).not.toContain(foreign.replace(/_FILE$/, ""));
    }
  });

  it("compose forwards NAME and NAME_FILE for every secret", () => {
    const shared = sharedEnvBlock();
    const missing: string[] = [];
    for (const name of SECRET_ENV_NAMES) {
      if (DB_SERVICE_ONLY.has(name)) {
        for (const svc of ["db", "db-upgrade"]) {
          if (!forwards(service(svc), `${name}_FILE`)) {
            missing.push(`${svc}: ${name}_FILE`);
          }
        }
        continue;
      }
      if (!forwards(shared, `${name}_FILE`)) missing.push(`${name}_FILE`);
      // DATABASE_URL is built in place rather than forwarded.
      if (name !== "DATABASE_URL" && !forwards(shared, name)) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("compose forwards no _FILE variable the list does not know", () => {
    const known = new Set([
      ...SECRET_ENV_NAMES.map((name) => `${name}_FILE`),
      ...FOREIGN_FILE_VARIABLES,
    ]);
    const forwarded = [
      ...COMPOSE.matchAll(/^\s+([A-Z][A-Z0-9_]*_FILE): "/gm),
    ].map((m) => m[1]);
    expect(forwarded.length).toBeGreaterThan(SECRET_ENV_NAMES.length);
    expect(forwarded.filter((name) => !known.has(name))).toEqual([]);
  });

  it("the manifest marks exactly the listed variables as secret", () => {
    const variables = MANIFEST.groups.flatMap((group) => group.variables);
    const marked = variables.filter((v) => v.secret).map((v) => v.name);
    const listedInManifest = variables
      .map((v) => v.name)
      .filter((name) => SECRET_ENV_NAMES.includes(name));
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.sort()).toEqual(listedInManifest.sort());
  });

  it("the docs table names exactly the listed variables", () => {
    const section = DOCS.slice(
      DOCS.indexOf("## Which variables"),
      DOCS.indexOf("## Docker Compose"),
    );
    const rows = [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)`/gm)].map(
      (m) => m[1],
    );
    expect([...rows].sort()).toEqual([...SECRET_ENV_NAMES].sort());
  });

  it("every listed variable is read somewhere", () => {
    // Cheap and wide: the name as a whole word in shipped code outside the
    // loader. A stale entry has no such reader left.
    const words = new Set<string>();
    for (const root of ["src", "scripts"]) {
      const files = walkSourceFiles(join(ROOT, root), {
        floor: root === "src" ? 3000 : 30,
        extensions: [".ts", ".tsx", ".mjs"],
      }).filter(
        (rel) =>
          !rel.includes("__tests__") &&
          !rel.startsWith("generated/") &&
          rel !== "lib/boot/secret-files.mjs",
      );
      for (const rel of files) {
        const text = readSourceText(join(ROOT, root, rel));
        for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
          words.add(m[0]);
        }
      }
    }
    expect(words.has("ENCRYPTION_KEY")).toBe(true);
    expect(SECRET_ENV_NAMES.filter((name) => !words.has(name))).toEqual([]);
  });
});
