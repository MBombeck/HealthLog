/**
 * The morning read on `/` is data, and stays out of every model's way in
 * both directions: nothing in it comes from a model, and nothing in it goes to
 * one.
 *
 *   - Its builder, loader and route import nothing from `@/lib/ai`.
 *   - Only the route, the server render of `/` and the one warming job load
 *     it. The reaction-line job and the daily push read the digest, and the
 *     evidence handed to the reaction-line model is built from the digest's
 *     score, signal and briefing lead, never from the morning.
 *   - The morning carries no health score of its own: the ring beside the
 *     sentence is the digest's, whose model-bound reading is held in
 *     `privacy-promise-guard.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  stripComments,
} from "./helpers/source-files";

const MORNING_FILES = [
  ["src/lib/daily/morning.ts", "buildMorningLead"],
  ["src/lib/daily/morning-load.ts", "loadDailyMorning"],
  ["src/app/api/daily/morning/route.ts", "loadDailyMorning"],
] as const;

const AI_IMPORT = /from\s+["']@\/lib\/ai(?:\/|["'])/;
const MORNING_IMPORT = /from\s+["']@\/lib\/daily\/morning(?:-load)?["']/;

describe("the morning read is model-free", () => {
  it("imports nothing from the AI layer", () => {
    for (const [file, anchor] of MORNING_FILES) {
      const code = stripComments(readSource(file, anchor), file);
      expect(AI_IMPORT.test(code), file).toBe(false);
    }
  });

  it("is loaded by the route, the page and the warming job only", () => {
    const loaders: string[] = [];
    for (const [dir, floor] of [
      ["src/lib", 1500],
      ["src/app", 500],
    ] as const) {
      for (const [rel, text] of readSourceFolder(dir, {
        floor,
        include: (path) => !path.includes("__tests__"),
      })) {
        if (/from\s+["']@\/lib\/daily\/morning-load["']/.test(text)) {
          loaders.push(`${dir}/${rel}`);
        }
      }
    }
    expect(loaders.sort()).toEqual([
      "src/app/api/daily/morning/route.ts",
      "src/app/page.tsx",
      "src/lib/jobs/morning-digest-refresh.ts",
    ]);
  });

  it("never reaches the reaction-line evidence or the daily push", () => {
    for (const [file, anchor] of [
      ["src/lib/jobs/reaction-line.ts", "buildEvidence("],
      [
        "src/lib/jobs/reaction-line-evidence.ts",
        "export function buildEvidence",
      ],
      ["src/lib/daily/daily-briefing-push.ts", "loadDailyDigest"],
    ] as const) {
      const code = stripComments(readSource(file, anchor), file);
      expect(MORNING_IMPORT.test(code), file).toBe(false);
      expect(/\bmorning\s*[:?]/i.test(code), file).toBe(false);
    }
    // The evidence takes the digest's score, signal and lead, and nothing else.
    const evidence = readSource(
      "src/lib/jobs/reaction-line-evidence.ts",
      "export function buildEvidence",
    );
    const signature = evidence.slice(
      evidence.indexOf("export function buildEvidence"),
      evidence.indexOf("): string {"),
    );
    expect(signature).toMatch(/score:/);
    expect(signature).not.toMatch(/morning|lead:\s*\{|cards/i);
  });

  it("carries no health score of its own", () => {
    const code = stripComments(
      readSource("src/lib/daily/morning.ts", "export interface DailyMorning"),
      "morning.ts",
    );
    const start = code.indexOf("export interface DailyMorning {");
    const shape = code.slice(start, code.indexOf("\n}", start));
    expect(shape).toMatch(/lead:/);
    // The score tiles it carries are the sleep score and readiness; the
    // Health score is the digest's, and stays there.
    expect(shape).toMatch(
      /scores:\s*\{\s*sleep: DailyMorningScore \| null;\s*readiness: DailyMorningScore \| null;\s*\}/,
    );
    expect(shape).not.toMatch(/composite|healthScore|health:/i);
  });
});
