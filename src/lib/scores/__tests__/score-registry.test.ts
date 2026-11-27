/**
 * The score register: every place a score is drawn as a ring and every score
 * page slug.
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
  type HealthLogScoreId,
} from "@/lib/scores/registry";

type ScoreId = HealthLogScoreId;
const SCORE_IDS = HEALTHLOG_SCORE_IDS;
/** Every slug `/insights/scores/<slug>` may answer to. */
const SCORE_SLUGS: readonly string[] = SCORE_IDS.map(
  (id) => HEALTHLOG_SCORES[id].slug,
);

/**
 * Every file that draws a `<ScoreRing>`, with the scores it may draw.
 * `planned` marks a site still being built; the register accepts its
 * absence and holds it like any other once it exists.
 */
const SCORE_RING_SITES: Readonly<
  Record<string, { scores: readonly ScoreId[]; planned?: true }>
> = {
  "src/components/insights/derived/score-ring-tile.tsx": {
    scores: ["HEALTH_SCORE", "SLEEP_SCORE", "READINESS"],
  },
  "src/components/dashboard/today-scores.tsx": {
    scores: ["HEALTH_SCORE", "SLEEP_SCORE", "READINESS"],
  },
  "src/components/insights/derived/score-anatomy-view.tsx": {
    scores: [
      "READINESS",
      "SLEEP_SCORE",
      "RECOVERY_SCORE",
      "STRESS_SCORE",
      "STRAIN_SCORE",
    ],
  },
  "src/components/insights/derived/wellness-scores.tsx": {
    scores: [
      "READINESS",
      "SLEEP_SCORE",
      "HEALTH_SCORE",
      "RECOVERY_SCORE",
      "STRESS_SCORE",
      "STRAIN_SCORE",
    ],
  },
  "src/components/insights/derived/hero-strip.tsx": {
    scores: ["READINESS", "SLEEP_SCORE", "HEALTH_SCORE"],
    planned: true,
  },
};

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
      for (const id of entry.scores) expect(SCORE_IDS).toContain(id);
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

  it("gives every score its own slug", () => {
    expect(new Set(SCORE_SLUGS).size).toBe(SCORE_IDS.length);
  });
});
