import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

import {
  MULTIPART_ENVELOPE_RESERVE_BYTES,
  MultipartTooLargeError,
  parseBoundary,
  streamMultipartToDisk,
} from "../stream-to-disk";
import { extractExportXml } from "@/lib/import/unzip-export-xml";

const BOUNDARY = "----HealthLogTestBoundary";

/**
 * Build a multipart body covering the canonical Apple Health import
 * upload shape: one named `file` field + one text `userId` field.
 */
function buildMultipartBody(
  filename: string,
  fileContent: Buffer,
  textFields: Record<string, string> = {},
): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(textFields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          value +
          `\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(fileContent);
  parts.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

function toWebStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

describe("parseBoundary", () => {
  it("extracts a quoted boundary", () => {
    expect(parseBoundary(`multipart/form-data; boundary="abc-123"`)).toBe(
      "abc-123",
    );
  });

  it("extracts an unquoted boundary", () => {
    expect(parseBoundary(`multipart/form-data; boundary=abc-123`)).toBe(
      "abc-123",
    );
  });

  it("returns null on a missing header", () => {
    expect(parseBoundary(null)).toBeNull();
    expect(parseBoundary("application/json")).toBeNull();
  });
});

describe("streamMultipartToDisk", () => {
  it("streams the file field to disk + captures text fields + sha256", async () => {
    const payload = Buffer.from("the quick brown fox jumps over the lazy dog");
    const body = buildMultipartBody("export.zip", payload, { userId: "u-1" });
    const result = await streamMultipartToDisk(
      toWebStream(body),
      `multipart/form-data; boundary=${BOUNDARY}`,
      {
        maxBytes: 1024,
        fieldName: "file",
      },
    );

    try {
      expect(result.bytes).toBe(payload.length);
      expect(result.originalFilename).toBe("export.zip");
      expect(result.textFields.userId).toBe("u-1");
      const written = readFileSync(result.filePath);
      expect(written.equals(payload)).toBe(true);
      // SHA-256 of the well-known phrase
      expect(result.sha256).toBe(
        "05c6e08f1d9fdafa03147fcb8f82f124c76d2f70e3d989dc8aadb5e7d7450bec",
      );
    } finally {
      try {
        unlinkSync(result.filePath);
      } catch {
        /* ignore */
      }
    }
  });

  it("throws when the upload exceeds the size cap", async () => {
    const payload = Buffer.alloc(2048, 0x41);
    const body = buildMultipartBody("export.zip", payload);
    await expect(
      streamMultipartToDisk(
        toWebStream(body),
        `multipart/form-data; boundary=${BOUNDARY}`,
        { maxBytes: 100, fieldName: "file" },
      ),
    ).rejects.toThrow(/size cap/);
  });

  // What was written before the refusal is the person's export in plain
  // text; it must not stay behind in the temp directory.
  it("removes the partial file when the upload is refused part-way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "healthlog-stream-"));
    const body = buildMultipartBody("export.zip", Buffer.alloc(4096, 0x41));
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += 256) {
          controller.enqueue(new Uint8Array(body.subarray(i, i + 256)));
        }
        controller.close();
      },
    });
    await expect(
      streamMultipartToDisk(
        chunked,
        `multipart/form-data; boundary=${BOUNDARY}`,
        { maxBytes: 1000, fieldName: "file", tmpDir: dir },
      ),
    ).rejects.toThrow(/size cap/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("throws when the named field is missing", async () => {
    const body = buildMultipartBody("export.zip", Buffer.from("x"), {
      something: "else",
    });
    // Override the filename to a field name that's NOT the captured one
    // by re-building without a file field at all.
    const onlyText = Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="userId"\r\n\r\n` +
        `u-1` +
        `\r\n` +
        `--${BOUNDARY}--\r\n`,
    );
    void body; // referenced above for shape demo
    await expect(
      streamMultipartToDisk(
        toWebStream(onlyText),
        `multipart/form-data; boundary=${BOUNDARY}`,
        { maxBytes: 1024, fieldName: "file" },
      ),
    ).rejects.toThrow(/file/);
  });

  it("throws when the boundary is missing from the header", async () => {
    const body = buildMultipartBody("export.zip", Buffer.from("x"));
    await expect(
      streamMultipartToDisk(toWebStream(body), `application/json`, {
        maxBytes: 1024,
        fieldName: "file",
      }),
    ).rejects.toThrow(/boundary/);
  });
});

