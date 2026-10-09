/**
 * Structural guard: every runtime environment variable the server reads is on
 * the compose `environment:` whitelist.
 *
 * ## The failure this freezes
 *
 * `docker-compose.yml`'s `environment:` block is a WHITELIST. Compose reads
 * `.env` for `${VAR}` substitution at compose-up time, so a value an operator
 * sets there appears to be configured — but a variable the block does not name
 * never reaches the Node process. The symptom is the worst kind: no error, no
 * warning, the documented knob simply does nothing and the default silently
 * stands. v1.5.2 closed one instance of this (`SESSION_COOKIE_SECURE`); it
 * came back at scale, which is why the question is a gate now rather than a
 * comment on each entry.
 *
 * ## What it proves and what it does not
 *
 * It proves one thing exactly: no variable is read by shipped server code
 * without either reaching the container or carrying a written reason why it
 * must not. It does NOT prove the whitelist's defaults are right, that the
 * `.env.production.example` prose is accurate, or that a variable behaves as
 * documented. Those stay review questions.
 *
 * ## Why the matchers are what they are
 *
 * A grep for `process.env.X` alone is not the read set. Three modules resolve
 * a name through a helper and index `process.env` dynamically, so their reads
 * are invisible to the direct matcher — every `OIDC_*` among them. (The AI
 * private-host grants were a fourth until v1.39.3, when they became direct
 * `process.env` reads.) Each is registered below with its own call-shape
 * matcher AND its own non-zero assertion, so a refactor that renames the
 * helper fails this file loudly instead of quietly shrinking the read set.
 *
 * An empty match set is the other way a sweep goes quiet: it agrees with any
 * allowlist. Both the walk and every matcher therefore assert a floor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** `process.env.NAME` and `process.env["NAME"]`. */
const DIRECT_READ =
  /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\])/g;

/**
 * `envValue("NAME")`, `envOr("NAME", …)` and `envFlag("NAME")` from
 * `src/lib/env.ts` — the one helper every read with a fallback goes through,
 * so its call shape is a read wherever it appears. Asserted non-empty in T2.
 */
const HELPER_READ = /\benv(?:Value|Or|Flag)\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g;

/**
 * Modules that index `process.env` through a variable rather than a literal.
 * The direct matcher cannot see their reads at all, so each names the exact
 * call shape that carries the variable name, and each is asserted non-empty
 * in T2 below. `minimum` is the count that must still match — pinned under
 * the real number so an added read does not need a test edit, but a removed
 * matcher does.
 */
const INDIRECT_READERS: ReadonlyArray<{
  file: string;
  pattern: RegExp;
  minimum: number;
  why: string;
}> = [
  {
    file: "lib/auth/oidc.ts",
    pattern: /envOrEmpty\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    minimum: 6,
    why: "every OIDC_* name goes through the envOrEmpty() helper",
  },
  {
    file: "app/api/settings/privacy-summary/route.ts",
    pattern: /intEnv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    minimum: 1,
    why: "the retention windows are parsed through a local intEnv() helper",
  },
  {
    file: "lib/boot/readiness-summary.ts",
    pattern: /\benv\.([A-Z][A-Z0-9_]*)/g,
    minimum: 5,
    why: "the readiness report reads a `process.env`-defaulted parameter",
  },
];

/**
 * Read but deliberately NOT on the compose whitelist. Every entry carries the
 * reason adding it would be wrong — not merely why nobody got round to it.
 * Kept honest from both ends by T4: an entry that stops being read, or that
 * later appears in compose, fails this file.
 */
const NOT_OPERATOR_CONFIGURABLE: Readonly<Record<string, string>> = {
  // --- Provided by the runtime or the platform, never by an operator. ---
  NEXT_RUNTIME: "set by Next.js to distinguish the node and edge runtimes",
  npm_package_version: "set by the package manager when it spawns the process",

  // --- Baked at build time by the Dockerfile's ARG/ENV pairs. ---
  NEXT_PUBLIC_APP_VERSION:
    "Dockerfile build arg; a runtime value cannot change what is compiled in",
  NEXT_PUBLIC_I18N_CATALOG_VERSION:
    "computed by next.config.ts from the message catalogs at build time",
  NEXT_PUBLIC_APP_BUILD_SHA:
    "Dockerfile build arg, stamped from the release commit",
  NEXT_PUBLIC_APP_BUILT_AT: "Dockerfile build arg, stamped at image build",
  BUILD_TIMESTAMP:
    "build-provenance stamp; an operator value would be a lie about the image",
  GIT_COMMIT:
    "build-provenance stamp, read only as a fallback for the build SHA",
  COMMIT_SHA:
    "build-provenance stamp, read only as a fallback for the build SHA",
  SOURCE_COMMIT:
    "build-provenance stamp, read only as a fallback for the build SHA",

  // --- Reachable, but through a different name that IS on the whitelist. ---
  DB_CONNECTION_LIMIT:
    "compose splices it into DATABASE_URL's connection_limit parameter; forwarding it as a second env var would be two paths to one knob",
  DB_POOL_TIMEOUT:
    "compose splices it into DATABASE_URL's pool_timeout parameter, same reasoning as DB_CONNECTION_LIMIT",
  DATABASE_POOL_MAX:
    "a third spelling of DB_CONNECTION_LIMIT, read only as its fallback; one operator-facing name is enough",

  // --- Not an operator decision. ---
  CODEX_OAUTH_CLIENT_ID:
    "the ChatGPT OAuth application id is a fixed protocol constant, overridable only for development against a different app",

  // --- Never executes inside the container. ---
  COACH_EVAL_API_KEY:
    "repository secret for the nightly model-graded Coach eval; that workflow runs in CI, never in the app image",
  COACH_EVAL_GENERATOR_MODEL: "CI-only knob for the same nightly eval workflow",
  COACH_EVAL_JUDGE_MODEL: "CI-only knob for the same nightly eval workflow",
  COACH_EVAL_SCENARIO_REPEATS:
    "CI-only knob for the same nightly eval workflow",
  HEALTHLOG_MCP_TOKEN:
    "read by the local stdio MCP bridge the operator runs on their own machine; the production image strips tsx so it cannot run there",

  // --- A whitelist entry would be obeyed by half the readers. ---
  NEXT_PUBLIC_DASHBOARD_SNAPSHOT:
    "NEXT_PUBLIC_* is inlined into the client bundle at build time and three of its four readers are client components, so a runtime value would steer the server half only — a split-brain worse than no knob. .env.production.example already documents it as a build-time toggle and says it is deliberately absent from the whitelist; adding it would make that note false.",
};

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((rel) => !rel.startsWith("generated/"))
    .filter((rel) => !rel.includes("__tests__"))
    .filter((rel) => !rel.endsWith(".test.ts") && !rel.endsWith(".test.tsx"));
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** Every environment variable shipped server code reads, however it reads it. */
function runtimeReads(): Set<string> {
  const names = new Set<string>();
  for (const rel of sourceFiles()) {
    const src = read(rel);
    for (const m of src.matchAll(DIRECT_READ)) names.add(m[1] ?? m[2]);
    for (const m of src.matchAll(HELPER_READ)) names.add(m[1]);
  }
  for (const reader of INDIRECT_READERS) {
    for (const m of read(reader.file).matchAll(reader.pattern)) names.add(m[1]);
  }
  return names;
}

