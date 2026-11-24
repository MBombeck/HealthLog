#!/usr/bin/env node
/**
 * Resolve `<NAME>_FILE` secrets for `docker-entrypoint.sh`.
 *
 * The rules and the list live in `src/lib/boot/secret-files.mjs`. This is the
 * entrypoint's side: it hands the values to the shell as `export NAME='…'`
 * lines (plus `unset NAME_FILE`) on file descriptor 3 and nowhere else, the
 * way `db-app-role.mjs` hands over the role's URL. Every message goes to
 * stderr and names variables, paths and reasons, never a value. The
 * entrypoint reads it with
 *
 *     exports="$(node scripts/secret-files.mjs export 3>&1 1>&2)" || exit 1
 *     eval "$exports"
 *
 * Usage:
 *   node scripts/secret-files.mjs export   write the lines to descriptor 3
 *   node scripts/secret-files.mjs check    resolve, print the names only
 *
 * Exit 0: nothing to resolve, or every file resolved. Exit 1: a file is
 * unusable, or descriptor 3 is not open for `export`; nothing is written.
 * Exit 2: usage.
 */
import { fstatSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  SecretFileError,
  resolveSecretFiles,
  shellExports,
  unknownFileVariables,
} from "../src/lib/boot/secret-files.mjs";

const PREFIX = "HealthLog:";

/**
 * Whether descriptor 3 is a pipe or a file. Necessary, not sufficient: when
 * the caller opened nothing there, Node's own runtime may hold descriptor 3
 * (a pipe of its event loop), so the write itself can still fail, and
 * {@link handOver} catches that.
 */
function descriptor3IsOpen() {
  try {
    const stat = fstatSync(3);
    return stat.isFIFO() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Write all of `text` to descriptor 3.
 *
 * @param {string} text
 * @returns {boolean} whether it was written
 */
function handOver(text) {
  const bytes = Buffer.from(text, "utf8");
  try {
    for (let offset = 0; offset < bytes.length;) {
      offset += writeSync(3, bytes, offset);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {number} the exit code
 */
export function main(argv = process.argv.slice(2), env = process.env) {
  const mode = argv[0];
  if (mode !== "export" && mode !== "check") {
    console.error(
      "secret-files: usage: node scripts/secret-files.mjs export|check",
    );
    return 2;
  }

  for (const name of unknownFileVariables(env)) {
    const base = name.replace(/_FILE$/, "");
    console.error(
      `${PREFIX} WARNING — ${name} is set, but ${base} cannot be read from a file; ignoring it. ` +
        "docs/self-hosting/secrets.md lists the variables that can.",
    );
  }

  let resolved;
  try {
    resolved = resolveSecretFiles(env);
  } catch (error) {
    if (!(error instanceof SecretFileError)) throw error;
    for (const problem of error.problems) {
      console.error(`${PREFIX} ERROR — ${problem}`);
    }
    console.error(
      `${PREFIX} not starting. Fix what is named above and start again.`,
    );
    return 1;
  }

  if (resolved.length > 0) {
    console.error(
      `${PREFIX} read from files: ${resolved.map(({ name }) => name).join(", ")}`,
    );
  }
  if (mode === "check" || resolved.length === 0) return 0;

  if (!descriptor3IsOpen() || !handOver(shellExports(resolved))) {
    console.error(
      `${PREFIX} ERROR — secret-files export writes to descriptor 3, which is not open for it.`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
