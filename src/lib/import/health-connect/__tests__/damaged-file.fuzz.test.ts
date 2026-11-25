/**
 * A damaged Health Connect database, read to the end.
 *
 * SQLite reads pages lazily: the header, the version and the schema of a file
 * can be sound while a page that one of the record tables lives on is not.
 * The Gadgetbridge property found that such a file failed the import with
 * SQLite's own "database disk image is malformed" as an internal error; this
 * reader shares the SQLite thread, so it gets the same property. Opening the
 * file and reading every table either succeeds or refuses the file with a
 * `HealthConnectImportError`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";

import { buildHealthConnectFixture } from "../../../../../tests/fixtures/health-connect/build-fixture";
import {
  assertAsyncProperty,
  propertyTimeout,
} from "../../../../../tests/property/fast-check";
import {
  HC_TABLES,
  HealthConnectImportError,
  openHealthConnectDb,
} from "../reader";

const DIR = mkdtempSync(join(tmpdir(), "hc-damage-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const FIXTURE = join(DIR, "fixture.db");
buildHealthConnectFixture(FIXTURE);
const BYTES = readFileSync(FIXTURE);

let n = 0;
async function readAll(bytes: Buffer): Promise<unknown> {
  const path = join(DIR, `damaged-${n++}.db`);
  writeFileSync(path, bytes);
  try {
    const db = await openHealthConnectDb(path);
    try {
      for (const table of HC_TABLES) {
        if (!db.columns(table)) continue;
        for await (const batch of db.batches(`SELECT * FROM "${table}"`)) {
          void batch;
        }
        await db.all(`SELECT COUNT(*) AS n FROM "${table}"`);
      }
    } finally {
      await db.close();
    }
    return null;
  } catch (err) {
    return err;
  } finally {
    rmSync(path, { force: true });
  }
}

describe("a damaged Health Connect database", () => {
  it("reads the intact fixture", async () => {
    expect(await readAll(BYTES)).toBeNull();
  });

  it(
    "is read to the end or refused as the uploader's file",
    async () => {
      const outcomes = new Set<string>();
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
            const err = await readAll(bytes);
            outcomes.add(err === null ? "read" : (err as Error).name);
            if (err !== null) {
              expect(err).toBeInstanceOf(HealthConnectImportError);
            }
          },
        ),
        60,
      );
      // Some damage must have reached a refusal, or the property proved
      // nothing about the refusal path.
      expect(outcomes.has("HealthConnectImportError")).toBe(true);
    },
    propertyTimeout(120_000),
  );
});
