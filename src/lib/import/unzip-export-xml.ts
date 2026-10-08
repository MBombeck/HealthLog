/**
 * Minimal `export.zip` extractor — pulls `apple_health_export/export.xml`
 * out of an Apple Health export archive without spawning a third-party
 * dependency.
 *
 * Why hand-rolled: every iOS Apple Health export lands as a single
 * deflate-compressed ZIP archive. Pulling in `yauzl` / `adm-zip` / etc.
 * for one file we only ever read once would balloon the build graph
 * (and `yauzl` ships a non-trivial number of transitive deps). Node 22
 * ships `node:zlib` already; the only missing piece is a tiny ZIP
 * central-directory walker.
 *
 * Coverage scope:
 *   - Stored entries (compression method 0) — copy bytes verbatim.
 *   - Deflated entries (compression method 8) — streamed through
 *     `zlib.createInflateRaw()`.
 *   - Encrypted entries → unsupported (Apple does not encrypt the
 *     export.zip; reject with a clear error).
 *   - Zip64 — supported for the central directory record (Apple
 *     exports easily push past the 4 GB limit on multi-year accounts).
 *
 * v1.32.1 (issue #588) moved the member extraction from a synchronous
 * whole-buffer `inflateRawSync()` onto a streamed inflate pipeline.
 * (issue #775) finishes the job for the archive itself: the extractor
 * used to `readFileSync()` the ENTIRE `export.zip` into one Buffer —
 * hundreds of MB resident for the whole unpack phase on a real
 * multi-year export, on top of everything else the worker holds. The
 * archive is now read through a file handle: the EOCD is located in a
 * bounded tail read (≤ 64 KiB + 22 bytes), the central directory is
 * read as one size-capped slice, and the member bytes flow through a
 * byte-range `createReadStream` → inflate → byte-cap → file pipeline.
 * Peak memory is bounded by stream buffer sizes and the (small)
 * central directory, independent of archive size.
 *
 * v1.42 (#972): the same walker pulls `health_connect_export.db` out of an
 * Android Health Connect export (`extractHealthConnectDb`), under its own,
 * lower size ceiling.
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §6.1.
 */
import {
  createReadStream,
  createWriteStream,
  statSync,
  unlinkSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createInflateRaw } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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
 * This is a coarse signal — the byte-counting cap on the streamed
 * inflate output (`streamEntryToFile()` below) is the load-bearing
 * defence.
 */
const MAX_COMPRESSION_RATIO = 200;

/**
 * Floor for the output cap of a small member. The ratio cap alone would
 * refuse a tiny, legitimately very compressible export; below this many
 * bytes of output the ratio is not what protects the disk.
 */
const MIN_OUTPUT_CAP_BYTES = 64 * 1024 * 1024;

/**
 * How many bytes one member may inflate to, from what it ACTUALLY occupies
 * in the archive rather than what its header claims. The header is the
 * attacker's to write: a member declaring an honest-looking 10:1 ratio can
 * still inflate at 1000:1, and with only the flat 8 GiB ceiling an 8 MB
 * upload could fill `/tmp` with 8 GB before anything noticed. The streamed
 * byte count is held to the ratio the preflight states, applied to the
 * compressed bytes on disk, and never above the absolute ceiling. A stored
 * member cannot grow at all.
 */
export function memberOutputCap(entry: {
  compressionMethod: number;
  compressedSize: number;
}): number {
  if (entry.compressionMethod === 0) {
    return Math.min(entry.compressedSize, MAX_DECOMPRESSED_BYTES);
  }
  return Math.min(
    MAX_DECOMPRESSED_BYTES,
    Math.max(
      MIN_OUTPUT_CAP_BYTES,
      entry.compressedSize * MAX_COMPRESSION_RATIO,
    ),
  );
}

/**
 * Cap on the central-directory slice the extractor is willing to hold
 * in memory. A real Apple export's central directory is a few KB (one
 * XML member + optional ECG CSVs, ~100 bytes per entry); 64 MiB gives
 * six orders of magnitude of headroom while refusing a forged EOCD
 * that advertises a multi-GB directory purely to force an allocation.
 */
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;

/** EOCD is 22 bytes plus an up-to-64 KiB trailing comment. */
const MAX_EOCD_SEARCH = 22 + 0x10000;

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
 * Central-directory metadata for the `export.xml` member, surfaced to
 * the optional preflight hook BEFORE any extraction work starts. The
 * declared sizes come from the archive and are attacker-controlled;
 * they are suitable for a resource preflight, not for trust decisions
 * (the byte-counting cap enforces the real output).
 */
