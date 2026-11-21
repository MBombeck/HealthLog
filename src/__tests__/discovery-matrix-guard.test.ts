/**
 * Structural guards on the correlation-discovery matrix.
 *
 * The matrix is a channel SET, and a channel set copied into four files is a
 * channel set that will differ in three of them. It did: the route and the
 * per-metric card folded in the environmental-exposure and custom-metric
 * families, the Coach `get_correlations` tool folded in neither, and the
 * period narrative folded in neither of those plus neither of the
 * compliance / symptom pair. Nobody wrote anything wrong — a family was added
 * where it was needed and the other call sites were not on anyone's screen.
 * `src/lib/insights/discovery-matrix.ts` removes the copies; these guards are
 * what stop a fifth one appearing.
 *
 * ## What each guard rests on
 *
 * T1 freezes who may FETCH a channel. A new surface that wants a matrix has to
 * either call the assembler or import a fetcher, and the second is the one this
 * catches.
 *
 * T2 freezes who may CONSTRUCT a channel — the `role: "behaviour" | "outcome"`
 * literal that makes a `NamedSeries`. A hand-rolled channel that never touches
 * `correlation-channel-series.ts` would slip T1 and lands here.
 *
 * T3 freezes who may SCAN. This is the weakest of the three and the most
 * likely to read as the strong one, so: passing T3 proves only that the list of
 * files calling `discoverCorrelations` has not changed silently. It says
 * nothing about what series those files pass. T1 and T2 are what make the
 * series the same series.
 *
 * ## What they cannot do
 *
 * They are tripwires, not proofs. A reviewer who waves through an addition to
 * an allowlist defeats all three. They match import statements and source
 * text, so a fetcher reached through a re-export, a dynamic `import()`, or a
 * channel built by a helper that takes `role` as a parameter would pass
 * unseen. And they cannot tell a deliberate divergence from an accidental one:
 * `assembleDiscoveryMatrix`'s options are where a real difference gets
 * declared, and only a reader can judge whether the reason written there is
 * a reason.
 *
 * Every match set below asserts a non-zero count. A matcher that has silently
 * stopped matching agrees with any allowlist, and that failure mode is exactly
 * how `bearer-scope-enforcement-guard` stayed green over a file it never saw.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The one assembler. Every allowlist below is "this, plus the unavoidable". */
const ASSEMBLER = "lib/insights/discovery-matrix.ts";

/** The module the channel fetchers live in — it defines them, so it matches. */
const CHANNEL_SERIES = "lib/insights/correlation-channel-series.ts";

/**
 * Every non-test `.ts` / `.tsx` under `src/`, excluding the generated Prisma
 * client (9 MB; never read it) and test files themselves.
 */
function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readSourceText(join(SRC, rel));
}

function filesMatching(re: RegExp): string[] {
  return sourceFiles().filter((rel) => re.test(read(rel)));
}

describe("T1 — only the assembler fetches discovery channels", () => {
  /**
   * The per-channel DB reads. A surface holding these is assembling a matrix
   * by hand, whatever it calls the variable.
   *
   * `fetchLabDraws` is deliberately absent: the labs pass runs over
   * `LabDrawPoint[]` in a separate point-vs-window scan, not over the
   * behaviour × outcome day grid, so the route and the Coach tool fetch it
   * directly and the assembler does not own it.
   */
  const CHANNEL_FETCHERS = [
    "fetchComplianceSeries",
    "fetchSymptomSeries",
    "fetchEnvironmentSeries",
    "fetchCustomMetricBehaviourSeries",
    "fetchSymptomEventSeries",
    "fetchMoodWindowSeries",
    "fetchMoodFactorWindowSeries",
    "fetchMeasurementDailySeriesTiered",
    "fetchMeasurementWindowSeries",
    "fetchNutrientSeries",
    "fetchAlcoholSeries",
    "fetchTrainingSeries",
    "fetchIndoorClimateSeries",
  ] as const;

  /**
   * `correlation-channel-series.ts` defines them all. The assembler is the one
   * consumer. Nothing else.
   */
  const FETCH_ALLOWLIST = [ASSEMBLER, CHANNEL_SERIES].sort();

  for (const fetcher of CHANNEL_FETCHERS) {
    it(`${fetcher} is reached only from the assembler`, () => {
      const matches = filesMatching(new RegExp(`\\b${fetcher}\\b`));
      // A matcher that found nothing would agree with any allowlist.
      expect(matches.length).toBeGreaterThan(0);
      expect(matches).toEqual(FETCH_ALLOWLIST);
    });
  }
});