/**
 * Deterministic pseudo-random binary that contains the byte sequences a
 * multipart parser is most likely to mis-handle: bare CRLF (0x0D 0x0A),
 * "--" runs (0x2D 0x2D), and partial boundary-marker prefixes. None of
 * these is the full boundary marker (the sender guarantees the marker
 * cannot appear in the content), so a correct parser must copy every
 * byte through verbatim.
 */
function makeAdversarialBinary(n: number): Buffer {
  const b = Buffer.alloc(n);
  let s = 0x12345678 >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    b[i] = (s >>> 16) & 0xff;
  }
  const partialMarker = Buffer.from(`\r\n--${BOUNDARY.slice(0, 12)}`);
  for (let off = 100; off + partialMarker.length < n; off += 991) {
    partialMarker.copy(b, off);
  }
  for (let off = 37; off + 1 < n; off += 257) {
    b[off] = 0x0d;
    b[off + 1] = 0x0a;
  }
  return b;
}

/** Build a single-entry deflate ZIP wrapping the supplied member. */
function buildZip(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const compressed = deflateRawSync(data);
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0 ^ -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
  }
  const crc32 = (crc ^ -1) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(8, 10);
  cdh.writeUInt32LE(crc32, 16);
  cdh.writeUInt32LE(compressed.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);

  const localFull = Buffer.concat([local, nameBuf, compressed]);
  const cdhFull = Buffer.concat([cdh, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdhFull.length, 12);
  eocd.writeUInt32LE(localFull.length, 16);

  return Buffer.concat([localFull, cdhFull, eocd]);
}

/** Feed `buf` to a ReadableStream in the repeating chunk sizes given. */
function fixedChunkStream(
  buf: Buffer,
  sizes: number[],
): ReadableStream<Uint8Array> {
  let i = 0;
  let si = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= buf.length) {
        controller.close();
        return;
      }
      const size = sizes[si % sizes.length];
      si++;
      const end = Math.min(buf.length, i + size);
      controller.enqueue(new Uint8Array(buf.subarray(i, end)));
      i = end;
    },
  });
}

/** Split `buf` at the explicit byte offsets given. */
function splitAtStream(
  buf: Buffer,
  points: number[],
): ReadableStream<Uint8Array> {
  const segments: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    segments.push(buf.subarray(prev, p));
    prev = p;
  }
  segments.push(buf.subarray(prev));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= segments.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(segments[i]));
      i++;
    },
  });
}

