/**
 * Every write of page state into the query string goes through
 * `@/lib/url-state`, which derives it from the live address and holds it
 * until the router has the previous one.
 *
 * Next 16.4 adopts a native history write a render later, and a write
 * computed from `useSearchParams` starts from the URL before the last write.
 * Each surface that wrote on its own met one of the two: a quick second
 * step of the day undone, a closed document sheet left open, cleared vault
 * filters coming back as `?encounter=`. A raw `history.pushState` /
 * `replaceState`, or a router write built from the rendered search params,
 * reopens the class, so both are refused outside the helper and the few
 * places listed here with their reason.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder } from "@/__tests__/helpers/source-files";

const RAW_HISTORY_WRITE = /\bhistory\s*\.\s*(?:pushState|replaceState)\s*\(/;
const RENDERED_SEARCH = /\bsearchParams\??\.toString\(\)/;
const ROUTER_WRITE = /\brouter\s*\.\s*(?:push|replace)\s*\(/;

const ALLOWED: Record<string, string> = {
  "lib/url-state.ts": "the helper itself",
  "components/clinician/share-unlock-gate.tsx":
    "scrubs a passphrase from the fragment synchronously, before the unlock request leaves; no query state",
  "components/documents/vault/selection-history.ts":
    "closeDocumentSelectionHistoryEntry takes a history-shaped argument for its tests; the page passes `urlStateHistory`",
};

describe("query-string writes go through @/lib/url-state", () => {
  const files = readSourceFolder("src", {
    floor: 500,
    include: (rel) =>
      !rel.startsWith("generated/") &&
      !rel.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(rel),
  });

  it("reads the whole tree (floor)", () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it("finds no raw history write outside the helper", () => {
    const offenders = files
      .filter(([rel, text]) => !ALLOWED[rel] && RAW_HISTORY_WRITE.test(text))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it("finds no router write built from the rendered search params", () => {
    const offenders = files
      .filter(
        ([rel, text]) =>
          !ALLOWED[rel] &&
          RENDERED_SEARCH.test(text) &&
          ROUTER_WRITE.test(text),
      )
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it("still sees the helper's own writes (the matcher is alive)", () => {
    const helper = files.find(([rel]) => rel === "lib/url-state.ts");
    expect(helper && RAW_HISTORY_WRITE.test(helper[1])).toBe(true);
    for (const rel of Object.keys(ALLOWED)) {
      expect(
        files.some(([path]) => path === rel),
        `${rel} is still in the tree`,
      ).toBe(true);
    }
  });
});
