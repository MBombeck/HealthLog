/**
 * Secrets from files: `<NAME>_FILE` for every secret environment variable.
 *
 * Docker secrets, Kubernetes secret volumes and a Vault agent all hand a
 * secret over as a file. For every name in {@link SECRET_ENV_NAMES}, setting
 * `<NAME>_FILE` to a path makes HealthLog read `<NAME>` from that file. The
 * rules, the same everywhere:
 *
 *   - `<NAME>_FILE` unset or empty: nothing happens.
 *   - Set: the file is read as UTF-8 and ONE trailing `\n` or `\r\n` is
 *     removed (an editor's or `echo`'s final newline); nothing else is
 *     trimmed. A file that cannot be read, or that holds nothing but
 *     whitespace, or that holds a NUL byte, refuses the start.
 *   - `<NAME>` set as well (non-empty): the same value is fine; a different
 *     one refuses the start, since either choice could be the wrong key.
 *   - A `<X>_FILE` for a name not on the list is left alone, with a warning,
 *     because it does nothing (see {@link unknownFileVariables}).
 *
 * A refusal names the variable and the reason, never the value.
 *
 * Where it runs: `docker-entrypoint.sh` calls `scripts/secret-files.mjs`
 * before anything else, so the migrations, the dump, the role setup, the
 * server and the worker all inherit plain variables, and the `_FILE`
 * variables it resolved are unset. The server calls
 * {@link applySecretFiles} again at the start of `register()` in
 * `src/instrumentation.ts`, which does the work for a start without the
 * entrypoint (`node server.js`, `next start`) and finds nothing to do in the
 * container. The maintenance scripts an operator runs with
 * `docker compose exec` / `docker compose run` (`reset-password.mjs`,
 * `db-restore.mjs`) call it too, because those processes do not inherit the
 * entrypoint's environment.
 *
 * `APNS_KEY_FILE` is not part of this scheme: it predates it, and the APNs
 * sender reads that path itself, with its own precedence (`APNS_KEY_B64` >
 * `APNS_KEY` > `APNS_KEY_FILE`) and a disabled channel rather than a refused
 * start when the file is bad. `APNS_KEY` is therefore not on the list, and
 * `APNS_KEY_B64_FILE` is the file form of the base64 key.
 *
 * Plain ESM with no imports beyond Node, so the entrypoint runs it without a
 * build and the app bundles it like any other module.
 */
import { readFileSync } from "node:fs";

/**
 * Every environment variable that holds a credential or a key. A URL, an id
 * or a public key is not on it. Adding a name is one line here, plus the
 * `<NAME>_FILE` line in the compose whitelist (`secret-files-guard.test.ts`
 * holds the two, and `scripts/env-manifest.json`, in step).
 */
export const SECRET_ENV_NAMES = Object.freeze([
  // Database. The bundled compose file builds DATABASE_URL from
  // POSTGRES_PASSWORD; the `db` service's image reads POSTGRES_PASSWORD_FILE
  // itself.
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  // Encryption at rest, tokens and sessions.
  "ENCRYPTION_KEY",
  "ENCRYPTION_KEYS",
  "API_TOKEN_HMAC_KEY",
  // Backups.
  "BACKUP_ENCRYPTION_KEY",
  "BACKUP_ENCRYPTION_PREVIOUS_KEYS",
  "BACKUP_S3_ACCESS_KEY",
  "BACKUP_S3_SECRET_KEY",
  // Inbound webhooks.
  "WITHINGS_WEBHOOK_SECRET",
  "WHOOP_WEBHOOK_SECRET",
  "TELEGRAM_WEBHOOK_SECRET",
  "DEPLOY_WEBHOOK_SECRET",
  // OAuth clients and single sign-on.
  "POLAR_CLIENT_SECRET",
  "OURA_CLIENT_SECRET",
  "STRAVA_CLIENT_SECRET",
  "OIDC_CLIENT_SECRET",
  // Notifications.
  "SMTP_PASS",
  "VAPID_PRIVATE_KEY",
  "APNS_KEY_B64",
  // Apple Wallet signing key.
  "WALLET_APPLE_KEY_B64",
  "WALLET_APPLE_KEY_PASSPHRASE",
  // Third-party services.
  "MAXMIND_LICENSE_KEY",
  "LOKI_PASSWORD",
]);

/**
 * `_FILE` variables that are not this scheme's and get no warning:
 * `APNS_KEY_FILE` (read by the APNs sender itself) and `SSL_CERT_FILE`
 * (OpenSSL's CA bundle path).
 */
