/**
 * The default source ladders (`DEFAULT_SOURCE_PRIORITY`) are what a person's
 * order falls back to, never a reader's order. Every reader that picks one
 * source for a value reads the person's ladder: `parseSourcePriority` over
 * their stored `sourcePriorityJson`, which fills in the defaults itself.
 *
 * The recovery resolver read `DEFAULT_SOURCE_PRIORITY.recovery` directly, and
 * so did the doctor report: someone who put Oura above WHOOP in the settings
 * saw WHOOP in the ring, the Coach, the briefing and the report, and Oura in
 * the charts, which rank in SQL by the person's ladder.
 *
 * The constant may appear where it is the default itself: the validation
 * module that defines it and merges it under the person's order, the
 * settings section that shows it and resets to it, and the list of sources
 * the server knows (`sources-in-use`). Comments and string literals (the
 * OpenAPI descriptions name it) are not reads.
 *
 * Mutation check: put `const RECOVERY_LADDER = DEFAULT_SOURCE_PRIORITY.recovery;`
 * back in `recovery-resolve.ts` and this goes red.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scanSourceMatches } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const DEFAULT_ITSELF = new Set([
  "lib/validations/source-priority.ts",
  "components/settings/sources-section.tsx",
  "lib/integrations/sources-in-use.ts",
]);

describe("the default source ladder is no reader's order", () => {
  // Not inside a template or string: the OpenAPI copy names the constant.
  const hits = scanSourceMatches(
    SRC,
    /(?<![`'"\w])DEFAULT_SOURCE_PRIORITY\b/g,
    {
      fileFloor: 500,
      matchFloor: 5,
      stripComments: true,
      include: (rel) => !/(^|\/)(__tests__|generated)\//.test(rel),
    },
  );

  it("is read only where it is the default itself", () => {
    expect(
      hits
        .filter((h) => !DEFAULT_ITSELF.has(h.file))
        .map((h) => `${h.file}:${h.line}`),
    ).toEqual([]);
  });

  it("is still found where it lives", () => {
    expect(
      hits.filter((h) => h.file === "lib/validations/source-priority.ts")
        .length,
    ).toBeGreaterThan(0);
  });
});
