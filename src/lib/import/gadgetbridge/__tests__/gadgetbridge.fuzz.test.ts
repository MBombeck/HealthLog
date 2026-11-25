/**
 * The Gadgetbridge import against damaged databases.
 *
 * The upload is an SQLite file, and SQLite reads a damaged one lazily: the
 * header and schema can be fine while a page the importer reaches later is
 * not. The property overwrites bytes of a real export, past the header and
 * across the pages, and runs the whole read path (every table, every batch)
 * with the write stage stubbed out. The run either completes or refuses the
 * file with a `RecordFileImportError`; an SQLite error reaching the worker
 * would fail the job as an internal error and report it as one.
 */
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import fc from "fast-check";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/import/file-import/write-measurements", () => ({
  writeImportedMeasurements: vi.fn(async () => undefined),
}));

import { RecordFileImportError } from "@/lib/import/file-import/kinds";
import { RecordFileImportTally } from "@/lib/import/file-import/tally";

import { importGadgetbridgeExport } from "../import";
import { buildGadgetbridgeFixture } from "./fixture";

import {
  assertAsyncProperty,
  propertyTimeout,
} from "../../../../../tests/property/fast-check";

const FIXTURE = buildGadgetbridgeFixture();
const BYTES = readFileSync(FIXTURE);
const WORK = mkdtempSync(join(tmpdir(), "gb-fuzz-"));

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
  rmSync(dirname(FIXTURE), { recursive: true, force: true });
});

let n = 0;
async function importBytes(bytes: Buffer): Promise<unknown> {
  const path = join(WORK, `Gadgetbridge-${n++}`);
  writeFileSync(path, bytes);
  try {
    await importGadgetbridgeExport({
      userId: "user-1",
      dbPath: path,
      tz: "Europe/Berlin",
      tally: new RecordFileImportTally("gadgetbridge"),
    });
    return null;
  } catch (err) {
    return err;
  } finally {
    rmSync(path, { force: true });
  }
}

describe("importGadgetbridgeExport on damaged files", () => {
  it("reads the intact fixture", async () => {
    expect(await importBytes(BYTES)).toBeNull();
  });

  it(
    "completes or refuses the file, for any damage past the header",
    async () => {
      await assertAsyncProperty(
        fc.asyncProperty(
          fc.array(
            fc.tuple(
              fc.integer({ min: 100, max: BYTES.length - 1 }),
              fc.uint8Array({ minLength: 1, maxLength: 16 }),
            ),
            { minLength: 1, maxLength: 8 },
          ),
          async (edits) => {
            const bytes = Buffer.from(BYTES);
            for (const [at, junk] of edits) {
              bytes.set(junk.subarray(0, bytes.length - at), at);
            }
            const err = await importBytes(bytes);
            if (err !== null) expect(err).toBeInstanceOf(RecordFileImportError);
          },
        ),
        60,
      );
    },
    propertyTimeout(120_000),
  );

  it(
    "refuses arbitrary bytes and a truncated file",
    async () => {
      await assertAsyncProperty(
        fc.asyncProperty(
          fc.oneof(
            fc.uint8Array({ maxLength: 4096 }).map((b) => Buffer.from(b)),
            fc
              .nat({ max: BYTES.length - 1 })
              .map((len) => BYTES.subarray(0, len)),
          ),
          async (bytes) => {
            const err = await importBytes(Buffer.from(bytes));
            if (err !== null) expect(err).toBeInstanceOf(RecordFileImportError);
          },
        ),
        40,
      );
    },
    propertyTimeout(120_000),
  );
});
