/**
 * Bounded ZIP reader for Apple Health's auxiliary members: the ECG CSVs, the
 * workout-route GPX files and the Health Records FHIR JSON files. Reads ZIP64
 * archives too, which is what the Health app writes for a large export.
 *
 * ZIP entry names are treated as untrusted identifiers only: no archive member
 * is ever materialised on disk. Central-directory metadata is checked before
 * decompression, then the real decompressed byte count is enforced while
 * inflating so forged size metadata cannot bypass the limits.
 */
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

export interface AppleHealthArchiveLimits {
  maxMembers: number;
  maxEcgMembers: number;
  maxMemberBytes: number;
  maxTotalEcgBytes: number;
  maxCompressionRatio: number;
}

/**
 * Why a wanted member was not read: it breaks a per-member limit (`too_large`
 * for its size or compression ratio, `unsupported` for encryption or a
 * compression method the reader does not inflate).
 */
export type AppleHealthMemberRefusal = "too_large" | "unsupported";

export interface AppleHealthArchiveMember {
  name: string;
  /** Errors on the first read when the member was refused. */
  stream: Readable;
  /** Set when the member broke a per-member limit and was not inflated. */
  refused?: AppleHealthMemberRefusal;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** Set on a wanted member of the kind that breaks a per-member limit. */
  refused?: AppleHealthMemberRefusal;
}

/**
 * The most directory entries an archive may hold, for every pass alike. It
 * bounds the walk of the central directory, which every pass makes over every
 * entry whatever its kind; a pass's own members are bounded by its own count.
 * A Health app export holds one file per ECG, per workout route and per Health
 * Records resource beside `export.xml`, so years of routes and a clinic's
 * history reach tens of thousands.
 */
export const APPLE_HEALTH_ARCHIVE_MAX_ENTRIES = 200_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const MAX_EOCD_SEARCH = 65_535 + 22;
const ECG_PREFIX = "apple_health_export/electrocardiograms/";
const ROUTE_PREFIX = "apple_health_export/workout-routes/";
const CLINICAL_PREFIX = "apple_health_export/clinical-records/";

/**
 * One family of auxiliary members: which names belong to it, the label its
 * errors carry, and its own count and total-byte ceilings.
 */
interface MemberKind {
  label: string;
  matches: (name: string) => boolean;
  maxMembers: number;
  maxTotalBytes: number;
}

function archiveError(message: string): Error {
  return new Error(`Unsafe Apple Health archive: ${message}`);
}

function assertPositiveLimits(limits: AppleHealthArchiveLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw archiveError("invalid resource limit");
    }
  }
}

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
    throw archiveError("invalid member bounds");
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
      throw archiveError("truncated member data");
    }
    offset += read.bytesRead;
  }
  return buffer;
}

/** A 64-bit ZIP field as a number, refused past the safe-integer range. */
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw archiveError("ZIP64 value is too large to address safely");
  }
  return Number(value);
}

/**
 * The ZIP64 extended-information values a central-directory entry asked for.
 * A sentinel without its value in the extra field is a malformed archive.
 */
function zip64ExtraValues(
  extra: Buffer,
  wanted: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { uncompressed?: number; compressed?: number; offset?: number } {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const end = cursor + 4 + size;
    if (end > extra.length) break;
    if (id === ZIP64_EXTRA_ID) {
      const out: {
        uncompressed?: number;
        compressed?: number;
        offset?: number;
      } = {};
      let at = cursor + 4;
      for (const field of ["uncompressed", "compressed", "offset"] as const) {
        if (!wanted[field]) continue;
        if (at + 8 > end) throw archiveError("malformed ZIP64 member");
        out[field] = safeNumber(extra.readBigUInt64LE(at));
        at += 8;
      }
      return out;
    }
    cursor = end;
  }
  throw archiveError("malformed ZIP64 member");
}

