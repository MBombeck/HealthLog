/**
 * Structural guard: every caller of the doctor-report aggregator is named here
 * with the source of its selection.
 *
 * The aggregator's third parameter is required and brand-typed, so a new
 * egress path cannot compile without naming a selection source. This is the
 * second half of that: it cannot be ADDED without a human writing down which
 * source, in this list, which is the moment a reviewer asks the consent
 * question. Modelled on `bearer-scope-enforcement-guard.test.ts`.
 *
 * Adding a caller fails the build until the list is updated deliberately.
 *
 * Mutation check: add a `collectDoctorReportData(` call anywhere under `src/`
 * that is not in the list → "the set of aggregator callers is frozen" goes red
 * naming the file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./helpers/source-files";

const SRC = join(__dirname, "..");
/**
 * Pruned on purpose: the generated Prisma client, build output, vendored
 * dependencies, and the suites themselves are not the tree under audit. Note
 * what is NOT pruned — this walk descends into dot-prefixed directories, so
 * `src/app/.well-known` is inside the sweep. `fs.globSync` would drop it.
 */
const SKIP_DIRS = new Set(["__tests__", "node_modules", ".next", "generated"]);

/**
 * Every production call site, with the source of its selection. A path here
 * that no longer calls the aggregator is as much a failure as one that does
 * and is missing — a stale entry is how a list stops being read.
 */
const CALLERS: Record<string, string> = {
  "app/api/export/health-record/route.ts":
    "the request body's `selection` field, minted through selectionFromRequest",
  "lib/clinician-share/share-view-data.ts":
    "the share link's frozen sectionsJson, minted through selectionFromStoredBlob",
  "lib/fhir/rest.ts": "the owner's saved profile (resolveSavedSelection)",
  "lib/mcp/resources.ts": "the owner's saved profile (resolveSavedSelection)",
  "lib/mcp/prompts.ts": "the owner's saved profile (resolveSavedSelection)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("doctor-report aggregator egress", () => {
  // A sweep that finds nothing agrees with every allowlist, so the size of
  // the tree being read is asserted before anything is concluded from it.
  // Pinned below the real source-file count with headroom, not at one.
  it("reads the tree it claims to sweep", () => {
    expect(walk(SRC).length).toBeGreaterThan(1500);
  });

  it("keeps the set of aggregator callers frozen", () => {
    const found: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      // The aggregator's own module and its public surface are not callers.
      if (rel === "lib/doctor-report/collect.ts") continue;
      if (rel === "lib/doctor-report-data.ts") continue;
      const body = stripComments(readFileSync(file, "utf8"));
      if (body.includes("collectDoctorReportData(")) found.push(rel);
    }

    const expected = Object.keys(CALLERS).sort();
    expect(
      found.sort(),
      "Every surface that assembles the whole record has to name where its " +
        "selection came from. Add the file to CALLERS with its source, or " +
        "remove the call.",
    ).toEqual(expected);
  });

  it("names a real selection source for each caller", () => {
    for (const [path, source] of Object.entries(CALLERS)) {
      expect(
        source.length,
        `${path} has no stated selection source`,
      ).toBeGreaterThan(10);
    }
  });
});
