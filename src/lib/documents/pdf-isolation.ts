/**
 * Runs pdf.js in a child process with a memory ceiling and a time limit.
 *
 * A PDF's cost is set by whoever wrote it. A 400 KB file can declare an image
 * of twenty thousand pixels square, and pdf.js allocated about 7 GB decoding
 * it; a content stream can keep the parser busy for minutes. Inside the
 * server either one took the web process, every user's requests and the
 * background jobs down with it, and the job queue then retried the same
 * document after the restart. pdf.js' own `maxImageSize` stops the first
 * shape (see `./pdf-engine.mjs`), but an image mask, a font program or a
 * shading can still allocate in proportion to what the file declares. So the
 * reading itself happens in `./pdf-child.mjs`, one process per document:
 *
 *   - the child's V8 heap is capped with `--max-old-space-size`;
 *   - its resident memory, which also counts the image buffers outside the
 *     heap, is sampled from here and the child is killed past the ceiling;
 *   - on Linux the child marks itself as the first thing the kernel's
 *     out-of-memory killer takes, for an allocation faster than the sampling;
 *   - it is killed when the time limit runs out;
 *   - it starts with an almost empty environment, so it holds no key, token
 *     or database address;
 *   - one runs at a time (`MAX_PARALLEL_CHILDREN`), so a burst of uploads
 *     cannot multiply the ceiling.
 *
 * A document that crosses a bound fails with `limit` and is not something a
 * retry will fix; callers record it as a final failure.
 *
 * This module logs nothing and imports nothing from the app, so the
 * end-to-end suite can read report text through `./pdfjs.ts` as well.
 */
import { execFile, fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RenderOptions, RenderedDocument } from "./pdf-engine.mjs";

/** Resident memory a child may reach before it is killed. */
export const PDF_CHILD_MEMORY_MB = 640;

/** The child's V8 heap; the rest of the ceiling is image and canvas buffers. */
const PDF_CHILD_HEAP_MB = 256;

/**
 * Children running at once in this process. One: the server and one child at
 * its ceiling fit the default container limit; two would not.
 */
export const MAX_PARALLEL_CHILDREN = 1;

/** How often the child's resident memory is read. */
const SAMPLE_INTERVAL_MS = 50;

/**
 * Where the child script lives, relative to the working directory: the
 * checkout root in development and the suites, `/app` in the image (traced in
 * by `outputFileTracingIncludes` in `next.config.ts`). The bundler is told
 * not to follow it: tracing `process.cwd()` pulls the whole checkout into
 * the standalone output.
 */
const CHILD_PATH = ["src", "lib", "documents", "pdf-child.mjs"];

export type PdfChildRequest =
  | { op: "text"; data: Uint8Array; maxPages: number }
  | { op: "render"; data: Uint8Array; options: RenderOptions };

type PdfChildValue<R extends PdfChildRequest> = R extends { op: "text" }
  ? string
  : RenderedDocument;

/** Why a child gave no result. */
export type PdfChildFailure =
  /** The document crossed the memory ceiling or the time limit. */
  | { ok: false; reason: "limit"; limit: "memory" | "time" | "exit" }
  /** pdf.js refused the document: malformed, encrypted, unreadable. */
  | { ok: false; reason: "error"; name: string; message: string };

export type PdfChildResult<R extends PdfChildRequest> =
  { ok: true; value: PdfChildValue<R> } | PdfChildFailure;

export interface PdfChildLimits {
  timeoutMs: number;
  /** Overrides `PDF_CHILD_MEMORY_MB`; the suites use a small one. */
  memoryMb?: number;
}

// ── Concurrency ────────────────────────────────────────────────────────────

let running = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (running < MAX_PARALLEL_CHILDREN) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

// ── Resident memory of another process ─────────────────────────────────────

/** The child's resident set in MB, or null where it cannot be read. */
async function residentMb(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      return kb ? Number(kb) / 1024 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("ps", ["-o", "rss=", "-p", String(pid)], (err, stdout) => {
        const kb = Number(stdout.trim());
        resolve(err || !Number.isFinite(kb) || kb <= 0 ? null : kb / 1024);
      });
    });
  }
  return null;
}

