/**
 * A minimal ZIP64 writer for tests: stored members, every size and offset
 * moved into the ZIP64 extra field and the ZIP64 end record, the way a large
 * Health app export is written. fflate writes classic ZIP only.
 */
export function zip64Archive(
  files: Record<string, string>,
  options: { omitLocator?: boolean; omitExtra?: boolean } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(body, "utf8");
    const crc = crc32(data);

    const localExtra = Buffer.alloc(20);
    localExtra.writeUInt16LE(0x0001, 0);
    localExtra.writeUInt16LE(16, 2);
    localExtra.writeBigUInt64LE(BigInt(data.length), 4);
    localExtra.writeBigUInt64LE(BigInt(data.length), 12);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const localRecord = Buffer.concat([local, nameBytes, localExtra, data]);

    const centralExtra = Buffer.alloc(28);
    centralExtra.writeUInt16LE(0x0001, 0);
    centralExtra.writeUInt16LE(24, 2);
    centralExtra.writeBigUInt64LE(BigInt(data.length), 4);
    centralExtra.writeBigUInt64LE(BigInt(data.length), 12);
    centralExtra.writeBigUInt64LE(BigInt(offset), 20);
    const extra = options.omitExtra ? Buffer.alloc(0) : centralExtra;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(45, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(0xffffffff, 42);
    centrals.push(Buffer.concat([central, nameBytes, extra]));

    locals.push(localRecord);
    offset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const centralOffset = offset;
  const count = Object.keys(files).length;

  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(centralDirectory.length), 40);
  record.writeBigUInt64LE(BigInt(centralOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(centralOffset + centralDirectory.length), 8);
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);

  return Buffer.concat([
    ...locals,
    centralDirectory,
    record,
    ...(options.omitLocator ? [] : [locator]),
    eocd,
  ]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
