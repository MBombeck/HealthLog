#!/usr/bin/env tsx
/**
 * Pre-deploy env-var sanity check.
 *
 * Reads `scripts/env-manifest.json` and verifies every variable
 * declared `required: true` (group-level) is present + non-empty in
 * the runtime environment. Optional groups are reported as
 * informational so an operator can spot misconfigurations (e.g. three
 * out of four APNS_* vars set — the silent-disable case that bit us
 * for 3 days in v1.4.40).
 *
 * Designed to run in two modes:
 *
 *   1. Live env (default): inspects `process.env` after dotenv has
 *      loaded `.env` / `.env.production`. This is what `pnpm
 *      check-env` does locally and what CI will run against the
 *      pre-deploy environment.
 *
 *   2. File mode: `pnpm check-env --file .env.production` reads a
 *      KEY=VALUE file directly without loading it into `process.env`.
 *      Useful for checking a Coolify export against the manifest
 *      without polluting the local shell.
 *
 * Exit codes:
 *   0  — all required variables present + non-empty.
 *   1  — at least one required variable missing/empty.
 *   2  — manifest file unreadable or malformed.
 *
 * Future (v1.4.43): CI integration via a GitHub Action that runs this
 * against a `.env.production.example`-style file in the repo,
 * blocking PRs that introduce new required vars without updating the
 * manifest.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit, env as processEnv } from "node:process";

const MANIFEST_PATH = resolve(__dirname, "env-manifest.json");

interface ManifestVariable {
  name: string;
  purpose: string;
  example?: string;
  /**
   * Alternative names — if at least one is present, the variable is
   * considered satisfied. Used for APNS_KEY vs APNS_KEY_FILE.
   */
  anyOf?: string[];
}

interface ManifestGroup {
  name: string;
  description: string;
  required: boolean;
  allOrNone?: boolean;
  variables: ManifestVariable[];
}

interface Manifest {
  description: string;
  groups: ManifestGroup[];
}

interface CheckResult {
  group: string;
  variable: string;
  present: boolean;
  required: boolean;
  note?: string;
  /**
   * For `anyOf` rows: the alternative that actually satisfied the row.
   * Set only when the matched name differs from the primary `variable`
   * — e.g. APNS_KEY satisfied by APNS_KEY_FILE. Lets the renderer print
   * `[OK] APNS_KEY (satisfied by APNS_KEY_FILE)` instead of misleading
   * the operator into greping for the primary name.
   */
  satisfiedBy?: string;
}

/**
 * Parse a KEY=VALUE file into an env-lookup object. Mirrors dotenv's
 * minimal behaviour (no variable expansion, no escape sequences) so a
 * Coolify export file or .env.production can be inspected without
 * pulling in the full dotenv parse path.
 *
 *   - Lines beginning with `#` are comments.
 *   - Empty lines are skipped.
 *   - Quoted values (`"..."` or `'...'`) have the quotes stripped.
 *   - Whitespace around `=` is preserved (Coolify never adds any).
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes — dotenv accepts both flavours.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * A variable counts as "present" only when the value is defined AND
 * non-empty (whitespace-only counts as empty). Pre-v1.4.42 the v1.4.40
 * AP-2 gap shipped because the .p8 file simply did not exist — but a
 * `""` value would have passed an `existsSync`-style check too.
 */
function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Pure classifier — exported so unit tests can drive it without
 * hitting the filesystem. Given a manifest and an env lookup, return
 * one result row per declared variable plus any group-level
 * all-or-none violations.
 */
