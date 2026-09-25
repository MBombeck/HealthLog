/**
 * Structural guards on workout sport provenance.
 *
 * Every provider labels a workout in its own vocabulary, and every ingest
 * collapses that label onto the canonical `WorkoutSportType` set. The
 * collapse is lossy at both ends: an unmapped label lands on `"other"`, and
 * `"other"` read back cannot be told apart from a label that genuinely meant
 * "other". The rule that keeps it recoverable is one line long — a
 * server-side ingest that maps a raw sport label writes that label verbatim
 * to `Workout.metadata`.
 *
 * Google Health broke that rule silently for three releases while the
 * comment above its type map asserted the opposite, and a user's workout
 * showed as "Other" with the original nowhere in the database. Other workout
 * providers carried the provenance write, but nothing connected the paths.
 *
 * These are tripwires, not proofs. A grep cannot show that a metadata key
 * holds the right value — only that a registered ingest still writes one, and
 * that a new ingest cannot appear without someone editing this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Every non-test `.ts` / `.tsx` under `src/`, minus the generated client. */
function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

interface ProviderIngest {
  /** Human name, for the failure message. */
  provider: string;
  /** The exported function that resolves the upstream label. */
  mapper: string;
  /** File declaring the mapper. */
  mapperFile: string;
  /** File where the raw label is captured alongside the mapped one. */
  captureFile: string;
  /** Identifier or literal that carries the raw label out of the capture. */
  captureField: string;
  /** File that builds the `Workout` row written to Postgres. */
  writeFile: string;
  /** The `metadata` key the raw label is stored under. */
  metadataKey: string;
}

/**
 * Every server-side workout ingest that maps a raw sport label onto the
 * canonical enum, with the provenance write that makes the mapping
 * reversible. Adding a provider means adding a row here.
 */
const PROVIDER_INGESTS: ProviderIngest[] = [
  {
    provider: "Google Health",
    mapper: "mapGoogleHealthSportType",
    mapperFile: "lib/google-health/mappers.ts",
    captureFile: "lib/google-health/mappers.ts",
    captureField: "sportTypeRaw",
    writeFile: "lib/google-health/sync-workout.ts",
    metadataKey: "googleExerciseType",
  },
  {
    provider: "WHOOP",
    mapper: "mapWhoopSportType",
    mapperFile: "lib/whoop/sport-map.ts",
    captureFile: "lib/whoop/sync-workout.ts",
    captureField: "sport_name",
    writeFile: "lib/whoop/sync-workout.ts",
    metadataKey: "whoopSportName",
  },
  {
    provider: "Polar",
    mapper: "mapPolarSportType",
    mapperFile: "lib/polar/sport-map.ts",
    captureFile: "lib/polar/client.ts",
    captureField: "detailed_sport_info",
    writeFile: "lib/polar/sync-workouts.ts",
    metadataKey: "polarSport",
  },
  {
    provider: "Strava",
    mapper: "mapStravaSportType",
    mapperFile: "lib/strava/sport-map.ts",
    captureFile: "lib/strava/client.ts",
    captureField: "rawSportType",
    writeFile: "lib/strava/sync.ts",
    metadataKey: "stravaType",
  },
  {
    provider: "Apple Health export",
    mapper: "resolveHkWorkoutSportType",
    mapperFile: "lib/measurements/hk-workout-activity-type-map.ts",
    captureFile: "lib/measurements/import-apple-health-export.ts",
    captureField: "workoutActivityType",
    writeFile: "lib/measurements/import-apple-health-export.ts",
    metadataKey: "activityType",
  },
  {
    provider: "Fitbit",
    mapper: "mapFitbitSportType",
    mapperFile: "lib/fitbit/client.ts",
    captureFile: "lib/fitbit/client.ts",
    captureField: "activityName",
    writeFile: "lib/fitbit/sync-workout.ts",
    metadataKey: "fitbitActivityName",
  },
];

/**
 * Exported helpers whose name ends in `SportType` but which never see an
 * upstream label — they narrow a value that is already canonical, at read
 * time, and have no provenance to preserve.
 */
const READ_TIME_NARROWERS = [
  "closedSportType", // lib/ai/coach/workout-evidence.ts — evidence payload
  "narrowSportType", // lib/workouts/insight-evidence.ts — insight claims
];

describe("T1 — the set of sport-label mappers is frozen", () => {
  // A sweep that finds nothing agrees with every allowlist, so the size of
  // the tree being read is asserted before anything is concluded from it.
  // Pinned below the real source-file count with headroom, not at one.
  it("reads the tree it claims to sweep", () => {
    expect(sourceFiles().length).toBeGreaterThan(1500);
  });

  it("every exported sport-type resolver is registered", () => {
    const found = new Set<string>();
    for (const rel of sourceFiles()) {
      for (const m of read(rel).matchAll(
        /export function (\w*(?:SportType|WorkoutSportType))\s*\(/g,
      )) {
        found.add(m[1]);
      }
    }

    const registered = [
      ...PROVIDER_INGESTS.map((p) => p.mapper),
      ...READ_TIME_NARROWERS,
    ].sort();

    // A new name here means a new provider vocabulary, which means a new
    // provenance obligation. It belongs in a reviewed diff.
    expect([...found].sort()).toEqual(registered);
  });

  it("each registered mapper lives where the registry says it does", () => {
    for (const p of PROVIDER_INGESTS) {
      expect(
        read(p.mapperFile).includes(`export function ${p.mapper}`),
        `${p.provider}: ${p.mapper} is no longer declared in ${p.mapperFile}`,
      ).toBe(true);
    }
  });
});

describe("T2 — the set of files writing Workout rows is frozen", () => {
  /**
   * Non-mapping writers: they persist a `sportType` that some other layer
   * already resolved, so the provenance rule does not reach them.
   */
  const NON_MAPPING_WRITERS: Record<string, string> = {
    // The iOS / client batch endpoint. The client sends an enum value and MAY
    // send its own `metadata`; no server-side label mapping happens here.
    "app/api/workouts/batch/route.ts": "client-supplied enum",
    // Backup restore replays rows this app previously wrote, provenance and
    // all.
    "lib/export/restore-backup.ts": "restore replay",
  };

  it("only the registered ingests and the declared non-mappers create Workout rows", () => {
    const writers = sourceFiles().filter((rel) =>
      /(?:prisma|tx)\.workout\.(?:create|createMany|createManyAndReturn|upsert)\(/.test(
        read(rel),
      ),
    );

    const expected = [
      ...PROVIDER_INGESTS.map((p) => p.writeFile),
      ...Object.keys(NON_MAPPING_WRITERS),
    ].sort();

    expect(writers.sort()).toEqual(expected);
  });
});

describe("T3 — every mapping ingest preserves the raw label", () => {
  it.each(PROVIDER_INGESTS)(
    "$provider writes metadata.$metadataKey",
    ({ provider, captureFile, captureField, writeFile, metadataKey }) => {
      expect(
        read(captureFile).includes(captureField),
        `${provider}: the raw label (${captureField}) is no longer read in ${captureFile}`,
      ).toBe(true);

      const writer = read(writeFile);
      expect(
        /metadata[,:]/.test(writer),
        `${provider}: ${writeFile} writes no metadata onto the Workout row`,
      ).toBe(true);

      // The key itself is declared where the metadata object is built, which
      // for two providers is the capture file rather than the writer.
      expect(
        writer.includes(metadataKey) || read(captureFile).includes(metadataKey),
        `${provider}: nothing writes the raw label under metadata.${metadataKey}`,
      ).toBe(true);
    },
  );
});