function isUnsafeName(name: string): boolean {
  if (
    name.length === 0 ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.includes("\uFFFD")
  ) {
    return true;
  }
  const segments = name.split("/");
  return segments.some((segment) => segment === "." || segment === "..");
}

function isDirectChild(name: string, prefix: string, extension: string) {
  return (
    name.startsWith(prefix) &&
    name.length > prefix.length &&
    name.toLowerCase().endsWith(extension) &&
    !name.slice(prefix.length).includes("/")
  );
}

function isEcgCsv(name: string): boolean {
  return isDirectChild(name, ECG_PREFIX, ".csv");
}

/** A workout route as the archive names it: `workout-routes/<file>.gpx`. */
export function isWorkoutRouteGpx(name: string): boolean {
  return isDirectChild(name, ROUTE_PREFIX, ".gpx");
}

/**
 * The archive member a `<FileReference path="…">` inside a `<Workout>`
 * points at. Apple writes the path from the export root
 * (`/workout-routes/route_….gpx`); the member carries the export folder in
 * front. Null for anything that is not a direct route file.
 */
export function routeMemberNameFromReference(path: string): string | null {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  const name = `apple_health_export/${trimmed}`;
  return isWorkoutRouteGpx(name) ? name : null;
}

/** A Health Records resource as the archive names it: `clinical-records/<file>.json`. */
export function isClinicalRecordJson(name: string): boolean {
  return isDirectChild(name, CLINICAL_PREFIX, ".json");
}

/**
 * The archive member a `<ClinicalRecord resourceFilePath="…">` points at.
 * Apple writes the path from the export root
 * (`/clinical-records/Observation-….json`); the member carries the export
 * folder in front. Null for anything that is not a direct clinical file.
 */
export function clinicalMemberNameFromReference(path: string): string | null {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  const name = `apple_health_export/${trimmed}`;
  return isClinicalRecordJson(name) ? name : null;
}

/**
 * The central directory, checked as a whole: entry count, bounds, names. Of
 * the entries, only the ones the pass will read (`wanted` members of its
 * kind) are held to the per-member limits and counted against the kind's
 * ceiling; one that breaks a per-member limit is marked refused rather than
 * failing the archive. The others are not read, so neither their size nor how
 * many there are can make reading the wanted ones unsafe.
 */