describe("streamMultipartToDisk — large multi-chunk binary round-trip", () => {
  // Regression for the cross-chunk boundary-suffix loss: a chunk that
  // ended exactly on the opening boundary marker dropped the parser back
  // into a fresh marker search and swallowed the whole part body, so a
  // multi-chunk upload landed on disk truncated. The downstream ZIP
  // reader then failed with "Could not locate ZIP End-Of-Central-Directory
  // record". A tiny single-chunk upload never tripped it.
  it("writes a multi-MB binary byte-exact under coarse chunkings", async () => {
    // A few-MB payload exercises many chunks at realistic network sizes —
    // this is the shape the wild 40 MB upload took.
    const fileContent = makeAdversarialBinary(3 * 1024 * 1024 + 777);
    const expectedSha = createHash("sha256").update(fileContent).digest("hex");
    const body = buildMultipartBody("export.zip", fileContent, {
      userId: "u-1",
    });

    const markerLen = `--${BOUNDARY}`.length;
    const sepLen = `\r\n--${BOUNDARY}`.length;
    const chunkings: number[][] = [
      [body.length], // single chunk (the trivially-passing case)
      [4096],
      [16384, markerLen, 1, 2, 3], // realistic chunks then tiny tails
      // A repeating size aligned so chunks routinely end on / inside the
      // boundary marker — the exact window the bug lived in.
      [markerLen, 8192],
      [sepLen - 1, 8192], // ends one byte short of the full separator
      [1024, 64, 5000, 13, 8192], // odd repeating mix
    ];

    for (const sizes of chunkings) {
      const result = await streamMultipartToDisk(
        fixedChunkStream(body, sizes),
        `multipart/form-data; boundary=${BOUNDARY}`,
        { maxBytes: 1.5 * 1024 * 1024 * 1024, fieldName: "file" },
      );
      try {
        expect(result.bytes, `bytes for chunking ${sizes}`).toBe(
          fileContent.length,
        );
        expect(result.sha256, `sha for chunking ${sizes}`).toBe(expectedSha);
        const written = readFileSync(result.filePath);
        expect(
          written.equals(fileContent),
          `byte-exact for chunking ${sizes}`,
        ).toBe(true);
        expect(result.textFields.userId).toBe("u-1");
      } finally {
        try {
          unlinkSync(result.filePath);
        } catch {
          /* ignore */
        }
      }
    }
  }, 20_000);

  it("writes byte-exact under fine (1/3/7-byte) chunkings", async () => {
    // The pathological 1-byte feed is the cleanest reproduction of the
    // boundary-suffix-loss bug; keep the payload small so the per-chunk
    // file writes stay fast while still spanning thousands of chunks.
    const fileContent = makeAdversarialBinary(16 * 1024 + 17);
    const expectedSha = createHash("sha256").update(fileContent).digest("hex");
    const body = buildMultipartBody("export.zip", fileContent, {
      userId: "u-1",
    });

    for (const sizes of [[1], [3], [7], [1, 3, 7, 2, 5, 13]]) {
      const result = await streamMultipartToDisk(
        fixedChunkStream(body, sizes),
        `multipart/form-data; boundary=${BOUNDARY}`,
        { maxBytes: 1024 * 1024, fieldName: "file" },
      );
      try {
        expect(result.bytes, `bytes for chunking ${sizes}`).toBe(
          fileContent.length,
        );
        expect(result.sha256, `sha for chunking ${sizes}`).toBe(expectedSha);
        const written = readFileSync(result.filePath);
        expect(
          written.equals(fileContent),
          `byte-exact for chunking ${sizes}`,
        ).toBe(true);
      } finally {
        try {
          unlinkSync(result.filePath);
        } catch {
          /* ignore */
        }
      }
    }
  }, 20_000);

  it("survives a chunk split at every offset (single + adjacent)", async () => {
    // Small body, exhaustive split coverage — the failing case in the
    // wild was a chunk boundary landing in a specific window; assert no
    // offset can corrupt the captured bytes.
    const fileContent = Buffer.concat([
      Buffer.from("AAAA\r\n--BBBB"),
      Buffer.from(`\r\n--${BOUNDARY.slice(0, 12)}`),
      Buffer.from("CCCC\r\nDDDD\r\n--"),
      Buffer.from([0x0d, 0x0a, 0x2d, 0x2d, 0x00, 0xff]),
    ]);
    const expectedSha = createHash("sha256").update(fileContent).digest("hex");
    const body = buildMultipartBody("export.zip", fileContent, {
      userId: "u-1",
    });

    for (let p = 1; p < body.length; p++) {
      for (const points of [[p], [p, Math.min(p + 1, body.length)]]) {
        const result = await streamMultipartToDisk(
          splitAtStream(body, points),
          `multipart/form-data; boundary=${BOUNDARY}`,
          { maxBytes: 1024, fieldName: "file" },
        );
        try {
          expect(result.sha256, `sha at split ${points}`).toBe(expectedSha);
          const written = readFileSync(result.filePath);
          expect(
            written.equals(fileContent),
            `byte-exact at split ${points}`,
          ).toBe(true);
        } finally {
          try {
            unlinkSync(result.filePath);
          } catch {
            /* ignore */
          }
        }
      }
    }
  });

  it("a streamed export.zip stays a valid archive end-to-end", async () => {
    // Build a real deflate ZIP whose member contains binary-flavoured
    // XML, stream it through awkward chunkings, and confirm the file on
    // disk is still extractable — i.e. the EOCD record survives.
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n`;
    let s = 42 >>> 0;
    for (let i = 0; i < 8000; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      xml += `<Record type="HKQuantityTypeIdentifierStepCount" value="${s % 1000}"/>\n`;
    }
    xml += `</HealthData>\n`;
    const xmlBuf = Buffer.from(xml, "utf8");
    const zip = buildZip("apple_health_export/export.xml", xmlBuf);
    const expectedSha = createHash("sha256").update(zip).digest("hex");
    const body = buildMultipartBody("export.zip", zip, { userId: "u-1" });

    const markerLen = `--${BOUNDARY}`.length;
    for (const sizes of [[7], [markerLen, 257], [1, 3, 7, 64, 13, 257]]) {
      const result = await streamMultipartToDisk(
        fixedChunkStream(body, sizes),
        `multipart/form-data; boundary=${BOUNDARY}`,
        { maxBytes: 1.5 * 1024 * 1024 * 1024, fieldName: "file" },
      );
      let xmlPath: string | null = null;
      try {
        expect(result.sha256, `zip sha for chunking ${sizes}`).toBe(
          expectedSha,
        );
        const written = readFileSync(result.filePath);
        expect(written.equals(zip), `zip byte-exact for ${sizes}`).toBe(true);
        // The load-bearing assertion: the saved file is still a parseable
        // archive (EOCD intact) and the member round-trips.
        const extracted = await extractExportXml(result.filePath);
        xmlPath = extracted.xmlPath;
        expect(readFileSync(extracted.xmlPath).equals(xmlBuf)).toBe(true);
      } finally {
        try {
          unlinkSync(result.filePath);
        } catch {
          /* ignore */
        }
        if (xmlPath) {
          try {
            unlinkSync(xmlPath);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }, 20_000);
});

/**
 * Only the `file` part used to be held to `maxBytes`. A part under any other
 * name was collected in memory whole, and a header block that never ended
 * grew without bound, so a body with no Content-Length (chunked) or a large
 * one could fill the heap of the process that also serves the app. Every
 * byte read now counts against the cap plus a fixed envelope, a text part has
 * its own small ceiling, and so does a header block.
 */
describe("streamMultipartToDisk — everything outside the file part is bounded", () => {
  const CT = `multipart/form-data; boundary=${BOUNDARY}`;

  /** A pull stream of `head` then `fill` bytes in 64 KiB chunks, counting reads. */
  function countingStream(head: Buffer, fillBytes: number, tail?: Buffer) {
    const counter = { pulled: 0 };
    let sentHead = false;
    let remaining = fillBytes;
    let sentTail = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        let chunk: Buffer;
        if (!sentHead) {
          sentHead = true;
          chunk = head;
        } else if (remaining > 0) {
          const n = Math.min(remaining, 64 * 1024);
          remaining -= n;
          chunk = Buffer.alloc(n, 0x41);
        } else if (tail && !sentTail) {
          sentTail = true;
          chunk = tail;
        } else {
          controller.close();
          return;
        }
        counter.pulled += chunk.length;
        controller.enqueue(new Uint8Array(chunk));
      },
    });
    return { stream, counter };
  }

  it("refuses a text part larger than the text ceiling", async () => {
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
    // Smaller than the file cap, so only a ceiling of its own stops it.
    const { stream, counter } = countingStream(head, 4 * 1024 * 1024, tail);
    await expect(
      streamMultipartToDisk(stream, CT, {
        maxBytes: 64 * 1024 * 1024,
        fieldName: "file",
      }),
    ).rejects.toThrow(MultipartTooLargeError);
    expect(counter.pulled).toBeLessThan(1024 * 1024);
  });

  it("refuses a header block that never ends", async () => {
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="`,
    );
    const { stream, counter } = countingStream(head, 4 * 1024 * 1024);
    await expect(
      streamMultipartToDisk(stream, CT, {
        maxBytes: 64 * 1024 * 1024,
        fieldName: "file",
      }),
    ).rejects.toThrow(/header/i);
    expect(counter.pulled).toBeLessThan(1024 * 1024);
  });

  it("stops reading once the whole body passes the cap and its envelope", async () => {
    // A tiny file, then an epilogue that runs on: none of it is kept, but a
    // body the size of the cap's many times must not be read to its end.
    const body = buildMultipartBody("x.fit", Buffer.from("abc"));
    const { stream, counter } = countingStream(body, 8 * 1024 * 1024);
    await expect(
      streamMultipartToDisk(stream, CT, { maxBytes: 1024, fieldName: "file" }),
    ).rejects.toThrow(MultipartTooLargeError);
    expect(counter.pulled).toBeLessThan(
      1024 + MULTIPART_ENVELOPE_RESERVE_BYTES + 128 * 1024,
    );
  });

  it("still accepts the ordinary shape with a small text field", async () => {
    const body = buildMultipartBody("x.fit", Buffer.from("abc"), {
      userId: "u-1",
    });
    const result = await streamMultipartToDisk(toWebStream(body), CT, {
      maxBytes: 1024,
      fieldName: "file",
    });
    expect(result.textFields.userId).toBe("u-1");
    expect(result.bytes).toBe(3);
    unlinkSync(result.filePath);
  });
});
