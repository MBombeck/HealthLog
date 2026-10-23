/**
 * Structural guard: audit rows are written through `auditLog()`.
 *
 * `auditLog` decides two things a bare `prisma.auditLog.create` cannot: who
 * acted when the row is not theirs (the delegate on a shared record), and
 * whether a refused attempt (`<surface>.validation-failed`) becomes a row
 * at all. An owner's own refused request stays on the wide event; only a
 * refusal somebody else caused reaches the ledger the owner's activity feed
 * reads. Twelve routes wrote their refusal row directly and filed every
 * malformed body an owner's app sent, a few per sync, with no actor on a
 * delegate's.
 *
 * Whitespace-tolerant: the calls were written across two lines
 * (`prisma.auditLog` then `.create(`).
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder, stripComments } from "./helpers/source-files";

/** Files that write the table directly, and why. */
const DIRECT_WRITERS: Record<string, string> = {
  "lib/auth/audit.ts": "the one writer",
  "lib/insights/briefing-failure-marker.ts":
    "a dated failure marker the briefing read looks up again, not an audit of an act",
};

const RAW_WRITE = /\bauditLog\s*\.\s*create(?:Many(?:AndReturn)?)?\s*\(/;

describe("audit rows go through auditLog()", () => {
  const files = readSourceFolder("src", {
    floor: 3000,
    include: (rel) =>
      !rel.startsWith("generated/") &&
      !rel.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(rel),
  });
  const writers = files
    .filter(([, text]) => RAW_WRITE.test(stripComments(text)))
    .map(([rel]) => rel);

  it("finds the writers it polices", () => {
    expect(files.length).toBeGreaterThan(3000);
    expect(writers.length).toBeGreaterThanOrEqual(2);
    expect(writers).toContain("lib/auth/audit.ts");
  });

  it("no other file writes the audit table directly", () => {
    expect(writers.filter((rel) => !(rel in DIRECT_WRITERS))).toEqual([]);
  });

  it("lists no file that stopped writing it", () => {
    expect(
      Object.keys(DIRECT_WRITERS).filter((rel) => !writers.includes(rel)),
    ).toEqual([]);
  });

  it("the matcher reads a call split across lines", () => {
    expect(RAW_WRITE.test("prisma.auditLog\n      .create({ data })")).toBe(
      true,
    );
    expect(RAW_WRITE.test('auditLog("x.validation-failed", {})')).toBe(false);
  });
});
