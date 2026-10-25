/**
 * Every reader of a stored or uploaded backup reads it as a stream (#1031),
 * through the one shared reader (#1239).
 *
 * A backup's JSON grows with the record, and past 536 870 888 characters it
 * cannot exist as one JavaScript string at all: the disaster-recovery JSON of
 * an account with 1.25 million measurements is 662 MB. Each of the readers
 * below used to turn the file into one string first, and so none of them
 * could open that account's backup. This pins that none of them goes back to
 * it: no whole-document decrypt-to-string, no whole-body text read.
 *
 * Streaming is not enough on its own. The scanner keeps every section it is
 * not told to stream as one string and one parse, so a reader is only as
 * light as the section list it passes. The upload route once passed its own
 * list with the measurements alone in it, and held a document vault of a few
 * hundred megabytes whole while the restore beside it streamed the same
 * documents. So every reader goes through `readStreamedBackup`, or, where it
 * only counts and checks keys, scans with `BACKUP_STREAM_KEYS`, and no reader
 * names a section list of its own. The sweep at the end finds any file that
 * calls the scanner or names a stream list, so a new reader cannot sit
 * outside this list unnoticed.
 *
 * Every matcher is whitespace-tolerant and every check also asserts that it
 * matched something: a pattern that matches nothing proves nothing.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BACKUP_STREAMED_SECTIONS,
  BACKUP_STREAM_KEYS,
} from "@/lib/export/streamed-backup";

/** Where the stream list is defined, and the scanner it is handed to. */
const SHARED_READER = "src/lib/export/streamed-backup.ts";
const SCANNER = "src/lib/export/backup-json-scan.ts";

/** Readers that read the file through `readStreamedBackup`. */
const SHARED_READER_CALLERS = [
  "src/lib/export/restore-preflight.ts",
  "src/app/api/admin/backups/[id]/summary/route.ts",
  "src/app/api/admin/backups/[id]/download/route.ts",
  "src/app/api/admin/backups/upload/route.ts",
] as const;

/** Readers that only count and check keys: the scanner, with the shared list. */
const SHARED_KEY_SCANNERS = [
  "src/lib/jobs/restore-drill.ts",
  "scripts/restore-backup.ts",
] as const;

const READERS = [...SHARED_READER_CALLERS, ...SHARED_KEY_SCANNERS];

/** Calls that hand back the whole document as one string or parse it whole. */
const WHOLE_DOCUMENT = [
  /\bunpackBackupBlob\s*\(/,
  /\bdecryptBackup\s*\(/,
  /\bJSON\.parse\s*\(\s*plaintext\b/,
  /\bparseBackupPayload\s*\(\s*plaintext\b/,
  /\bfile\.text\s*\(/,
  /\bawait\s+request\.text\s*\(\s*\)[\s\S]{0,200}parseBackupPayload/,
];

const SHARED_READER_CALL = /\breadStreamedBackup\s*\(/g;
const SCANNER_CALL = /\bscanBackupJson\s*\(/g;
/** Any stream list handed to the scanner, whatever its value. */
const STREAM_KEYS_OPTION = /\bstreamKeys\s*:/g;
/** The one stream list a reader may hand it. */
const SHARED_STREAM_KEYS_OPTION = /\bstreamKeys\s*:\s*BACKUP_STREAM_KEYS\b/g;
const SHARED_IMPORT =
  /import\s*\{[^}]*\bBACKUP_STREAM_KEYS\b[^}]*\}\s*from\s*["']@\/lib\/export\/streamed-backup["']/;
const SHARED_READER_IMPORT =
  /import\s*\{[^}]*\breadStreamedBackup\b[^}]*\}\s*from\s*["']@\/lib\/export\/streamed-backup["']/;

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "generated") continue;
      if (name === "__tests__") continue;
      walk(path, out);
    } else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("backup readers stream the file", () => {
  it.each(READERS)("%s never holds the whole document", (path) => {
    const source = readFileSync(path, "utf8");
    for (const pattern of WHOLE_DOCUMENT) {
      expect(source, `${path} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it.each(SHARED_READER_CALLERS)(
    "%s reads through the shared reader and scans nothing itself",
    (path) => {
      const source = readFileSync(path, "utf8");
      expect(source).toMatch(SHARED_READER_IMPORT);
      expect(count(source, SHARED_READER_CALL)).toBeGreaterThan(0);
      expect(count(source, SCANNER_CALL), `${path} calls the scanner`).toBe(0);
      expect(
        count(source, STREAM_KEYS_OPTION),
        `${path} names a stream list of its own`,
      ).toBe(0);
    },
  );

  it.each(SHARED_KEY_SCANNERS)(
    "%s scans with the shared stream list and no list of its own",
    (path) => {
      const source = readFileSync(path, "utf8");
      const calls = count(source, SCANNER_CALL);
      expect(calls).toBeGreaterThan(0);
      expect(source).toMatch(SHARED_IMPORT);
      // Every scan names a list, and every list named is the shared one.
      expect(count(source, SHARED_STREAM_KEYS_OPTION)).toBe(calls);
      expect(count(source, STREAM_KEYS_OPTION)).toBe(calls);
    },
  );

  it("the shared reader's first read uses the shared stream list", () => {
    const source = readFileSync(SHARED_READER, "utf8");
    expect(count(source, SHARED_STREAM_KEYS_OPTION)).toBeGreaterThan(0);
    // The sections that grow with a record, in rows or in stored bytes.
    expect([...BACKUP_STREAM_KEYS].sort()).toEqual(
      [...BACKUP_STREAMED_SECTIONS].sort(),
    );
    for (const section of [
      "measurements",
      "intakeEvents",
      "moodEntries",
      "documents",
      "ecgRecordings",
    ]) {
      expect(BACKUP_STREAM_KEYS.has(section), section).toBe(true);
    }
  });

  it("no file outside the list scans a backup or names a stream list", () => {
    const found = [...walk("src"), ...walk("scripts")]
      .filter((path) => path !== SHARED_READER && path !== SCANNER)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return (
          count(source, SCANNER_CALL) > 0 ||
          count(source, STREAM_KEYS_OPTION) > 0
        );
      })
      .sort();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual([...SHARED_KEY_SCANNERS].sort());
  });
});
