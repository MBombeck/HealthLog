/**
 * The multipart reader against generated bodies.
 *
 * For any body and any way the network cuts it into chunks, the reader either
 * returns the captured file or refuses with one of its two errors, and a
 * refusal leaves no temp file behind. A body that a well-formed client would
 * send reads back byte for byte, whatever the chunking.
 *
 * The properties found two defects. A second part under the captured field's
 * name wrote into a stream that had already ended and surfaced Node's own
 * "write after end", which the route echoed to the client; and a body that
 * ended without its closing boundary was taken as complete, with the bytes
 * held back for the boundary search dropped from the end of the file. Both
 * are `MultipartMalformedError` now, and only that error's text reaches a
 * response.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";

import {
  MultipartMalformedError,
  MultipartTooLargeError,
  streamMultipartToDisk,
} from "../stream-to-disk";

import { assertAsyncProperty } from "../../../../tests/property/fast-check";

const TMP = mkdtempSync(join(tmpdir(), "multipart-fuzz-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const BOUNDARY = "----hlfuzz7MA4YWxkTrZu0gW";
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

function chunked(
  bytes: Uint8Array,
  cuts: number[],
): ReadableStream<Uint8Array> {
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (const cut of cuts) {
    if (at >= bytes.length) break;
    pieces.push(bytes.slice(at, at + Math.max(1, cut)));
    at += Math.max(1, cut);
  }
  if (at < bytes.length) pieces.push(bytes.slice(at));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < pieces.length) controller.enqueue(pieces[i++]);
      else controller.close();
    },
  });
}

function wellFormed(
  file: Uint8Array,
  textFields: Array<[string, string]>,
): Uint8Array {
  const parts: Buffer[] = [];
  for (const [name, value] of textFields) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="export.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    Buffer.from(file),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  );
  return new Uint8Array(Buffer.concat(parts));
}

/** Pieces a hostile body is built from: boundary fragments and part headers. */
const hostilePiece = fc.oneof(
  fc.constantFrom(
    `--${BOUNDARY}`,
    `--${BOUNDARY}--`,
    `\r\n--${BOUNDARY}`,
    "\r\n",
    "\r\n\r\n",
    "--",
    " \t",
    'Content-Disposition: form-data; name="file"; filename="a"',
    'Content-Disposition: form-data; name="other"',
    "Content-Disposition: form-data",
    `--${BOUNDARY.slice(0, 10)}`,
  ),
  fc
    .uint8Array({ maxLength: 64 })
    .map((b) => Buffer.from(b).toString("latin1")),
);
const hostileBody = fc
  .array(hostilePiece, { maxLength: 30 })
  .map((ps) => new Uint8Array(Buffer.from(ps.join(""), "latin1")));
const cuts = fc.array(fc.integer({ min: 1, max: 97 }), { maxLength: 40 });
const textValue = fc
  .string({ maxLength: 40 })
  .filter((s) => !s.includes(BOUNDARY));

function leftovers(): string[] {
  return readdirSync(TMP);
}

describe("streamMultipartToDisk under generated bodies", () => {
  it("returns the file or refuses with its own errors, and cleans up", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(
        fc.oneof(
          hostileBody,
          fc.uint8Array({ maxLength: 300 }),
          // A well-formed body with one byte range overwritten.
          fc
            .tuple(
              fc.uint8Array({ maxLength: 200 }),
              fc.nat(),
              fc.uint8Array({ minLength: 1, maxLength: 8 }),
            )
            .map(([file, at, junk]) => {
              const body = wellFormed(file, [["kind", "x"]]);
              body.set(
                junk.slice(0, Math.max(0, body.length - (at % body.length))),
                at % body.length,
              );
              return body;
            }),
        ),
        cuts,
        async (body, cut) => {
          const before = leftovers().length;
          try {
            const out = await streamMultipartToDisk(
              chunked(body, cut),
              CONTENT_TYPE,
              {
                maxBytes: 4096,
                fieldName: "file",
                tmpDir: TMP,
              },
            );
            expect(out.bytes).toBeGreaterThan(0);
            expect(readFileSync(out.filePath).length).toBe(out.bytes);
            rmSync(out.filePath);
          } catch (err) {
            expect(
              err instanceof MultipartMalformedError ||
                err instanceof MultipartTooLargeError,
            ).toBe(true);
          }
          expect(leftovers().length).toBe(before);
        },
      ),
      300,
    );
  });

  it("reads a well-formed body back exactly, however it is chunked", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 2048 }),
        fc.array(fc.tuple(fc.constantFrom("kind", "note", "tz"), textValue), {
          maxLength: 3,
        }),
        cuts,
        async (file, fields, cut) => {
          const out = await streamMultipartToDisk(
            chunked(wellFormed(file, fields), cut),
            CONTENT_TYPE,
            { maxBytes: 4096, fieldName: "file", tmpDir: TMP },
          );
          try {
            expect(out.bytes).toBe(file.length);
            expect(out.sha256).toBe(
              createHash("sha256").update(file).digest("hex"),
            );
            expect(
              Buffer.compare(readFileSync(out.filePath), Buffer.from(file)),
            ).toBe(0);
            expect(out.originalFilename).toBe("export.zip");
            for (const [name, value] of fields) {
              // A later part of the same name wins, as in a form.
              const last = fields.filter(([n]) => n === name).at(-1)![1];
              expect(out.textFields[name]).toBe(last);
              void value;
            }
          } finally {
            rmSync(out.filePath, { force: true });
          }
        },
      ),
      200,
    );
  });
});

describe("streamMultipartToDisk refusals found by the properties", () => {
  const part = (name: string, body: string) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.bin"\r\n\r\n${body}\r\n`;

  it("refuses a second part under the captured field's name", async () => {
    const body = new TextEncoder().encode(
      part("file", "first") + part("file", "second") + `--${BOUNDARY}--\r\n`,
    );
    const err = await streamMultipartToDisk(chunked(body, []), CONTENT_TYPE, {
      maxBytes: 4096,
      fieldName: "file",
      tmpDir: TMP,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultipartMalformedError);
    expect((err as Error).message).toContain("more than one 'file' part");
    expect(leftovers()).toEqual([]);
  });

  it("refuses a body that ends before its closing boundary", async () => {
    const body = new TextEncoder().encode(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\n\r\n` +
        "PK".padEnd(500, "z"),
    );
    const err = await streamMultipartToDisk(chunked(body, [64]), CONTENT_TYPE, {
      maxBytes: 4096,
      fieldName: "file",
      tmpDir: TMP,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultipartMalformedError);
    expect((err as Error).message).toContain("closing boundary");
    expect(leftovers()).toEqual([]);
  });
});
