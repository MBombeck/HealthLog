/**
 * A structural pass over a FIT file before any decoder sees it.
 *
 * The file comes from whoever uploaded it, and the decoder builds objects in
 * proportion to what the file declares. This pass checks the frame (header
 * size, the `.FIT` signature, the declared data size against the bytes
 * there), both checksums, and walks every record header without decoding a
 * single field, counting what the decoder would have to build. A file over
 * one of the caps below is refused here, so the decoder's work is bounded by
 * numbers this module chose, not by the file.
 *
 * The caps sit well above anything a real activity holds. A 24-hour ultra at
 * one record a second is about 90 000 data messages, with about a dozen
 * fields each; a typical Garmin file
 * redefines its local messages a few hundred times; Connect IQ data fields
 * add a handful of developer fields per message.
 *
 * Only the first FIT file of a chained upload is read; trailing bytes after
 * its checksum are ignored, as the decoder does.
 */
import { FitImportError } from "./errors";

/** Data messages of every kind, across the file. */
export const FIT_MAX_DATA_MESSAGES = 150_000;
/**
 * Fields across every data message of the file: what the decoder builds a
 * value for. A day of 1 Hz records with every sensor is under a million; a
 * file that declares eighty fields per message and fills them is refused
 * here long before it is decoded.
 */
export const FIT_MAX_FIELD_CELLS = 3_000_000;
/** Definition messages, across the file. */
export const FIT_MAX_DEFINITIONS = 20_000;
/** Developer fields one definition may declare. */
export const FIT_MAX_DEVELOPER_FIELDS_PER_DEFINITION = 64;
/** `field_description` messages (one per declared developer field). */
export const FIT_MAX_FIELD_DESCRIPTIONS = 256;

const FIELD_DESCRIPTION_MESG = 206;
const TIMESTAMP_FIELD = 253;
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001,
  0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

/** The FIT CRC-16 of `bytes[start, end)`. */
export function fitCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i]!;
    let tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]!;
    tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]!;
  }
  return crc;
}

export interface FitScan {
  /** Header, data and file CRC: the bytes the decoder is handed. */
  fileLength: number;
  dataMessages: number;
  /** Fields across every data message, developer fields included. */
  fieldCells: number;
  definitions: number;
  /** The most developer fields any single definition declared. */
  maxDeveloperFields: number;
  fieldDescriptions: number;
}

interface LocalDefinition {
  size: number;
  global: number;
  /** Native and developer fields a message under it carries. */
  fields: number;
  /**
   * The bytes of a leading timestamp field (253), which a message under a
   * compressed-timestamp header leaves out, as the decoder reads it.
   */
  timestampSize: number;
}

function tooComplex(what: string): FitImportError {
  return new FitImportError("too_complex", `too many ${what}`);
}

function malformed(what: string): FitImportError {
  return new FitImportError("malformed", what);
}

/** Check the frame and checksums and count the messages; throws on refusal. */
export function scanFitFile(bytes: Uint8Array): FitScan {
  if (bytes.length < 12) throw new FitImportError("not_fit", "too short");
  const headerSize = bytes[0]!;
  if (headerSize !== 12 && headerSize !== 14) {
    throw new FitImportError("not_fit", "unexpected header size");
  }
  if (
    bytes[8] !== 0x2e ||
    bytes[9] !== 0x46 ||
    bytes[10] !== 0x49 ||
    bytes[11] !== 0x54
  ) {
    throw new FitImportError("not_fit", "missing .FIT signature");
  }
  if (bytes.length < headerSize) throw malformed("header cut short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataSize = view.getUint32(4, true);
  const dataEnd = headerSize + dataSize;
  const fileLength = dataEnd + 2;
  if (fileLength > bytes.length) {
    throw malformed("the file ends before its declared size");
  }
  if (headerSize === 14) {
    const headerCrc = view.getUint16(12, true);
    // A header CRC of zero means "not computed", which the protocol allows.
    if (headerCrc !== 0 && headerCrc !== fitCrc(bytes, 0, 12)) {
      throw new FitImportError("crc_mismatch", "header checksum");
    }
  }
  if (view.getUint16(dataEnd, true) !== fitCrc(bytes, 0, dataEnd)) {
    throw new FitImportError("crc_mismatch", "file checksum");
  }

  const locals: Array<LocalDefinition | undefined> = new Array(16);
  const scan: FitScan = {
    fileLength,
    dataMessages: 0,
    fieldCells: 0,
    definitions: 0,
    maxDeveloperFields: 0,
    fieldDescriptions: 0,
  };
  let p = headerSize;
  while (p < dataEnd) {
    const header = bytes[p]!;
    p += 1;
    if (header & 0x40 && !(header & 0x80)) {
      const hasDeveloperData = (header & 0x20) !== 0;
      if (p + 5 > dataEnd) throw malformed("definition cut short");
      const bigEndian = bytes[p + 1] === 1;
      const global = view.getUint16(p + 2, !bigEndian);
      const fieldCount = bytes[p + 4]!;
      p += 5;
      if (p + fieldCount * 3 > dataEnd) throw malformed("definition cut short");
      let size = 0;
      for (let i = 0; i < fieldCount; i += 1) size += bytes[p + i * 3 + 1]!;
      const timestampSize =
        fieldCount > 0 && bytes[p] === TIMESTAMP_FIELD ? bytes[p + 1]! : 0;
      p += fieldCount * 3;
      let devCount = 0;
      if (hasDeveloperData) {
        if (p + 1 > dataEnd) throw malformed("definition cut short");
        devCount = bytes[p]!;
        p += 1;
        if (devCount > FIT_MAX_DEVELOPER_FIELDS_PER_DEFINITION) {
          throw tooComplex("developer fields");
        }
        if (p + devCount * 3 > dataEnd) {
          throw malformed("definition cut short");
        }
        for (let i = 0; i < devCount; i += 1) size += bytes[p + i * 3 + 1]!;
        p += devCount * 3;
        scan.maxDeveloperFields = Math.max(scan.maxDeveloperFields, devCount);
      }
      locals[header & 0x0f] = {
        size,
        global,
        fields: fieldCount + devCount,
        timestampSize,
      };
      scan.definitions += 1;
      if (scan.definitions > FIT_MAX_DEFINITIONS)
        throw tooComplex("definitions");
      continue;
    }
    // A data message, under a normal header (local type in bits 0-3) or a
    // compressed-timestamp one (bits 5-6), which leaves the timestamp out.
    const compressed = (header & 0x80) !== 0;
    const def = locals[compressed ? (header >> 5) & 0x3 : header & 0x0f];
    if (!def) throw malformed("data before its definition");
    p += compressed ? def.size - def.timestampSize : def.size;
    scan.dataMessages += 1;
    scan.fieldCells += def.fields;
    if (def.global === FIELD_DESCRIPTION_MESG) {
      scan.fieldDescriptions += 1;
      if (scan.fieldDescriptions > FIT_MAX_FIELD_DESCRIPTIONS) {
        throw tooComplex("developer field descriptions");
      }
    }
    if (scan.dataMessages > FIT_MAX_DATA_MESSAGES) throw tooComplex("messages");
    if (scan.fieldCells > FIT_MAX_FIELD_CELLS) throw tooComplex("fields");
  }
  if (p !== dataEnd) throw malformed("the last message runs past the data");
  return scan;
}
