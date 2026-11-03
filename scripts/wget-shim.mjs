// @ts-check
/**
 * `wget` in the image (`/usr/local/bin/wget` runs this file): enough of wget
 * for a container health check, and nothing more.
 *
 * The runtime base has no wget, but health checks written outside the image
 * call it: compose files copied from this repository up to v1.46.6 run
 * `wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health`,
 * and the TrueNAS catalog app renders `wget --quiet --spider <url>`. Such a
 * check replaces the image's own HEALTHCHECK, so without a `wget` the
 * container would never turn healthy. The image's HEALTHCHECK and the
 * bundled compose file use a `node -e` fetch instead; this file exists only
 * for those external callers.
 *
 * Understood: the URL, `--spider`, `-q`/`--quiet`, `-nv`/`--no-verbose`,
 * `-t N`/`--tries=N`, `-T N`/`--timeout=N`, `-O -` and `-O /dev/null`
 * (also `-O-`, `--output-document=…`), `-S`/`--server-response`. Any other
 * flag is ignored. It is not a download tool: it writes a body only to
 * standard output (`-O -`), refuses any other `-O` target before sending a
 * request, never follows a redirect, and speaks plain http/https only.
 *
 * Exit 0 on a 2xx or 3xx answer, 1 on any other status, a refused or
 * failed connection, or the timeout, and 2 on a command line it will not
 * run. Without `-T` a request gives up after 30 s; Docker's own health
 * check timeout usually ends it sooner.
 */

import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_SECONDS = 30;

/** Flags whose value may follow as the next argument. */
const VALUE_FLAGS = new Set(["-O", "-T", "-t", "-o", "-U", "-P", "--header"]);

/**
 * @param {string[]} argv
 * @returns {{ url: string | null; spider: boolean; quiet: boolean;
 *   verbose: boolean; tries: number; timeout: number; output: string | null;
 *   serverResponse: boolean }}
 */
function parseArgs(argv) {
  const opts = {
    url: /** @type {string | null} */ (null),
    spider: false,
    quiet: false,
    verbose: true,
    tries: 1,
    timeout: DEFAULT_TIMEOUT_SECONDS,
    output: /** @type {string | null} */ (null),
    serverResponse: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    /** @param {string} name */
    const inline = (name) =>
      arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : null;
    /** The value of a short flag, attached (`-T4`) or as the next argument. */
    const shortValue = () => {
      if (arg.length > 2) return arg.slice(2).replace(/^=/, "");
      i += 1;
      return argv[i] ?? "";
    };
    if (/^https?:\/\//i.test(arg)) {
      opts.url ??= arg;
    } else if (arg === "--spider") {
      opts.spider = true;
    } else if (arg === "-q" || arg === "--quiet") {
      opts.quiet = true;
    } else if (arg === "-nv" || arg === "--no-verbose") {
      opts.verbose = false;
    } else if (arg === "-S" || arg === "--server-response") {
      opts.serverResponse = true;
    } else if (arg.startsWith("--tries=")) {
      opts.tries = count(inline("--tries"), 1);
    } else if (arg.startsWith("-t")) {
      opts.tries = count(shortValue(), 1);
    } else if (arg.startsWith("--timeout=")) {
      opts.timeout = count(inline("--timeout"), DEFAULT_TIMEOUT_SECONDS);
    } else if (arg.startsWith("-T")) {
      opts.timeout = count(shortValue(), DEFAULT_TIMEOUT_SECONDS);
    } else if (arg.startsWith("--output-document=")) {
      opts.output = inline("--output-document");
    } else if (arg.startsWith("-O")) {
      opts.output = shortValue();
    } else if (VALUE_FLAGS.has(arg)) {
      // A flag this shim ignores, with its value as the next argument.
      i += 1;
    } else if (/^-q[a-zA-Z]*O/.test(arg)) {
      // `-qO-` / `-qO /dev/null`: quiet plus an output target, bundled.
      opts.quiet = true;
      const rest = arg.slice(arg.indexOf("O") + 1);
      opts.output = rest || (argv[++i] ?? "");
    }
    // Anything else is ignored.
  }
  // wget treats 0 tries as "retry forever"; a health check must not.
  if (opts.tries < 1) opts.tries = 1;
  return opts;
}

/**
 * @param {string | null} value
 * @param {number} fallback
 */
function count(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** @param {string} message @param {boolean} quiet */
function say(message, quiet) {
  if (!quiet) process.stderr.write(`wget: ${message}\n`);
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
async function run(argv) {
  const opts = parseArgs(argv);
  if (!opts.url) {
    process.stderr.write("wget: missing URL (health check shim)\n");
    return 2;
  }
  const toStdout = opts.output === "-";
  if (opts.output !== null && !toStdout && opts.output !== "/dev/null") {
    process.stderr.write(
      `wget: refusing to write ${opts.output}: this image's wget is a health check shim (-O - and -O /dev/null only)\n`,
    );
    return 2;
  }
  let lastError = "";
  for (let attempt = 1; attempt <= opts.tries; attempt += 1) {
    try {
      const response = await fetch(opts.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(opts.timeout, 0.001) * 1000),
      });
      if (opts.serverResponse) {
        process.stderr.write(
          `  HTTP/1.1 ${response.status} ${response.statusText}\n`,
        );
        for (const [name, value] of response.headers) {
          process.stderr.write(`  ${name}: ${value}\n`);
        }
      }
      if (toStdout && !opts.spider && response.body) {
        for await (const chunk of response.body) process.stdout.write(chunk);
      } else {
        await response.body?.cancel();
      }
      const ok = response.status >= 200 && response.status < 400;
      if (ok) {
        if (opts.verbose) say(`${opts.url}: ${response.status}`, opts.quiet);
        return 0;
      }
      say(`server returned error: HTTP ${response.status}`, opts.quiet);
      return 1;
    } catch (err) {
      lastError =
        err instanceof Error && err.name === "TimeoutError"
          ? "download timed out"
          : err instanceof Error
            ? err.cause instanceof Error
              ? err.cause.message
              : err.message
            : String(err);
    }
  }
  say(`${opts.url}: ${lastError}`, opts.quiet);
  return 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
