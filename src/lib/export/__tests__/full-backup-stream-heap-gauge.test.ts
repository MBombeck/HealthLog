/**
 * The streaming writer must not gate a backup on a heap gauge.
 *
 * It did, for one release. Every flush read `process.memoryUsage().heapUsed`
 * and aborted above 80 % of V8's heap limit — a reading of the whole process,
 * garbage included. A Next.js server that has been up a week sits at 400 MB of
 * largely collectable heap, so on a 1 GB container the weekly pass aborted the
 * first chunk of every account: four out of four, in seven seconds, one of
 * them a demo record whose entire stored copy is 1.2 MB. The failure told the
 * operator the record was too large and to buy memory.
 *
 * The bound that replaced it counts the bytes the backup itself produced, in
 * `packBackupChunks`, and it is a storage limit, not a memory one: the stored
 * copy is written in sealed pieces and nothing in the process grows with it. This test is the tripwire for putting the gauge back.
 *
 * It is a grep with the limits of one: a heap reading spelled some other way —
 * a `v8.getHeapStatistics()` destructure, an import alias — would slip it. It
 * catches the shape that was actually written, which is the shape a revert
 * would reintroduce.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(import.meta.dirname, "..", "full-backup-stream.ts"),
  "utf8",
);

describe("full-backup-stream", () => {
  it("reads no process or V8 memory gauge", () => {
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*"))
      .join("\n");

    expect(code).not.toMatch(/memoryUsage\s*\(/);
    expect(code).not.toMatch(/getHeapStatistics\s*\(/);
    expect(code).not.toMatch(/heap_size_limit/);
    expect(code).not.toMatch(/from\s+"node:v8"/);
  });

  it("still explains why, so the next reader does not re-add it", () => {
    // A tripwire with no reason attached gets deleted by whoever trips it.
    expect(source).toContain("no heap reading in this writer");
  });
});
