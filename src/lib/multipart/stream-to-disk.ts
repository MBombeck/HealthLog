/**
 * Stream a `multipart/form-data` body to disk without buffering the
 * whole payload in memory.
 *
 * Next.js 16's `request.formData()` is fine up to ~10 MB but allocates
 * the full body on a 1 GB upload. The Apple Health export ingest
 * therefore reads `request.body` directly (a `ReadableStream<Uint8Array>`
 * per Web Streams) and walks the multipart boundary by hand.
 *
 * Only the named `file` field of the upload is captured to disk; any
 * other part is kept in memory as a text field, under a small ceiling
 * of its own. Every byte read counts against the file cap plus a fixed
 * envelope, and a part's header block has a ceiling too, so nothing in
 * the body is held without a bound. The captured field's bytes are written to a temp file and
 * a SHA-256 digest is computed in the same pass — the digest powers
 * the content-hash idempotency check in the kick-off endpoint.
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §5.4.
 */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

export interface MultipartFileResult {
  /** Absolute path the captured file landed at. */
  filePath: string;
  /** Total bytes streamed. */
  bytes: number;
  /** SHA-256 hex digest of the captured bytes. */
  sha256: string;
  /** Optional original filename pulled from `Content-Disposition`. */
  originalFilename: string | null;
  /** Other named text fields encountered in the multipart body. */
  textFields: Record<string, string>;
}

export interface MultipartStreamOptions {
  /** Maximum allowed file size in bytes (hard cap; throws on overflow). */
  maxBytes: number;
  /** Required multipart field name to capture. */
  fieldName: string;
  /** Temp directory; defaults to OS temp dir. */
  tmpDir?: string;
  /** Optional filename prefix; defaults to `healthlog-upload`. */
  tmpPrefix?: string;
}

