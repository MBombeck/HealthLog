/**
 * No backup tool sends its bulk output through a pipe.
 *
 * `pg_dump` writes the archive and `pg_restore --list` writes the table of
 * contents with `--file`; `runTool` discards standard output unless it is
 * asked to capture a line or two. Read through a pipe, a write could fail
 * with EAGAIN when something between the tool and the reader left the
 * descriptor non-blocking, and the dump before migrating gates every boot
 * that migrates: a spurious failure there stops a working install.
 *
 * Every `runTool("pg_dump" | "pg_restore", [...])` call therefore names its
 * output file, restores into a database (no output), or asks for the
 * version. A new call that does none of these fails here.
 *
 * Limit, stated: the matcher sees calls whose tool is a string literal and
 * whose arguments are an array literal; a tool name or argument list built
 * elsewhere and passed in is not matched. The floor below makes a matcher
 * that finds nothing fail rather than pass.
 */
import { describe, expect, it } from "vitest";

import { readSource } from "./helpers/source-files";

const SOURCES = [
  "src/lib/database-backup/dump-core.mjs",
  "scripts/db-restore.mjs",
];

const CALL = /runTool\(\s*"(pg_dump|pg_restore)",\s*\[([\s\S]*?)\]/g;

describe("database dump tool output", () => {
  it("every pg_dump / pg_restore call writes to a named file, a database, or only its version", () => {
    let calls = 0;
    for (const file of SOURCES) {
      const text = readSource(file, "runTool(");
      for (const m of text.matchAll(CALL)) {
        calls++;
        expect(
          /`--file=|--dbname=|"--version"/.test(m[2]),
          `${file}: ${m[1]} [${m[2].trim()}]`,
        ).toBe(true);
      }
    }
    // pg_dump twice (archive, version), pg_restore twice (listing, restore).
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("captures standard output only where it is asked for", () => {
    const core = readSource("src/lib/database-backup/dump-core.mjs", [
      'options.capture ? "pipe" : "ignore"',
      "MAX_CAPTURED_OUTPUT_BYTES",
    ]);
    const captures = [...core.matchAll(/capture:\s*true/g)].length;
    // Only `--version`.
    expect(captures).toBe(1);
  });
});