export interface ExportXmlPreflightInfo {
  /** Uncompressed size of export.xml as declared by the archive. */
  declaredXmlBytes: number;
  /** Compressed size of the export.xml member inside the archive. */
  compressedXmlBytes: number;
}

export interface ExtractExportXmlOptions {
  /**
   * Called once with the member's declared sizes after the central
   * directory is read but before extraction begins. Throwing here
   * aborts the extraction with the thrown error — the worker uses it
   * to refuse an import the runtime demonstrably cannot carry, before
   * minutes of inflate work are spent.
   */
  preflight?: (info: ExportXmlPreflightInfo) => void | Promise<void>;
}

/** Apple ships a second, far smaller clinical-document XML beside the export. */
const CDA_SUFFIX = /_cda\.xml$/i;

function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Find the export XML inside an Apple Health archive.
 *
 * The member is not always `apple_health_export/export.xml`. iOS writes the
 * file name in the phone's language, and some versions capitalise it, so an
 * archive can carry `Export.xml` or a translated name instead. Matching the
 * English lowercase spelling alone refused those archives with a message that
 * told the reader their export was invalid, which it was not.
 *
 * Order matters. The basename `export.xml` in any capitalisation wins, since
 * that is the overwhelming case and the one Apple documents. Failing that, a
 * single XML member at the top of the archive is taken as the translated
 * spelling. `*_cda.xml` never qualifies: Apple ships that clinical-document
 * file beside the real export, and picking it would parse to nothing.
 */
export function selectExportXmlEntry<T extends { fileName: string }>(
  entries: readonly T[],
): { entry: T } | { candidates: readonly string[] } {
  const usable = entries.filter(
    (e) => !e.fileName.startsWith("__MACOSX/") && !e.fileName.endsWith("/"),
  );
  const exact = usable.find(
    (e) => baseName(e.fileName).toLowerCase() === "export.xml",
  );
  if (exact) return { entry: exact };

  const shallowXml = usable.filter(
    (e) =>
      /\.xml$/i.test(e.fileName) &&
      !CDA_SUFFIX.test(baseName(e.fileName)) &&
      e.fileName.split("/").length <= 2,
  );
  if (shallowXml.length === 1) return { entry: shallowXml[0] };

  return {
    candidates: usable
      .filter((e) => /\.xml$/i.test(e.fileName))
      .map((e) => e.fileName)
      .slice(0, 8),
  };
}

/**
 * Walk the central directory of `archivePath` and write the
 * `apple_health_export/export.xml` member out to a temp file.
 * Throws when the member is missing, encrypted, or compressed with
 * an unsupported method.
 */
