/**
 * Structural guard on the E2E suite's session boundary.
 *
 * Account switching is stamped on the session row, not held in the tab. Every
 * Playwright context opened from `STORAGE_STATE_PATH` carries the SAME session
 * cookie, so a spec that switches that jar into another account's record
 * switches it for every spec authenticating with it — and the suite runs
 * `fullyParallel`. The failure lands in an unrelated file: a settings surface
 * painting "Not part of shared access", an axe scan reading a banner its spec
 * never asked for, a `waitForResponse` on a request the refused surface never
 * sends. Nothing in the spec that fails is wrong, and nothing in its file
 * explains it.
 *
 * So: a spec that switches accounts uses its own jar. This file holds that
 * shape by matching the two things a switching spec cannot avoid naming — the
 * menu entry it clicks and the endpoint that entry calls.
 *
 * It is a tripwire, not a proof. A future spec could switch through a control
 * neither marker names, and this guard would not see it; the counter-check
 * below is what stops the matchers from quietly matching nothing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { join, sep } from "node:path";
import { stripComments } from "./helpers/source-files";

const E2E = join(process.cwd(), "e2e");

/**
 * Markers that mean "this spec drives an account switch": the switcher entry
 * a person clicks, and the endpoint that click posts to.
 */
const SWITCH_MARKERS = ["account-switcher-entry", "/api/account/switch"];

/** The jar shared by every ordinary authenticated spec. */
const SHARED_JAR = "STORAGE_STATE_PATH";

function specFiles(): string[] {
  return globSync("*.spec.ts", { cwd: E2E })
    .map((p) => p.split(sep).join("/"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(E2E, rel), "utf8");
}

function switchingSpecs(): string[] {
  return specFiles().filter((rel) => {
    const src = stripComments(read(rel));
    return SWITCH_MARKERS.some((marker) => src.includes(marker));
  });
}

/**
 * `STORAGE_STATE_PATH` as a whole word, so `OWNER_STORAGE_STATE_PATH` and
 * `DELEGATE_STORAGE_STATE_PATH` — the isolated jars, which are the fix rather
 * than the problem — do not read as a hit.
 */
function usesSharedJar(src: string): boolean {
  return new RegExp(`(^|[^A-Z_])${SHARED_JAR}\\b`).test(src);
}

describe("e2e specs that switch accounts do not share a session", () => {
  it("finds the specs that switch at all", () => {
    // An empty match set would make every assertion below vacuous. The suite
    // has a switching journey; if it ever has none, this guard has no subject
    // and should be deleted rather than left passing.
    expect(switchingSpecs().length).toBeGreaterThan(0);
  });

  it("none of them authenticates with the shared jar", () => {
    const offenders = switchingSpecs().filter((rel) =>
      usesSharedJar(stripComments(read(rel))),
    );
    expect(offenders).toEqual([]);
  });

  it("the shared jar is still what the ordinary specs read", () => {
    // The other way this guard could go quietly green: the shared jar renamed
    // or retired, leaving the matcher above looking for a string nothing uses.
    const sharing = specFiles().filter((rel) =>
      usesSharedJar(stripComments(read(rel))),
    );
    expect(sharing.length).toBeGreaterThan(10);
  });
});
