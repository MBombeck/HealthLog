import { describe, expect, it } from "vitest";
import { readFileSync, unlinkSync } from "node:fs";

import {
  parseBoundary,
  streamMultipartToDisk,
} from "../stream-to-disk";

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
        `--${BOUNDARY}\r\n`
        + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
        + value
        + `\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + `Content-Type: application/octet-stream\r\n\r\n`,
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
      try { unlinkSync(result.filePath); } catch { /* ignore */ }
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

  it("throws when the named field is missing", async () => {
    const body = buildMultipartBody("export.zip", Buffer.from("x"), {
      something: "else",
    });
    // Override the filename to a field name that's NOT the captured one
    // by re-building without a file field at all.
    const onlyText = Buffer.from(
      `--${BOUNDARY}\r\n`
      + `Content-Disposition: form-data; name="userId"\r\n\r\n`
      + `u-1`
      + `\r\n`
      + `--${BOUNDARY}--\r\n`,
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
      streamMultipartToDisk(
        toWebStream(body),
        `application/json`,
        { maxBytes: 1024, fieldName: "file" },
      ),
    ).rejects.toThrow(/boundary/);
  });
});