export async function extractExportXml(
  archivePath: string,
  options: ExtractExportXmlOptions = {},
): Promise<UnzipResult> {
  const handle = await open(archivePath, "r");
  try {
    const stat = await handle.stat();
    const fileSize = Number(stat.size);
    if (!Number.isSafeInteger(fileSize)) {
      throw new Error("Archive is too large to address safely");
    }
    const entries = await readCentralDirectoryFromFile(handle, fileSize);

    const selected = selectExportXmlEntry(entries);
    if ("candidates" in selected) {
      throw new Error(
        "Archive is missing the `apple_health_export/export.xml` member" +
          " — is this a valid Apple Health export.zip?" +
          (selected.candidates.length > 0
            ? ` XML members found: ${selected.candidates.join(", ")}`
            : " The archive contains no XML member at all."),
      );
    }
    const exportXmlEntry = selected.entry;

    if (
      exportXmlEntry.compressionMethod !== 0 &&
      exportXmlEntry.compressionMethod !== 8
    ) {
      throw new Error(
        `Unsupported ZIP compression method ${exportXmlEntry.compressionMethod}` +
          " for export.xml (expected 0=stored or 8=deflate)",
      );
    }

    // Pre-flight zip-bomb defence. The central directory's advertised
    // `uncompressedSize` is attacker-controlled (a malicious archive can
    // lie), so this catches honest-but-oversized payloads early; the
    // load-bearing defence is the byte-counting cap inside
    // `streamEntryToFile()` which trips on the actual inflate output.
    if (exportXmlEntry.uncompressedSize > MAX_DECOMPRESSED_BYTES) {
      throw new Error(
        `export.xml declares an uncompressed size of ${exportXmlEntry.uncompressedSize} bytes` +
          ` — refusing to extract (cap is ${MAX_DECOMPRESSED_BYTES} bytes).`,
      );
    }
    if (
      exportXmlEntry.compressedSize > 0 &&
      exportXmlEntry.uncompressedSize / exportXmlEntry.compressedSize >
        MAX_COMPRESSION_RATIO
    ) {
      throw new Error(
        `export.xml advertises a ${(
          exportXmlEntry.uncompressedSize / exportXmlEntry.compressedSize
        ).toFixed(0)}× compression ratio (cap is ${MAX_COMPRESSION_RATIO}×)` +
          " — refusing as a suspected zip bomb.",
      );
    }

    if (options.preflight) {
      await options.preflight({
        declaredXmlBytes: exportXmlEntry.uncompressedSize,
        compressedXmlBytes: exportXmlEntry.compressedSize,
      });
    }

    // Unguessable temp name: the extraction target lives in the shared
    // system tmpdir, and a predictable name (timestamp + Math.random) is
    // what a local pre-creation or symlink attack needs.
    const xmlPath = join(
      tmpdir(),
      `healthlog-import-${randomBytes(12).toString("hex")}.xml`,
    );
    const xmlBytes = await streamEntryToFile(
      handle,
      archivePath,
      fileSize,
      exportXmlEntry,
      xmlPath,
    );

    const otherMembers = entries
      .filter((e) => e !== exportXmlEntry)
      .map((e) => ({ name: e.fileName, bytes: e.uncompressedSize }));

    return {
      xmlPath,
      xmlBytes,
      otherMembers,
    };
  } finally {
    await handle.close();
  }
}

/** The one member of a Health Connect export ZIP the importer reads. */
export const HEALTH_CONNECT_DB_MEMBER = "health_connect_export.db";

/**
 * Ceiling on the extracted Health Connect database. The export is a byte copy
 * of the phone's own database; years of minute-by-minute heart rate from a
 * watch put it in the hundreds of megabytes, and 4 GiB leaves room for that
 * while keeping a forged archive from filling the temp directory.
 */
export const MAX_HEALTH_CONNECT_DB_BYTES = 4 * 1024 * 1024 * 1024;

/** Where the Health Connect database landed. */
export interface HealthConnectUnzipResult {
  dbPath: string;
  dbBytes: number;
}

/**
 * Find `health_connect_export.db` among the archive's members. The Health
 * Connect app writes it as the archive's single entry; any folder in front of
 * it (an archive repacked on a computer) is tolerated.
 */
export function selectHealthConnectDbEntry<T extends { fileName: string }>(
  entries: readonly T[],
): T | null {
  return (
    entries.find(
      (e) =>
        !e.fileName.startsWith("__MACOSX/") &&
        !e.fileName.endsWith("/") &&
        baseName(e.fileName).toLowerCase() === HEALTH_CONNECT_DB_MEMBER,
    ) ?? null
  );
}

/**
 * Write the `health_connect_export.db` member of `archivePath` to a temp file
 * with an unguessable name. Refuses an archive without the member, an
 * encrypted or unknown compression method, a declared size above
 * `maxBytes`, and a declared ratio above the zip-bomb threshold; the streamed
 * byte cap holds the real output to the same ceiling whatever the header
 * claims.
 */
export async function extractHealthConnectDb(
  archivePath: string,
  options: { maxBytes?: number } = {},
): Promise<HealthConnectUnzipResult> {
  const maxBytes = options.maxBytes ?? MAX_HEALTH_CONNECT_DB_BYTES;
  const handle = await open(archivePath, "r");
  try {
    const fileSize = Number((await handle.stat()).size);
    if (!Number.isSafeInteger(fileSize)) {
      throw new Error("Archive is too large to address safely");
    }
    const entries = await readCentralDirectoryFromFile(handle, fileSize);
    const entry = selectHealthConnectDbEntry(entries);
    if (!entry) {
      throw new Error(
        `not_health_connect: the archive has no ${HEALTH_CONNECT_DB_MEMBER} member — is this a Health Connect export?`,
      );
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw new Error(
        `Unsupported ZIP compression method ${entry.compressionMethod}` +
          ` for ${HEALTH_CONNECT_DB_MEMBER} (expected 0=stored or 8=deflate)`,
      );
    }
    if (entry.uncompressedSize > maxBytes) {
      throw new Error(
        `too_large: ${HEALTH_CONNECT_DB_MEMBER} declares ${entry.uncompressedSize} bytes` +
          ` — refusing to extract (cap is ${maxBytes} bytes).`,
      );
    }
    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new Error(
        `${HEALTH_CONNECT_DB_MEMBER} advertises a ${(
          entry.uncompressedSize / entry.compressedSize
        ).toFixed(0)}× compression ratio (cap is ${MAX_COMPRESSION_RATIO}×)` +
          " — refusing as a suspected zip bomb.",
      );
    }
    const dbPath = join(
      tmpdir(),
      `healthlog-hc-import-${randomBytes(12).toString("hex")}.db`,
    );
    const dbBytes = await streamEntryToFile(
      handle,
      archivePath,
      fileSize,
      entry,
      dbPath,
      maxBytes,
    );
    return { dbPath, dbBytes };
  } finally {
    await handle.close();
  }
}