// ── One run ────────────────────────────────────────────────────────────────

interface ChildReply {
  ok: boolean;
  text?: string;
  document?: RenderedDocument;
  error?: { name: string; message: string };
}

function decodeDocument(document: RenderedDocument): RenderedDocument {
  // Buffers arrive as plain Uint8Arrays over the channel.
  return {
    ...document,
    pages: document.pages.map((page) => ({
      ...page,
      jpeg: Buffer.from(
        page.jpeg.buffer,
        page.jpeg.byteOffset,
        page.jpeg.byteLength,
      ),
    })),
  };
}

/**
 * Read or render one PDF in a child process. Never throws: a document that
 * crosses a bound answers `limit`, one pdf.js refuses answers `error`.
 */
export async function runPdfChild<R extends PdfChildRequest>(
  request: R,
  limits: PdfChildLimits,
): Promise<PdfChildResult<R>> {
  const script = join(/* turbopackIgnore: true */ process.cwd(), ...CHILD_PATH);
  if (!existsSync(script)) {
    return {
      ok: false,
      reason: "error",
      name: "PdfChildMissing",
      message: "the PDF reader is missing from this build",
    };
  }

  await acquireSlot();
  try {
    return await runOnce(script, request, limits);
  } finally {
    releaseSlot();
  }
}

function runOnce<R extends PdfChildRequest>(
  script: string,
  request: R,
  limits: PdfChildLimits,
): Promise<PdfChildResult<R>> {
  const memoryMb = limits.memoryMb ?? PDF_CHILD_MEMORY_MB;
  const heapMb = Math.min(PDF_CHILD_HEAP_MB, Math.max(32, memoryMb / 2));

  return new Promise((resolve) => {
    let settled = false;
    let killedFor: "memory" | "time" | null = null;
    let stderrTail = "";

    let child: ChildProcess;
    try {
      child = fork(script, [], {
        cwd: /* turbopackIgnore: true */ process.cwd(),
        // Nothing the server holds: no keys, no database address, no tokens.
        env: { NODE_ENV: process.env.NODE_ENV || "production" },
        execArgv: [`--max-old-space-size=${heapMb}`],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    } catch (err) {
      resolve({
        ok: false,
        reason: "error",
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message.slice(0, 300) : "",
      });
      return;
    }

    const finish = (result: PdfChildResult<R>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(sampler);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve(result);
    };

    const kill = (why: "memory" | "time") => {
      if (killedFor) return;
      killedFor = why;
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => kill("time"), limits.timeoutMs);
    let sampling = false;
    const sampler = setInterval(() => {
      if (sampling || child.pid === undefined) return;
      sampling = true;
      void residentMb(child.pid).then((mb) => {
        sampling = false;
        if (mb !== null && mb > memoryMb) kill("memory");
      });
    }, SAMPLE_INTERVAL_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    child.on("message", (raw) => {
      const reply = raw as ChildReply;
      if (reply.ok) {
        const value =
          request.op === "text"
            ? reply.text
            : decodeDocument(reply.document as RenderedDocument);
        finish({ ok: true, value: value as PdfChildValue<R> });
      } else {
        finish({
          ok: false,
          reason: "error",
          name: reply.error?.name ?? "Error",
          message: reply.error?.message ?? "",
        });
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        reason: "error",
        name: err.name,
        message: err.message.slice(0, 300),
      });
    });

    child.on("close", () => {
      if (killedFor) {
        finish({ ok: false, reason: "limit", limit: killedFor });
        return;
      }
      // Gone without an answer: V8 hit its heap ceiling, the kernel took it
      // for memory, or it crashed in native code. Any of them is the
      // document's doing.
      const heap = /heap limit|heap out of memory/i.test(stderrTail);
      finish({ ok: false, reason: "limit", limit: heap ? "memory" : "exit" });
    });

    child.send(request, (err) => {
      if (err) {
        finish({
          ok: false,
          reason: "error",
          name: err.name,
          message: err.message.slice(0, 300),
        });
      }
    });
  });
}
