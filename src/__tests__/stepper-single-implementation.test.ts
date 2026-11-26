/**
 * One progress band: `ui/stepper.tsx`.
 *
 * The medication wizard, the setup flows and the check-in wizard each drew
 * their own progress (dots and connectors, a segment bar, a `Progress`
 * strip), so the same idea looked three ways and the dots drifted out of
 * line. A step marker (`aria-current="step"`) belongs to the primitive. The
 * setup frame keeps its own bar until the setup flows move onto the
 * primitive; that is the one listed exception, and an entry that no longer
 * matches fails, so the list cannot outlive its cause.
 *
 * Matched: a `"step"` literal within a few characters of `aria-current`, on
 * one line or across a ternary. Not matched: a marker built from a variable.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(__dirname, "..");

const PRIMITIVE = "components/ui/stepper.tsx";

const RATCHETED: Record<string, string> = {
  "components/onboarding/setup-frame.tsx":
    "the setup flows' segment bar, until they move onto the primitive",
};

const MARKER_RE = /aria-current=\{?[^}\n]{0,40}"step"/;

function stepMarkers(files: { path: string; source: string }[]): string[] {
  return files
    .filter(({ source }) => MARKER_RE.test(source))
    .map(({ path }) => path)
    .sort();
}

describe("one progress band", () => {
  const files = walkSourceFiles(SRC, { floor: 1200, extensions: [".tsx"] })
    .filter(
      (p) =>
        (p.startsWith("components/") || p.startsWith("app/")) &&
        !p.includes("__tests__/"),
    )
    .map((path) => ({
      path,
      source: stripComments(readSourceText(join(SRC, path)), path),
    }));

  it("recognises a hand-drawn step marker", () => {
    expect(
      stepMarkers([
        {
          path: "components/a.tsx",
          source: '<li aria-current={active ? "step" : undefined} />',
        },
        { path: "components/b.tsx", source: '<li aria-current="step" />' },
        { path: "components/c.tsx", source: '<a aria-current="page" />' },
      ]),
    ).toEqual(["components/a.tsx", "components/b.tsx"]);
  });

  it("marks steps only in the primitive and the listed exceptions", () => {
    expect(stepMarkers(files)).toEqual(
      [PRIMITIVE, ...Object.keys(RATCHETED)].sort(),
    );
  });
});