/** Read exactly `length` bytes at `position` or throw on truncation. */
async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(position) ||
    length < 0 ||
    position < 0
  ) {
    throw new Error("Invalid ZIP read bounds");
  }
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (read.bytesRead === 0) {
      throw new Error("Truncated ZIP archive");
    }
    offset += read.bytesRead;
  }
  return buffer;
}

/**
 * EOCD fields after Zip64 resolution — enough to locate and size the
 * central directory.
 */
interface EocdSummary {
  entryCount: number;
  centralDirOffset: number;
  centralDirSize: number;
}

/**
 * Resolve the (possibly Zip64) EOCD from a tail slice. `readAt` supplies
 * absolute-offset reads for the Zip64 locator/record, which can sit
 * outside the tail slice on a large archive; the buffer-based caller
 * passes a same-buffer reader.
 */
async function resolveEocd(
  tail: Buffer,
  tailFileOffset: number,
  eocdOffsetInTail: number,
  readAt: (length: number, position: number) => Promise<Buffer>,
): Promise<EocdSummary> {
  let centralDirSize = tail.readUInt32LE(eocdOffsetInTail + 12);
  let centralDirOffset = tail.readUInt32LE(eocdOffsetInTail + 16);
  let entryCount = tail.readUInt16LE(eocdOffsetInTail + 10);

  // Zip64 handling — when any of the three count/offset fields is the
  // 0xFFFFFFFF / 0xFFFF sentinel, the real value lives in the Zip64
  // EOCD record located by walking back through the locator.
  if (
    centralDirOffset === 0xffffffff ||
    centralDirSize === 0xffffffff ||
    entryCount === 0xffff
  ) {
    const locatorFileOffset = tailFileOffset + eocdOffsetInTail - 20;
    if (locatorFileOffset < 0) {
      throw new Error("Zip64 sentinels present but Zip64 locator missing");
    }
    const locator = await readAt(20, locatorFileOffset);
    if (locator.readUInt32LE(0) !== ZIP64_EOCD_LOCATOR) {
      throw new Error("Zip64 sentinels present but Zip64 locator missing");
    }
    const zip64EocdOffset = Number(locator.readBigUInt64LE(8));
    const zip64Eocd = await readAt(56, zip64EocdOffset);
    if (zip64Eocd.readUInt32LE(0) !== ZIP64_EOCD_RECORD) {
      throw new Error("Zip64 EOCD record signature mismatch");
    }
    entryCount = Number(zip64Eocd.readBigUInt64LE(32));
    centralDirSize = Number(zip64Eocd.readBigUInt64LE(40));
    centralDirOffset = Number(zip64Eocd.readBigUInt64LE(48));
  }

  return { entryCount, centralDirOffset, centralDirSize };
}

/**
 * Locate and parse the central directory through the file handle,
 * without ever holding more than the tail slice + the central
 * directory itself in memory.
 */
