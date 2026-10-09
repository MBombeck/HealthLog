/**
 * v1.42 (#613) — every key the timeline and the day view word a code with
 * exists. The maps in `label-keys.ts` replaced template keys the call-site
 * coverage guard could not read; this walks their values instead, so a map
 * entry without its message fails here rather than on a screen.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as dayKeys from "@/components/day/label-keys";
import { INSTRUMENTS, INSTRUMENT_ORDER } from "@/lib/mental-health/instruments";
import { workoutSportTypeEnum } from "@/lib/validations/workout";

import * as timelineKeys from "../label-keys";

const LOCALES = ["de", "en", "es", "fr", "it", "ko", "pl"] as const;

const bundles = Object.fromEntries(
  LOCALES.map((l) => [
    l,
    JSON.parse(
      readFileSync(join(process.cwd(), "messages", `${l}.json`), "utf8"),
    ),
  ]),
);

function leaf(bundle: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (o, part) =>
        o && typeof o === "object"
          ? (o as Record<string, unknown>)[part]
          : undefined,
      bundle,
    );
}

/** Every string value in a map, maps of maps included, with its path. */
function values(map: unknown, path: string): Array<[string, string]> {
  if (typeof map === "string") return [[path, map]];
  if (!map || typeof map !== "object") return [];
  return Object.entries(map).flatMap(([k, v]) => values(v, `${path}.${k}`));
}

const MAPS = [
  ...Object.entries(timelineKeys),
  ...Object.entries(dayKeys),
].filter(([, v]) => typeof v === "object");

describe("label key maps", () => {
  it("finds the maps it is meant to check", () => {
    expect(MAPS.length).toBeGreaterThanOrEqual(18);
  });

  it.each(LOCALES)("resolves every key in %s", (locale) => {
    const missing = MAPS.flatMap(([name, map]) => values(map, name)).filter(
      ([, key]) => typeof leaf(bundles[locale], key) !== "string",
    );
    expect(missing).toEqual([]);
  });

  it("names every band each screener stores", () => {
    for (const id of INSTRUMENT_ORDER) {
      expect(Object.keys(dayKeys.ASSESSMENT_BAND_KEY[id]).sort()).toEqual(
        INSTRUMENTS[id].bands.map((b) => b.key).sort(),
      );
    }
  });

  it("names every sport a workout can carry", () => {
    expect(Object.keys(dayKeys.WORKOUT_SPORT_KEY).sort()).toEqual(
      [...workoutSportTypeEnum.options].sort(),
    );
  });
});
