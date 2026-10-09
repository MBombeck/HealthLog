/**
 * Pulling `health_connect_export.db` out of an uploaded ZIP: the member is
 * found by name, a forged header (a size above the cap, a bomb ratio) is
 * refused before anything is written, and the streamed output is held to the
 * cap whatever the header claims.
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildHealthConnectFixture,
  zipHealthConnectDb,
} from "../../../../tests/fixtures/health-connect/build-fixture";
import {
  extractHealthConnectDb,
  selectHealthConnectDbEntry,
} from "../unzip-export-xml";

function archive(options: Parameters<typeof zipHealthConnectDb>[2] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hc-unzip-"));
  const db = join(dir, "source.db");
  buildHealthConnectFixture(db, { days: 2 });
  const zip = join(dir, "Health Connect.zip");
  zipHealthConnectDb(db, zip, options);
  return { db, zip };
}

const extracted = () =>
  readdirSync(tmpdir()).filter((n) =>
    /^healthlog-hc-import-[0-9a-f]{24}\.db$/.test(n),
  );

describe("extractHealthConnectDb", () => {
  it("writes the database member byte for byte", async () => {
    const { db, zip } = archive();
    const out = await extractHealthConnectDb(zip);
    try {
      expect(out.dbBytes).toBe(statSync(db).size);
      expect(readFileSync(out.dbPath).equals(readFileSync(db))).toBe(true);
    } finally {
      rmSync(out.dbPath, { force: true });
    }
  });

  it("refuses an archive without the database member", async () => {
    const { zip } = archive({ memberName: "export.xml" });
    await expect(extractHealthConnectDb(zip)).rejects.toThrow(
      /^not_health_connect:/,
    );
  });

  it("refuses a member that declares more than the cap", async () => {
    const { zip } = archive();
    await expect(
      extractHealthConnectDb(zip, { maxBytes: 1024 }),
    ).rejects.toThrow(/^too_large:/);
  });

  it("refuses a header that claims a zip-bomb ratio", async () => {
    const { zip } = archive({ declaredSize: 0xfffffff0 });
    await expect(
      extractHealthConnectDb(zip, { maxBytes: 0xffffffff }),
    ).rejects.toThrow(/compression ratio/);
  });

  it("holds the real output to the cap when the header understates it, and leaves nothing behind", async () => {
    const before = new Set(extracted());
    const { zip } = archive({ declaredSize: 1000 });
    await expect(
      extractHealthConnectDb(zip, { maxBytes: 2048 }),
    ).rejects.toThrow();
    expect(extracted().filter((n) => !before.has(n))).toEqual([]);
  });
});

describe("selectHealthConnectDbEntry", () => {
  it("finds the member in a folder and ignores macOS metadata", () => {
    const entries = [
      { fileName: "__MACOSX/health_connect_export.db" },
      { fileName: "Health Connect/health_connect_export.db" },
    ];
    expect(selectHealthConnectDbEntry(entries)).toEqual(entries[1]);
    expect(selectHealthConnectDbEntry([{ fileName: "export.xml" }])).toBeNull();
  });
});