async function readCentralDirectoryFromFile(
  handle: FileHandle,
  fileSize: number,
): Promise<CentralDirectoryEntry[]> {
  if (fileSize < 22) {
    throw new Error("Could not locate ZIP End-Of-Central-Directory record");
  }
  const tailLength = Math.min(fileSize, MAX_EOCD_SEARCH);
  const tailFileOffset = fileSize - tailLength;
  const tail = await readExactly(handle, tailLength, tailFileOffset);
  const eocdOffsetInTail = locateEocd(tail);
  if (eocdOffsetInTail === -1) {
    throw new Error("Could not locate ZIP End-Of-Central-Directory record");
  }

  const summary = await resolveEocd(
    tail,
    tailFileOffset,
    eocdOffsetInTail,
    (length, position) => readExactly(handle, length, position),
  );
  validateCentralDirectoryBounds(summary, fileSize);

  const centralDir = await readExactly(
    handle,
    summary.centralDirSize,
    summary.centralDirOffset,
  );
  return parseCentralDirectory(
    centralDir,
    summary.centralDirOffset,
    summary.entryCount,
  );
}

function validateCentralDirectoryBounds(
  summary: EocdSummary,
  fileSize: number,
): void {
  if (summary.centralDirSize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error(
      `ZIP central directory declares ${summary.centralDirSize} bytes` +
        ` — refusing (cap is ${MAX_CENTRAL_DIRECTORY_BYTES} bytes).`,
    );
  }
  if (
    summary.centralDirOffset < 0 ||
    summary.centralDirSize < 0 ||
    summary.centralDirOffset + summary.centralDirSize > fileSize
  ) {
    throw new Error("ZIP central directory bounds exceed the archive");
  }
}

/**
 * Walk the ZIP central directory of a fully-buffered archive and return
 * one descriptor per member. Kept as a Buffer-based API for unit tests
 * and small in-memory archives; the production extraction path reads
 * the directory through a file handle instead of buffering the archive.
 */
export function readCentralDirectory(buf: Buffer): CentralDirectoryEntry[] {
  const eocdOffset = locateEocd(buf);
  if (eocdOffset === -1) {
    throw new Error("Could not locate ZIP End-Of-Central-Directory record");
  }

  // The whole archive is in `buf`, so absolute-offset reads are slices.
  const resolved = resolveEocdSync(buf, eocdOffset);
  validateCentralDirectoryBounds(resolved, buf.length);
  const centralDir = buf.subarray(
    resolved.centralDirOffset,
    resolved.centralDirOffset + resolved.centralDirSize,
  );
  return parseCentralDirectory(
    centralDir,
    resolved.centralDirOffset,
    resolved.entryCount,
  );
}

