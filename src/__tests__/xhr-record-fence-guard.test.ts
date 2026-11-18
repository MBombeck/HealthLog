/**
 * Every raw `XMLHttpRequest` in `src/` carries the record-session fence.
 *
 * `apiFetch` adds the two assertion headers to every request, so a caller on
 * `fetch` cannot forget them. An `XMLHttpRequest` goes around that wrapper,
 * and inside a managed or shared record the server refuses a headerless
 * request as an unfenced client. The vault upload did exactly that: it was the
 * one XHR in the tree, it set no fence headers, and every upload into a
 * guardian's record failed with the generic error.
 *
 * So the set of files that construct an XHR is frozen here, and each one must
 * set both headers from `currentAssertion()` and check the response echo. A new
 * XHR fails this test until it does the same, or until the reason it does not
 * need to is written down in the allowlist.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Files allowed to construct an XHR. Each must pass the fence checks below. */
const XHR_FILES = ["components/documents/use-document-upload.ts"];

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function code(rel: string): string {
  return stripComments(readSourceText(join(SRC, rel)), rel);
}

const XHR_RE = /\bnew\s+XMLHttpRequest\b|\bXMLHttpRequest\s*\(/;

describe("raw XMLHttpRequest carries the record-session fence", () => {
  it("finds exactly the allowlisted XHR call sites", () => {
    const found = sourceFiles().filter((rel) => XHR_RE.test(code(rel)));
    // A matcher that finds nothing would pass the next assertion vacuously.
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(XHR_FILES);
  });

  it.each(XHR_FILES)(
    "%s sets both fence headers and checks the echo",
    (rel) => {
      const src = code(rel);
      expect(src).toMatch(/currentAssertion\s*\(\s*\)/);
      expect(src).toMatch(/setRequestHeader\(\s*RECORD_EPOCH_HEADER\s*,/);
      expect(src).toMatch(/setRequestHeader\(\s*RECORD_SCOPE_HEADER\s*,/);
      expect(src).toMatch(/validateEchoedContext\s*\(/);
    },
  );
});
