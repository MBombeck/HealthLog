/**
 * Every client that writes the profile has to read the answer.
 *
 * `applyProfileUpdate` writes field by field: a body where some fields
 * validate and some do not is answered with 200 and a `rejectedFields`
 * list naming what was dropped. A client that treats any 200 as a clean
 * save discards the person's correction and says nothing — which is
 * exactly what the onboarding baseline step did, for as long as the
 * route has behaved this way.
 *
 * That is a whole-class defect, not one screen's bug, so the guard is
 * on the class: enumerate every surface that writes to either profile
 * route and require each one either to read `rejectedFields`, or to
 * send a body the partial arm cannot reach.
 *
 * Its limit, written down so nobody mistakes it for a proof: it matches
 * a URL literal next to a mutating method. A future submitter that
 * builds its path by concatenation, or routes through a helper that
 * takes the path as an argument, would not be seen. The set below is
 * frozen so that adding one has to be a deliberate edit here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The two routes that answer with `rejectedFields`. */
const PROFILE_ROUTES = ["/api/auth/profile", "/api/user/profile"];

function sourceFiles(): string[] {
  return (
    walkSourceFiles(SRC, { floor: 3000 })
      .filter((p) => !p.startsWith("generated/"))
      .filter((p) => !p.startsWith("app/api/"))
      // v1.39 (Wave C, C6) — the edge proxy names routes and methods as DATA
      // (the demo-mode mutation allowlist is a list of path/method pairs), and
      // a pair reads to the matcher below exactly like a request expression. It
      // submits nothing and has no answer to read.
      .filter((p) => p !== "proxy.ts")
      .filter((p) => !p.includes("__tests__"))
      .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
      .sort()
  );
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * A file counts as a submitter when a profile-route literal and a
 * mutating method literal both appear within one request expression —
 * approximated as the 400 characters following the URL, which covers
 * the `fetch(url, { method, headers, body })` shape every caller in the
 * tree uses.
 */
function submitters(): string[] {
  const found: string[] = [];
  for (const rel of sourceFiles()) {
    const text = read(rel);
    for (const route of PROFILE_ROUTES) {
      let at = text.indexOf(`"${route}"`);
      while (at !== -1) {
        const window = text.slice(at, at + 400);
        if (/method:\s*"(PUT|PATCH)"/.test(window)) {
          found.push(rel);
          at = -1;
          break;
        }
        at = text.indexOf(`"${route}"`, at + 1);
      }
      if (found[found.length - 1] === rel) break;
    }
  }
  return [...new Set(found)].sort();
}

/**
 * Submitters whose body carries exactly ONE field. The partial arm
 * needs at least one field to accept alongside at least one to refuse,
 * so a one-field body is answered either with a clean 200 or with the
 * 422 `profile.update.nothingSaved` — never with `rejectedFields`.
 * These already surface the 422 as a save error.
 *
 * The claim is not taken on trust: the body literal is counted below.
 */
const SINGLE_FIELD_SUBMITTERS = [
  "components/settings/date-format-select.tsx",
  "components/settings/mood-reminder-card.tsx",
  "components/settings/time-format-select.tsx",
];

/** Submitters that send several fields and must read the answer. */
const MULTI_FIELD_SUBMITTERS = [
  "components/onboarding/baseline-form-utils.ts",
  "components/settings/account-section/index.tsx",
];

describe("every profile submitter answers a rejected field", () => {
  it("finds the submitters at all", () => {
    // A guard that matches nothing is green for the wrong reason.
    expect(submitters().length).toBeGreaterThan(0);
  });

  it("keeps the submitter set frozen", () => {
    expect(submitters()).toEqual(
      [...SINGLE_FIELD_SUBMITTERS, ...MULTI_FIELD_SUBMITTERS].sort(),
    );
  });

  it.each(MULTI_FIELD_SUBMITTERS)("%s reads rejectedFields", (rel) => {
    const text = read(rel);
    expect(text).toMatch(/rejectedFields/);
    // And renders them per field, rather than only counting them. The
    // matcher demands a CALL: an import of the helper next to a body
    // that never calls it is the shape this whole guard exists to
    // catch, and matching the bare name would pass on it.
    const calls = [...text.matchAll(/describeRejectedProfileFields\s*\(/g)];
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(SINGLE_FIELD_SUBMITTERS)("%s sends exactly one field", (rel) => {
    const text = read(rel);
    const bodies = [
      ...text.matchAll(/body:\s*JSON\.stringify\(\{([^}]*)\}\)/g),
    ];
    expect(bodies.length).toBeGreaterThan(0);
    for (const [, inner] of bodies) {
      const keys = inner
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      // One key, so there is never a valid sibling to save alongside an
      // invalid field — the arm that answers with `rejectedFields`
      // cannot be reached from here.
      expect(keys).toHaveLength(1);
    }
  });
});
