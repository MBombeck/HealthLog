/**
 * Regression-class ban for the German-default locale binary.
 *
 * The bug this pins had exactly one shape: `locale === "en" ? "en" : "de"`
 * (and its `=== "de" ? ... : ...` inversions with a `de` fallback). Every
 * occurrence sent French, Spanish, Italian and Polish accounts down the German
 * branch. This walks the source of the surfaces that carried it and fails on
 * the shape itself, so a future edit cannot quietly reintroduce it.
 *
 * Scoped to the files this change owns — the coach memory refresh, the coach
 * snapshot's narrative recall, the narrative route + generator + warm, and the
 * dashboard briefing recall. Blunt by design: it matches text, not behaviour,
 * which is precisely what makes it survive a refactor of the logic around it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { requireFloor } from "@/__tests__/helpers/source-files";
import { stripComments } from "../../../../__tests__/helpers/source-files";

const ROOT = resolve(__dirname, "../../../..");

/**
 * The chat route hands each turn to the pipeline under `lib/ai/coach/turn/`,
 * so every module there is guarded — read from the directory, so a step added
 * later is covered without editing this list.
 */
const TURN_PIPELINE_FILES = requireFloor(
  "coach turn pipeline modules",
  readdirSync(resolve(ROOT, "lib/ai/coach/turn"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `lib/ai/coach/turn/${name}`),
  12,
);

const GUARDED_FILES = [
  "app/api/insights/chat/route.ts",
  ...TURN_PIPELINE_FILES,
  "app/api/insights/narrative/route.ts",
  "lib/ai/coach/snapshot.ts",
  "lib/ai/coach/memory-snapshot.ts",
  "lib/ai/coach/coach-memory-refresh-worker.ts",
  "lib/dashboard/snapshot.ts",
  "lib/insights/narrative/period-narrative-generate.ts",
  "lib/jobs/period-narrative-warm.ts",
  "lib/jobs/period-narrative-shared.ts",
];

/**
 * A ternary whose FALSE branch is the German literal — the de-default shape.
 * Deliberately narrow: it must not flag `locale === "de" ? deBody : enBody`,
 * which is the correct polarity (German only for German readers).
 */
const DE_DEFAULT_TERNARY = /\?\s*"[a-z]{2}"\s*:\s*"de"/;

/** `payload.locale ?? "de"` and friends — a German default by omission. */
const DE_DEFAULT_NULLISH = /\?\?\s*"de"/;

/**
 * Read a guarded file with comments stripped.
 *
 * The comments at these call sites deliberately QUOTE the banned shape to
 * explain what was fixed; scanning them would make the guard self-tripping.
 * Only executable source is checked.
 */
function readCode(rel: string): string {
  return stripComments(readFileSync(resolve(ROOT, rel), "utf8"), rel);
}

describe("no German-default locale binary", () => {
  it.each(GUARDED_FILES)("%s carries no de-default ternary", (rel) => {
    expect(readCode(rel)).not.toMatch(DE_DEFAULT_TERNARY);
  });

  it.each(GUARDED_FILES)("%s carries no de-default fallback", (rel) => {
    expect(readCode(rel)).not.toMatch(DE_DEFAULT_NULLISH);
  });

  it.each(GUARDED_FILES)("%s reads as code, not as an empty file", (rel) => {
    // The bans above pass on nothing; the stripped file must still export.
    expect(readCode(rel)).toMatch(/\bexport\b/);
  });

  it("finds the turn pipeline it guards", () => {
    // An empty directory read would leave the pipeline unguarded and green.
    expect(TURN_PIPELINE_FILES).toContain("lib/ai/coach/turn/context.ts");
    expect(TURN_PIPELINE_FILES).toContain("lib/ai/coach/turn/pipeline.ts");
  });

  it("recognises the shape it bans", () => {
    // Guard the guard: the patterns must actually match the bug they describe,
    // so a typo cannot turn this file into a silent pass.
    expect(`locale === "en" ? "en" : "de"`).toMatch(DE_DEFAULT_TERNARY);
    expect(`payload.locale ?? "de"`).toMatch(DE_DEFAULT_NULLISH);
    // ...and must NOT match the correct polarity.
    expect(`instructionLocale(locale)`).not.toMatch(DE_DEFAULT_TERNARY);
    expect(`locale === "de" ? DE_BODY : EN_BODY`).not.toMatch(
      DE_DEFAULT_TERNARY,
    );
  });
});
