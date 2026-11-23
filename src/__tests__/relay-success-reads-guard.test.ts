/**
 * Structural guard: no send path reads "something was handed on" as sent.
 *
 * The relay answers `200` for a batch and refuses items inside it. The intake
 * sync flush counted a sync the relay had refused for the device's silent
 * budget as `ok` because it read `anyAccepted || waiting` (the outbox held
 * the push), so it never owed the sync. Whether a sealed send succeeded is
 * now read per device, by one rule (`sealedOutcome`, `route-device.ts`;
 * pinned in `relay-item-outcome.test.ts`).
 *
 * Here: outside the two modules that build them, the aggregate flags of a
 * sealed send (`anyAccepted`, `waiting`) and the counts of a relay send
 * (`summary.accepted`, `.waiting`, `.owed`, `.failed`) are read in exactly
 * the places listed, each for a reason that is not "was it delivered":
 * - `apns-channel.ts` answers the dispatcher whether the person was reached
 *   (`anyAccepted`), so it never sends again to the devices that have it;
 *   its ledger row follows the rule;
 * - `test-push.ts` compares the accepted count with the items it sent.
 *
 * Every matcher asserts a non-zero count, so a guard that matches nothing
 * fails instead of passing.
 */
import { describe, expect, it } from "vitest";

import {
  readSourceFolder,
  requireFloor,
  stripComments,
} from "./helpers/source-files";

const BUILDERS = new Set(["route-device.ts", "relay-send.ts"]);

function reads(folder: string, floor: number): string[] {
  const found: string[] = [];
  for (const [rel, text] of readSourceFolder(folder, {
    floor,
    include: (r) => !r.includes("__tests__"),
  })) {
    if (BUILDERS.has(rel)) continue;
    const code = stripComments(text);
    for (const m of code.matchAll(
      /\.\s*(anyAccepted|waiting)\b|\bsummary\s*\.\s*(accepted|waiting|owed|failed)\b/g,
    )) {
      found.push(`${folder.split("/").pop()}/${rel}:${m[1] ?? m[2]}`);
    }
  }
  return found;
}

describe("relay success reads", () => {
  it("reads a send's aggregate outcome only where listed", () => {
    const found = [
      ...reads("src/lib/push-relay", 10),
      ...reads("src/lib/notifications", 10),
    ];
    requireFloor("aggregate relay outcome reads", found, 3);
    expect([...new Set(found)].sort()).toEqual([
      "push-relay/apns-channel.ts:anyAccepted",
      "push-relay/test-push.ts:accepted",
      "push-relay/test-push.ts:failed",
      "push-relay/test-push.ts:owed",
      "push-relay/test-push.ts:waiting",
    ]);
  });
});
