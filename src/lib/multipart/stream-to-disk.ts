/**
 * Stream a `multipart/form-data` body to disk without buffering the
 * whole payload in memory.
 *
 * Next.js 16's `request.formData()` is fine up to ~10 MB but allocates
 * the full body on a 1 GB upload. The Apple Health export ingest
 * therefore reads `request.body` directly (a `ReadableStream<Uint8Array>`
 * per Web Streams) and walks the multipart boundary by hand.
 *
 * Only the named `file` field of the upload is captured; any other
 * field-name parts are read and discarded so the stream drains
 * cleanly. The captured field's bytes are written to a temp file and
 * a SHA-256 digest is computed in the same pass — the digest powers
 * the content-hash idempotency check in the kick-off endpoint.
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §5.4.
 */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
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

const CRLF = Buffer.from("\r\n");
const DOUBLE_CRLF = Buffer.from("\r\n\r\n");

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
  //   "preamble"  — before the first boundary
  //   "headers"   — inside a part's header block
  //   "body-file" — inside the captured file's body
  //   "body-text" — inside a text field's body
  //   "epilogue"  — after the closing boundary
  type ParserState = "preamble" | "headers" | "body-file" | "body-text" | "epilogue";
  let state: ParserState = "preamble";
  let currentFieldName: string | null = null;
  let currentTextBuffer: Buffer[] = [];

  const writeFileChunk = (chunk: Buffer): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (bytesWritten + chunk.length > opts.maxBytes) {
        reject(
          new Error(
            `Upload exceeds size cap of ${opts.maxBytes} bytes`,
          ),
        );
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

  const reader = body.getReader();
  let streamDone = false;

  // The classic SAX-style boundary scanner: accumulate into `buffer`,
  // search for the boundary marker, emit bytes up to it.
  const processBuffer = async (): Promise<void> => {
    while (true) {
      if (state === "preamble") {
        const idx = buffer.indexOf(boundaryMarker);
        if (idx === -1) {
          // Need more bytes to find a boundary; retain a small tail
          // so a boundary split across chunks is still detectable.
          if (buffer.length > boundaryMarker.length) {
            buffer = buffer.slice(buffer.length - boundaryMarker.length);
          }
          return;
        }
        // Drop everything up to and including the boundary marker.
        buffer = buffer.slice(idx + boundaryMarker.length);
        // After the first boundary we expect "\r\n" or "--" (closing).
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
        return;
      }

      if (state === "headers") {
        const eoh = buffer.indexOf(DOUBLE_CRLF);
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
          currentTextBuffer = [];
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
            currentTextBuffer.push(emit);
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
          currentTextBuffer.push(emit);
        }
      }
      // Finalise the text field if applicable.
      if (state === "body-text" && currentFieldName) {
        textFields[currentFieldName] = Buffer.concat(
          currentTextBuffer,
        ).toString("utf8");
        currentTextBuffer = [];
      }
      if (state === "body-file") {
        await closeFileSink();
      }
      buffer = buffer.slice(idx + sep.length);
      // After the boundary we expect "\r\n" or "--".
      if (buffer.length < 2) {
        state = "preamble";
        return;
      }
      if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
        state = "epilogue";
        return;
      }
      if (buffer[0] === 0x0d && buffer[1] === 0x0a) {
        buffer = buffer.slice(2);
        state = "headers";
        continue;
      }
      return;
    }
  };

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

  return {
    filePath,
    bytes: bytesWritten,
    sha256: hash.digest("hex"),
    originalFilename,
    textFields,
  };
}
