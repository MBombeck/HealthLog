/**
 * Minimal `export.zip` extractor — pulls `apple_health_export/export.xml`
 * out of an Apple Health export archive without spawning a third-party
 * dependency.
 *
 * Why hand-rolled: every iOS Apple Health export lands as a single
 * deflate-compressed ZIP archive. Pulling in `yauzl` / `adm-zip` / etc.
 * for one file we only ever read once would balloon the build graph
 * (and `yauzl` ships a non-trivial number of transitive deps). Node 22
 * ships `node:zlib` `inflateRawSync` already; the only missing piece
 * is a tiny ZIP central-directory walker.
 *
 * Coverage scope:
 *   - Stored entries (compression method 0) — copy bytes verbatim.
 *   - Deflated entries (compression method 8) — `inflateRawSync`.
 *   - Encrypted entries → unsupported (Apple does not encrypt the
 *     export.zip; reject with a clear error).
 *   - Zip64 — supported for the central directory record (Apple
 *     exports easily push past the 4 GB limit on multi-year accounts).
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §6.1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Signature bytes for the End-Of-Central-Directory record. */
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP64_EOCD_RECORD = 0x06064b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/**
 * Hard cap on the decompressed `export.xml` size. Apple Health exports
 * for heavy multi-year accounts settle in the low single-digit GB
 * range; 8 GiB leaves a wide ceiling for any legitimate user while
 * making zip-bomb expansion (1000:1 deflate ratios are easily
 * crafted) refuse the inflate before it OOMs the process.
 */
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
/**
 * Pre-flight refusal threshold for the central-directory's advertised
 * ratio. Legitimate Apple Health XML compresses at maybe 10–20× under
 * DEFLATE; anything claiming a 200× expansion is a synthesized bomb.
 * This is a coarse signal — the `maxOutputLength` ceiling on the
 * inflate call below is the load-bearing defence.
 */
const MAX_COMPRESSION_RATIO = 200;

/** A single entry within the archive's central directory. */
interface CentralDirectoryEntry {
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Result of `extractExportXml()`. The XML is written to a temp file
 * because the streaming SAX parser expects a path it can `createReadStream`
 * against.
 */
export interface UnzipResult {
  /** Filesystem path the extracted `export.xml` lives at. */
  xmlPath: string;
  /** Uncompressed size in bytes of the extracted XML. */
  xmlBytes: number;
  /** Members the parser ignored (everything other than `export.xml`). */
  otherMembers: { name: string; bytes: number }[];
}

/**
 * Walk the central directory of `archivePath` and write the
 * `apple_health_export/export.xml` member out to a temp file.
 * Throws when the member is missing, encrypted, or compressed with
 * an unsupported method.
 */
export function extractExportXml(archivePath: string): UnzipResult {
  const buf = readFileSync(archivePath);
  const entries = readCentralDirectory(buf);

  const exportXmlEntry = entries.find(
    (e) =>
      e.fileName.endsWith("/export.xml") || e.fileName === "export.xml",
  );
  if (!exportXmlEntry) {
    throw new Error(
      "Archive is missing the `apple_health_export/export.xml` member"
        + " — is this a valid Apple Health export.zip?",
    );
  }

  if (
    exportXmlEntry.compressionMethod !== 0
    && exportXmlEntry.compressionMethod !== 8
  ) {
    throw new Error(
      `Unsupported ZIP compression method ${exportXmlEntry.compressionMethod}`
        + " for export.xml (expected 0=stored or 8=deflate)",
    );
  }

  // Pre-flight zip-bomb defence. The central directory's advertised
  // `uncompressedSize` is attacker-controlled (a malicious archive can
  // lie), so this catches honest-but-oversized payloads early; the
  // load-bearing defence is the `maxOutputLength` cap inside
  // `extractEntry()` which trips on the actual inflate output.
  if (exportXmlEntry.uncompressedSize > MAX_DECOMPRESSED_BYTES) {
    throw new Error(
      `export.xml declares an uncompressed size of ${exportXmlEntry.uncompressedSize} bytes`
        + ` — refusing to extract (cap is ${MAX_DECOMPRESSED_BYTES} bytes).`,
    );
  }
  if (
    exportXmlEntry.compressedSize > 0
    && exportXmlEntry.uncompressedSize / exportXmlEntry.compressedSize
      > MAX_COMPRESSION_RATIO
  ) {
    throw new Error(
      `export.xml advertises a ${(
        exportXmlEntry.uncompressedSize / exportXmlEntry.compressedSize
      ).toFixed(0)}× compression ratio (cap is ${MAX_COMPRESSION_RATIO}×)`
        + " — refusing as a suspected zip bomb.",
    );
  }

  const xmlBytes = extractEntry(buf, exportXmlEntry);

  const xmlPath = join(
    tmpdir(),
    `healthlog-import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.xml`,
  );
  writeFileSync(xmlPath, xmlBytes);

  const otherMembers = entries
    .filter((e) => e !== exportXmlEntry)
    .map((e) => ({ name: e.fileName, bytes: e.uncompressedSize }));

  return {
    xmlPath,
    xmlBytes: xmlBytes.length,
    otherMembers,
  };
}

/**
 * Walk the ZIP central directory and return one descriptor per member.
 * Exported for unit testing the central-directory parser independently
 * of the file-extraction path.
 */
export function readCentralDirectory(
  buf: Buffer,
): CentralDirectoryEntry[] {
  const eocdOffset = locateEocd(buf);
  if (eocdOffset === -1) {
    throw new Error("Could not locate ZIP End-Of-Central-Directory record");
  }

  let centralDirSize = buf.readUInt32LE(eocdOffset + 12);
  let centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  let entryCount = buf.readUInt16LE(eocdOffset + 10);

  // Zip64 handling — when any of the three count/offset fields is the
  // 0xFFFFFFFF / 0xFFFF sentinel, the real value lives in the Zip64
  // EOCD record located by walking back through the locator.
  if (
    centralDirOffset === 0xffffffff
    || centralDirSize === 0xffffffff
    || entryCount === 0xffff
  ) {
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset < 0
      || buf.readUInt32LE(locatorOffset) !== ZIP64_EOCD_LOCATOR) {
      throw new Error("Zip64 sentinels present but Zip64 locator missing");
    }
    const zip64EocdOffset = Number(buf.readBigUInt64LE(locatorOffset + 8));
    if (buf.readUInt32LE(zip64EocdOffset) !== ZIP64_EOCD_RECORD) {
      throw new Error("Zip64 EOCD record signature mismatch");
    }
    entryCount = Number(buf.readBigUInt64LE(zip64EocdOffset + 32));
    centralDirSize = Number(buf.readBigUInt64LE(zip64EocdOffset + 40));
    centralDirOffset = Number(buf.readBigUInt64LE(zip64EocdOffset + 48));
  }

