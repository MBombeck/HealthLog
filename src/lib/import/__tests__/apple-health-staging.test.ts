/**
 * The sweep removes staged exports no running import can own, and nothing
 * else. Mutations that must turn this red: drop the age check (the fresh
 * upload of a running import goes), or widen the name pattern (a file the app
 * did not write goes).
 */
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  STAGING_MAX_AGE_MS,
  sweepStaleImportStaging,
} from "../apple-health-staging";

describe("sweepStaleImportStaging", () => {
  it("removes old staged uploads and extracted XML, and leaves the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "healthlog-sweep-"));
    const uuid = "0b7f3c2a-1d4e-4f5a-9b8c-7d6e5f4a3b2c";
    const names = {
      oldUpload: `healthlog-apple-health-import-${uuid}.bin`,
      oldAdminUpload: `healthlog-admin-apple-health-import-${uuid}.bin`,
      oldXml: `healthlog-import-${"ab".repeat(12)}.xml`,
      freshUpload: `healthlog-upload-${uuid}.bin`,
      foreign: "somebody-elses-file.bin",
    };
    for (const name of Object.values(names)) {
      writeFileSync(join(dir, name), "x");
    }
    const now = Date.now();
    const old = new Date(now - STAGING_MAX_AGE_MS - 60_000);
    for (const name of [
      names.oldUpload,
      names.oldAdminUpload,
      names.oldXml,
      names.foreign,
    ]) {
      utimesSync(join(dir, name), old, old);
    }

    expect(await sweepStaleImportStaging(dir, now)).toBe(3);
    expect(readdirSync(dir).sort()).toEqual(
      [names.foreign, names.freshUpload].sort(),
    );
  });

  it("keeps what a queued or running import still owns, whatever its age", async () => {
    const dir = mkdtempSync(join(tmpdir(), "healthlog-sweep-"));
    const uuid = "0b7f3c2a-1d4e-4f5a-9b8c-7d6e5f4a3b2c";
    const queued = `healthlog-apple-health-import-${uuid}.bin`;
    const orphan = `healthlog-upload-${uuid}.bin`;
    const xml = `healthlog-import-${"cd".repeat(12)}.xml`;
    const now = Date.now();
    const old = new Date(now - STAGING_MAX_AGE_MS - 60_000);
    for (const name of [queued, orphan, xml]) {
      writeFileSync(join(dir, name), "x");
      utimesSync(join(dir, name), old, old);
    }

    expect(
      await sweepStaleImportStaging(dir, now, {
        paths: new Set([join(dir, queued)]),
        extractedInUse: true,
      }),
    ).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([queued, xml].sort());
  });

  it("removes a Health Connect upload and its extracted database once they are old", async () => {
    const dir = mkdtempSync(join(tmpdir(), "healthlog-sweep-"));
    const uuid = "0b7f3c2a-1d4e-4f5a-9b8c-7d6e5f4a3b2c";
    const upload = `healthlog-health-connect-import-${uuid}.bin`;
    const db = `healthlog-hc-import-${"ef".repeat(12)}.db`;
    const foreign = "health_connect_export.db";
    const now = Date.now();
    const old = new Date(now - STAGING_MAX_AGE_MS - 60_000);
    for (const name of [upload, db, foreign]) {
      writeFileSync(join(dir, name), "x");
      utimesSync(join(dir, name), old, old);
    }
    expect(await sweepStaleImportStaging(dir, now)).toBe(2);
    expect(readdirSync(dir)).toEqual([foreign]);
  });

  it("keeps an extracted database while an import is reading one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "healthlog-sweep-"));
    const db = `healthlog-hc-import-${"ab".repeat(12)}.db`;
    const now = Date.now();
    const old = new Date(now - STAGING_MAX_AGE_MS - 60_000);
    writeFileSync(join(dir, db), "x");
    utimesSync(join(dir, db), old, old);
    expect(
      await sweepStaleImportStaging(dir, now, {
        paths: new Set(),
        extractedInUse: true,
      }),
    ).toBe(0);
  });

  it("answers zero for a directory that is not there", async () => {
    expect(await sweepStaleImportStaging("/nonexistent/healthlog")).toBe(0);
  });
});
