/**
 * Whose number a wellness score is (`value.origin`, `value.deviceSource`) is
 * decided once, where the value is assembled, and nowhere else.
 *
 * Before 1.50 each client worked it out: the app took a WHOOP recovery from
 * `provenance.inputs` and a device strain from `value.device`, and could not
 * tell an Oura or Polar recovery from HealthLog's own; the web hid the device
 * strain from one section and named the rest "estimates" by section. The
 * server now publishes the answer, and this guard keeps it in one place:
 *
 *   - every value `wellness-scores.ts` builds spreads `wellnessScoreOrigin`,
 *     so an arm added later cannot ship without it;
 *   - nothing else calls the resolver, so no second reading grows beside it;
 *   - the web reads the label and the no-factors sentence from the wire's
 *     `origin`, never from `source`, `device` or `components`.
 */
import { describe, expect, it } from "vitest";

import { readSource, readSourceFolder } from "./helpers/source-files";

const ENGINE = "src/lib/insights/derived/wellness-scores.ts";

const sources = readSourceFolder("src", {
  floor: 2500,
  include: (rel) =>
    !rel.startsWith("generated/") &&
    !rel.includes("__tests__/") &&
    !/\.test\.tsx?$/.test(rel),
}).map(([rel, text]) => ({ path: `src/${rel}`, text }));

describe("wellness score origin has one home", () => {
  it("every value the engine builds carries the resolved origin", () => {
    const engine = readSource(ENGINE, "buildOk<WellnessScoreValue>");
    const builds = engine.match(/buildOk<WellnessScoreValue>\s*\(/g) ?? [];
    const resolved = engine.match(/\.\.\.wellnessScoreOrigin\s*\(/g) ?? [];
    expect(builds.length).toBeGreaterThan(0);
    expect(resolved.length).toBe(builds.length);
  });

  it("nothing outside the engine resolves it", () => {
    const callers = sources
      .filter((file) => /\bwellnessScoreOrigin\s*\(/.test(file.text))
      .map((file) => file.path);
    expect(callers).toEqual([ENGINE]);
  });

  it("the web labels a score from the wire's origin", () => {
    const sites = sources.flatMap((file) =>
      [
        ...file.text.matchAll(
          /\b(scoreOriginLabelKey|scoreNoFactorsKey)\s*\(\s*([^)]*)\)/g,
        ),
      ]
        .filter((match) => !file.text.includes(`export function ${match[1]}`))
        .map((match) => ({ path: file.path, arg: match[2].trim() })),
    );
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      // `v.origin`, or a local read straight off the value as `origin`.
      expect(site.arg, site.path).toMatch(/(^|\.)origin$/);
    }
  });
});