async function readCentralDirectory(
  handle: FileHandle,
  fileSize: number,
  limits: AppleHealthArchiveLimits,
  kind: MemberKind,
  wanted: (name: string) => boolean,
): Promise<ZipEntry[]> {
  if (fileSize < 22) throw archiveError("missing ZIP directory");

  const tailLength = Math.min(fileSize, MAX_EOCD_SEARCH);
  const tail = await readExactly(handle, tailLength, fileSize - tailLength);
  let eocdOffset = -1;
  for (let cursor = tail.length - 22; cursor >= 0; cursor -= 1) {
    if (tail.readUInt32LE(cursor) === EOCD_SIGNATURE) {
      eocdOffset = cursor;
      break;
    }
  }
  if (eocdOffset < 0) throw archiveError("missing ZIP directory");

  const disk = tail.readUInt16LE(eocdOffset + 4);
  const centralDisk = tail.readUInt16LE(eocdOffset + 6);
  const diskEntries = tail.readUInt16LE(eocdOffset + 8);
  let totalEntries = tail.readUInt16LE(eocdOffset + 10);
  let centralSize = tail.readUInt32LE(eocdOffset + 12);
  let centralOffset = tail.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw archiveError("unsupported multi-disk archive");
  }
  // ZIP64: a sentinel in any of the three fields means the real values live
  // in the ZIP64 end record, found through the locator just before the end
  // record. The Health app writes one for a large export.
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    const locatorOffset = fileSize - tailLength + eocdOffset - 20;
    if (locatorOffset < 0) throw archiveError("missing ZIP64 locator");
    const locator = await readExactly(handle, 20, locatorOffset);
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
      throw archiveError("missing ZIP64 locator");
    }
    if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) > 1) {
      throw archiveError("unsupported multi-disk archive");
    }
    const recordOffset = safeNumber(locator.readBigUInt64LE(8));
    if (recordOffset + 56 > fileSize) {
      throw archiveError("invalid ZIP64 directory bounds");
    }
    const record = await readExactly(handle, 56, recordOffset);
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      throw archiveError("malformed ZIP64 directory");
    }
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
      throw archiveError("unsupported multi-disk archive");
    }
    const recordDiskEntries = safeNumber(record.readBigUInt64LE(24));
    totalEntries = safeNumber(record.readBigUInt64LE(32));
    centralSize = safeNumber(record.readBigUInt64LE(40));
    centralOffset = safeNumber(record.readBigUInt64LE(48));
    if (recordDiskEntries !== totalEntries) {
      throw archiveError("unsupported multi-disk archive");
    }
  }
  if (totalEntries > limits.maxMembers) {
    throw archiveError("member count limit exceeded");
  }
  if (centralOffset + centralSize > fileSize) {
    throw archiveError("invalid ZIP directory bounds");
  }

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let kindCount = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    const header = await readExactly(handle, 46, cursor);
    if (header.readUInt32LE(0) !== CENTRAL_SIGNATURE) {
      throw archiveError("malformed ZIP member directory");
    }
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    let compressedSize = header.readUInt32LE(20);
    let uncompressedSize = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    let localHeaderOffset = header.readUInt32LE(42);

    const nameBuffer = await readExactly(handle, nameLength, cursor + 46);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      // ZIP64 member: the real values sit in the extended-information extra
      // field (id 0x0001), in this order, each present only when its 32-bit
      // field holds the sentinel.
      const extra = await readExactly(
        handle,
        extraLength,
        cursor + 46 + nameLength,
      );
      const sizes = zip64ExtraValues(extra, {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localHeaderOffset === 0xffffffff,
      });
      if (sizes.uncompressed !== undefined)
        uncompressedSize = sizes.uncompressed;
      if (sizes.compressed !== undefined) compressedSize = sizes.compressed;
      if (sizes.offset !== undefined) localHeaderOffset = sizes.offset;
    }
    const name = nameBuffer.toString("utf8");
    if (isUnsafeName(name)) throw archiveError("unsafe member path");
    if (names.has(name)) throw archiveError("duplicate member name");
    names.add(name);

    let refused: AppleHealthMemberRefusal | undefined;
    if (kind.matches(name) && wanted(name)) {
      kindCount += 1;
      if (kindCount > kind.maxMembers) {
        throw archiveError(`${kind.label} member count limit exceeded`);
      }
      refused = memberRefusal(
        { flags, method, compressedSize, uncompressedSize },
        limits,
      );
    }

    entries.push({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      ...(refused ? { refused } : {}),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > centralOffset + centralSize) {
      throw archiveError("invalid ZIP directory size");
    }
  }
  return entries;
}

/**
 * Why a member breaks a per-member limit by what its directory entry
 * declares, or undefined. The compressed size is held to the member limit
 * too: it is what the reader allocates before inflating, and a member that
 * does not fit compressed cannot fit inflated.
 */
function memberRefusal(
  entry: Pick<
    ZipEntry,
    "flags" | "method" | "compressedSize" | "uncompressedSize"
  >,
  limits: AppleHealthArchiveLimits,
): AppleHealthMemberRefusal | undefined {
  if ((entry.flags & 0x1) !== 0) return "unsupported";
  if (entry.method !== 0 && entry.method !== 8) return "unsupported";
  if (
    entry.uncompressedSize > limits.maxMemberBytes ||
    entry.compressedSize > limits.maxMemberBytes
  ) {
    return "too_large";
  }
  const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
  if (ratio > limits.maxCompressionRatio) return "too_large";
  return undefined;
}

