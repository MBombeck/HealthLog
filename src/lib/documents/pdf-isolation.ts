/**
 * Runs pdf.js, and the image decoder behind the vault's thumbnails, in a child
 * process with a memory ceiling and a time limit.
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
 *     cannot multiply the ceiling. Who runs next is decided by
 *     `./reader-queue.ts`: a read a person is waiting on before background
 *     work, accounts in turn, a few waiting items per account, and a
 *     deadline after which a waiting item is answered `busy`.
 *
 * A document that crosses a bound this module measured (the sampled memory,
 * the time limit, or the child's own heap cap) fails with `limit` and is not
 * something a retry will fix; callers record it as a final failure. A child
 * that is gone without an answer and without a measured cause is not that:
 * the kernel may have taken it because the container as a whole ran short,
 * the server's own memory included. It is run once more, and a second such
 * exit answers `interrupted`, which callers treat as retryable.
 *
 * This module logs nothing and imports nothing from the app, so the
 * end-to-end suite can read report text through `./pdfjs.ts` as well.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ImageThumbnailOptions,
  ImageThumbnailOutcome,
} from "./image-engine.mjs";
import type { RenderOptions, RenderedDocument } from "./pdf-engine.mjs";
import { createReaderQueue, type ReaderLane } from "./reader-queue";

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
  | { op: "render"; data: Uint8Array; options: RenderOptions }
  | { op: "image-thumbnail"; data: Uint8Array; options: ImageThumbnailOptions };

type PdfChildValue<R extends PdfChildRequest> = R extends { op: "text" }
  ? string
  : R extends { op: "render" }
    ? RenderedDocument
    : ImageThumbnailOutcome;

/** Why a child gave no result. */
export type PdfChildFailure =
  /** The document crossed the memory ceiling or the time limit. */
  | { ok: false; reason: "limit"; limit: "memory" | "time" }
  /** pdf.js or the decoder refused the input: malformed, encrypted, unreadable. */
  | { ok: false; reason: "error"; name: string; message: string }
  /**
   * The child ended without an answer and without a cause this module
   * measured, twice. Not the document's verdict; try again later.
   */
  | { ok: false; reason: "interrupted" }
  /**
   * The reader was taken for longer than the wait this work may spend, or
   * this account already has as much waiting as it may. Try again later.
   */
  | { ok: false; reason: "busy"; retryAfterMs: number };

export type PdfChildResult<R extends PdfChildRequest> =
  { ok: true; value: PdfChildValue<R> } | PdfChildFailure;

export interface PdfChildLimits {
  timeoutMs: number;
  /** Overrides `PDF_CHILD_MEMORY_MB`; the suites use a small one. */
  memoryMb?: number;
  /** Replaces the child start; the suites use it to stand in for a child. */
  run?: (
    script: string,
    request: PdfChildRequest,
    limits: PdfChildLimits,
  ) => Promise<PdfChildResult<PdfChildRequest>>;
}

// ── Who runs next ──────────────────────────────────────────────────────────

/** Items one account may have waiting for the reader, across both lanes. */
export const MAX_QUEUED_PER_OWNER = 4;

/**
 * How long an item may wait for the reader. A person waiting on a read gets
 * an answer within a minute; background work can wait longer, and its job is
 * retried when it does not get a turn.
 */
export const READER_WAIT_MS: Record<ReaderLane, number> = {
  interactive: 60_000,
  background: 5 * 60_000,
};

const queue = createReaderQueue({
  slots: MAX_PARALLEL_CHILDREN,
  maxQueuedPerOwner: MAX_QUEUED_PER_OWNER,
  waitMs: READER_WAIT_MS,
});

/** Whose work this is and whether a person is waiting on it. */
export interface PdfWork {
  /** The account the work is done for; the queue takes accounts in turn. */
  owner: string;
  lane: ReaderLane;
  /**
   * Moves the caller's own clock by `ms`. A background AI run has a deadline
   * measured in model calls, and time spent waiting for the reader or
   * reading is not model time: when the slot is granted the clock moves by
   * the wait plus the most the read may take, and when the read ends it moves
   * back by the part of that allowance the read did not use. So the run's
   * model-time budget starts once the reader is done with it, however long
   * the queue was. Failures are the caller's to swallow; the read goes on.
   */
  extendDeadline?: (ms: number) => Promise<void>;
}

const workContext = new AsyncLocalStorage<PdfWork>();

