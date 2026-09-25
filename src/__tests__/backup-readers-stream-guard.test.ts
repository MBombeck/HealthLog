/**
 * Every reader of a stored or uploaded backup reads it as a stream (#1031).
 *
 * A backup's JSON grows with the record, and past 536 870 888 characters it
 * cannot exist as one JavaScript string at all: the disaster-recovery JSON of
 * an account with 1.25 million measurements is 662 MB. Each of the readers
 * below used to turn the file into one string first, and so none of them
 * could open that account's backup. This pins that none of them goes back to
 * it: no whole-document decrypt-to-string, no whole-body text read.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const READERS = [
  "src/lib/export/restore-backup.ts",
  "src/app/api/admin/backups/[id]/summary/route.ts",
  "src/app/api/admin/backups/[id]/download/route.ts",
  "src/app/api/admin/backups/upload/route.ts",
  "src/lib/jobs/restore-drill.ts",
  "scripts/restore-backup.ts",
] as const;

/** Calls that hand back the whole document as one string or parse it whole. */
const WHOLE_DOCUMENT = [
  /\bunpackBackupBlob\s*\(/,
  /\bdecryptBackup\s*\(/,
  /\bJSON\.parse\s*\(\s*plaintext\b/,
  /\bparseBackupPayload\s*\(\s*plaintext\b/,
  /\bfile\.text\s*\(/,
  /\bawait\s+request\.text\s*\(\s*\)[\s\S]{0,200}parseBackupPayload/,
];

describe("backup readers stream the file", () => {
  it.each(READERS)("%s never holds the whole document", (path) => {
    const source = readFileSync(path, "utf8");
    for (const pattern of WHOLE_DOCUMENT) {
      expect(source, `${path} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it.each(READERS)("%s reads through the streaming reader", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toMatch(/\b(readStreamedBackup|scanBackupJson)\b/);
  });
});
