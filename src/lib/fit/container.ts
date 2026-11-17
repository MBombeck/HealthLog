/**
 * What an uploaded activity file may be wrapped in, and how it is unwrapped.
 *
 * Three shapes arrive in practice: a bare `.fit` (Wahoo, Coros, Zwift, a
 * watch's USB folder), a `.fit.gz` (Strava's "export original" of a gzipped
 * upload), and the ZIP Garmin Connect's "Export original" hands out, which
 * holds the one `.fit` of the activity. The Garmin Personal API's activity
 * download returns that same ZIP.
 *
 * The upload is capped before it gets here (`FIT_UPLOAD_MAX_BYTES`), and both
 * decompressions run with a hard output ceiling (`FIT_DECOMPRESSED_MAX_BYTES`)
 * enforced by zlib itself, so a small archive that inflates to gigabytes is
 * stopped at the ceiling, not after it. A ZIP must hold exactly one `.fit`
 * member; folders and the macOS resource-fork entries are ignored, anything
 * encrypted or in an unknown compression method is refused.
 */
import { gunzipSync, inflateRawSync } from "node:zlib";

import { FitImportError } from "./errors";

/** The largest upload the import accepts. */
export const FIT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The largest FIT file a compressed upload may inflate to. A four-hour ride
 * at one record a second is one to two megabytes; a full day of 1 Hz data
 * with every sensor stays under ten. Thirty-two leaves room and bounds the
 * one buffer the import holds.
 */
export const FIT_DECOMPRESSED_MAX_BYTES = 32 * 1024 * 1024;

/** A ZIP with more entries than this is not an activity export. */
const MAX_ZIP_ENTRIES = 16;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

export type FitContainer = "fit" | "gzip" | "zip";

/** Whether the bytes start like a FIT file (`.FIT` at offset 8). */
export function looksLikeFit(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[8] === 0x2e &&
    bytes[9] === 0x46 &&
    bytes[10] === 0x49 &&
    bytes[11] === 0x54
  );
}

function looksLikeGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/** zlib's refusal when `maxOutputLength` is reached. */
function isOutputCapError(err: unknown): boolean {
  return (
    err instanceof RangeError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE")
  );
}

function inflateCapped(fn: () => Buffer): Buffer {
  try {
    return fn();
  } catch (err) {
    if (isOutputCapError(err)) {
      throw new FitImportError(
        "too_large",
        "the file inflates past the size limit",
      );
    }
    throw new FitImportError("archive_invalid", "the data does not inflate");
  }
}

/** Whether a ZIP entry name is one the reader ignores. */
function isIgnoredZipEntry(name: string): boolean {
  return (
    name.endsWith("/") ||
    name.startsWith("__MACOSX/") ||
    (name.split("/").pop() ?? "").startsWith("._")
  );
}

/**
 * The one `.fit` member of an in-memory ZIP, inflated under the ceiling.
 * Zip64 is not supported: no activity export comes near its 4 GB threshold.
 */
export function readSingleFitFromZip(zip: Buffer): Buffer {
  // The end-of-central-directory record sits in the last 64 KiB + 22 bytes.
  const searchFrom = Math.max(0, zip.length - (0xffff + 22));
  let eocd = -1;
  for (let i = zip.length - 22; i >= searchFrom; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new FitImportError("archive_invalid", "no ZIP directory found");
  }
  const entryCount = zip.readUInt16LE(eocd + 10);
  const dirSize = zip.readUInt32LE(eocd + 12);
  const dirOffset = zip.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new FitImportError("archive_invalid", "too many entries");
  }
  if (dirOffset + dirSize > eocd) {
    throw new FitImportError("archive_invalid", "directory out of bounds");
  }

  const members: Array<{
    method: number;
    flags: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
  }> = [];
  let p = dirOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== CENTRAL_FILE_HEADER) {
      throw new FitImportError("archive_invalid", "damaged directory");
    }
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const uncompressedSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    if (p + 46 + nameLen > zip.length) {
      throw new FitImportError("archive_invalid", "damaged directory");
    }
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (isIgnoredZipEntry(name)) continue;
    if (!name.toLowerCase().endsWith(".fit")) continue;
    members.push({
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
  }
  if (members.length !== 1) {
    throw new FitImportError(
      "archive_invalid",
      members.length === 0
        ? "the archive holds no .fit file"
        : "the archive holds more than one .fit file",
    );
  }
  const member = members[0]!;
  if (member.flags & 0x1) {
    throw new FitImportError("archive_invalid", "encrypted member");
  }
  if (
    member.compressedSize === 0xffffffff ||
    member.uncompressedSize === 0xffffffff
  ) {
    throw new FitImportError("archive_invalid", "zip64 member");
  }
  if (member.uncompressedSize > FIT_DECOMPRESSED_MAX_BYTES) {
    throw new FitImportError("too_large", "the member is over the size limit");
  }
  const lo = member.localOffset;
  if (lo + 30 > zip.length || zip.readUInt32LE(lo) !== LOCAL_FILE_HEADER) {
    throw new FitImportError("archive_invalid", "damaged member header");
  }
  const dataStart =
    lo + 30 + zip.readUInt16LE(lo + 26) + zip.readUInt16LE(lo + 28);
  const dataEnd = dataStart + member.compressedSize;
  if (dataEnd > zip.length) {
    throw new FitImportError("archive_invalid", "member out of bounds");
  }
  const data = zip.subarray(dataStart, dataEnd);
  if (member.method === 0) {
    return Buffer.from(data);
  }
  if (member.method === 8) {
    return inflateCapped(() =>
      inflateRawSync(data, { maxOutputLength: FIT_DECOMPRESSED_MAX_BYTES }),
    );
  }
  throw new FitImportError("archive_invalid", "unsupported compression");
}

/**
 * The FIT bytes inside an upload, whatever it came wrapped in, and which
 * wrapping it was. Throws a `FitImportError` for anything else.
 */
export function unwrapFitUpload(upload: Buffer): {
  fit: Buffer;
  container: FitContainer;
} {
  if (upload.length > FIT_UPLOAD_MAX_BYTES) {
    throw new FitImportError("too_large", "the upload is over the size limit");
  }
  if (looksLikeFit(upload)) return { fit: upload, container: "fit" };
  let fit: Buffer;
  let container: FitContainer;
  if (looksLikeGzip(upload)) {
    fit = inflateCapped(() =>
      gunzipSync(upload, { maxOutputLength: FIT_DECOMPRESSED_MAX_BYTES }),
    );
    container = "gzip";
  } else if (looksLikeZip(upload)) {
    fit = readSingleFitFromZip(upload);
    container = "zip";
  } else {
    throw new FitImportError(
      "unsupported_file",
      "expected a .fit, .fit.gz or .zip file",
    );
  }
  // One layer only: a gzip inside the ZIP, or a ZIP inside the gzip, is not
  // something any exporter writes.
  if (!looksLikeFit(fit)) {
    throw new FitImportError("not_fit", "the unpacked file is not a FIT file");
  }
  return { fit, container };
}