export function checkEnv(
  manifest: Manifest,
  env: Record<string, string | undefined>,
): CheckResult[] {
  const results: CheckResult[] = [];

  for (const group of manifest.groups) {
    let presentInGroup = 0;
    let absentInGroup = 0;

    for (const v of group.variables) {
      const names = v.anyOf ?? [v.name];
      const matched = names.find((n) => isPresent(env[n]));
      const present = matched !== undefined;
      const note = v.anyOf
        ? `Satisfied by any of: ${v.anyOf.join(", ")}`
        : undefined;
      results.push({
        group: group.name,
        variable: v.name,
        present,
        required: group.required,
        note,
        satisfiedBy:
          present && matched && matched !== v.name ? matched : undefined,
      });
      if (present) presentInGroup++;
      else absentInGroup++;
    }

    // All-or-none groups: surface a synthetic row when the group is
    // partially populated. This catches the v1.4.40 AP-2 pattern even
    // when the group itself is `required: false`.
    if (
      group.allOrNone &&
      presentInGroup > 0 &&
      absentInGroup > 0
    ) {
      results.push({
        group: group.name,
        variable: "<all-or-none>",
        present: false,
        // Promote to required severity — a partial all-or-none group
        // is always wrong, no matter the surrounding group flag.
        required: true,
        note: `Group is all-or-none but only ${presentInGroup}/${
          presentInGroup + absentInGroup
        } variables are set. Either set all or unset all.`,
      });
    }
  }

  return results;
}

/**
 * Render a one-row-per-variable summary to stdout. The output is
 * intentionally grep-friendly so a CI pipeline can pattern-match for
 * `[MISSING-REQUIRED]` to fail the build.
 */
function renderResults(results: CheckResult[]): {
  missingRequired: number;
  missingOptional: number;
} {
  let missingRequired = 0;
  let missingOptional = 0;
  let currentGroup = "";

  for (const r of results) {
    if (r.group !== currentGroup) {
      console.log(`\n# ${r.group}`);
      currentGroup = r.group;
    }
    if (r.present) {
      console.log(
        `  [OK] ${r.variable}` +
          (r.satisfiedBy ? ` (satisfied by ${r.satisfiedBy})` : ""),
      );
    } else if (r.required) {
      console.log(
        `  [MISSING-REQUIRED] ${r.variable}` +
          (r.note ? ` — ${r.note}` : ""),
      );
      missingRequired++;
    } else {
      console.log(
        `  [missing-optional] ${r.variable}` + (r.note ? ` — ${r.note}` : ""),
      );
      missingOptional++;
    }
  }

  return { missingRequired, missingOptional };
}

/**
 * Entry point — kept as a named export so a test harness can call it
 * with a synthetic argv without spawning a child process.
 */
export function main(args: string[]): number {
  const fileFlagIdx = args.indexOf("--file");
  let env: Record<string, string | undefined>;
  let envLabel: string;

  if (fileFlagIdx !== -1 && args[fileFlagIdx + 1]) {
    const filePath = resolve(args[fileFlagIdx + 1]!);
    try {
      env = parseEnvFile(readFileSync(filePath, "utf8"));
      envLabel = filePath;
    } catch (err) {
      console.error(`Failed to read env file at ${filePath}: ${err}`);
      return 2;
    }
  } else {
    env = processEnv;
    envLabel = "process.env";
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  } catch (err) {
    console.error(`Failed to read manifest at ${MANIFEST_PATH}: ${err}`);
    return 2;
  }

  console.log(`Checking ${envLabel} against ${MANIFEST_PATH}`);
  const results = checkEnv(manifest, env);
  const { missingRequired, missingOptional } = renderResults(results);

  console.log("");
  console.log(
    `Summary: ${results.filter((r) => r.present).length}/${results.length} variables present`,
  );
  if (missingRequired > 0) {
    console.log(
      `  ${missingRequired} REQUIRED variable(s) missing — deploy WILL FAIL.`,
    );
  }
  if (missingOptional > 0) {
    console.log(
      `  ${missingOptional} optional variable(s) missing — feature will silently disable.`,
    );
  }

  return missingRequired > 0 ? 1 : 0;
}

// Only run when invoked directly (`pnpm check-env` / `tsx scripts/check-env.ts`).
// `require.main === module` survives the bundler-style ESM->CJS shim
// that tsx uses.
if (require.main === module) {
  exit(main(argv.slice(2)));
}
