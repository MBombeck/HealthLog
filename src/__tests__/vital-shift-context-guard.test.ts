/**
 * Every lasting-change notice asks what explains the shift first.
 *
 * The notice used to skip an open illness only: a pregnancy, where weight
 * and resting pulse move for months, got a "lasting change" every week. The
 * known states now live in one read, `vitalShiftContext`, and this test holds
 * every file that dispatches a `MEASUREMENT_ANOMALY` notice to it. A new
 * dispatcher that forgets it fails here; a new state added to the read
 * reaches every dispatcher at once.
 *
 * The sweep has a floor (the one dispatcher there is), so a matcher that
 * finds nothing fails instead of passing empty.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const DISPATCH =
  /dispatchNotification\s*\(\s*\{[^}]*?eventType\s*:\s*MEASUREMENT_ANOMALY(?:_EVENT)?\b/;

describe("lasting-change dispatchers", () => {
  const dispatchers = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/") && !p.includes("__tests__"))
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .filter((p) => DISPATCH.test(stripComments(readSourceText(join(SRC, p)))));

  it("are found", () => {
    requireFloor("MEASUREMENT_ANOMALY dispatchers", dispatchers, 1);
  });

  it("each read the vital-shift context before they send", () => {
    const missing = dispatchers.filter(
      (p) =>
        !/\bvitalShiftContext\s*\(/.test(
          stripComments(readSourceText(join(SRC, p))),
        ),
    );
    expect(
      missing,
      "Ask vitalShiftContext() (src/lib/insights/vital-shift-context.ts) before telling a person about a shift.",
    ).toEqual([]);
  });
});