/** The captured file passed `maxBytes`; the upload is refused as too large. */
export class MultipartTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Upload exceeds size cap of ${maxBytes} bytes`);
    this.name = "MultipartTooLargeError";
  }
}

/**
 * What a body may carry beyond the file itself: boundaries, part headers and
 * the small text fields. Every byte read from the stream counts against
 * `maxBytes` plus this, so a body without a Content-Length (chunked) is held
 * to the same ceiling as one that declares it.
 */
export const MULTIPART_ENVELOPE_RESERVE_BYTES = 64 * 1024;
/** One part's header block. */
export const MULTIPART_MAX_HEADER_BYTES = 16 * 1024;
/** All text parts together; they are held in memory, unlike the file. */
export const MULTIPART_MAX_TEXT_BYTES = 32 * 1024;

const CRLF = Buffer.from("\r\n");
const DOUBLE_CRLF = Buffer.from("\r\n\r\n");

/**
 * A reader over `body` that refuses once more than the file cap plus the
 * envelope has been read, whatever part the bytes belong to.
 */
function cappedReader(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  let read = 0;
  return {
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      const next = await reader.read();
      read += next.value?.length ?? 0;
      if (read > maxBytes + MULTIPART_ENVELOPE_RESERVE_BYTES) {
        throw new MultipartTooLargeError(maxBytes);
      }
      return next;
    },
    cancel: () => reader.cancel(),
  };
}

/** Where a part's header block ends, or -1 while it may still come. */
function headerBlockEnd(buffer: Buffer): number {
  const eoh = buffer.indexOf(DOUBLE_CRLF);
  if ((eoh === -1 ? buffer.length : eoh) > MULTIPART_MAX_HEADER_BYTES) {
    throw new Error("Multipart part headers too large");
  }
  return eoh;
}

/**
 * The text parts' bytes. They are held in memory, unlike the file, so all of
 * them together share a small ceiling.
 */
class TextParts {
  private bytes = 0;
  private parts: Buffer[] = [];

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > MULTIPART_MAX_TEXT_BYTES) {
      throw new MultipartTooLargeError(this.maxBytes);
    }
    this.parts.push(chunk);
  }

  /** The current part's text; the next part starts empty. */
  take(): string {
    const text = Buffer.concat(this.parts).toString("utf8");
    this.parts = [];
    return text;
  }

  reset(): void {
    this.parts = [];
  }
}

/**
 * Parse the multipart boundary from a `Content-Type` header. Returns
 * `null` if the header is missing or unparseable.
 */
export function parseBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;,\s]+))/i);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/**
 * Stream a multipart body from `req.body` to disk, returning the
 * captured file's path + a SHA-256 digest. Throws on:
 *   - Missing / unparseable boundary.
 *   - Missing required field.
 *   - Size cap exceeded.
 */
export async function streamMultipartToDisk(
  body: ReadableStream<Uint8Array>,
  contentType: string | null,
  opts: MultipartStreamOptions,
): Promise<MultipartFileResult> {
  const boundary = parseBoundary(contentType);
  if (!boundary) {
    throw new Error("Multipart body missing boundary parameter");
  }
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const tmpDirectory = opts.tmpDir ?? tmpdir();
  const filePath = join(
    tmpDirectory,
    `${opts.tmpPrefix ?? "healthlog-upload"}-${randomUUID()}.bin`,
  );

  const hash = createHash("sha256");
  let bytesWritten = 0;
  let originalFilename: string | null = null;
  const textFields: Record<string, string> = {};

  // Lazily created sink — opens once we have entered the matching part.
  let fileSink: Writable | null = null;
  let fileSinkOpen = false;

  const ensureFileSink = (): Writable => {
    if (!fileSink) {
      fileSink = createWriteStream(filePath);
      fileSinkOpen = true;
    }
    return fileSink;
  };

  // Buffer holding bytes awaiting boundary scan. Capped at twice the
  // boundary length so we never accumulate more than necessary.
  let buffer = Buffer.alloc(0);
  // Current parser state:
  //   "preamble"       — before the first boundary marker
  //   "after-boundary" — a boundary marker was just consumed; awaiting
  //                      its two-byte suffix ("\r\n" for another part or
  //                      "--" for the closing boundary)
  //   "headers"        — inside a part's header block
  //   "body-file"      — inside the captured file's body
  //   "body-text"      — inside a text field's body
  //   "epilogue"       — after the closing boundary
  type ParserState =
    | "preamble"
    | "after-boundary"
    | "headers"
    | "body-file"
    | "body-text"
    | "epilogue";
  let state: ParserState = "preamble";
  let currentFieldName: string | null = null;
  const text = new TextParts(opts.maxBytes);

  const writeFileChunk = (chunk: Buffer): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (bytesWritten + chunk.length > opts.maxBytes) {
        reject(new MultipartTooLargeError(opts.maxBytes));
        return;
      }
      bytesWritten += chunk.length;
      hash.update(chunk);
      const sink = ensureFileSink();
      sink.write(chunk, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  const closeFileSink = (): Promise<void> => {
    return new Promise((resolve) => {
      if (!fileSink || !fileSinkOpen) {
        resolve();
        return;
      }
      fileSinkOpen = false;
      fileSink.end(() => resolve());
    });
  };

  const reader = cappedReader(body, opts.maxBytes);
  let streamDone = false;

  // The classic SAX-style boundary scanner: accumulate into `buffer`,
  // search for the boundary marker, emit bytes up to it.
  const processBuffer = async (): Promise<void> => {
    while (true) {
      if (state === "epilogue") {
        // Everything after the closing boundary is discarded.
        buffer = Buffer.alloc(0);
        return;
      }

      if (state === "preamble") {
        const idx = buffer.indexOf(boundaryMarker);
        if (idx === -1) {
          // Need more bytes to find a boundary; retain a tail of
          // `boundaryMarker.length - 1` bytes so a marker split across
          // chunks is still detectable on the next read. Retaining the
          // full marker length could drop a byte that completes the
          // marker, so keep one fewer.
          const keep = Math.min(buffer.length, boundaryMarker.length - 1);
          if (buffer.length > keep) {
            buffer = buffer.slice(buffer.length - keep);
          }
          return;
        }
        // Drop everything up to and including the boundary marker and
        // hand off to "after-boundary" to classify the two-byte suffix.
        // Doing this in its own state means a chunk boundary landing
        // immediately after the marker cannot reset us into a fresh
        // marker search (which would silently swallow the part body).
        buffer = buffer.slice(idx + boundaryMarker.length);
        state = "after-boundary";
        continue;
      }

      if (state === "after-boundary") {
        // A boundary marker was just consumed. Wait until we have the
        // two-byte suffix before deciding: "\r\n" introduces another
        // part, "--" closes the multipart body. Never search for a new
        // marker here — that is the bug class this state exists to
        // prevent.
        if (buffer.length < 2) return;
        if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
          state = "epilogue";
          return;
        }
        if (buffer[0] === 0x0d && buffer[1] === 0x0a) {
          buffer = buffer.slice(2);
          state = "headers";
          continue;
        }
        // RFC 2046 allows linear whitespace ("transport padding")
        // between the marker and its CRLF. Skip a leading run of SP/HT
        // and re-test; if neither suffix is present yet, the chunk is
        // malformed.
        if (buffer[0] === 0x20 || buffer[0] === 0x09) {
          let i = 0;
          while (
            i < buffer.length &&
            (buffer[i] === 0x20 || buffer[i] === 0x09)
          ) {
            i++;
          }
          if (i >= buffer.length) return; // need more bytes
          buffer = buffer.slice(i);
          continue;
        }
        throw new Error("Malformed multipart boundary suffix");
      }

      if (state === "headers") {
        const eoh = headerBlockEnd(buffer);
        if (eoh === -1) return;
        const headerBlock = buffer.slice(0, eoh).toString("utf8");
        buffer = buffer.slice(eoh + DOUBLE_CRLF.length);

        const disposition = headerBlock
          .split(/\r?\n/)
          .find((l) => l.toLowerCase().startsWith("content-disposition:"));
        if (!disposition) {
          // Unparseable part — skip until next boundary as text.
          state = "body-text";
          currentFieldName = null;
          continue;
        }
        const nameMatch = disposition.match(/name="([^"]+)"/i);
        const filenameMatch = disposition.match(/filename="([^"]*)"/i);
        currentFieldName = nameMatch?.[1] ?? null;
        if (currentFieldName === opts.fieldName) {
          state = "body-file";
          originalFilename = filenameMatch?.[1] ?? null;
        } else {
          state = "body-text";
          text.reset();
        }
        continue;
      }

      // body-file / body-text: emit bytes up to the next CRLF--boundary.
      const sep = Buffer.concat([CRLF, boundaryMarker]);
      const idx = buffer.indexOf(sep);
      if (idx === -1) {
        // Emit everything except a trailing slice that might contain
        // the start of the next boundary marker.
        const keep = Math.min(buffer.length, sep.length - 1);
        const emit = buffer.slice(0, buffer.length - keep);
        if (emit.length > 0) {
          if (state === "body-file") {
            await writeFileChunk(emit);
          } else {
            text.push(emit);
          }
        }
        buffer = buffer.slice(buffer.length - keep);
        return;
      }

      const emit = buffer.slice(0, idx);
      if (emit.length > 0) {
        if (state === "body-file") {
          await writeFileChunk(emit);
        } else {
          text.push(emit);
        }
      }
      // Finalise the text field if applicable.
      if (state === "body-text" && currentFieldName) {
        textFields[currentFieldName] = text.take();
      }
      if (state === "body-file") {
        await closeFileSink();
      }
      buffer = buffer.slice(idx + sep.length);
      // The boundary marker is consumed; classify its two-byte suffix
      // in "after-boundary" so a chunk split landing right here cannot
      // lose the next part.
      state = "after-boundary";
    }
  };

  try {
    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      await processBuffer();
    }
    await processBuffer();
    await closeFileSink();

    if (bytesWritten === 0) {
      throw new Error(
        `Multipart body did not include a '${opts.fieldName}' file field`,
      );
    }
  } catch (err) {
    // Whatever was written so far is the user's plaintext health export,
    // and it must not outlive a refused upload in the shared temp
    // directory: the size cap, a malformed body and a dropped connection
    // all end here. The reader is cancelled so the rest of the body is not
    // read for nothing.
    await reader.cancel().catch(() => {});
    const sink = fileSink as Writable | null;
    if (sink && !sink.closed) {
      fileSinkOpen = false;
      await new Promise<void>((resolve) => {
        sink.once("close", () => resolve());
        sink.destroy();
      });
    }
    await rm(filePath, { force: true }).catch(() => {});
    throw err;
  }

  return {
    filePath,
    bytes: bytesWritten,
    sha256: hash.digest("hex"),
    originalFilename,
    textFields,
  };
}