/**
 * Run `fn` with every reader call inside it counted as `work`. The entry
 * points set it: the background AI run worker (interactive) and the document
 * jobs (background). A call outside any of them is background work of an
 * unattributed owner.
 */
export function withPdfWork<T>(
  work: PdfWork,
  fn: () => Promise<T>,
): Promise<T> {
  return workContext.run(work, fn);
}

const UNATTRIBUTED: PdfWork = { owner: "unattributed", lane: "background" };

/** The work the reader would count a call made here as. */
export function currentPdfWork(): PdfWork {
  return workContext.getStore() ?? UNATTRIBUTED;
}

/** How many times a child that vanished without a measured cause is run. */
const MAX_ATTEMPTS = 2;

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
  thumbnail?: ImageThumbnailOutcome;
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

function decodeValue<R extends PdfChildRequest>(
  request: R,
  reply: ChildReply,
): PdfChildValue<R> {
  if (request.op === "text") return reply.text as PdfChildValue<R>;
  if (request.op === "render") {
    return decodeDocument(
      reply.document as RenderedDocument,
    ) as PdfChildValue<R>;
  }
  const thumbnail = reply.thumbnail as ImageThumbnailOutcome;
  return (
    thumbnail.ok
      ? {
          ...thumbnail,
          jpeg: Buffer.from(
            thumbnail.jpeg.buffer,
            thumbnail.jpeg.byteOffset,
            thumbnail.jpeg.byteLength,
          ),
        }
      : thumbnail
  ) as PdfChildValue<R>;
}

/**
 * Read or render one PDF, or decode one image, in a child process. Never
 * throws: a document that crosses a bound answers `limit`, one the reader
 * refuses answers `error`, a reader that is taken answers `busy`, and a
 * child that twice ended for no reason it could see answers `interrupted`.
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

  const work = currentPdfWork();
  const queuedAt = Date.now();
  const ticket = await queue.acquire(work.owner, work.lane);
  if (!ticket.ok) {
    return { ok: false, reason: "busy", retryAfterMs: ticket.retryAfterMs };
  }
  const grantedAt = Date.now();
  // The most this read may take: every attempt to its time limit.
  const allowance = limits.timeoutMs * MAX_ATTEMPTS;
  await moveCallerClock(work, grantedAt - queuedAt + allowance);
  try {
    for (let attempt = 1; ; attempt++) {
      const result = limits.run
        ? ((await limits.run(script, request, limits)) as PdfChildResult<R>)
        : await runOnce(script, request, limits);
      if (result.ok || result.reason !== "interrupted") return result;
      if (attempt >= MAX_ATTEMPTS) return result;
    }
  } finally {
    ticket.release();
    await moveCallerClock(
      work,
      -Math.max(0, allowance - (Date.now() - grantedAt)),
    );
  }
}

async function moveCallerClock(work: PdfWork, ms: number): Promise<void> {
  if (!work.extendDeadline || ms === 0) return;
  try {
    await work.extendDeadline(ms);
  } catch {
    // The caller's clock is the caller's; the read is not failed for it.
  }
}

/** Start one child for `request` and wait for its answer or its end. */
export function runOnce<R extends PdfChildRequest>(
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
        finish({ ok: true, value: decodeValue(request, reply) });
      } else {
        finish({
          ok: false,
          reason: "error",
          name: reply.error?.name ?? "Error",
          message: reply.error?.message ?? "",
        });
      }
    });

    // The process could not be started or signalled. What pdf.js or the
    // decoder thought of the document arrives as a reply, never here.
    child.on("error", () => {
      finish({ ok: false, reason: "interrupted" });
    });

    child.on("close", () => {
      if (killedFor) {
        finish({ ok: false, reason: "limit", limit: killedFor });
        return;
      }
      // Gone without an answer. V8 reaching the heap cap this module gave
      // the child is the document's doing, whatever else the host runs. Any
      // other end (the kernel's out-of-memory killer, which also acts when
      // the server itself grew, a signal from outside, a native crash) says
      // nothing certain about the document, so it is not a final verdict.
      if (/heap limit/i.test(stderrTail)) {
        finish({ ok: false, reason: "limit", limit: "memory" });
        return;
      }
      finish({ ok: false, reason: "interrupted" });
    });

    child.send(request, (err) => {
      // The bytes never reached the child, mostly because it was already
      // gone. That says nothing about the document either: end the child and
      // let its close answer `interrupted`.
      if (err && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    });
  });
}
