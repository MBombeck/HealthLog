/**
 * One band rule, with direction (1.50, scores).
 *
 * Every 0..100 score HealthLog computes is banded by `scoreBand` in
 * `src/lib/analytics/score/shared.ts` (green from 70, yellow from 50). The
 * two load scores, stress and strain, read the other way round: a high
 * number is a heavy day, so they are banded on `100 - score`. A vendor's own
 * number (a WHOOP recovery, an Oura sleep score) gets no HealthLog band at
 * all; the vendor colours it by its own scale.
 *
 * Before this, four functions banded at 70/40 while the health score banded
 * at 70/50, so the same 45 was yellow on one ring and red on the next, and a
 * pillar row coloured itself differently from the score the server had
 * computed. The guard pins both halves: the rule itself, and that no file
 * keeps a private copy of it. The source scan's matcher is proven against
 * the three threshold ladders it deliberately leaves alone (a mood
 * stability word, a compliance heat colour and a confidence tier), so it
 * cannot pass by matching nothing.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bandForScoreKind,
  legacyVendorWireBand,
  scoreBand,
} from "@/lib/analytics/score/shared";
import { bandForScore as clientBandForScore } from "@/components/insights/derived/band-tokens";
import { bandWellnessScore } from "@/lib/insights/derived/wellness-scores";

import { readSource, scanSourceMatches } from "./helpers/source-files";

const EDGES = [0, 39, 40, 49, 50, 69, 70, 100];

describe("one band rule", () => {
  it("bands readiness and the sleep score exactly as scoreBand does", () => {
    for (const score of EDGES) {
      expect(bandForScoreKind("readiness", score)).toBe(scoreBand(score));
      expect(bandForScoreKind("sleep", score)).toBe(scoreBand(score));
      expect(bandForScoreKind("recovery", score)).toBe(scoreBand(score));
      expect(bandWellnessScore("RECOVERY_SCORE", score)).toBe(scoreBand(score));
      // The client's ring colours a score it has no band for with the same
      // rule, so a pillar row and the server's band agree.
      expect(clientBandForScore(score)).toBe(scoreBand(score));
    }
    expect(bandForScoreKind("readiness", 45)).toBe("red");
    expect(bandForScoreKind("sleep", 49)).toBe("red");
    expect(bandForScoreKind("sleep", 50)).toBe("yellow");
  });

  it("never paints a heavy stress or strain day green", () => {
    expect(bandForScoreKind("stress", 80)).toBe("red");
    expect(bandForScoreKind("strain", 80)).toBe("red");
    expect(bandWellnessScore("STRESS_SCORE", 80)).not.toBe("green");
    expect(bandWellnessScore("STRAIN_SCORE", 80)).not.toBe("green");
    expect(bandWellnessScore("STRESS_SCORE", 80)).toBe("red");
    expect(bandWellnessScore("STRESS_SCORE", 20)).toBe("green");
    for (const score of EDGES) {
      expect(bandForScoreKind("stress", score)).toBe(scoreBand(100 - score));
      expect(bandWellnessScore("STRAIN_SCORE", score)).toBe(
        scoreBand(100 - score),
      );
    }
  });

  it("gives a vendor's own number no HealthLog band", () => {
    for (const score of EDGES) {
      expect(bandForScoreKind("vendor", score)).toBeNull();
    }
    // The wire band an iOS ring shows for a vendor's number keeps its old
    // ladder until the ring is rebuilt on the vendor's thresholds (1.51).
    expect(legacyVendorWireBand(45, "higher-better")).toBe("yellow");
    expect(legacyVendorWireBand(39, "higher-better")).toBe("red");
    expect(legacyVendorWireBand(80, "lower-better")).toBe("red");
  });
});

describe("no private band ladder", () => {
  // A literal 70 / 50 / 40 threshold that returns a word straight away is
  // the shape every retired copy had (`if (score >= 70) return "green"`).
  const LADDER = /(?:>=)\s*(?:40|50|70)\s*\)\s*return\s*["'][^"']+["']/g;

  // Ladders on other scales that only look alike: a mood-stability word, a
  // compliance heat colour, a confidence tier. Each is named with its count,
  // so a new rung in one of them is seen too.
  const OTHER_SCALES: Record<string, number> = {
    "lib/insights/mood-patterns.ts": 1,
    "components/charts/compliance-heatmap.tsx": 1,
    "lib/insights/derived/coverage.ts": 1,
  };

  it("finds no score band computed outside shared.ts", () => {
    const matches = scanSourceMatches(join(process.cwd(), "src"), LADDER, {
      fileFloor: 1000,
      // The three ladders on other scales prove the matcher still reads.
      matchFloor: 3,
      stripComments: true,
      include: (rel) =>
        !rel.startsWith("generated/") &&
        !rel.includes("/__tests__/") &&
        !/\.test\.tsx?$/.test(rel),
    });
    const perFile = new Map<string, number>();
    for (const m of matches) {
      perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);
    }
    const offenders = [...perFile.entries()]
      .filter(([file, count]) => OTHER_SCALES[file] !== count)
      .map(([file, count]) => `${file} (${count})`);
    expect(offenders).toEqual([]);
    for (const file of Object.keys(OTHER_SCALES)) {
      expect(perFile.get(file), file).toBe(OTHER_SCALES[file]);
    }
  });

  it("has readiness, the sleep score and the load scores read the shared rule", () => {
    for (const rel of [
      "src/lib/insights/derived/readiness.ts",
      "src/lib/insights/derived/sleep-score.ts",
      "src/lib/insights/derived/wellness-scores.ts",
    ]) {
      const source = readSource(rel, [/bandForScoreKind\(/]);
      expect(source, rel).toMatch(/from "@\/lib\/analytics\/score\/shared"/);
    }
  });
});
