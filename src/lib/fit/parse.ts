/**
 * Decode an activity FIT file: the structural scan first (`./scan.ts`), then
 * `fit-file-parser` in strict-checksum mode on exactly the bytes the scan
 * framed, in a child process with a heap ceiling and a time limit.
 *
 * The scan bounds what the decoder is asked to build, but the decoder builds
 * a JS object per field, and the pg-boss worker that runs an import shares
 * its process with the web server. So the decode runs in a process of its
 * own: its old-generation heap is capped (`--max-old-space-size`), it is
 * killed when the time limit runs out, and it starts with an empty
 * environment. A file that crosses either bound costs that process and is
 * refused as `too_complex`; the server keeps running.
 *
 * A process, not a worker thread: a worker's `resourceLimits` lose to a
 * process-wide `--max-old-space-size`, and an operator who raises the
 * server's heap through `NODE_OPTIONS` (as the scaling guide describes) set
 * exactly that, so the thread ran on the server's limit instead of its own.
 * The child gets its ceiling on its own command line and no `NODE_OPTIONS`.
 *
 * `force: false` is not optional. The library defaults to `force: true`,
 * which skips the CRC check and recovers what it can from a damaged file;
 * the scan has already verified both checksums, and the decoder is told to
 * verify them again so a future change to the scan cannot quietly let a
 * damaged file through.
 *
 * The decoder's output is untrusted: its object keys include developer field
 * names taken from the file. Nothing reads it except `./map.ts`, which takes
 * named fields one by one through own-property checks and never spreads it.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

import FitParser from "fit-file-parser";

import { FitImportError } from "./errors";
import { scanFitFile, type FitScan } from "./scan";

/** The decoded file, kept opaque: only `./map.ts` reads into it. */
export type DecodedFit = Readonly<Record<string, unknown>>;

/** The decoder process's old-generation heap. */
export const FIT_DECODE_HEAP_MB = 192;
/** How long a decode may run before its process is killed. */
export const FIT_DECODE_TIMEOUT_MS = 30_000;

const PARSER_OPTIONS = {
  force: false,
  mode: "list",
  speedUnit: "m/s",
  lengthUnit: "m",
  temperatureUnit: "celsius",
} as const;

/**
 * The child's whole program. It waits for one message, imports the decoder
 * by file URL, decodes the bytes it was handed and sends the result back. A
 * rejection is reduced to whether it was a checksum: its text may quote the
 * file.
 */
const CHILD_SOURCE = `
process.once("message", (job) => {
  const reply = (msg) => process.send(msg, () => process.exit(0));
  import(job.parserUrl).then(async (mod) => {
    const FitParser = mod.default;
    const parser = new FitParser(job.options);
    try {
      reply({ ok: true, decoded: await parser.parseAsync(Buffer.from(job.bytes)) });
    } catch (err) {
      reply({ ok: false, crc: typeof err === "string" && /crc/i.test(err) });
    }
  }, () => reply({ ok: false, crc: false, load: true }));
});
`;

// The decoder never runs in this process. The import keeps it in the server's
// file trace as an external package, under the `.next/node_modules` alias the
// Dockerfile asserts and the child loads it from (`resolveParserUrl`).
void FitParser;

let parserUrl: string | null = null;

/**
 * The decoder's ES module entry, by path. In the image the tracer ships it
 * as a hashed alias under `.next/node_modules` (the Dockerfile asserts that
 * path); in a checkout it is the installed package.
 */
function resolveParserUrl(): string {
  if (parserUrl) return parserUrl;
  const aliasRoot = join(process.cwd(), ".next", "node_modules");
  let entry: string | null = null;
  try {
    const alias = readdirSync(aliasRoot).find((name) =>
      name.startsWith("fit-file-parser-"),
    );
    if (alias) entry = join(aliasRoot, alias, "dist", "fit-parser.js");
  } catch {
    // No build output here: a checkout, the suites.
  }
  if (!entry) {
    const requireFromRoot = createRequire(join(process.cwd(), "package.json"));
    // The package's `require` entry is `dist/cjs/fit-parser.js`; its ES
    // module build sits one directory up.
    const cjs = requireFromRoot.resolve("fit-file-parser");
    entry = join(dirname(dirname(cjs)), "fit-parser.js");
  }
  parserUrl = pathToFileURL(entry).href;
  return parserUrl;
}

export interface FitDecodeLimits {
  /** Old-generation heap of the decoder process, in MB. */
  maxOldGenerationSizeMb?: number;
  /** Wall-clock limit of the decode, in milliseconds. */
  timeoutMs?: number;
}

function tooComplex(what: string): FitImportError {
  return new FitImportError("too_complex", what);
}

export async function decodeFitFile(
  bytes: Buffer,
  limits: FitDecodeLimits = {},
): Promise<{ decoded: DecodedFit; scan: FitScan }> {
  const scan = scanFitFile(bytes);
  const framed = Uint8Array.from(bytes.subarray(0, scan.fileLength));
  const decoded = await new Promise<DecodedFit>((resolve, reject) => {
    let settled = false;
    const heapMb = limits.maxOldGenerationSizeMb ?? FIT_DECODE_HEAP_MB;
    const child: ChildProcess = spawn(
      process.execPath,
      [`--max-old-space-size=${heapMb}`, "-e", CHILD_SOURCE],
      {
        // No NODE_OPTIONS, so nothing can raise the ceiling, and no keys,
        // database address or tokens of the server: only NODE_ENV, as the
        // PDF reader's child.
        env: { NODE_ENV: process.env.NODE_ENV },
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(
      () => settle(() => reject(tooComplex("the decoder ran out of its time"))),
      limits.timeoutMs ?? FIT_DECODE_TIMEOUT_MS,
    );
    child.on(
      "message",
      (msg: { ok: boolean; decoded?: DecodedFit; crc?: boolean }) =>
        settle(() => {
          if (msg.ok) resolve(msg.decoded ?? {});
          else if (msg.crc) {
            reject(new FitImportError("crc_mismatch", "checksum"));
          } else {
            reject(
              new FitImportError("malformed", "the decoder refused the file"),
            );
          }
        }),
    );
    // A heap past its ceiling ends the process with a fatal out-of-memory
    // error; anything else that ends it without an answer, or keeps it from
    // starting, is treated the same way: the file asked for more than the
    // decoder may spend.
    child.on("error", () =>
      settle(() => reject(tooComplex("the decoder ran out of its memory"))),
    );
    child.on("exit", () =>
      settle(() => reject(tooComplex("the decoder stopped without an answer"))),
    );
    child.send(
      { parserUrl: resolveParserUrl(), options: PARSER_OPTIONS, bytes: framed },
      (err: Error | null) => {
        if (err) {
          settle(() => reject(tooComplex("the decoder could not be started")));
        }
      },
    );
  });
  return { decoded, scan };
}
