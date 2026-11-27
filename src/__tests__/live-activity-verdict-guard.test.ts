/**
 * What the relay may do to a device's Live Activities has one home:
 * `laVerdict` in `src/lib/push-relay/live-activity-eligibility.ts`. The
 * operator's switch (`liveActivityRelayEnabled()`) and the device's Live
 * Activity consent (`liveActivityConsentAt`) decide nothing anywhere else.
 *
 * A second reading of either is how a running Activity stayed on the lock
 * screen after the consent was withdrawn or the switch turned off: the pass
 * asked the start rule before it built the list of Activities to end, and
 * picked its devices by the consent in its own Prisma filter.
 *
 * Writes (`liveActivityConsentAt: null`, `: new Date()`), the column in a
 * `select` (`: true`) and type declarations are not decisions and pass.
 * `capability.ts` publishes the switch (the events the relay offers) and the
 * consent bit as they are, for the app to show; it decides nothing.
 *
 * Mutation check: put `if (!liveActivityRelayEnabled()) return facts;` back
 * at the top of `runLiveActivityRelayPass` and this goes red.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scanSourceMatches } from "./helpers/source-files";

const HOME = "lib/push-relay/live-activity-eligibility.ts";
const ALLOWED = new Set([
  HOME,
  // The definition of the switch.
  "lib/push-relay/config.ts",
  // Publishes the switch and the consent bit; decides nothing.
  "lib/push-relay/capability.ts",
]);

/** A call of the switch, or a read of the consent as a condition. */
const DECISION =
  /\bliveActivityRelayEnabled\s*\(|\.\s*liveActivityConsentAt\b|\bliveActivityConsentAt\s*:\s*\{/g;

describe("the Live Activity verdict has one home", () => {
  const hits = scanSourceMatches(join(process.cwd(), "src"), DECISION, {
    fileFloor: 500,
    matchFloor: 3,
    stripComments: true,
    include: (rel) => !/(^|\/)(__tests__|generated)\//.test(rel),
  });

  it("reads the switch and the consent nowhere else", () => {
    expect(
      hits
        .filter((h) => !ALLOWED.has(h.file))
        .map((h) => `${h.file}:${h.line}`),
    ).toEqual([]);
  });

  it("still finds the rule where it lives (a matcher that finds nothing proves nothing)", () => {
    expect(hits.filter((h) => h.file === HOME).length).toBeGreaterThanOrEqual(
      3,
    );
  });
});
