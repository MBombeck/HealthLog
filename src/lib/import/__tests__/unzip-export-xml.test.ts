import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";

import { extractExportXml, readCentralDirectory } from "../unzip-export-xml";

/**
 * Hand-build a single-entry deflate-compressed ZIP archive with the
 * supplied filename + payload. Enough to exercise the central-directory
 * walker + extractor without pulling in a full zip library.
 */
function buildMinimalZip(filename: string, payload: Buffer): Buffer {
  const compressed = deflateRawSync(payload);
  const crc32 = (() => {
    // Pre-computed lookup table for CRC-32. node:zlib has crc32 in 22+
    // but we keep the function inline to stay version-agnostic.
    let c: number;
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
    let crc = 0 ^ -1;
    for (let i = 0; i < payload.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ payload[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  })();

  const nameBuf = Buffer.from(filename, "utf8");
  // Local file header
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(8, 8); // method: deflate
  localHeader.writeUInt16LE(0, 10); // time
  localHeader.writeUInt16LE(0, 12); // date
  localHeader.writeUInt32LE(crc32, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(payload.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra len

  // Central directory file header
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4); // version made by
  cdh.writeUInt16LE(20, 6); // version needed
  cdh.writeUInt16LE(0, 8); // flags
  cdh.writeUInt16LE(8, 10); // method
  cdh.writeUInt16LE(0, 12); // time
  cdh.writeUInt16LE(0, 14); // date
  cdh.writeUInt32LE(crc32, 16);
  cdh.writeUInt32LE(compressed.length, 20);
  cdh.writeUInt32LE(payload.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30); // extra
  cdh.writeUInt16LE(0, 32); // comment
  cdh.writeUInt16LE(0, 34); // disk num
  cdh.writeUInt16LE(0, 36); // internal attrs
  cdh.writeUInt32LE(0, 38); // external attrs
  cdh.writeUInt32LE(0, 42); // local header offset

  // End of Central Directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk-with-cd
  eocd.writeUInt16LE(1, 8); // entries-on-disk
  eocd.writeUInt16LE(1, 10); // total-entries
  eocd.writeUInt32LE(46 + nameBuf.length, 12); // cd size
  // cd offset = local-header + name + data
  eocd.writeUInt32LE(30 + nameBuf.length + compressed.length, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([
    localHeader,
    nameBuf,
    compressed,
    cdh,
    nameBuf,
    eocd,
  ]);
}

describe("readCentralDirectory", () => {
  it("walks a single-entry archive", () => {
    const payload = Buffer.from("<HealthData/>");
    const zip = buildMinimalZip("apple_health_export/export.xml", payload);
    const entries = readCentralDirectory(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].fileName).toBe("apple_health_export/export.xml");
    expect(entries[0].compressionMethod).toBe(8);
    expect(entries[0].uncompressedSize).toBe(payload.length);
  });
});

describe("extractExportXml", () => {
  it("extracts the export.xml member to a temp file", () => {
    const payload = Buffer.from(
      `<?xml version="1.0"?><HealthData><ExportDate value="2026-05-15"/></HealthData>`,
    );
    const zip = buildMinimalZip("apple_health_export/export.xml", payload);
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-unzip-"));
    const zipPath = join(tmp, "export.zip");
    writeFileSync(zipPath, zip);

    const out = extractExportXml(zipPath);
    expect(out.xmlBytes).toBe(payload.length);
    expect(out.otherMembers).toHaveLength(0);

    const extracted = readFileSync(out.xmlPath);
    expect(extracted.toString("utf8")).toBe(payload.toString("utf8"));
  });

  it("throws when the export.xml member is missing", () => {
    const payload = Buffer.from("noop");
    const zip = buildMinimalZip("other-file.txt", payload);
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-unzip-"));
    const zipPath = join(tmp, "export.zip");
    writeFileSync(zipPath, zip);

    expect(() => extractExportXml(zipPath)).toThrow(/missing/);
  });
});
