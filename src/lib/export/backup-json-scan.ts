/**
 * Read a backup's JSON as a stream, without ever holding the document.
 *
 * Why. A backup is one JSON object, and every reader used to turn it into
 * one string and `JSON.parse` it. For an account of 1.25 million measurements
 * (issue #1031) the disaster-recovery JSON is 662 MB. V8 cannot hold a string
 * longer than 536 870 888 characters at all, so `unpackBackupBlob` threw
 * before a byte was parsed: the weekly backup of that account could not be
 * restored, downloaded or even summarised, and the restore route reported the
 * copy as undecryptable. A portable export of the same account fits under
 * the limit but not beside the rest of a 1 GB container.
 *
 * What this does. It scans the bytes once, tracking only string and nesting
 * state. Every top-level member is parsed on its own with `JSON.parse` and
 * kept, except the members named in `streamKeys`: those must be arrays, and
 * each element is parsed and handed to `onElement` instead, so the caller
 * sees them one at a time and the kept object holds an empty array in their
 * place. A backup's bulk tables (measurements, intake events, mood entries)
 * are the only members that grow with a record, so everything else is small.
 *
 * Structural characters are ASCII and UTF-8 never uses an ASCII byte inside a
 * multi-byte sequence, so scanning bytes is exact. A value is decoded only
 * once it is complete, which is where a character split across two chunks is
 * put back together.
 *
 * The output is what `JSON.parse` of the whole document would give, with the
 * streamed arrays emptied: the tests hold it to that over arbitrary splits.
 */

/** Characters the scanner cares about, as bytes. */
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

export interface ScanBackupJsonOptions {
  /** Top-level members whose array elements are streamed, not kept. */
  streamKeys?: ReadonlySet<string>;
  /**
   * Receives each element of a streamed member, parsed, with its index.
   * Awaited, so a consumer that writes to a database applies backpressure.
   */
  onElement?: (key: string, element: unknown, index: number) => unknown;
  /**
   * Members to skip entirely: scanned past, never parsed or kept. For a
   * reader that only needs a few sections of the document.
   */
  skipKeys?: ReadonlySet<string>;
}

export interface ScanBackupJsonResult {
  /** The document, with streamed members as empty arrays and skipped ones absent. */
  document: Record<string, unknown>;
  /** How many elements each streamed member held. */
  streamedCounts: Record<string, number>;
}

/** Thrown for input that is not a JSON object the scanner can walk. */
export class BackupJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupJsonError";
  }
}

/** Collects the bytes of one value across chunks. */
class Collector {
  private parts: Buffer[] = [];
  private bytes = 0;
  add(chunk: Buffer, from: number, to: number): void {
    if (to > from) {
      this.parts.push(chunk.subarray(from, to));
      this.bytes += to - from;
    }
  }
  take(): string {
    const text =
      this.parts.length === 1
        ? this.parts[0]!.toString("utf8")
        : Buffer.concat(this.parts, this.bytes).toString("utf8");
    this.parts = [];
    this.bytes = 0;
    return text;
  }
}

type Phase =
  | "start" // before the opening brace
  | "key" // expecting a key or the closing brace
  | "colon"
  | "value" // expecting the start of a member value
  | "in-value" // inside a kept or skipped member value
  | "array-start" // a streamed member: expecting its opening bracket
  | "element" // inside a streamed array, expecting an element or `]`
  | "in-element" // inside one element
  | "after" // after a member, expecting `,` or `}`
  | "done";

/**
 * Scan a backup document delivered as byte chunks. Resolves to the document
 * (see the module comment) once the closing brace has been read; rejects with
 * `BackupJsonError` on malformed input or with whatever `onElement` threw.
 */
