/**
 * A health score pillar's band comes from the server (1.50).
 *
 * The scorer resolves each scored pillar's band once (`okPillar` sets
 * `value.band`; the snapshot row carries it as `band`), so the web and the
 * native app colour a pillar the same way. A client that bands a pillar from
 * its number again would be a second copy of the rule, free to drift from the
 * one the server applies. This guard fails when any client file that speaks
 * of pillars calls a banding function.
 *
 * The matcher is proven on a sample that must match, and the scan must find
 * the pillar panel itself, so the guard cannot pass by reading nothing.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { okPillar } from "@/lib/analytics/score/shared";
import type { PillarValue } from "@/lib/analytics/score/types";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Client code: components, pages (not the API routes) and hooks. */
const CLIENT_ROOTS = [
  { dir: "components", floor: 300 },
  { dir: "app", floor: 100 },
  { dir: "hooks", floor: 10 },
] as const;

const SPEAKS_OF_PILLARS = /pillar/i;
const BANDS_A_SCORE = /\b(?:bandForScore|bandForScoreKind|scoreBand)\s*\(/;

function clientFiles(): string[] {
  return CLIENT_ROOTS.flatMap(({ dir, floor }) =>
    walkSourceFiles(join(SRC, dir), { floor })
      .map((rel) => `${dir}/${rel}`)
      .filter(
        (rel) =>
          !rel.startsWith("app/api/") &&
          !rel.includes("__tests__/") &&
          !/\.test\.tsx?$/.test(rel),
      ),
  );
}

describe("pillar bands are served, never derived on the client", () => {
  it("the matcher catches a client banding a pillar", () => {
    const sample = `const band = bandForScore(pillar.result.value.score);`;
    expect(SPEAKS_OF_PILLARS.test(sample)).toBe(true);
    expect(BANDS_A_SCORE.test(sample)).toBe(true);
    expect(BANDS_A_SCORE.test(`bandForScoreKind("health", pillarScore)`)).toBe(
      true,
    );
  });

  it("no client file that renders pillars calls a banding function", () => {
    const pillarFiles = clientFiles().filter((rel) =>
      SPEAKS_OF_PILLARS.test(
        stripComments(readSourceText(join(SRC, rel)), rel),
      ),
    );
    requireFloor("client files that speak of pillars", pillarFiles, 3);
    expect(pillarFiles).toContain(
      "components/insights/health-score-pillars.tsx",
    );

    const offenders = pillarFiles.filter((rel) =>
      BANDS_A_SCORE.test(stripComments(readSourceText(join(SRC, rel)), rel)),
    );
    expect(offenders).toEqual([]);
  });

  it("the scorer sets the band on every scored pillar", () => {
    const at = (score: number) =>
      okPillar({
        id: "ACTIVITY",
        source: "DAY",
        asOf: new Date("2026-11-25T07:00:00.000Z"),
        windowDays: 28,
        coverage: {
          requiredInputs: 1,
          presentInputs: 1,
          historyDays: 28,
          missing: [],
        },
        value: { score } as unknown as PillarValue,
      });
    const bands = [92, 70, 69, 50, 49, 0].map((score) => {
      const result = at(score);
      return result.status === "ok" ? result.value.band : undefined;
    });
    expect(bands).toEqual(["green", "green", "yellow", "yellow", "red", "red"]);
  });
});
