/**
 * One retry rule for every provider history import.
 *
 * The admission drain reads why an import run failed and, for a provider
 * outage, sends the run again after a backoff of minutes to hours
 * (`src/lib/jobs/integration-backfill-retry.ts`). It can only see an outage
 * through the thrown error's `cause` chain. A runner that throws a bare
 * `new Error("… incomplete …")` hides the provider's error, so the run falls
 * back to pg-boss's three short retries and an outage of ten minutes ends the
 * chain. That is how WHOOP and Google Health stayed outside the rule after
 * Garmin, Oura and Strava moved onto it.
 *
 * The guard holds three things:
 *   - every import kind the drain records on a provider ledger has a runner
 *     listed here, so a new provider cannot arrive without a decision;
 *   - no listed runner throws a bare "incomplete" error: it throws through
 *     `backfillIncomplete(message, failure)` or throws the provider's error
 *     itself;
 *   - the syncs that carry on past a failed collection (WHOOP, Google
 *     Health) note that collection's error with `noteBackfillFailure`, which
 *     is where a runner's `failure` comes from.
 */
import { describe, expect, it } from "vitest";

import { readSource } from "@/__tests__/helpers/source-files";

type Carrier = "backfillIncomplete" | "throws the provider error";

/** Runner file of every import kind that belongs to a provider ledger. */
const RUNNERS: Record<
  string,
  { file: string; runner: string; carrier: Carrier }
> = {
  "whoop-backfill": {
    file: "src/lib/jobs/whoop-backfill.ts",
    runner: "runWhoopBackfillForUser",
    carrier: "backfillIncomplete",
  },
  "google-health-backfill": {
    file: "src/lib/jobs/google-health-backfill.ts",
    runner: "runGoogleHealthBackfillForUser",
    carrier: "backfillIncomplete",
  },
  "google-health-sleep-repair": {
    file: "src/lib/jobs/google-health-sleep-repair.ts",
    runner: "runGoogleHealthSleepRepairForUser",
    carrier: "backfillIncomplete",
  },
  // The WHOOP arm re-syncs the full history; the Withings arm's sync throws
  // the provider error itself.
  "sleep-timeline-backfill": {
    file: "src/lib/jobs/sleep-timeline-backfill.ts",
    runner: "runSleepTimelineBackfillForUser",
    carrier: "backfillIncomplete",
  },
  "garmin-backfill": {
    file: "src/lib/jobs/garmin-backfill.ts",
    runner: "runGarminBackfillForUser",
    carrier: "backfillIncomplete",
  },
  "oura-backfill": {
    file: "src/lib/jobs/oura-backfill.ts",
    runner: "runOuraBackfillForUser",
    carrier: "backfillIncomplete",
  },
  "strava-backfill": {
    file: "src/lib/jobs/strava-backfill.ts",
    runner: "runStravaBackfillForUser",
    carrier: "throws the provider error",
  },
};

/** Syncs that swallow a collection's error and must note it. */
const COLLECTORS = [
  "src/lib/whoop/sync.ts",
  "src/lib/google-health/sync.ts",
  "src/lib/google-health/sync-core.ts",
];

/** The kinds `integrationOf` maps to a provider ledger (not `null`). */
function ledgerKinds(): string[] {
  const source = readSource(
    "src/lib/jobs/integration-backfill-retry.ts",
    "function integrationOf(",
  );
  const body = source.match(
    /const map: Record<IntegrationBackfillKind, IntegrationKey \| null> = \{([\s\S]*?)\};/,
  )?.[1];
  expect(body, "integrationOf's map").toBeDefined();
  const kinds = [...body!.matchAll(/"([a-z-]+)":\s*([^,]+),/g)]
    .filter(([, , value]) => value!.trim() !== "null")
    .map(([, kind]) => kind!);
  return kinds;
}

const BARE_INCOMPLETE = /throw new Error\(\s*`[^`]*incomplete/g;

describe("integration backfill retry rule", () => {
  it("lists a runner for every import kind on a provider ledger", () => {
    const kinds = ledgerKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(7);
    expect(kinds.sort()).toEqual(Object.keys(RUNNERS).sort());
  });

  it.each(Object.entries(RUNNERS))(
    "%s throws its failure where the drain can read it",
    (_kind, { file, runner, carrier }) => {
      const source = readSource(file, `function ${runner}(`);
      expect(source.match(BARE_INCOMPLETE) ?? [], file).toEqual([]);
      if (carrier === "backfillIncomplete") {
        expect(
          source.match(/throw backfillIncomplete\(/g)?.length ?? 0,
          file,
        ).toBeGreaterThan(0);
      } else {
        expect(source.match(/throw new Error\(/g) ?? [], file).toEqual([]);
      }
    },
  );

  it.each(COLLECTORS)("%s notes a failed collection's error", (file) => {
    expect(
      readSource(file, "catch (err)").match(/noteBackfillFailure\(err\)/g)
        ?.length ?? 0,
      file,
    ).toBeGreaterThan(0);
  });
});
