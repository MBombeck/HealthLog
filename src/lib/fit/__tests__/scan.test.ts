import { describe, expect, it } from "vitest";

import {
  BT,
  FitBuilder,
  buildBikeComputerActivity,
  buildWatchActivity,
} from "../../../../tests/fixtures/fit/build-fit";
import { FitImportError } from "../errors";
import {
  FIT_MAX_DATA_MESSAGES,
  FIT_MAX_DEFINITIONS,
  FIT_MAX_DEVELOPER_FIELDS_PER_DEFINITION,
  FIT_MAX_FIELD_DESCRIPTIONS,
  FIT_MAX_FIELD_CELLS,
  fitCrc,
  scanFitFile,
} from "../scan";

const START = new Date("2026-10-01T08:00:00Z");

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof FitImportError ? err.code : `other:${String(err)}`;
  }
}

describe("scanFitFile", () => {
  it("accepts a watch file (14-byte header with header CRC)", () => {
    const file = buildWatchActivity({ start: START, seconds: 60 });
    const scan = scanFitFile(file);
    expect(scan.fileLength).toBe(file.length);
    expect(scan.dataMessages).toBe(1 + 60 + 1 + 1 + 1);
    expect(scan.definitions).toBe(5);
  });

  it("accepts compressed timestamps and developer fields (12-byte header)", () => {
    const file = buildBikeComputerActivity({ start: START, seconds: 90 });
    const scan = scanFitFile(file);
    expect(scan.maxDeveloperFields).toBe(2);
    expect(scan.fieldDescriptions).toBe(2);
    expect(scan.dataMessages).toBe(1 + 1 + 2 + 90 + 1);
  });

  it("matches the published FIT CRC check value", () => {
    // CRC-16/ARC, which the FIT CRC is: "123456789" → 0xBB3D.
    const bytes = new TextEncoder().encode("123456789");
    expect(fitCrc(bytes, 0, bytes.length)).toBe(0xbb3d);
  });

  it("refuses a flipped data byte (file CRC)", () => {
    const file = Buffer.from(buildWatchActivity({ start: START, seconds: 30 }));
    file[40] ^= 0xff;
    expect(codeOf(() => scanFitFile(file))).toBe("crc_mismatch");
  });

  it("refuses a damaged header CRC", () => {
    const file = Buffer.from(buildWatchActivity({ start: START, seconds: 30 }));
    file[12] ^= 0x01;
    expect(codeOf(() => scanFitFile(file))).toBe("crc_mismatch");
  });

  it("refuses a missing .FIT signature and odd header sizes", () => {
    const file = buildWatchActivity({ start: START, seconds: 5 });
    const noSig = Buffer.from(file);
    noSig.write("XFIT", 8, "ascii");
    expect(codeOf(() => scanFitFile(noSig))).toBe("not_fit");
    const odd = Buffer.from(file);
    odd[0] = 13;
    expect(codeOf(() => scanFitFile(odd))).toBe("not_fit");
    expect(codeOf(() => scanFitFile(Buffer.alloc(4)))).toBe("not_fit");
  });

  it("refuses a file cut short of its declared size", () => {
    const file = buildWatchActivity({ start: START, seconds: 30 });
    expect(codeOf(() => scanFitFile(file.subarray(0, file.length - 20)))).toBe(
      "malformed",
    );
  });

  it("refuses data that names no definition", () => {
    const file = new FitBuilder().raw([0x03, 1, 2, 3]).build();
    expect(codeOf(() => scanFitFile(file))).toBe("malformed");
  });

  it("refuses a last message that runs past the data", () => {
    const b = new FitBuilder();
    b.define(0, 20, [[3, 4, BT.uint32]]);
    b.raw([0x00, 1]);
    expect(codeOf(() => scanFitFile(b.build()))).toBe("malformed");
  });

  it("caps data messages", () => {
    const b = new FitBuilder();
    b.define(0, 20, []);
    b.raw(new Array<number>(FIT_MAX_DATA_MESSAGES + 1).fill(0x00));
    expect(codeOf(() => scanFitFile(b.build()))).toBe("too_complex");
  });

  it("caps definitions", () => {
    const b = new FitBuilder();
    for (let i = 0; i <= FIT_MAX_DEFINITIONS; i += 1) b.define(0, 20, []);
    expect(codeOf(() => scanFitFile(b.build()))).toBe("too_complex");
  });

  it("caps developer fields per definition", () => {
    const dev: Array<[number, number, number]> = [];
    for (let i = 0; i <= FIT_MAX_DEVELOPER_FIELDS_PER_DEFINITION; i += 1) {
      dev.push([i, 1, 0]);
    }
    const file = new FitBuilder().define(0, 20, [], dev).build();
    expect(codeOf(() => scanFitFile(file))).toBe("too_complex");
  });

  it("caps developer field descriptions", () => {
    const b = new FitBuilder();
    b.define(0, 206, [[1, 1, BT.uint8]]);
    for (let i = 0; i <= FIT_MAX_FIELD_DESCRIPTIONS; i += 1) {
      b.data(0, [i % 255]);
    }
    expect(codeOf(() => scanFitFile(b.build()))).toBe("too_complex");
  });

  it("frames only the first file of a chained upload", () => {
    const file = buildWatchActivity({ start: START, seconds: 5 });
    const chained = Buffer.concat([file, Buffer.from("trailing bytes")]);
    expect(scanFitFile(chained).fileLength).toBe(file.length);
  });

  it("sizes a compressed-timestamp message without the timestamp it omits", () => {
    // The definition opens with the timestamp (field 253); a message under a
    // compressed-timestamp header leaves those four bytes out.
    const b = new FitBuilder({ headerSize: 12 });
    b.define(0, 20, [
      [253, 4, BT.uint32],
      [3, 1, BT.uint8],
    ]).data(0, [1_100_000_000, 120]);
    for (let i = 0; i < 10; i += 1) b.raw([0x80 | (i & 0x1f), 121]);
    const scan = scanFitFile(b.build());
    expect(scan.dataMessages).toBe(11);
  });

  it("counts a compressed-timestamp flood against the message cap", () => {
    const b = new FitBuilder({ headerSize: 12 });
    b.define(0, 20, [
      [253, 4, BT.uint32],
      [3, 1, BT.uint8],
    ]).data(0, [1_100_000_000, 120]);
    for (let i = 0; i < FIT_MAX_DATA_MESSAGES; i += 1) {
      b.raw([0x80 | (i & 0x1f), 121]);
    }
    expect(codeOf(() => scanFitFile(b.build()))).toBe("too_complex");
  });

  it("refuses more decoded fields across the file than any activity holds", () => {
    // Few messages, each declaring a hundred one-byte fields: the decoder
    // builds an object per field, so the field count is what is bounded.
    const fields = Array.from(
      { length: 100 },
      (_, i) => [i + 10, 1, BT.uint8] as [number, number, number],
    );
    const b = new FitBuilder({ headerSize: 12 });
    b.define(0, 20, fields);
    const messages = Math.ceil(FIT_MAX_FIELD_CELLS / 100) + 1;
    const row = Array.from({ length: 100 }, () => 1);
    for (let i = 0; i < messages; i += 1) b.data(0, row);
    expect(messages).toBeLessThan(FIT_MAX_DATA_MESSAGES);
    expect(codeOf(() => scanFitFile(b.build()))).toBe("too_complex");
  });
});