/** A member breaking a per-member limit; the pass goes on without it. */
class MemberRefused extends Error {
  constructor(
    readonly reason: AppleHealthMemberRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** A member that was not read: its stream errors on the first read. */
function refusedMember(
  name: string,
  reason: AppleHealthMemberRefusal,
  label: string,
): AppleHealthArchiveMember {
  const error = archiveError(`${label} member refused (${reason})`);
  return {
    name,
    refused: reason,
    stream: new Readable({
      read() {
        this.destroy(error);
      },
    }),
  };
}

async function decompressEntry(
  handle: FileHandle,
  entry: ZipEntry,
  fileSize: number,
  limits: AppleHealthArchiveLimits,
  kind: MemberKind,
  total: { bytes: number },
): Promise<Buffer[]> {
  const local = await readExactly(handle, 30, entry.localHeaderOffset);
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw archiveError("malformed local member header");
  }
  const localFlags = local.readUInt16LE(6);
  const localMethod = local.readUInt16LE(8);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const localName = (
    await readExactly(handle, nameLength, entry.localHeaderOffset + 30)
  ).toString("utf8");
  if (
    localName !== entry.name ||
    localFlags !== entry.flags ||
    localMethod !== entry.method
  ) {
    throw archiveError("inconsistent member headers");
  }
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > fileSize) {
    throw archiveError("invalid member data bounds");
  }
  // Checked again here, beside the allocation it guards.
  if (entry.compressedSize > limits.maxMemberBytes) {
    throw new MemberRefused(
      "too_large",
      `${kind.label} member byte limit exceeded`,
    );
  }

  const compressed = await readExactly(
    handle,
    entry.compressedSize,
    dataOffset,
  );
  // A stored member is read through a copy: the read buffer is wiped below,
  // and the stored bytes are the member's content.
  const source =
    entry.method === 0
      ? Readable.from([Buffer.from(compressed)])
      : Readable.from([compressed]).pipe(createInflateRaw());
  const chunks: Buffer[] = [];
  let memberBytes = 0;
  // Which limit stopped the inflate: the member's own fails the member, the
  // running total ends the pass.
  let stop: Error | null = null;

  try {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      memberBytes += chunk.byteLength;
      if (memberBytes > limits.maxMemberBytes) {
        stop = new MemberRefused(
          "too_large",
          `actual ${kind.label} member byte limit exceeded`,
        );
        throw stop;
      }
      if (total.bytes + memberBytes > kind.maxTotalBytes) {
        stop = archiveError(`total ${kind.label} byte limit exceeded`);
        throw stop;
      }
      chunks.push(chunk);
    }
  } catch {
    for (const chunk of chunks) chunk.fill(0);
    throw stop ?? archiveError(`${kind.label} decompression failure`);
  } finally {
    compressed.fill(0);
  }

  total.bytes += memberBytes;
  return chunks;
}

/**
 * Yield the members of one kind as in-memory bounded streams, one at a time.
 * The complete central directory is validated before any health data is
 * yielded, so a structurally unsafe archive is never partly processed.
 * `wanted` narrows further (a route the export's XML actually references).
 * A wanted member that breaks a per-member limit is yielded refused (its
 * stream errors) and the pass goes on; a running total, a malformed archive
 * or an inflate failure ends it.
 */