describe("T2 — only the declared builders construct a discovery channel", () => {
  /**
   * A `NamedSeries` is identified by its `role` literal. Whitespace-tolerant:
   * the same call written across two lines is the same call, and a matcher
   * that demands one line is a matcher that can be defeated by prettier.
   */
  const ROLE_LITERAL = /role:\s*"(?:behaviour|outcome)"/;

  /**
   * Files allowed to mint a channel.
   *
   *  - the assembler, which folds the matrix;
   *  - `correlation-channel-series.ts` + `correlation-series-builders.ts`,
   *    which shape one channel each from its own source;
   *  - `correlation-discovery.ts`, which declares the `NamedSeries` type and
   *    re-runs the engine over a filtered copy in the emerging pass;
   *  - `cycle/phase-crosstab.ts`, which builds a DELIBERATELY separate,
   *    cycle-gated matrix (CYCLE_PHASE × outcomes). That one must never reach
   *    the non-gated surfaces, which is the opposite requirement to this
   *    file's, and is why it is listed rather than merged;
   *  - `energy-balance-channel.ts`, which shapes the ENERGY_BALANCE channel
   *    from the energy-balance read and is folded by the assembler.
   */
  const CONSTRUCTION_ALLOWLIST = [
    ASSEMBLER,
    CHANNEL_SERIES,
    "lib/insights/correlation-series-builders.ts",
    "lib/insights/correlation-discovery.ts",
    "lib/cycle/phase-crosstab.ts",
    "lib/insights/energy-balance-channel.ts",
  ].sort();

  it("no file outside the allowlist constructs a NamedSeries", () => {
    const matches = filesMatching(ROLE_LITERAL);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches).toEqual(CONSTRUCTION_ALLOWLIST);
  });
});

describe("T3 — the set of files that scan a matrix is frozen", () => {
  /**
   * Whitespace-tolerant on purpose: `discoverCorrelations(\n  series,` is the
   * same call, and a literal `discoverCorrelations(` matcher would miss it.
   */
  const SCAN_CALL = /\bdiscoverCorrelations\s*\(/;

  /**
   * The four discovery surfaces, plus the two engine-internal uses.
   *
   * Being on this list is NOT permission to build a matrix — T1 and T2 decide
   * that. It is permission to scan one, and every entry here gets its series
   * from `assembleDiscoveryMatrix` except the two that are the engine.
   */
  const SCAN_ALLOWLIST = [
    // The four surfaces. Each calls the assembler for its series.
    "app/api/insights/correlations/route.ts",
    "lib/insights/metric-correlation-context.ts",
    "lib/ai/coach/tools/correlations-read.ts",
    "lib/insights/narrative/period-narrative.ts",
    // The engine itself: the declaration and the emerging-window re-run.
    "lib/insights/correlation-discovery.ts",
    // The cycle-gated phase matrix — see T2's note.
    "lib/cycle/phase-crosstab.ts",
  ].sort();

  it("no file outside the allowlist runs the discovery scan", () => {
    const matches = filesMatching(SCAN_CALL);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches).toEqual(SCAN_ALLOWLIST);
  });

  it("every scanning surface takes its series from the assembler", () => {
    const surfaces = SCAN_ALLOWLIST.filter(
      (rel) =>
        rel !== "lib/insights/correlation-discovery.ts" &&
        rel !== "lib/cycle/phase-crosstab.ts",
    );
    expect(surfaces).toHaveLength(4);
    for (const rel of surfaces) {
      expect(read(rel)).toMatch(/\bassembleDiscoveryMatrix\s*\(/);
    }
  });
});
