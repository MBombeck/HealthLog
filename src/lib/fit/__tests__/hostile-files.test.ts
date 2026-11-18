/**
 * The files a review built to take the server down, refused before the
 * decoder sees them.
 *
 * One `record` definition with 86 one-byte fields, then data messages of it,
 * written straight into a buffer the way the probe wrote them. 340 000 of
 * them gzip to about 1.4 MB and inflate to about 31 MB; decoded, they held
 * 738 MB of heap and killed a process capped at 512 MB. 85 000 of them stay
 * under the inflate cap and still declare seven million decoded fields.
 */
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { crc16 } from "../../../../tests/fixtures/fit/build-fit";
import { unwrapFitUpload } from "../container";
import { FitImportError } from "../errors";
import { scanFitFile } from "../scan";

const FIELDS = 86;

function wideRecords(messages: number): Buffer {
  const defLen = 6 + 3 * (FIELDS + 1);
  const msgLen = 1 + 4 + FIELDS;
  const dataSize = defLen + messages * msgLen;
  const buf = Buffer.alloc(14 + dataSize + 2);
  buf[0] = 14;
  buf[1] = 0x20;
  buf.writeUInt16LE(2132, 2);
  buf.writeUInt32LE(dataSize, 4);
  buf.write(".FIT", 8, "ascii");
  buf.writeUInt16LE(crc16(buf, 0, 12), 12);
  let p = 14;
  buf[p++] = 0x40;
  buf[p++] = 0;
  buf[p++] = 0;
  buf.writeUInt16LE(20, p);
  p += 2;
  buf[p++] = FIELDS + 1;
  buf[p++] = 253;
  buf[p++] = 4;
  buf[p++] = 0x86;
  for (let f = 0; f < FIELDS; f += 1) {
    buf[p++] = f;
    buf[p++] = 1;
    buf[p++] = 0x02;
  }
  for (let i = 0; i < messages; i += 1) {
    buf[p++] = 0;
    buf.writeUInt32LE(1_000_000_000 + i, p);
    p += 4;
    for (let f = 0; f < FIELDS; f += 1) buf[p++] = ((i + f) % 200) + 1;
  }
  buf.writeUInt16LE(crc16(buf, 0, p), p);
  return buf;
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof FitImportError ? err.code : `other:${String(err)}`;
  }
}

describe("hostile FIT uploads", () => {
  it("refuses the 1.4 MB gzip that inflated to 31 MB", () => {
    const upload = gzipSync(wideRecords(340_000), { level: 9 });
    expect(upload.length).toBeLessThan(2 * 1024 * 1024);
    expect(codeOf(() => unwrapFitUpload(upload))).toBe("too_large");
  });

  it("refuses the same shape under the inflate cap by its field count", () => {
    const { fit } = unwrapFitUpload(gzipSync(wideRecords(85_000)));
    expect(codeOf(() => scanFitFile(fit))).toBe("too_complex");
  });
});
