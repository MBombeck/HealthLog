/**
 * Decode an activity FIT file: the structural scan first (`./scan.ts`), then
 * `fit-file-parser` in strict-checksum mode on exactly the bytes the scan
 * framed, in a worker thread with a heap ceiling and a time limit.
 *
 * The scan bounds what the decoder is asked to build, but the decoder builds
 * a JS object per field, and the pg-boss worker that runs an import shares
 * its process with the web server. So the decode runs in a thread of its own:
 * its old-generation heap is capped (`resourceLimits`), it is terminated when
 * the time limit runs out, and it starts with an empty environment. A file
 * that crosses either bound costs that thread and is refused as
 * `too_complex`; the server keeps running.
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
import { Worker } from "node:worker_threads";

import FitParser from "fit-file-parser";

import { FitImportError } from "./errors";
import { scanFitFile, type FitScan } from "./scan";

/** The decoded file, kept opaque: only `./map.ts` reads into it. */
export type DecodedFit = Readonly<Record<string, unknown>>;

/** The decoder thread's old-generation heap. */
export const FIT_DECODE_HEAP_MB = 192;
/** How long a decode may run before its thread is terminated. */
export const FIT_DECODE_TIMEOUT_MS = 30_000;

const PARSER_OPTIONS = {
  force: false,
  mode: "list",
  speedUnit: "m/s",
  lengthUnit: "m",
  temperatureUnit: "celsius",
} as const;

/**
 * The thread's whole program. It imports the decoder by file URL, decodes
 * the bytes it was handed and posts the result back. A rejection is reduced
 * to whether it was a checksum: its text may quote the file.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.parserUrl).then(async (mod) => {
  const FitParser = mod.default;
  const parser = new FitParser(workerData.options);
  try {
    const decoded = await parser.parseAsync(Buffer.from(workerData.bytes));
    parentPort.postMessage({ ok: true, decoded });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      crc: typeof err === "string" && /crc/i.test(err),
    });
  }
}, () => parentPort.postMessage({ ok: false, crc: false, load: true }));
`;

// The decoder never runs in this thread. The import keeps it in the server's
// file trace as an external package, under the `.next/node_modules` alias the
// Dockerfile asserts and the worker loads it from (`resolveParserUrl`).
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
  /** Old-generation heap of the decoder thread, in MB. */
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
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      env: {},
      workerData: {
        parserUrl: resolveParserUrl(),
        options: PARSER_OPTIONS,
        bytes: framed,
      },
      transferList: [framed.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb:
          limits.maxOldGenerationSizeMb ?? FIT_DECODE_HEAP_MB,
      },
    });
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => settle(() => reject(tooComplex("the decoder ran out of its time"))),
      limits.timeoutMs ?? FIT_DECODE_TIMEOUT_MS,
    );
    worker.on(
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
    // A heap past its ceiling ends the thread with ERR_WORKER_OUT_OF_MEMORY;
    // anything else that ends it without an answer is treated the same way:
    // the file asked for more than the decoder may spend.
    worker.on("error", () =>
      settle(() => reject(tooComplex("the decoder ran out of its memory"))),
    );
    worker.on("exit", () =>
      settle(() => reject(tooComplex("the decoder stopped without an answer"))),
    );
  });
  return { decoded, scan };
}