  const entries: CentralDirectoryEntry[] = [];
  let cursor = centralDirOffset;
  const end = centralDirOffset + centralDirSize;
  while (cursor < end && entries.length < entryCount) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new Error(
        `Central directory entry ${entries.length} has wrong signature`,
      );
    }
    const compressionMethod = buf.readUInt16LE(cursor + 10);
    const flags = buf.readUInt16LE(cursor + 8);
    if (flags & 0x0001) {
      throw new Error("Encrypted ZIP entries are not supported");
    }
    const compressedSize32 = buf.readUInt32LE(cursor + 20);
    const uncompressedSize32 = buf.readUInt32LE(cursor + 24);
    const fileNameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset32 = buf.readUInt32LE(cursor + 42);

    const fileName = buf
      .slice(cursor + 46, cursor + 46 + fileNameLen)
      .toString("utf8");

    let compressedSize = compressedSize32;
    let uncompressedSize = uncompressedSize32;
    let localHeaderOffset = localHeaderOffset32;

    // Zip64 extra-field walk if any of the three values is sentinel.
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff
    ) {
      const extraStart = cursor + 46 + fileNameLen;
      let extraCursor = extraStart;
      const extraEnd = extraStart + extraLen;
      while (extraCursor + 4 <= extraEnd) {
        const headerId = buf.readUInt16LE(extraCursor);
        const dataSize = buf.readUInt16LE(extraCursor + 2);
        if (headerId === 0x0001) {
          // Zip64 extended-info extra field
          let dCursor = extraCursor + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(buf.readBigUInt64LE(dCursor));
            dCursor += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buf.readBigUInt64LE(dCursor));
            dCursor += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(buf.readBigUInt64LE(dCursor));
            dCursor += 8;
          }
          break;
        }
        extraCursor += 4 + dataSize;
      }
    }

    entries.push({
      fileName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

/** Extract the bytes of a single ZIP entry into a Buffer. */
function extractEntry(buf: Buffer, entry: CentralDirectoryEntry): Buffer {
  const local = entry.localHeaderOffset;
  if (buf.readUInt32LE(local) !== LOCAL_FILE_HEADER) {
    throw new Error(
      `Local file header for ${entry.fileName} has wrong signature`,
    );
  }
  const localFileNameLen = buf.readUInt16LE(local + 26);
  const localExtraLen = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + localFileNameLen + localExtraLen;
  const compressed = buf.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressed;
  }
  // Method 8 — DEFLATE. `maxOutputLength` instructs `node:zlib` to
  // refuse expansion past the cap with a thrown error, defeating
  // zip-bomb amplification even when the central-directory metadata
  // lies about the uncompressed size.
  return inflateRawSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
}

/**
 * Scan backwards from the end of the buffer for the EOCD signature.
 * The EOCD lives in the last 22 + comment bytes; a comment is rare in
 * the Health export but we tolerate up to 64 KB just in case.
 */
function locateEocd(buf: Buffer): number {
  const searchStart = Math.max(0, buf.length - (22 + 0x10000));
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}