/** Synchronous EOCD/Zip64 resolution over a fully-buffered archive. */
function resolveEocdSync(buf: Buffer, eocdOffset: number): EocdSummary {
  let centralDirSize = buf.readUInt32LE(eocdOffset + 12);
  let centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  let entryCount = buf.readUInt16LE(eocdOffset + 10);

  if (
    centralDirOffset === 0xffffffff ||
    centralDirSize === 0xffffffff ||
    entryCount === 0xffff
  ) {
    const locatorOffset = eocdOffset - 20;
    if (
      locatorOffset < 0 ||
      buf.readUInt32LE(locatorOffset) !== ZIP64_EOCD_LOCATOR
    ) {
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
  return { entryCount, centralDirOffset, centralDirSize };
}

/**
 * Parse central-directory entries from a slice that starts at the
 * directory's first byte. `baseOffset` is the slice's absolute file
 * offset, used only for error reporting symmetry — entry offsets in
 * the records themselves are already absolute.
 */
function parseCentralDirectory(
  centralDir: Buffer,
  baseOffset: number,
  entryCount: number,
): CentralDirectoryEntry[] {
  void baseOffset;
  const entries: CentralDirectoryEntry[] = [];
  let cursor = 0;
  const end = centralDir.length;
  while (cursor < end && entries.length < entryCount) {
    if (cursor + 46 > end) {
      throw new Error(`Central directory entry ${entries.length} is truncated`);
    }
    if (centralDir.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new Error(
        `Central directory entry ${entries.length} has wrong signature`,
      );
    }
    const compressionMethod = centralDir.readUInt16LE(cursor + 10);
    const flags = centralDir.readUInt16LE(cursor + 8);
    if (flags & 0x0001) {
      throw new Error("Encrypted ZIP entries are not supported");
    }
    const compressedSize32 = centralDir.readUInt32LE(cursor + 20);
    const uncompressedSize32 = centralDir.readUInt32LE(cursor + 24);
    const fileNameLen = centralDir.readUInt16LE(cursor + 28);
    const extraLen = centralDir.readUInt16LE(cursor + 30);
    const commentLen = centralDir.readUInt16LE(cursor + 32);
    const localHeaderOffset32 = centralDir.readUInt32LE(cursor + 42);

    const fileName = centralDir
      .subarray(cursor + 46, cursor + 46 + fileNameLen)
      .toString("utf8");

    let compressedSize = compressedSize32;
    let uncompressedSize = uncompressedSize32;
    let localHeaderOffset = localHeaderOffset32;

    // Zip64 extra-field walk if any of the three values is sentinel.
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const extraStart = cursor + 46 + fileNameLen;
      let extraCursor = extraStart;
      const extraEnd = extraStart + extraLen;
      while (extraCursor + 4 <= extraEnd) {
        const headerId = centralDir.readUInt16LE(extraCursor);
        const dataSize = centralDir.readUInt16LE(extraCursor + 2);
        if (headerId === 0x0001) {
          // Zip64 extended-info extra field
          let dCursor = extraCursor + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(centralDir.readBigUInt64LE(dCursor));
            dCursor += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(centralDir.readBigUInt64LE(dCursor));
            dCursor += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(centralDir.readBigUInt64LE(dCursor));
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

/**
 * Byte-counting passthrough that refuses to forward more than `limit`
 * bytes — the streaming equivalent of `inflateRawSync`'s
 * `maxOutputLength`, since the Transform-based zlib API exposes no such
 * option. Trips on the actual bytes flowing through even when the
 * central-directory metadata lied about the uncompressed size. Exported
 * so a unit test can exercise the cap directly against a small limit —
 * the real `MAX_DECOMPRESSED_BYTES` ceiling (8 GiB) is not practical to
 * trip from a test fixture.
 */
export function createByteCap(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(
          new Error(
            `Decompressed export.xml exceeds the ${limit}-byte cap` +
              " — refusing as a suspected zip bomb.",
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Stream a single ZIP entry's bytes out to `destPath`, decompressing
 * through `zlib.createInflateRaw()` when needed. The compressed bytes
 * are read through a byte-range file stream rather than an archive-wide
 * buffer, so peak memory is bounded by stream buffer sizes regardless
 * of archive size, and the decompression work runs off the JS event
 * loop on the libuv threadpool. Returns the number of bytes written.
 */
async function streamEntryToFile(
  handle: FileHandle,
  archivePath: string,
  fileSize: number,
  entry: CentralDirectoryEntry,
  destPath: string,
  maxOutputBytes: number = MAX_DECOMPRESSED_BYTES,
): Promise<number> {
  const local = await readExactly(handle, 30, entry.localHeaderOffset);
  if (local.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    throw new Error(
      `Local file header for ${entry.fileName} has wrong signature`,
    );
  }
  const localFileNameLen = local.readUInt16LE(26);
  const localExtraLen = local.readUInt16LE(28);
  const dataStart =
    entry.localHeaderOffset + 30 + localFileNameLen + localExtraLen;
  if (dataStart + entry.compressedSize > fileSize) {
    throw new Error(
      `Member data for ${entry.fileName} exceeds the archive bounds`,
    );
  }

  const dest = createWriteStream(destPath);
  const cap = createByteCap(Math.min(memberOutputCap(entry), maxOutputBytes));

  try {
    if (entry.compressedSize === 0) {
      // Empty member — nothing to stream; still create the file.
      await pipeline([], cap, dest);
    } else {
      const source = createReadStream(archivePath, {
        start: dataStart,
        end: dataStart + entry.compressedSize - 1,
      });
      if (entry.compressionMethod === 0) {
        await pipeline(source, cap, dest);
      } else {
        // Method 8 — DEFLATE, streamed through the async zlib Transform.
        await pipeline(source, createInflateRaw(), cap, dest);
      }
    }
  } catch (err) {
    // A mid-stream failure (byte cap trip, corrupt deflate stream) can
    // leave a partial file on disk — the old sync path only ever wrote
    // once inflate had already fully succeeded. Clean up so a rejected
    // archive doesn't leak a partial `/tmp` file.
    try {
      unlinkSync(destPath);
    } catch {
      // ignore — best-effort
    }
    throw err;
  }
  return statSync(destPath).size;
}

/**
 * Scan backwards from the end of the buffer for the EOCD signature.
 * The EOCD lives in the last 22 + comment bytes; a comment is rare in
 * the Health export but we tolerate up to 64 KB just in case.
 */
function locateEocd(buf: Buffer): number {
  const searchStart = Math.max(0, buf.length - MAX_EOCD_SEARCH);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}