export async function scanBackupJson(
  chunks: AsyncIterable<Uint8Array>,
  options: ScanBackupJsonOptions = {},
): Promise<ScanBackupJsonResult> {
  const streamKeys = options.streamKeys ?? new Set<string>();
  const skipKeys = options.skipKeys ?? new Set<string>();
  const document: Record<string, unknown> = {};
  const streamedCounts: Record<string, number> = {};

  let phase: Phase = "start";
  let inString = false;
  let escaped = false;
  // Nesting depth inside the current value or element (0 = not inside one).
  let depth = 0;
  let key = "";
  let skipping = false;
  // Inside a key string.
  let keyOpen = false;
  // Inside a streamed array, after an element: the next byte must be `,` or `]`.
  let elementNeedsComma = false;
  const keyBytes = new Collector();
  const value = new Collector();

  const finishValue = () => {
    const text = value.take();
    if (skipping) return;
    try {
      document[key] = JSON.parse(text);
    } catch {
      throw new BackupJsonError(`Backup member '${key}' is not valid JSON`);
    }
  };
  const finishElement = async () => {
    const text = value.take();
    let element: unknown;
    try {
      element = JSON.parse(text);
    } catch {
      throw new BackupJsonError(
        `Element ${streamedCounts[key]} of backup member '${key}' is not valid JSON`,
      );
    }
    const index = streamedCounts[key]!;
    streamedCounts[key] = index + 1;
    await options.onElement?.(key, element, index);
  };

  for await (const raw of chunks) {
    const chunk = Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    // Where the value or key being collected started in this chunk.
    let mark = 0;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;

      if (phase === "in-value" || phase === "in-element") {
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) escaped = true;
          else if (byte === QUOTE) inString = false;
          continue;
        }
        if (byte === QUOTE) {
          inString = true;
          continue;
        }
        if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
          depth += 1;
          continue;
        }
        if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
          if (depth > 0) {
            depth -= 1;
            if (depth > 0) continue;
            // The value's own closing bracket: it belongs to the value.
            value.add(chunk, mark, i + 1);
            if (phase === "in-value") {
              finishValue();
              phase = "after";
            } else {
              await finishElement();
              phase = "element";
              elementNeedsComma = true;
            }
            continue;
          }
          // A primitive value ended by the enclosing bracket.
          value.add(chunk, mark, i);
          if (phase === "in-value") {
            if (byte !== CLOSE_BRACE) {
              throw new BackupJsonError("Unbalanced bracket in backup");
            }
            finishValue();
            phase = "done";
          } else {
            if (byte !== CLOSE_BRACKET) {
              throw new BackupJsonError("Unbalanced bracket in backup");
            }
            await finishElement();
            phase = "after";
          }
          continue;
        }
        if (depth === 0 && (byte === COMMA || isWhitespace(byte))) {
          // A primitive value ended.
          value.add(chunk, mark, i);
          if (phase === "in-value") {
            finishValue();
            phase = byte === COMMA ? "key" : "after";
          } else {
            await finishElement();
            phase = "element";
            elementNeedsComma = byte !== COMMA;
          }
          continue;
        }
        continue;
      }

      if (phase === "key" && keyOpen) {
        if (escaped) escaped = false;
        else if (byte === BACKSLASH) escaped = true;
        else if (byte === QUOTE) {
          keyBytes.add(chunk, mark, i + 1);
          key = JSON.parse(keyBytes.take()) as string;
          keyOpen = false;
          phase = "colon";
        }
        continue;
      }

      if (isWhitespace(byte)) continue;

      switch (phase) {
        case "start":
          if (byte !== OPEN_BRACE) {
            throw new BackupJsonError("Backup is not a JSON object");
          }
          phase = "key";
          break;
        case "key":
          if (byte === CLOSE_BRACE) {
            phase = "done";
          } else if (byte === QUOTE) {
            keyOpen = true;
            escaped = false;
            mark = i;
          } else {
            throw new BackupJsonError("Malformed backup: expected a key");
          }
          break;
        case "colon":
          if (byte !== COLON) {
            throw new BackupJsonError("Malformed backup: expected ':'");
          }
          phase = streamKeys.has(key) ? "array-start" : "value";
          skipping = skipKeys.has(key);
          break;
        case "value":
          phase = "in-value";
          mark = i;
          depth = 0;
          inString = false;
          escaped = false;
          // Re-read this byte as the first byte of the value.
          i -= 1;
          break;
        case "array-start":
          if (byte !== OPEN_BRACKET) {
            throw new BackupJsonError(
              `Backup member '${key}' must be an array`,
            );
          }
          streamedCounts[key] = 0;
          document[key] = [];
          phase = "element";
          elementNeedsComma = false;
          break;
        case "element":
          if (byte === CLOSE_BRACKET) {
            phase = "after";
          } else if (byte === COMMA && elementNeedsComma) {
            elementNeedsComma = false;
          } else if (!elementNeedsComma) {
            phase = "in-element";
            mark = i;
            depth = 0;
            inString = false;
            escaped = false;
            i -= 1;
          } else {
            throw new BackupJsonError(
              `Malformed backup: expected ',' in '${key}'`,
            );
          }
          break;
        case "after":
          if (byte === COMMA) {
            phase = "key";
          } else if (byte === CLOSE_BRACE) {
            phase = "done";
          } else {
            throw new BackupJsonError("Malformed backup: expected ',' or '}'");
          }
          break;
        case "done":
          throw new BackupJsonError("Unexpected content after the backup");
      }
    }
    // Carry the unfinished key or value into the next chunk.
    if (phase === "in-value" || phase === "in-element") {
      value.add(chunk, mark, chunk.length);
    } else if (phase === "key" && keyOpen) {
      keyBytes.add(chunk, mark, chunk.length);
    }
  }

  // Anything but the closing brace as the last structural byte is a
  // truncated file, including one that ends inside a member value.
  if ((phase as Phase) !== "done") {
    throw new BackupJsonError("Backup ends before its closing brace");
  }
  return { document, streamedCounts };
}
