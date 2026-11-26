/**
 * The score register (`src/lib/scores/registry.ts`) knows every place a
 * score is drawn as a ring and every score page slug.
 *
 * A ring or a score page that appears without an entry is a score nobody
 * decided about: which number it shows, which band rule colours it, whether
 * it is HealthLog's or a device's. Each matcher asserts a non-zero match
 * count, so a matcher that silently finds nothing fails instead of passing.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readSource,
  readSourceFolder,
  stripComments,
} from "@/__tests__/helpers/source-files";
import {
  HEALTHLOG_SCORES,
  HEALTHLOG_SCORE_IDS,
  SCORE_RING_SITES,
  SCORE_SLUGS,
} from "@/lib/scores/registry";

/** Every non-test source file under src/, comments blanked. */
const FILES: Array<[string, string]> = readSourceFolder("src", {
  floor: 2000,
  include: (rel) =>
    !rel.startsWith("generated/") &&
    !rel.includes("__tests__/") &&
    !/\.test\.tsx?$/.test(rel),
}).map(([rel, text]) => [`src/${rel}`, stripComments(text, rel)]);

/** A JSX use of the ring, not an import or a type. */
const RING_JSX = /<ScoreRing(?=[\s/>]|$)/m;

function ringSites(): string[] {
  return FILES.filter(
    ([rel, text]) =>
      rel !== "src/components/insights/derived/score-ring.tsx" &&
      RING_JSX.test(text),
  ).map(([rel]) => rel);
}

describe("score register: ring sites", () => {
  const sites = ringSites();

  it("finds the ring in the code at all", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it("lists every file that draws a <ScoreRing>", () => {
    const unlisted = sites.filter((site) => !(site in SCORE_RING_SITES));
    expect(unlisted).toEqual([]);
  });

  it("holds every listed site that exists to drawing a ring", () => {
    for (const [site, entry] of Object.entries(SCORE_RING_SITES)) {
      const exists = existsSync(join(process.cwd(), site));
      if (!exists) {
        expect(entry.planned, `${site} is gone but not planned`).toBe(true);
        continue;
      }
      expect(sites, `${site} no longer draws a ring`).toContain(site);
    }
  });

  it("names only registered scores per site", () => {
    for (const entry of Object.values(SCORE_RING_SITES)) {
      expect(entry.scores.length).toBeGreaterThan(0);
      for (const id of entry.scores) expect(HEALTHLOG_SCORE_IDS).toContain(id);
    }
  });
});

describe("score register: slugs", () => {
  it("every /insights/scores/<slug> link in the code is a registered slug", () => {
    const linked = new Set<string>();
    for (const [, text] of FILES) {
      for (const m of text.matchAll(/\/insights\/scores\/([a-z][a-zA-Z-]*)/g)) {
        linked.add(m[1]);
      }
    }
    expect(linked.size).toBeGreaterThan(0);
    expect([...linked].filter((slug) => !SCORE_SLUGS.includes(slug))).toEqual(
      [],
    );
  });

  it("every slug the score page answers to is registered", () => {
    const page = readSource(
      "src/app/insights/scores/[metric]/page.tsx",
      "SLUG_TO_METRIC",
    );
    const block = page.match(/SLUG_TO_METRIC[^{]*\{([\s\S]*?)\n\};/);
    expect(block, "SLUG_TO_METRIC not found").not.toBeNull();
    const slugs = [
      ...block![1].matchAll(/^\s*"?([a-z][a-zA-Z-]*)"?\s*:/gm),
    ].map((m) => m[1]);
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs.filter((slug) => !SCORE_SLUGS.includes(slug))).toEqual([]);
  });

  it("gives every score its own slug and a title key", () => {
    expect(new Set(SCORE_SLUGS).size).toBe(HEALTHLOG_SCORE_IDS.length);
    for (const id of HEALTHLOG_SCORE_IDS) {
      expect(HEALTHLOG_SCORES[id].titleKey).toMatch(/^[a-zA-Z]+(\.[\w]+)+$/);
    }
  });
});
