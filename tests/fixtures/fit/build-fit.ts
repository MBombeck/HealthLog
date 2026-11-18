/**
 * A small FIT encoder for synthetic fixtures. Every file the FIT tests read
 * is built here from invented values, so no recording of a real person is
 * ever committed.
 *
 * It writes what the importer has to cope with and the published encoder
 * does not: the 12-byte header without a header CRC, compressed-timestamp
 * record headers, developer fields with their `developer_data_id` and
 * `field_description` messages, and deliberately broken frames.
 */
import { deflateRawSync, gzipSync } from "node:zlib";

export const BT = {
  enum: 0x00,
  sint8: 0x01,
  uint8: 0x02,
  sint16: 0x83,
  uint16: 0x84,
  sint32: 0x85,
  uint32: 0x86,
  string: 0x07,
  float32: 0x88,
  uint8z: 0x0a,
  byte: 0x0d,
  uint16z: 0x8b,
  uint32z: 0x8c,
} as const;

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001,
  0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function crc16(bytes: Uint8Array, start = 0, end = bytes.length) {
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

/** FIT epoch: 1989-12-31T00:00:00Z. */
export const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

export function fitTime(date: Date | number): number {
  const ms = typeof date === "number" ? date : date.getTime();
  return Math.floor((ms - FIT_EPOCH_MS) / 1000);
}

/** Degrees → semicircles. */
export function semicircles(deg: number): number {
  return Math.round((deg * 2 ** 31) / 180);
}

type FieldDef = [num: number, size: number, baseType: number];
type DevFieldDef = [num: number, size: number, devIndex: number];
type Value = number | string | Uint8Array | null;

interface Definition {
  global: number;
  fields: FieldDef[];
  devFields: DevFieldDef[];
}

export class FitBuilder {
  private readonly chunks: number[] = [];
  private readonly defs = new Map<number, Definition>();
  private readonly headerSize: 12 | 14;

  constructor(opts: { headerSize?: 12 | 14 } = {}) {
    this.headerSize = opts.headerSize ?? 14;
  }

  define(
    local: number,
    global: number,
    fields: FieldDef[],
    devFields: DevFieldDef[] = [],
  ): this {
    const header = 0x40 | (devFields.length > 0 ? 0x20 : 0) | (local & 0x0f);
    this.chunks.push(header, 0, 0, global & 0xff, (global >> 8) & 0xff);
    this.chunks.push(fields.length);
    for (const [num, size, bt] of fields) this.chunks.push(num, size, bt);
    if (devFields.length > 0) {
      this.chunks.push(devFields.length);
      for (const [num, size, idx] of devFields)
        this.chunks.push(num, size, idx);
    }
    this.defs.set(local, { global, fields, devFields });
    return this;
  }

  /** A data message; `null` writes the base type's invalid value. */
  data(local: number, values: Value[], devValues: Value[] = []): this {
    this.chunks.push(local & 0x0f);
    this.writeValues(local, values, devValues);
    return this;
  }

  /** A data message under a compressed-timestamp header (local 0-3). */
  compressed(
    local: number,
    timeOffset: number,
    values: Value[],
    devValues: Value[] = [],
  ): this {
    this.chunks.push(0x80 | ((local & 0x3) << 5) | (timeOffset & 0x1f));
    this.writeValues(local, values, devValues);
    return this;
  }

  /** Bytes written as they are (for broken frames). */
  raw(bytes: number[]): this {
    for (const byte of bytes) this.chunks.push(byte);
    return this;
  }

  private writeValues(local: number, values: Value[], devValues: Value[]) {
    const def = this.defs.get(local);
    if (!def) throw new Error(`no definition for local ${local}`);
    def.fields.forEach(([, size, bt], i) =>
      this.writeValue(values[i] ?? null, size, bt),
    );
    def.devFields.forEach(([, size], i) =>
      this.writeValue(devValues[i] ?? null, size, BT.byte),
    );
  }

  private writeValue(value: Value, size: number, bt: number) {
    if (value instanceof Uint8Array || typeof value === "string") {
      const bytes =
        typeof value === "string" ? new TextEncoder().encode(value) : value;
      for (let i = 0; i < size; i += 1) this.chunks.push(bytes[i] ?? 0);
      return;
    }
    const buf = Buffer.alloc(size);
    if (value === null) {
      const invalid: Record<number, number> = {
        [BT.enum]: 0xff,
        [BT.uint8]: 0xff,
        [BT.sint8]: 0x7f,
        [BT.uint8z]: 0,
      };
      if (size === 1) buf[0] = invalid[bt] ?? 0xff;
      else buf.fill(0xff);
      if (bt === BT.sint16) buf.writeInt16LE(0x7fff);
      if (bt === BT.sint32) buf.writeInt32LE(0x7fffffff);
      this.chunks.push(...buf);
      return;
    }
    switch (bt) {
      case BT.sint8:
        buf.writeInt8(value);
        break;
      case BT.sint16:
        buf.writeInt16LE(value);
        break;
      case BT.uint16:
      case BT.uint16z:
        buf.writeUInt16LE(value);
        break;
      case BT.sint32:
        buf.writeInt32LE(value);
        break;
      case BT.uint32:
      case BT.uint32z:
        buf.writeUInt32LE(value);
        break;
      case BT.float32:
        buf.writeFloatLE(value);
        break;
      default:
        buf.writeUInt8(value);
    }
    this.chunks.push(...buf);
  }

  /** The finished file: header (with its CRC on a 14-byte header), data, file CRC. */
  build(): Buffer {
    const data = Buffer.from(this.chunks);
    const header = Buffer.alloc(this.headerSize);
    header[0] = this.headerSize;
    header[1] = 0x20;
    header.writeUInt16LE(2188, 2);
    header.writeUInt32LE(data.length, 4);
    header.write(".FIT", 8, "ascii");
    if (this.headerSize === 14) header.writeUInt16LE(crc16(header, 0, 12), 12);
    const body = Buffer.concat([header, data]);
    const crc = Buffer.alloc(2);
    crc.writeUInt16LE(crc16(body));
    return Buffer.concat([body, crc]);
  }
}

export interface ActivityOptions {
  start: Date;
  seconds: number;
  /** FIT sport / sub_sport numbers (1 running, 2 cycling; 0 generic). */
  sport?: number;
  subSport?: number;
  /** file_id.type: 4 = activity. */
  fileType?: number;
  withPositions?: boolean;
  /** Heart rate at second `i`; null leaves it invalid. */
  hr?: (i: number) => number | null;
}

const LAT = 51.4818;
const LON = 7.2162;

/**
 * A watch-style file: 14-byte header, a full timestamp on every record,
 * positions, enhanced speed and altitude, one lap, one session.
 */
export function buildWatchActivity(opts: ActivityOptions): Buffer {
  const t0 = fitTime(opts.start);
  const hr = opts.hr ?? ((i: number) => 120 + (i % 30));
  const b = new FitBuilder({ headerSize: 14 });
  b.define(0, 0, [
    [0, 1, BT.enum],
    [1, 2, BT.uint16],
    [2, 2, BT.uint16],
    [4, 4, BT.uint32],
  ]).data(0, [opts.fileType ?? 4, 1, 3415, t0]);
  b.define(1, 20, [
    [253, 4, BT.uint32],
    [0, 4, BT.sint32],
    [1, 4, BT.sint32],
    [3, 1, BT.uint8],
    [4, 1, BT.uint8],
    [73, 4, BT.uint32],
    [78, 4, BT.uint32],
  ]);
  for (let i = 0; i < opts.seconds; i += 1) {
    const withFix = opts.withPositions !== false;
    b.data(1, [
      t0 + i,
      withFix ? semicircles(LAT + i * 0.00001) : null,
      withFix ? semicircles(LON + i * 0.00001) : null,
      hr(i),
      85,
      3100,
      (100 + (i % 20)) * 5 + 2500,
    ]);
  }
  b.define(2, 19, [
    [253, 4, BT.uint32],
    [2, 4, BT.uint32],
  ]).data(2, [t0 + opts.seconds, t0]);
  b.define(3, 18, [
    [253, 4, BT.uint32],
    [2, 4, BT.uint32],
    [5, 1, BT.enum],
    [6, 1, BT.enum],
    [7, 4, BT.uint32],
    [8, 4, BT.uint32],
    [9, 4, BT.uint32],
    [11, 2, BT.uint16],
    [16, 1, BT.uint8],
    [17, 1, BT.uint8],
    [22, 2, BT.uint16],
  ]).data(3, [
    t0 + opts.seconds,
    t0,
    opts.sport ?? 1,
    opts.subSport ?? 0,
    opts.seconds * 1000,
    (opts.seconds - Math.min(10, Math.floor(opts.seconds / 10))) * 1000,
    opts.seconds * 310,
    Math.round(opts.seconds / 6),
    135,
    149,
    42,
  ]);
  b.define(4, 34, [
    [253, 4, BT.uint32],
    [1, 2, BT.uint16],
  ]).data(4, [t0 + opts.seconds, 1]);
  return b.build();
}

/**
 * A bike-computer-style file: 12-byte header without a header CRC, records
 * under compressed-timestamp headers, power and cadence, and two developer
 * fields whose names the caller chooses (to test hostile names).
 */
export function buildBikeComputerActivity(
  opts: ActivityOptions & { developerFieldNames?: [string, string] },
): Buffer {
  const t0 = fitTime(opts.start);
  const names = opts.developerFieldNames ?? ["core_temp", "smo2"];
  const b = new FitBuilder({ headerSize: 12 });
  b.define(0, 0, [
    [0, 1, BT.enum],
    [1, 2, BT.uint16],
    [4, 4, BT.uint32],
  ]).data(0, [opts.fileType ?? 4, 32, t0]);
  // developer_data_id
  b.define(5, 207, [
    [1, 16, BT.byte],
    [3, 1, BT.uint8],
  ]).data(5, [new Uint8Array(16).fill(7), 0]);
  // field_description, one per developer field
  b.define(6, 206, [
    [0, 1, BT.uint8],
    [1, 1, BT.uint8],
    [2, 1, BT.uint8],
    [3, 32, BT.string],
    [8, 8, BT.string],
  ]);
  b.data(6, [0, 0, BT.uint16, names[0], "u"]);
  b.data(6, [0, 1, BT.uint8, names[1], "u"]);
  // One record with a full timestamp anchors the compressed ones.
  b.define(1, 20, [
    [253, 4, BT.uint32],
    [3, 1, BT.uint8],
    [7, 2, BT.uint16],
    [4, 1, BT.uint8],
    [6, 2, BT.uint16],
  ]).data(1, [t0, opts.hr ? opts.hr(0) : 110, 180, 88, 8200]);
  b.define(
    2,
    20,
    [
      [3, 1, BT.uint8],
      [7, 2, BT.uint16],
      [4, 1, BT.uint8],
      [6, 2, BT.uint16],
    ],
    [
      [0, 2, 0],
      [1, 1, 0],
    ],
  );
  for (let i = 1; i < opts.seconds; i += 1) {
    const ts = t0 + i;
    b.compressed(
      2,
      ts & 0x1f,
      [opts.hr ? opts.hr(i) : 110 + (i % 40), 180 + (i % 50), 88, 8200 + i],
      [new Uint8Array([0x70, 0x0e]), new Uint8Array([60])],
    );
  }
  b.define(3, 18, [
    [253, 4, BT.uint32],
    [2, 4, BT.uint32],
    [5, 1, BT.enum],
    [6, 1, BT.enum],
    [7, 4, BT.uint32],
    [8, 4, BT.uint32],
    [9, 4, BT.uint32],
    [11, 2, BT.uint16],
    [20, 2, BT.uint16],
  ]).data(3, [
    t0 + opts.seconds,
    t0,
    opts.sport ?? 2,
    opts.subSport ?? 0,
    opts.seconds * 1000,
    opts.seconds * 1000,
    opts.seconds * 820,
    Math.round(opts.seconds / 4),
    200,
  ]);
  return b.build();
}

/** A one-member ZIP (deflate or stored), the shape of Garmin's export. */
export function zipOne(
  name: string,
  content: Buffer,
  opts: {
    stored?: boolean;
    declaredSize?: number;
    extra?: Array<[string, Buffer]>;
  } = {},
): Buffer {
  const members: Array<[string, Buffer]> = [
    [name, content],
    ...(opts.extra ?? []),
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [memberName, data] of members) {
    const method = opts.stored ? 0 : 8;
    const payload = opts.stored ? data : deflateRawSync(data);
    const nameBuf = Buffer.from(memberName, "utf8");
    const size =
      memberName === name && opts.declaredSize !== undefined
        ? opts.declaredSize
        : data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, payload);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

export function gzip(content: Buffer): Buffer {
  return gzipSync(content);
}