async function* streamMembers(
  archivePath: string,
  limits: AppleHealthArchiveLimits,
  kind: MemberKind,
  wanted: (name: string) => boolean = () => true,
): AsyncGenerator<AppleHealthArchiveMember> {
  assertPositiveLimits(limits);
  const handle = await open(archivePath, "r");
  try {
    const stat = await handle.stat();
    const fileSize = Number(stat.size);
    if (!Number.isSafeInteger(fileSize)) {
      throw archiveError("archive is too large to address safely");
    }
    const entries = await readCentralDirectory(
      handle,
      fileSize,
      limits,
      kind,
      wanted,
    );
    const total = { bytes: 0 };
    for (const entry of entries) {
      if (!kind.matches(entry.name) || !wanted(entry.name)) continue;
      if (entry.refused) {
        yield refusedMember(entry.name, entry.refused, kind.label);
        continue;
      }
      let chunks: Buffer[];
      try {
        chunks = await decompressEntry(
          handle,
          entry,
          fileSize,
          limits,
          kind,
          total,
        );
      } catch (err) {
        if (!(err instanceof MemberRefused)) throw err;
        yield refusedMember(entry.name, err.reason, kind.label);
        continue;
      }
      yield { name: entry.name, stream: Readable.from(chunks) };
    }
  } finally {
    await handle.close();
  }
}

/** Yield only Apple Health's ECG CSV members as in-memory bounded streams. */
export async function* streamAppleHealthEcgMembers(input: {
  archivePath: string;
  limits: AppleHealthArchiveLimits;
}): AsyncGenerator<AppleHealthArchiveMember> {
  yield* streamMembers(input.archivePath, input.limits, {
    label: "ECG",
    matches: isEcgCsv,
    maxMembers: input.limits.maxEcgMembers,
    maxTotalBytes: input.limits.maxTotalEcgBytes,
  });
}

/** Ceilings for the route members; the shared ones keep their meaning. */
export interface AppleHealthRouteArchiveLimits {
  maxMembers: number;
  maxRouteMembers: number;
  maxMemberBytes: number;
  maxTotalRouteBytes: number;
  maxCompressionRatio: number;
}

/**
 * Yield the workout-route GPX members `wanted` names, one bounded buffer at
 * a time: the caller parses and drops each before the next is inflated.
 */
export async function* streamAppleHealthRouteMembers(input: {
  archivePath: string;
  limits: AppleHealthRouteArchiveLimits;
  wanted: (name: string) => boolean;
}): AsyncGenerator<AppleHealthArchiveMember> {
  const { limits } = input;
  yield* streamMembers(
    input.archivePath,
    {
      maxMembers: limits.maxMembers,
      maxEcgMembers: limits.maxRouteMembers,
      maxMemberBytes: limits.maxMemberBytes,
      maxTotalEcgBytes: limits.maxTotalRouteBytes,
      maxCompressionRatio: limits.maxCompressionRatio,
    },
    {
      label: "route",
      matches: isWorkoutRouteGpx,
      maxMembers: limits.maxRouteMembers,
      maxTotalBytes: limits.maxTotalRouteBytes,
    },
    input.wanted,
  );
}

/** Ceilings for the Health Records members; the shared ones keep their meaning. */
export interface AppleHealthClinicalArchiveLimits {
  maxMembers: number;
  maxClinicalMembers: number;
  maxMemberBytes: number;
  maxTotalClinicalBytes: number;
  maxCompressionRatio: number;
}

/**
 * Yield the Health Records JSON members `wanted` names, one bounded buffer at
 * a time: the caller parses and drops each before the next is inflated.
 */
export async function* streamAppleHealthClinicalMembers(input: {
  archivePath: string;
  limits: AppleHealthClinicalArchiveLimits;
  wanted: (name: string) => boolean;
}): AsyncGenerator<AppleHealthArchiveMember> {
  const { limits } = input;
  yield* streamMembers(
    input.archivePath,
    {
      maxMembers: limits.maxMembers,
      maxEcgMembers: limits.maxClinicalMembers,
      maxMemberBytes: limits.maxMemberBytes,
      maxTotalEcgBytes: limits.maxTotalClinicalBytes,
      maxCompressionRatio: limits.maxCompressionRatio,
    },
    {
      label: "clinical record",
      matches: isClinicalRecordJson,
      maxMembers: limits.maxClinicalMembers,
      maxTotalBytes: limits.maxTotalClinicalBytes,
    },
    input.wanted,
  );
}