/**
 * The keys the compose `environment:` block (via the shared `x-healthlog-env`
 * anchor) forwards into the container. Two-space-indented `KEY: value` lines
 * are the anchor's own entries; the services merge the anchor rather than
 * repeating it.
 */
function composeWhitelist(): Set<string> {
  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  const keys = new Set<string>();
  for (const line of compose.split("\n")) {
    const m = line.match(/^\s{2,}([A-Z][A-Z0-9_]*):\s/);
    if (m) keys.add(m[1]);
  }
  // The `db` service's own three; the app never reads them.
  for (const k of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]) {
    keys.delete(k);
  }
  return keys;
}

describe("compose env whitelist", () => {
  it("T1 — the sweep actually reads something", () => {
    const reads = runtimeReads();
    // Pinned well under the real count. A sweep that collapses to a handful
    // agrees with any allowlist, which is how an empty scan passes as green.
    expect(reads.size).toBeGreaterThan(80);
    expect(composeWhitelist().size).toBeGreaterThan(50);
  });

  it("T2 — every indirect reader still matches its call shape", () => {
    const helperReads = sourceFiles().flatMap((rel) =>
      [...read(rel).matchAll(HELPER_READ)].map((m) => m[1]),
    );
    // The env helper is the common path for reads with a fallback; a matcher
    // that stopped seeing it would drop those names from the read set.
    expect(helperReads.length).toBeGreaterThan(10);
    expect(helperReads).toContain("IP_GEO_LOOKUP_URL");
    for (const reader of INDIRECT_READERS) {
      const found = [...read(reader.file).matchAll(reader.pattern)].map(
        (m) => m[1],
      );
      expect(
        found.length,
        `${reader.file}: matched ${found.length} name(s), expected at least ` +
          `${reader.minimum} — ${reader.why}. A zero here means the matcher ` +
          `went stale, not that the reads went away.`,
      ).toBeGreaterThanOrEqual(reader.minimum);
    }
  });

  it("T3 — no runtime variable is read without reaching the container", () => {
    const whitelist = composeWhitelist();
    const missing = [...runtimeReads()]
      .filter((name) => !whitelist.has(name))
      .filter((name) => !(name in NOT_OPERATOR_CONFIGURABLE))
      .sort();

    expect(
      missing,
      `These variables are read by shipped server code but are not on the ` +
        `docker-compose.yml \`environment:\` whitelist, so a value set in a ` +
        `self-hoster's .env never reaches the process and the default stands ` +
        `silently. Either add each to the whitelist (with a default and a ` +
        `line in .env.production.example) or record in ` +
        `NOT_OPERATOR_CONFIGURABLE why forwarding it would be wrong.`,
    ).toEqual([]);
  });

  it("T4 — the exception list carries no stale entries", () => {
    const reads = runtimeReads();
    const whitelist = composeWhitelist();

    const unread = Object.keys(NOT_OPERATOR_CONFIGURABLE)
      .filter((name) => !reads.has(name))
      .sort();
    expect(
      unread,
      "Listed as a deliberate exception but no longer read anywhere — drop the entry.",
    ).toEqual([]);

    const alsoForwarded = Object.keys(NOT_OPERATOR_CONFIGURABLE)
      .filter((name) => whitelist.has(name))
      .sort();
    expect(
      alsoForwarded,
      "Listed as deliberately not forwarded, yet present in the compose whitelist — one of the two is wrong.",
    ).toEqual([]);

    for (const [name, reason] of Object.entries(NOT_OPERATOR_CONFIGURABLE)) {
      expect(
        reason.length,
        `${name} needs a real reason, not a placeholder`,
      ).toBeGreaterThan(30);
    }
  });
});