export const FOREIGN_FILE_VARIABLES = Object.freeze([
  "APNS_KEY_FILE",
  "SSL_CERT_FILE",
]);

/** A start refused because a secret file is unusable. */
export class SecretFileError extends Error {
  /** @param {string[]} problems one sentence per variable */
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "SecretFileError";
    /** @type {string[]} */
    this.problems = problems;
  }
}

/** @param {string | undefined} value */
function isSet(value) {
  return typeof value === "string" && value !== "";
}

/**
 * The file's content with one trailing line break removed.
 *
 * @param {string} raw
 */
export function stripOneTrailingNewline(raw) {
  if (raw.endsWith("\r\n")) return raw.slice(0, -2);
  if (raw.endsWith("\n")) return raw.slice(0, -1);
  return raw;
}

/** @param {unknown} error */
function reasonOf(error) {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ name: string; value: string }} ResolvedSecret
 * @typedef {{
 *   readFile?: (path: string) => string;
 *   names?: readonly string[];
 * }} ResolveOptions
 */

/**
 * Read every `<NAME>_FILE` that is set. Changes nothing.
 *
 * @param {Env} env
 * @param {ResolveOptions} [options]
 * @returns {ResolvedSecret[]} one entry per `_FILE` variable that was set
 * @throws {SecretFileError} naming every unusable file at once
 */
export function resolveSecretFiles(env, options = {}) {
  const readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
  const names = options.names ?? SECRET_ENV_NAMES;
  /** @type {ResolvedSecret[]} */
  const resolved = [];
  /** @type {string[]} */
  const problems = [];

  for (const name of names) {
    const fileVar = `${name}_FILE`;
    const path = env[fileVar];
    if (!isSet(path)) continue;

    let raw;
    try {
      raw = readFile(path);
    } catch (error) {
      problems.push(`${fileVar}: cannot read ${path} (${reasonOf(error)}).`);
      continue;
    }
    const value = stripOneTrailingNewline(raw);
    if (value.trim() === "") {
      problems.push(`${fileVar}: ${path} is empty.`);
      continue;
    }
    if (value.includes("\0")) {
      problems.push(`${fileVar}: ${path} contains a NUL byte.`);
      continue;
    }
    const plain = env[name];
    if (isSet(plain) && plain !== value) {
      problems.push(
        `${name} and ${fileVar} are both set, to different values. Set one of them.`,
      );
      continue;
    }
    resolved.push({ name, value });
  }

  if (problems.length > 0) throw new SecretFileError(problems);
  return resolved;
}

/**
 * `<X>_FILE` variables that are set but mean nothing here: neither on the
 * list nor known to belong to something else. An operator who sets
 * `SMTP_USER_FILE` expecting it to work hears that it does not, and the
 * start goes on (a refusal would also stop a host whose platform injects an
 * unrelated `_FILE` variable).
 *
 * @param {Env} env
 * @param {readonly string[]} [names]
 * @returns {string[]} the variable names, sorted
 */
export function unknownFileVariables(env, names = SECRET_ENV_NAMES) {
  const known = new Set([
    ...names.map((name) => `${name}_FILE`),
    ...FOREIGN_FILE_VARIABLES,
  ]);
  return Object.keys(env)
    .filter((key) => /^[A-Z][A-Z0-9_]*_FILE$/.test(key))
    .filter((key) => isSet(env[key]) && !known.has(key))
    .sort();
}

/**
 * Resolve the files and write the values into `env`, removing each
 * `<NAME>_FILE` that was resolved. Idempotent: a second call finds no
 * `_FILE` variable left.
 *
 * @param {Env} [env]
 * @param {ResolveOptions} [options]
 * @returns {string[]} the names now set from a file
 * @throws {SecretFileError}
 */
export function applySecretFiles(env = process.env, options = {}) {
  const resolved = resolveSecretFiles(env, options);
  for (const { name, value } of resolved) {
    env[name] = value;
    delete env[`${name}_FILE`];
  }
  return resolved.map(({ name }) => name);
}

/**
 * A POSIX shell single-quoted word for `value`: inside single quotes nothing
 * is special, and a single quote is closed, escaped and reopened.
 *
 * @param {string} value
 */
export function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell lines that set the resolved variables and unset their `_FILE`
 * variables, for the entrypoint to `eval`. Names come from the closed list,
 * so only the values need quoting.
 *
 * @param {ResolvedSecret[]} resolved
 */
export function shellExports(resolved) {
  return resolved
    .map(
      ({ name, value }) =>
        `export ${name}=${shellQuote(value)}\nunset ${name}_FILE\n`,
    )
    .join("");
}
